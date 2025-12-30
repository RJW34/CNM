@echo off
:: Quick launcher for CNM (Celio's Network Machine) project
:: Double-click to start a monitored Claude session for CNM development

title Claude Session: cnm

cd /d "C:\Users\mtoli\Documents\Code\iphone bridge"

echo ===============================================
echo  Celio's Network Machine - Claude Session
echo ===============================================
echo  Session:   cnm
echo  Directory: C:\Users\mtoli\Documents\Code\iphone bridge
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" cnm claude

pause
