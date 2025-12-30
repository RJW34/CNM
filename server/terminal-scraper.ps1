# Terminal Scraper using UI Automation
# Reads content from Windows Terminal and outputs to named pipe

param(
    [Parameter(Mandatory=$false)]
    [int]$TerminalPID = 0,
    [Parameter(Mandatory=$false)]
    [string]$PipeName = "claude-terminal-scraper"
)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

# Find Windows Terminal process
if ($TerminalPID -eq 0) {
    $terminal = Get-Process WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($terminal) {
        $TerminalPID = $terminal.Id
    } else {
        Write-Error "No Windows Terminal process found"
        exit 1
    }
}

Write-Host "Attaching to Windows Terminal PID: $TerminalPID"

# Get the automation element for the terminal window
$process = Get-Process -Id $TerminalPID
$hwnd = $process.MainWindowHandle

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Error "Could not find window handle"
    exit 1
}

# Use UI Automation to find the terminal content
$automation = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

# Find the text pattern or value pattern
function Get-TerminalText {
    param($element)

    try {
        # Try to get text from the terminal control
        $textPattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        if ($textPattern) {
            return $textPattern.DocumentRange.GetText(-1)
        }
    } catch {}

    try {
        # Try value pattern
        $valuePattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($valuePattern) {
            return $valuePattern.Current.Value
        }
    } catch {}

    # Try to find child elements with text
    $condition = [System.Windows.Automation.Condition]::TrueCondition
    $children = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)

    $text = ""
    foreach ($child in $children) {
        try {
            $name = $child.Current.Name
            if ($name) {
                $text += $name + "`n"
            }
        } catch {}
    }

    return $text
}

# Create named pipe server
$pipePath = "\\.\pipe\$PipeName"
Write-Host "Creating pipe: $pipePath"

# Continuous scraping loop
$lastText = ""
$pollInterval = 500  # ms

Write-Host "Starting terminal scraping... Press Ctrl+C to stop"
Write-Host "Output will be written to: $pipePath"

while ($true) {
    try {
        $currentText = Get-TerminalText -element $automation

        if ($currentText -ne $lastText) {
            # Text changed, output the difference
            $newContent = $currentText
            if ($lastText -and $currentText.StartsWith($lastText)) {
                $newContent = $currentText.Substring($lastText.Length)
            }

            if ($newContent) {
                Write-Host $newContent -NoNewline
            }

            $lastText = $currentText
        }

        Start-Sleep -Milliseconds $pollInterval
    } catch {
        Write-Error "Error: $_"
        Start-Sleep -Seconds 1
    }
}
