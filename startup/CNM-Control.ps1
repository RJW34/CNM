# CNM-Control.ps1
# Control script for external tools (like ABSO) to manage CNM
# Usage:
#   .\CNM-Control.ps1 -Stop      # Stop all CNM components
#   .\CNM-Control.ps1 -Start     # Start CNM tray app
#   .\CNM-Control.ps1 -Status    # Check if CNM is running
#   .\CNM-Control.ps1 -Disable   # Stop + disable scheduled task
#   .\CNM-Control.ps1 -Enable    # Enable scheduled task + start

param(
    [switch]$Stop,
    [switch]$Start,
    [switch]$Status,
    [switch]$Disable,
    [switch]$Enable,
    [switch]$Quiet
)

$TaskName = "CNM-Server-Tray"
$MutexName = "Global\CNM_Tray_SingleInstance"
$ServerPort = 3001

function Write-Info {
    param($Message)
    if (-not $Quiet) {
        Write-Host $Message
    }
}

function Write-Success {
    param($Message)
    if (-not $Quiet) {
        Write-Host $Message -ForegroundColor Green
    }
}

function Write-Warn {
    param($Message)
    if (-not $Quiet) {
        Write-Host $Message -ForegroundColor Yellow
    }
}

# Check if CNM server is running (listening on port 3001)
function Test-CNMServerRunning {
    try {
        $connections = @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue)
        return $connections.Count -gt 0
    } catch {
        return $false
    }
}

# Get CNM server process ID
function Get-CNMServerPID {
    try {
        $connections = @(Get-NetTCPConnection -LocalPort $ServerPort -State Listen -ErrorAction SilentlyContinue)
        if ($connections.Count -gt 0) {
            return $connections[0].OwningProcess
        }
    } catch {}
    return $null
}

# Check if CNM tray app is running (has mutex)
function Test-CNMTrayRunning {
    try {
        $mutex = [System.Threading.Mutex]::OpenExisting($MutexName)
        $mutex.Close()
        return $true
    } catch {
        return $false
    }
}

# Get tray app process (PowerShell running CNM-Tray.ps1)
function Get-CNMTrayProcess {
    Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like "*CNM-Tray.ps1*" }
}

# Stop the CNM server process
function Stop-CNMServer {
    $serverPid = Get-CNMServerPID
    if ($serverPid) {
        try {
            Stop-Process -Id $serverPid -Force -ErrorAction Stop
            Write-Success "[OK] Stopped CNM server (PID $serverPid)"
            return $true
        } catch {
            Write-Warn "[WARN] Failed to stop server: $_"
            return $false
        }
    }
    return $true
}

# Stop the CNM tray application
function Stop-CNMTray {
    $trayProc = Get-CNMTrayProcess
    if ($trayProc) {
        try {
            Stop-Process -Id $trayProc.ProcessId -Force -ErrorAction Stop
            Write-Success "[OK] Stopped CNM tray (PID $($trayProc.ProcessId))"
            return $true
        } catch {
            Write-Warn "[WARN] Failed to stop tray: $_"
            return $false
        }
    }
    return $true
}

# Disable the scheduled task
function Disable-CNMTask {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Disable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
            Write-Success "[OK] Disabled scheduled task '$TaskName'"
            return $true
        }
        return $true  # Task doesn't exist, that's fine
    } catch {
        Write-Warn "[WARN] Failed to disable task: $_"
        return $false
    }
}

# Enable the scheduled task
function Enable-CNMTask {
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            Enable-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Out-Null
            Write-Success "[OK] Enabled scheduled task '$TaskName'"
            return $true
        }
        Write-Warn "[WARN] Task '$TaskName' not found"
        return $false
    } catch {
        Write-Warn "[WARN] Failed to enable task: $_"
        return $false
    }
}

# Start CNM tray app
function Start-CNMTray {
    $vbsPath = Join-Path $PSScriptRoot "CNM-Tray.vbs"
    if (Test-Path $vbsPath) {
        Start-Process "wscript.exe" -ArgumentList "`"$vbsPath`"" -WorkingDirectory $PSScriptRoot
        Write-Success "[OK] Started CNM tray app"
        return $true
    } else {
        Write-Warn "[WARN] CNM-Tray.vbs not found"
        return $false
    }
}

# Get status as a structured object
function Get-CNMStatus {
    $serverRunning = Test-CNMServerRunning
    $serverPID = Get-CNMServerPID
    $trayRunning = Test-CNMTrayRunning
    $trayProc = Get-CNMTrayProcess

    $taskEnabled = $false
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($task) {
            $taskEnabled = ($task.State -ne 'Disabled')
        }
    } catch {}

    return @{
        ServerRunning = $serverRunning
        ServerPID = $serverPID
        TrayRunning = $trayRunning
        TrayPID = if ($trayProc) { $trayProc.ProcessId } else { $null }
        TaskEnabled = $taskEnabled
        IsActive = $serverRunning -or $trayRunning
    }
}

# Main logic
if ($Status) {
    $cnmState = Get-CNMStatus

    Write-Info ""
    Write-Info "CNM Status"
    Write-Info "==========="

    if ($cnmState.ServerRunning) {
        Write-Success "Server: Running (PID $($cnmState.ServerPID))"
    } else {
        Write-Info "Server: Stopped"
    }

    if ($cnmState.TrayRunning) {
        Write-Success "Tray:   Running (PID $($cnmState.TrayPID))"
    } else {
        Write-Info "Tray:   Stopped"
    }

    if ($cnmState.TaskEnabled) {
        Write-Success "Task:   Enabled"
    } else {
        Write-Warn "Task:   Disabled"
    }
    Write-Info ""

    # Return exit code based on whether CNM is active
    exit $(if ($cnmState.IsActive) { 0 } else { 1 })
}

if ($Stop -or $Disable) {
    Write-Info ""
    Write-Info "Stopping CNM..."
    Write-Info ""

    # Stop server first
    Stop-CNMServer

    # Stop tray app
    Stop-CNMTray

    # Wait for processes to terminate
    Start-Sleep -Milliseconds 500

    # If disable mode, also disable scheduled task
    if ($Disable) {
        Disable-CNMTask
    }

    Write-Info ""
    Write-Success "CNM stopped."
    Write-Info ""
    exit 0
}

if ($Start -or $Enable) {
    Write-Info ""
    Write-Info "Starting CNM..."
    Write-Info ""

    # If enable mode, first enable the scheduled task
    if ($Enable) {
        Enable-CNMTask
    }

    # Start tray app (which auto-starts the server)
    if (-not (Test-CNMTrayRunning)) {
        Start-CNMTray
        Start-Sleep -Seconds 2  # Give it time to start
    } else {
        Write-Info "Tray already running"
    }

    Write-Info ""
    Write-Success "CNM started."
    Write-Info ""
    exit 0
}

# Default: show usage
Write-Host ""
Write-Host "CNM-Control.ps1 - External control for Celio's Network Machine"
Write-Host ""
Write-Host "Usage:"
Write-Host "  -Stop      Stop CNM server and tray app"
Write-Host "  -Start     Start CNM tray app (auto-starts server)"
Write-Host "  -Status    Check CNM running status"
Write-Host "  -Disable   Stop CNM and disable startup task"
Write-Host "  -Enable    Enable startup task and start CNM"
Write-Host "  -Quiet     Suppress output (for scripting)"
Write-Host ""
Write-Host "Exit codes:"
Write-Host "  0 = Success / CNM is running (for -Status)"
Write-Host "  1 = Failure / CNM is stopped (for -Status)"
Write-Host ""
