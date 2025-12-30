@echo off
:: Quick launcher for melee-analysis-complete-TBD project
:: Double-click to start a monitored Claude session

title Claude Session: melee-complete

cd /d "C:\Users\mtoli\Documents\Code\melee-analysis-complete-TBD"

echo ===============================================
echo  Melee Analysis Complete (TBD) - Claude Session
echo ===============================================
echo  Session:   melee-complete
echo  Directory: C:\Users\mtoli\Documents\Code\melee-analysis-complete-TBD
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" melee-complete claude

pause
