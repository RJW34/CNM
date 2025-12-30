@echo off
:: Quick launcher for windowsoptimizerabso project
:: Double-click to start a monitored Claude session

title Claude Session: winoptimizer

cd /d "C:\Users\mtoli\Documents\Code\windowsoptimizerabso"

echo ===============================================
echo  Windows Optimizer - Claude Session
echo ===============================================
echo  Session:   winoptimizer
echo  Directory: C:\Users\mtoli\Documents\Code\windowsoptimizerabso
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" winoptimizer claude

pause
