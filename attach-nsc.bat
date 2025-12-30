@echo off
:: Quick launcher for nsc project
:: Double-click to start a monitored Claude session

title Claude Session: nsc

cd /d "C:\Users\mtoli\Documents\Code\nsc"

echo ===============================================
echo  NSC - Claude Session
echo ===============================================
echo  Session:   nsc
echo  Directory: C:\Users\mtoli\Documents\Code\nsc
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" nsc claude

pause
