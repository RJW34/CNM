@echo off
:: Quick launcher for All Projects- Production Build Pool
:: Double-click to start a monitored Claude session

title Claude Session: production-pool

cd /d "C:\Users\mtoli\Documents\Code\All Projects- Production Build Pool"

echo ===============================================
echo  Production Build Pool - Claude Session
echo ===============================================
echo  Session:   production-pool
echo  Directory: C:\Users\mtoli\Documents\Code\All Projects- Production Build Pool
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" production-pool claude

pause
