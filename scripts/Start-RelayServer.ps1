# Start-RelayServer.ps1
# PowerShell script to start the relay server with proper error handling

param(
    [switch]$Background,
    [int]$Port = 3000
)

$ServerPath = Join-Path $PSScriptRoot "..\server"
$IndexJs = Join-Path $ServerPath "index.js"

if (-not (Test-Path $IndexJs)) {
    Write-Error "Server not found at: $IndexJs"
    exit 1
}

Write-Host "=======================================" -ForegroundColor Cyan
Write-Host " Claude Code Relay Server" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Port: $Port"
Write-Host "  Path: $ServerPath"
Write-Host ""

Set-Location $ServerPath

if ($Background) {
    Write-Host "Starting in background..." -ForegroundColor Yellow
    Start-Process -FilePath "node" -ArgumentList "index.js" -WindowStyle Minimized
    Write-Host "Server started in background." -ForegroundColor Green
} else {
    Write-Host "Starting server (Ctrl+C to stop)..." -ForegroundColor Yellow
    Write-Host ""
    node index.js
}
