@echo off
:: CNM Tray - Manual Start
:: Run this to start the tray application manually

cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "CNM-Tray.ps1"
