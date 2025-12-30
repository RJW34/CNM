# Attach-Session.ps1
# PowerShell script to attach a Claude session to the relay

param(
    [Parameter(Mandatory=$true)]
    [string]$SessionName,

    [string]$WorkingDirectory = (Get-Location).Path,

    [string]$Command = "claude"
)

$AttachScript = Join-Path $PSScriptRoot "..\server\attach.js"

if (-not (Test-Path $AttachScript)) {
    Write-Error "Attach script not found at: $AttachScript"
    exit 1
}

Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Attaching Claude Session" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Session:   $SessionName" -ForegroundColor White
Write-Host "  Directory: $WorkingDirectory" -ForegroundColor White
Write-Host "  Command:   $Command" -ForegroundColor White
Write-Host ""

Set-Location $WorkingDirectory

Write-Host "Starting Claude with relay wrapper..." -ForegroundColor Yellow
Write-Host ""

node $AttachScript $SessionName $Command
