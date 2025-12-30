@echo off
:: Quick launcher for pokemon info scraper project
:: Double-click to start a monitored Claude session

title Claude Session: pokemon-scraper

cd /d "C:\Users\mtoli\Documents\Code\pokemon info scraper"

echo ===============================================
echo  Pokemon Info Scraper - Claude Session
echo ===============================================
echo  Session:   pokemon-scraper
echo  Directory: C:\Users\mtoli\Documents\Code\pokemon info scraper
echo ===============================================
echo.
echo Starting Claude with relay wrapper...
echo.

node "C:\Users\mtoli\Documents\Code\iphone bridge\server\attach.js" pokemon-scraper claude

pause
