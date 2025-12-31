@echo off
:: CNM Server - Background Launcher
:: Starts the relay server as a detached background process

cd /d "%~dp0server"

:: Check if already running
netstat -ano | findstr ":3001" >nul 2>&1
if %errorlevel%==0 (
    echo CNM Server is already running on port 3001
    exit /b 0
)

:: Start server in background (detached, no window)
start /b "" node index.js > "%~dp0server\server.log" 2>&1

:: Wait a moment for startup
timeout /t 2 /nobreak >nul

:: Verify it started
netstat -ano | findstr ":3001" >nul 2>&1
if %errorlevel%==0 (
    echo CNM Server started successfully in background
    echo Logs: %~dp0server\server.log
) else (
    echo Failed to start CNM Server - check server.log for errors
    exit /b 1
)
