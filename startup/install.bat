@echo off
:: CNM Startup Installer - Quick Install
:: Double-click to install CNM as a startup task

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "Install-CNMStartup.ps1"
pause
