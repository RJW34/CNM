@echo off
:: Quick launcher for ikneedatacalculatorAI project
:: Double-click to start a monitored Claude session

title Claude Session: datacalculator

cd /d "C:\Users\mtoli\Documents\Code\ikneedatacalculatorAI"

echo ===============================================
echo  ikneedatacalculatorAI - Claude Session
echo ===============================================
echo  Session:   datacalculator
echo  Directory: C:\Users\mtoli\Documents\Code\ikneedatacalculatorAI
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" datacalculator claude

pause
