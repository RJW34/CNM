@echo off
:: Quick launcher for pokemon-showdown-tags project
:: Double-click to start a monitored Claude session

title Claude Session: showdown-tags

cd /d "C:\Users\mtoli\Documents\Code\pokemon-showdown-tags"

echo ===============================================
echo  Pokemon Showdown Tags - Claude Session
echo ===============================================
echo  Session:   showdown-tags
echo  Directory: C:\Users\mtoli\Documents\Code\pokemon-showdown-tags
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" showdown-tags claude

pause
