# Explore Claude Code's data and running processes
Write-Host "=== Running Claude Processes ===" -ForegroundColor Cyan
Get-Process | Where-Object { $_.ProcessName -like "*claude*" } | Format-Table Id, ProcessName, Path -AutoSize

Write-Host "`n=== Claude Data Directory ===" -ForegroundColor Cyan
$claudeDir = Join-Path $env:USERPROFILE ".claude"
if (Test-Path $claudeDir) {
    Get-ChildItem -Path $claudeDir -Recurse -Force -ErrorAction SilentlyContinue |
        Select-Object -First 50 FullName
} else {
    Write-Host "Directory not found: $claudeDir"
}

Write-Host "`n=== Recent Session Files ===" -ForegroundColor Cyan
$projectsDir = Join-Path $claudeDir "projects"
if (Test-Path $projectsDir) {
    Get-ChildItem -Path $projectsDir -Recurse -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 10 FullName, LastWriteTime
}
