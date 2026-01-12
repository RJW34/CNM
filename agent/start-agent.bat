@echo off
:: CNM Agent Launcher
:: Starts the CNM agent on this machine

title CNM Agent - %COMPUTERNAME%

cd /d "%~dp0"

echo ===============================================
echo  CNM Agent - Celio's Network Machine
echo  Machine: %COMPUTERNAME%
echo ===============================================
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo Installing dependencies...
    npm install
    echo.
)

:: Start the agent
echo Starting agent...
echo.
node agent.js

pause
