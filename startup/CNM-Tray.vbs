' CNM Tray - Silent Launcher
' Launches CNM-Tray.ps1 completely hidden (no window flash)
' Uses -Silent flag to prevent "already running" popups from scheduled task

Set objShell = CreateObject("WScript.Shell")
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
strCommand = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & strPath & "\CNM-Tray.ps1"" -Silent"

' Run with window style 0 (completely hidden)
' -Silent ensures no popup if another instance is already running
objShell.Run strCommand, 0, False
