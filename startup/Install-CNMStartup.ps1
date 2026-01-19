# CNM Startup Task Installer
# Installs/uninstalls the CNM system tray application as a Windows startup task

param(
    [switch]$Uninstall,
    [switch]$Force
)

$TaskName = "CNM-Server-Tray"
$TaskDescription = "Celio's Network Machine - Ruby & Sapphire Link Server (System Tray)"
$VbsPath = Join-Path $PSScriptRoot "CNM-Tray.vbs"
$ScriptPath = Join-Path $PSScriptRoot "CNM-Tray.ps1"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-CNMTask {
    # Check if task already exists
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        if (-not $Force) {
            Write-Host "Task '$TaskName' already exists. Use -Force to reinstall." -ForegroundColor Yellow
            return
        }
        Write-Host "Removing existing task..." -ForegroundColor Cyan
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }

    # Verify scripts exist
    if (-not (Test-Path $VbsPath)) {
        Write-Host "Error: CNM-Tray.vbs not found at: $VbsPath" -ForegroundColor Red
        return
    }
    if (-not (Test-Path $ScriptPath)) {
        Write-Host "Error: CNM-Tray.ps1 not found at: $ScriptPath" -ForegroundColor Red
        return
    }

    Write-Host ""
    Write-Host "  Installing CNM Startup Task" -ForegroundColor Cyan
    Write-Host "  ============================" -ForegroundColor Cyan
    Write-Host ""

    # Create the action - use VBS launcher for truly hidden startup (no window flash)
    $action = New-ScheduledTaskAction `
        -Execute "wscript.exe" `
        -Argument "`"$VbsPath`"" `
        -WorkingDirectory $PSScriptRoot

    # Trigger at system startup (runs before login, as current user)
    $trigger = New-ScheduledTaskTrigger -AtStartup

    # Settings - allow running on battery, don't stop if on battery
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Hours 0)  # No time limit

    # Principal - run as current user (required for AtStartup)
    $principal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType S4U `
        -RunLevel Limited

    # Register the task
    try {
        Register-ScheduledTask `
            -TaskName $TaskName `
            -Description $TaskDescription `
            -Action $action `
            -Trigger $trigger `
            -Settings $settings `
            -Principal $principal | Out-Null

        Write-Host "  [OK] Task '$TaskName' installed successfully!" -ForegroundColor Green
        Write-Host ""
        Write-Host "  The CNM server will start automatically at BOOT" -ForegroundColor White
        Write-Host "  (before login) and keep the system awake." -ForegroundColor White
        Write-Host ""
        Write-Host "  To start now: Right-click task in Task Scheduler > Run" -ForegroundColor Gray
        Write-Host "  Or run: .\CNM-Tray.ps1" -ForegroundColor Gray
        Write-Host ""
    } catch {
        Write-Host "  [ERROR] Failed to install task: $_" -ForegroundColor Red
    }
}

function Uninstall-CNMTask {
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $existingTask) {
        Write-Host "Task '$TaskName' not found." -ForegroundColor Yellow
        return
    }

    try {
        # Stop if running
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

        # Unregister
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false

        Write-Host ""
        Write-Host "  [OK] Task '$TaskName' removed successfully!" -ForegroundColor Green
        Write-Host ""
    } catch {
        Write-Host "  [ERROR] Failed to remove task: $_" -ForegroundColor Red
    }
}

# Main
Write-Host ""
Write-Host "  ================================================" -ForegroundColor Magenta
Write-Host "  CELIO'S NETWORK MACHINE - Startup Installer" -ForegroundColor Magenta
Write-Host "  Ruby & Sapphire System Tray Service" -ForegroundColor Magenta
Write-Host "  ================================================" -ForegroundColor Magenta
Write-Host ""

if ($Uninstall) {
    Uninstall-CNMTask
} else {
    Install-CNMTask
}
