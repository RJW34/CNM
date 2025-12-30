@echo off
:: Start the Claude Code Relay Server
:: Run this once - it stays running in background

title Claude Relay Server

cd /d "%~dp0server"

echo ===============================================
echo  Claude Code Relay Server
echo ===============================================
echo.
echo Starting server on port 3001...
echo Access from iPhone: https://YOUR_IP:3001/?token=YOUR_TOKEN
echo (Token is configured in server\.env)
echo.
echo Press Ctrl+C to stop
echo ===============================================
echo.

node index.js

pause
