# Find running terminal processes
$processes = Get-Process | Where-Object {
    $_.ProcessName -match 'claude|WindowsTerminal|conhost|cmd|powershell|pwsh'
} | Select-Object Id, ProcessName, MainWindowTitle

$processes | Format-Table -AutoSize

# Also show Windows Terminal tabs info
Write-Host "`nWindows Terminal Processes:"
Get-Process WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  PID: $($_.Id) - $($_.MainWindowTitle)"
}

Write-Host "`nClaude Processes:"
Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  PID: $($_.Id)"
}
