@echo off
:: Quick launcher for walterfamwebsite project
:: Double-click to start a monitored Claude session

title Claude Session: walterfam

cd /d "C:\Users\mtoli\Documents\Code\walterfamwebsite"

echo ===============================================
echo  Walter Fam Website - Claude Session
echo ===============================================
echo  Session:   walterfam
echo  Directory: C:\Users\mtoli\Documents\Code\walterfamwebsite
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" walterfam claude

pause
