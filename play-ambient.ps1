Add-Type -AssemblyName presentationCore
$mediaPlayer = New-Object System.Windows.Media.MediaPlayer

# Tantal (Night) from Xenoblade Chronicles 2
$audioUrl = "https://vgmtreasurechest.com/soundtracks/xenoblade-chronicles-2-original-soundtrack-type-c/eoizviae/4-08%20Tantal%20%28Night%29.mp3"

$mediaPlayer.Open([System.Uri]::new($audioUrl))
$mediaPlayer.Volume = 0.25

# Event handler to loop when media ends
Register-ObjectEvent -InputObject $mediaPlayer -EventName MediaEnded -Action {
    $event.Sender.Position = [TimeSpan]::Zero
    $event.Sender.Play()
} | Out-Null

$mediaPlayer.Play()
Write-Host "Playing Tantal (Night) - Xenoblade Chronicles 2"
Write-Host "Volume: 25% | Looping enabled"
Write-Host "Press Ctrl+C to stop..."

# Keep the script running
while ($true) {
    Start-Sleep -Seconds 60
}
