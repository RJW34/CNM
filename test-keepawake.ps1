# Test SetThreadExecutionState directly

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TestKeepAwake {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);

    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
}
"@

Write-Host "=== Keep-Awake Test ===" -ForegroundColor Cyan
Write-Host ""

# Check current power requests BEFORE
Write-Host "Power requests BEFORE:" -ForegroundColor Yellow
$before = powercfg /requests
$before | Select-String -Pattern "SYSTEM:" -Context 0,1

# Call SetThreadExecutionState
Write-Host ""
Write-Host "Calling SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)..." -ForegroundColor Green
$flags = [TestKeepAwake]::ES_CONTINUOUS -bor [TestKeepAwake]::ES_SYSTEM_REQUIRED
$result = [TestKeepAwake]::SetThreadExecutionState($flags)

Write-Host "Result: $result (0 = FAILED, non-zero = previous state)" -ForegroundColor $(if ($result -eq 0) { "Red" } else { "Green" })

if ($result -eq 0) {
    $error = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "Last Win32 Error: $error" -ForegroundColor Red
}

# Check power requests AFTER
Write-Host ""
Write-Host "Power requests AFTER:" -ForegroundColor Yellow
Start-Sleep -Seconds 1
powercfg /requests

Write-Host ""
Write-Host "Press Enter to clear the keep-awake and exit..."
Read-Host

# Clear the state
[TestKeepAwake]::SetThreadExecutionState([TestKeepAwake]::ES_CONTINUOUS) | Out-Null
Write-Host "Keep-awake cleared."
