@echo off
:: Quick launcher for melee analysis tool project
:: Double-click to start a monitored Claude session

title Claude Session: melee-analysis

cd /d "C:\Users\mtoli\Documents\Code\melee analysis tool"

echo ===============================================
echo  Melee Analysis Tool - Claude Session
echo ===============================================
echo  Session:   melee-analysis
echo  Directory: C:\Users\mtoli\Documents\Code\melee analysis tool
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" melee-analysis claude

pause
