@echo off
:: Quick launcher for GBOperatorHelper project
:: Double-click to start a monitored Claude session

title Claude Session: gboperator

cd /d "C:\Users\mtoli\Documents\Code\GBOperatorHelper"

echo ===============================================
echo  GBOperatorHelper - Claude Session
echo ===============================================
echo  Session:   gboperator
echo  Directory: C:\Users\mtoli\Documents\Code\GBOperatorHelper
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" gboperator claude

pause
