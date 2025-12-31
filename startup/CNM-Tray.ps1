# CNM System Tray Application
# Celio's Network Machine - Ruby & Sapphire Link Server
# Lightweight startup with system tray icon

param(
    [switch]$Hidden
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:serverProcess = $null
$script:serverDir = Split-Path -Parent $PSScriptRoot
$script:logFile = Join-Path $script:serverDir "server\server.log"

# Create ruby + sapphire icon (red and blue gems)
function New-GemIcon {
    $bitmap = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Ruby (red gem) - left side
    $rubyBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 38, 38))
    $rubyHighlight = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(248, 113, 113))
    $rubyDark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(153, 27, 27))

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

    $g.Dispose()

    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    return $icon
}

# Check if server is running
function Test-ServerRunning {
    try {
        $connections = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
        return $connections.Count -gt 0
    } catch {
        return $false
    }
}

# Start the CNM server
function Start-CNMServer {
    if (Test-ServerRunning) {
        return $true
    }

    $nodeExe = "node"
    $indexJs = Join-Path $script:serverDir "server\index.js"

    if (-not (Test-Path $indexJs)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Server file not found: $indexJs",
            "Celio's Network Machine",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        )
        return $false
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

        # Wait a moment and verify it started
        Start-Sleep -Seconds 2
        return Test-ServerRunning
    } catch {
        return $false
    }
}

# Stop the CNM server
function Stop-CNMServer {
    # Find and kill node process on port 3001
    try {
        $connections = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -gt 0) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}

    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        $script:serverProcess.Kill()
    }
}

# Update tray icon tooltip
function Update-TrayStatus {
    param($notifyIcon)

    $running = Test-ServerRunning
    if ($running) {
        $notifyIcon.Text = "Celio's Network Machine - Process Running"
    } else {
        $notifyIcon.Text = "Celio's Network Machine - Process Stopped"
    }
}

# Main application
function Start-TrayApp {
    # Create notification icon
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = New-GemIcon
    $notifyIcon.Text = "Celio's Network Machine"
    $notifyIcon.BalloonTipTitle = "Celio's Network Machine"
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
    $startItem.Text = "Start Process"
    $startItem.Add_Click({
        $startItem.Enabled = $false
        if (Start-CNMServer) {
            $notifyIcon.ShowBalloonTip(2000, "Celio's Network Machine", "Link established on port 3001", [System.Windows.Forms.ToolTipIcon]::Info)
        } else {
            $notifyIcon.ShowBalloonTip(2000, "Celio's Network Machine", "Failed to establish link", [System.Windows.Forms.ToolTipIcon]::Error)
        }
        Update-MenuState
    })
    $contextMenu.Items.Add($startItem) | Out-Null

    # Stop process
    $stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $stopItem.Text = "Stop Process"
    $stopItem.Add_Click({
        Stop-CNMServer
        Start-Sleep -Milliseconds 500
        $notifyIcon.ShowBalloonTip(2000, "Celio's Network Machine", "Link disconnected", [System.Windows.Forms.ToolTipIcon]::Info)
        Update-MenuState
    })
    $contextMenu.Items.Add($stopItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

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
            [System.Windows.Forms.MessageBox]::Show("No log file found", "Celio's Network Machine")
        }
    })
    $contextMenu.Items.Add($logItem) | Out-Null

    $contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Exit
    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $exitItem.Text = "Exit"
    $exitItem.Add_Click({
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
        $running = Test-ServerRunning
        $statusItem.Text = if ($running) { "Status: Running" } else { "Status: Stopped" }
        $startItem.Enabled = -not $running
        $stopItem.Enabled = $running
        Update-TrayStatus $notifyIcon
    }

    function Update-MenuState { & $script:UpdateMenuState }

    # Timer to check status periodically
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 5000  # 5 seconds
    $timer.Add_Tick({ Update-MenuState })
    $timer.Start()

    # Auto-start server on launch
    Write-Host "Starting Celio's Network Machine..."
    if (Start-CNMServer) {
        $notifyIcon.ShowBalloonTip(3000, "Celio's Network Machine", "Ruby & Sapphire link established", [System.Windows.Forms.ToolTipIcon]::Info)
    } else {
        $notifyIcon.ShowBalloonTip(3000, "Celio's Network Machine", "Link may already exist or failed to establish", [System.Windows.Forms.ToolTipIcon]::Warning)
    }

    Update-MenuState

    # Run message loop
    [System.Windows.Forms.Application]::Run()

    # Cleanup
    $timer.Stop()
    $timer.Dispose()
    $notifyIcon.Dispose()
}

# Run the app
Start-TrayApp
