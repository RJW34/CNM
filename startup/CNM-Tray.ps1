# CNM System Tray Application
# CNM - Ruby & Sapphire Link Server
# Lightweight startup with system tray icon

param(
    [switch]$Hidden,
    [switch]$Silent  # Suppress "already running" message (for automated launches)
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Threading

# Single instance check using mutex - ONLY ONE TRAY ICON EVER
$mutexName = "Global\CNM_Tray_SingleInstance"
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)

if (-not $createdNew) {
    # Another instance is already running - exit silently or with message
    if (-not $Silent) {
        [System.Windows.Forms.MessageBox]::Show(
            "CNM Tray is already running.`n`nCheck your system tray for the gem icon.",
            "CNM",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        )
    }
    exit
}

# Set AppUserModelID for proper notification display
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class AppId {
    [DllImport("shell32.dll", SetLastError = true)]
    static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string AppID);

    public static void Set(string appId) {
        SetCurrentProcessExplicitAppUserModelID(appId);
    }
}
"@
[AppId]::Set("CNM.NetworkMachine.Server")

# Keep-awake API for preventing system sleep
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PowerKeepAwake {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;

    public static bool PreventSleep() {
        // Prevent system from sleeping (but allow display to sleep)
        // Call without ES_CONTINUOUS first to reset, then with it to set persistent
        uint result = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        return result != 0;
    }

    public static bool PreventSleepAndDisplay() {
        // Prevent both system and display from sleeping
        uint result = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        return result != 0;
    }

    public static void AllowSleep() {
        // Allow system to sleep normally
        SetThreadExecutionState(ES_CONTINUOUS);
    }

    public static bool Ping() {
        // Just ping to keep the state active (non-continuous refresh)
        uint result = SetThreadExecutionState(ES_SYSTEM_REQUIRED);
        return result != 0;
    }
}
"@

$script:serverProcess = $null
$script:serverDir = Split-Path -Parent $PSScriptRoot
$script:logFile = Join-Path $script:serverDir "server\server.log"
$script:keepAwakeEnabled = $true  # Default to enabled
$script:autoRestartServer = $true  # Always keep server running
$script:ownedProcessId = $null  # Track if we started the server

# Branded notification title
$script:NotifyTitle = "Network Machine"

# Create ruby + sapphire icon (red and blue gems)
function New-GemIcon {
    $bitmap = $null
    $g = $null
    $rubyBrush = $null
    $rubyHighlight = $null
    $sapphireBrush = $null
    $sapphireHighlight = $null

    try {
        $bitmap = New-Object System.Drawing.Bitmap(16, 16)
        $g = [System.Drawing.Graphics]::FromImage($bitmap)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.Clear([System.Drawing.Color]::Transparent)

        # Ruby (red gem) - left side
        $rubyBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 38, 38))
        $rubyHighlight = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(248, 113, 113))

        # Ruby gem shape (hexagonal)
        $rubyPoints = @(
            [System.Drawing.Point]::new(3, 4),
            [System.Drawing.Point]::new(6, 2),
            [System.Drawing.Point]::new(9, 4),
            [System.Drawing.Point]::new(9, 9),
            [System.Drawing.Point]::new(6, 11),
            [System.Drawing.Point]::new(3, 9)
        )
        $g.FillPolygon($rubyBrush, $rubyPoints)
        # Ruby highlight
        $g.FillPolygon($rubyHighlight, @(
            [System.Drawing.Point]::new(4, 4),
            [System.Drawing.Point]::new(6, 3),
            [System.Drawing.Point]::new(7, 5),
            [System.Drawing.Point]::new(5, 6)
        ))

        # Sapphire (blue gem) - right side, offset
        $sapphireBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
        $sapphireHighlight = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(96, 165, 250))

        # Sapphire gem shape
        $sapphirePoints = @(
            [System.Drawing.Point]::new(7, 6),
            [System.Drawing.Point]::new(10, 4),
            [System.Drawing.Point]::new(13, 6),
            [System.Drawing.Point]::new(13, 11),
            [System.Drawing.Point]::new(10, 13),
            [System.Drawing.Point]::new(7, 11)
        )
        $g.FillPolygon($sapphireBrush, $sapphirePoints)
        # Sapphire highlight
        $g.FillPolygon($sapphireHighlight, @(
            [System.Drawing.Point]::new(8, 6),
            [System.Drawing.Point]::new(10, 5),
            [System.Drawing.Point]::new(11, 7),
            [System.Drawing.Point]::new(9, 8)
        ))

        # Create icon from bitmap handle
        $hIcon = $bitmap.GetHicon()
        $icon = [System.Drawing.Icon]::FromHandle($hIcon)

        # Clone the icon so we can safely dispose the bitmap
        # (FromHandle doesn't copy the data, it shares the handle)
        $iconClone = $icon.Clone()

        return $iconClone
    } finally {
        # Dispose all GDI+ objects to prevent memory leaks
        if ($g) { $g.Dispose() }
        if ($rubyBrush) { $rubyBrush.Dispose() }
        if ($rubyHighlight) { $rubyHighlight.Dispose() }
        if ($sapphireBrush) { $sapphireBrush.Dispose() }
        if ($sapphireHighlight) { $sapphireHighlight.Dispose() }
        if ($bitmap) { $bitmap.Dispose() }
    }
}

# Check if server is running and get process info
function Get-ServerStatus {
    try {
        # Force array to handle single result (CimInstance doesn't have .Count)
        $connections = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
        if ($connections.Count -gt 0) {
            $serverPid = $connections[0].OwningProcess
            $isOwned = ($script:ownedProcessId -eq $serverPid)
            return @{
                Running = $true
                ProcessId = $serverPid
                Owned = $isOwned
            }
        }
        return @{ Running = $false; ProcessId = $null; Owned = $false }
    } catch {
        return @{ Running = $false; ProcessId = $null; Owned = $false }
    }
}

# Simple check for backward compatibility
function Test-ServerRunning {
    $status = Get-ServerStatus
    return $status.Running
}

# Start the CNM server
# Returns: "started" | "already_running" | "adopted" | "failed"
function Start-CNMServer {
    $status = Get-ServerStatus

    if ($status.Running) {
        if ($status.Owned) {
            return "already_running"
        } else {
            # Server running but not started by us - adopt it
            $script:ownedProcessId = $status.ProcessId
            return "adopted"
        }
    }

    $nodeExe = "node"
    $indexJs = Join-Path $script:serverDir "server\index.js"

    if (-not (Test-Path $indexJs)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Server file not found: $indexJs",
            "CNM",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
        return "failed"
    }

    try {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $nodeExe
        $psi.Arguments = "`"$indexJs`""
        $psi.WorkingDirectory = Join-Path $script:serverDir "server"
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true

        $script:serverProcess = [System.Diagnostics.Process]::Start($psi)

        # Wait and retry - server may take a moment to bind port
        for ($i = 0; $i -lt 5; $i++) {
            Start-Sleep -Seconds 1
            $newStatus = Get-ServerStatus
            if ($newStatus.Running) {
                $script:ownedProcessId = $newStatus.ProcessId
                return "started"
            }
        }
        return "failed"
    } catch {
        return "failed"
    }
}

# Stop the CNM server
function Stop-CNMServer {
    $status = Get-ServerStatus

    if (-not $status.Running) {
        return $false
    }

    # Kill the process
    try {
        if ($status.ProcessId -gt 0) {
            Stop-Process -Id $status.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}

    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        try { $script:serverProcess.Kill() } catch {}
    }

    $script:ownedProcessId = $null
    Start-Sleep -Milliseconds 500
    return -not (Test-ServerRunning)
}

# Restart the CNM server (stop then start)
# Returns: "restarted" | "started" | "failed"
function Restart-CNMServer {
    $wasRunning = Test-ServerRunning

    if ($wasRunning) {
        $stopped = Stop-CNMServer
        if (-not $stopped) {
            return "failed"
        }
        # Wait a bit for port to be released
        Start-Sleep -Seconds 1
    }

    $result = Start-CNMServer
    if ($result -eq "started") {
        return $(if ($wasRunning) { "restarted" } else { "started" })
    }
    return "failed"
}

# Update keep-awake state - INDEPENDENT of server status
# Keep system awake whenever tray app is running and feature is enabled
function Update-KeepAwake {
    if ($script:keepAwakeEnabled) {
        # Always keep awake when enabled - server status doesn't matter
        # This ensures system stays accessible for remote reconnection
        [PowerKeepAwake]::PreventSleep() | Out-Null
        [PowerKeepAwake]::Ping() | Out-Null
    } else {
        [PowerKeepAwake]::AllowSleep()
    }
}

# Update tray icon tooltip
function Update-TrayStatus {
    param($notifyIcon)

    $status = Get-ServerStatus
    $awakeText = if ($script:keepAwakeEnabled) { " [Awake]" } else { "" }

    if ($status.Running) {
        if ($status.Owned) {
            $notifyIcon.Text = "Network Machine - Running$awakeText"
        } else {
            $notifyIcon.Text = "Network Machine - External$awakeText"
        }
    } else {
        $notifyIcon.Text = "Network Machine - Stopped"
    }
}

# Main application
function Start-TrayApp {
    # Create notification icon
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = New-GemIcon
    $notifyIcon.Text = "Network Machine"
    $notifyIcon.Visible = $true

    # Create context menu
    $contextMenu = New-Object System.Windows.Forms.ContextMenuStrip

    # Status item (disabled, just shows status)
    $statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $statusItem.Text = "Status: Checking..."
    $statusItem.Enabled = $false
    $contextMenu.Items.Add($statusItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Start process
    $startItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $startItem.Text = "Start Server"
    $startItem.Add_Click({
        $startItem.Enabled = $false
        $result = Start-CNMServer
        switch ($result) {
            "started" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server started on port 3001", [System.Windows.Forms.ToolTipIcon]::None)
            }
            "adopted" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Connected to existing server", [System.Windows.Forms.ToolTipIcon]::None)
            }
            "already_running" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server already running", [System.Windows.Forms.ToolTipIcon]::None)
            }
            "failed" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Failed to start server", [System.Windows.Forms.ToolTipIcon]::Error)
            }
        }
        Update-MenuState
    })
    $contextMenu.Items.Add($startItem) | Out-Null

    # Stop process
    $stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $stopItem.Text = "Stop Server"
    $stopItem.Add_Click({
        $stopped = Stop-CNMServer
        if ($stopped) {
            $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server stopped", [System.Windows.Forms.ToolTipIcon]::None)
        } else {
            $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server was not running", [System.Windows.Forms.ToolTipIcon]::Warning)
        }
        Update-MenuState
    })
    $contextMenu.Items.Add($stopItem) | Out-Null

    # Restart/Refresh process (for picking up code changes)
    $restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $restartItem.Text = "Refresh Server"
    $restartItem.Add_Click({
        $restartItem.Enabled = $false
        $notifyIcon.ShowBalloonTip(1000, $script:NotifyTitle, "Restarting server...", [System.Windows.Forms.ToolTipIcon]::None)
        $result = Restart-CNMServer
        switch ($result) {
            "restarted" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server refreshed", [System.Windows.Forms.ToolTipIcon]::None)
            }
            "started" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server started", [System.Windows.Forms.ToolTipIcon]::None)
            }
            "failed" {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Failed to restart server", [System.Windows.Forms.ToolTipIcon]::Error)
            }
        }
        Update-MenuState
    })
    $contextMenu.Items.Add($restartItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Start CNM Dev Session
    $cnmDevItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $cnmDevItem.Text = "Start CNM Dev Session"
    $cnmDevItem.Add_Click({
        $cnmDir = $script:serverDir
        $attachScript = Join-Path $cnmDir "server\attach.js"

        if (Test-Path $attachScript) {
            # Start a new terminal with the CNM session attached
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = "cmd.exe"
            $psi.Arguments = "/k title Claude: CNM && cd /d `"$cnmDir`" && node `"$attachScript`" cnm claude"
            $psi.WorkingDirectory = $cnmDir
            $psi.UseShellExecute = $true
            [System.Diagnostics.Process]::Start($psi) | Out-Null
            $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Dev session started", [System.Windows.Forms.ToolTipIcon]::None)
        } else {
            [System.Windows.Forms.MessageBox]::Show("attach.js not found at: $attachScript", $script:NotifyTitle)
        }
    })
    $contextMenu.Items.Add($cnmDevItem) | Out-Null

    # Open in browser
    $browserItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $browserItem.Text = "Open Web UI"
    $browserItem.Add_Click({
        Start-Process "https://walterfam.xyz/cnm"
    })
    $contextMenu.Items.Add($browserItem) | Out-Null

    # Open log file
    $logItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $logItem.Text = "View Log"
    $logItem.Add_Click({
        if (Test-Path $script:logFile) {
            Start-Process notepad.exe -ArgumentList $script:logFile
        } else {
            [System.Windows.Forms.MessageBox]::Show("No log file found", $script:NotifyTitle)
        }
    })
    $contextMenu.Items.Add($logItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Keep Awake toggle
    $keepAwakeItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $keepAwakeItem.Text = "Keep System Awake"
    $keepAwakeItem.Checked = $script:keepAwakeEnabled
    $keepAwakeItem.CheckOnClick = $true
    $keepAwakeItem.Add_Click({
        $script:keepAwakeEnabled = $keepAwakeItem.Checked
        Update-KeepAwake
        if ($script:keepAwakeEnabled) {
            $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "System will stay awake", [System.Windows.Forms.ToolTipIcon]::None)
        } else {
            $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "System sleep enabled", [System.Windows.Forms.ToolTipIcon]::None)
        }
        Update-TrayStatus $notifyIcon
    })
    $contextMenu.Items.Add($keepAwakeItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Restart Tray
    $restartTrayItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $restartTrayItem.Text = "Restart Tray App"
    $restartTrayItem.Add_Click({
        # Stop server first
        $stopped = Stop-CNMServer

        # Re-enable system sleep
        [PowerKeepAwake]::AllowSleep()

        # Launch new instance via VBS (truly hidden, with -Silent flag)
        $vbsPath = Join-Path $PSScriptRoot "CNM-Tray.vbs"
        if (Test-Path $vbsPath) {
            Start-Process "wscript.exe" -ArgumentList "`"$vbsPath`"" -WorkingDirectory $PSScriptRoot
        } else {
            # Fallback to direct PowerShell launch (with -Silent to prevent popup)
            $ps1Path = Join-Path $PSScriptRoot "CNM-Tray.ps1"
            Start-Process "powershell.exe" -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1Path`" -Silent" -WindowStyle Hidden
        }

        # Exit current instance
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    })
    $contextMenu.Items.Add($restartTrayItem) | Out-Null

    # Exit
    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $exitItem.Text = "Exit"
    $exitItem.Add_Click({
        # Re-enable system sleep on exit
        [PowerKeepAwake]::AllowSleep()
        $notifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    })
    $contextMenu.Items.Add($exitItem) | Out-Null

    $notifyIcon.ContextMenuStrip = $contextMenu

    # Single click to show context menu (with start/stop options)
    $notifyIcon.Add_Click({
        param($sender, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            # Show context menu at cursor position
            $contextMenu.Show([System.Windows.Forms.Cursor]::Position)
        }
    })

    # Double-click to open browser
    $notifyIcon.Add_DoubleClick({
        Start-Process "https://walterfam.xyz/cnm"
    })

    # Update menu state function
    $script:UpdateMenuState = {
        $status = Get-ServerStatus

        if ($status.Running) {
            if ($status.Owned) {
                $statusItem.Text = "Status: Running (PID $($status.ProcessId))"
            } else {
                $statusItem.Text = "Status: External (PID $($status.ProcessId))"
            }
            $startItem.Enabled = $false
            $startItem.Text = "Start Server"
            $stopItem.Enabled = $true
            $restartItem.Enabled = $true
        } else {
            $statusItem.Text = "Status: Stopped"
            $startItem.Enabled = $true
            $startItem.Text = "Start Server"
            $stopItem.Enabled = $false
            $restartItem.Enabled = $true  # Can still use to start
        }

        Update-TrayStatus $notifyIcon
    }

    function Update-MenuState { & $script:UpdateMenuState }

    # Timer to check status periodically and auto-restart server
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 5000  # 5 seconds
    $timer.Add_Tick({
        $running = Test-ServerRunning

        # Auto-restart server if it's not running
        if (-not $running -and $script:autoRestartServer) {
            # Server should always be running - restart it
            $result = Start-CNMServer
            if ($result -eq "started") {
                $notifyIcon.ShowBalloonTip(2000, $script:NotifyTitle, "Server auto-restarted", [System.Windows.Forms.ToolTipIcon]::None)
            }
        }

        Update-MenuState
        Update-KeepAwake
    })
    $timer.Start()

    # Auto-start server on launch
    Write-Host "Starting CNM..."
    $result = Start-CNMServer
    switch ($result) {
        "started" {
            $notifyIcon.ShowBalloonTip(3000, $script:NotifyTitle, "Server started on port 3001", [System.Windows.Forms.ToolTipIcon]::None)
        }
        "adopted" {
            $notifyIcon.ShowBalloonTip(3000, $script:NotifyTitle, "Connected to existing server", [System.Windows.Forms.ToolTipIcon]::None)
        }
        "already_running" {
            $notifyIcon.ShowBalloonTip(3000, $script:NotifyTitle, "Server already running", [System.Windows.Forms.ToolTipIcon]::None)
        }
        "failed" {
            $notifyIcon.ShowBalloonTip(3000, $script:NotifyTitle, "Failed to start server", [System.Windows.Forms.ToolTipIcon]::Error)
        }
    }

    Update-MenuState
    Update-KeepAwake  # Start keep-awake if server is running

    # Run message loop
    [System.Windows.Forms.Application]::Run()

    # Cleanup
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Dispose()
    # Ensure system sleep is re-enabled
    [PowerKeepAwake]::AllowSleep()
}

# Run the app
try {
    Start-TrayApp
} finally {
    # Release mutex on exit
    if ($mutex) {
        $mutex.ReleaseMutex()
        $mutex.Dispose()
    }
}
