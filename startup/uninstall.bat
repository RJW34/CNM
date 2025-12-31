@echo off
:: CNM Startup Uninstaller
:: Double-click to remove CNM startup task

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "Install-CNMStartup.ps1" -Uninstall
pause
