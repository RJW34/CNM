@echo off
:: Quick launcher for rippi project
:: Double-click to start a monitored Claude session

title Claude Session: rippi

cd /d "C:\Users\mtoli\Documents\Code\rippi"

echo ===============================================
echo  Rippi - Claude Session
echo ===============================================
echo  Session:   rippi
echo  Directory: C:\Users\mtoli\Documents\Code\rippi
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" rippi claude

pause
