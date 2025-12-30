@echo off
:: Start relay server in background, then attach a session
:: Usage: start-all.bat <session-name> [working-directory]

setlocal enabledelayedexpansion

set SESSION_NAME=%~1
set WORK_DIR=%~2

if "%SESSION_NAME%"=="" (
    echo ===============================================
    echo  Claude Relay - Quick Start
    echo ===============================================
    echo.
    echo Usage: start-all.bat ^<session-name^> [working-directory]
    echo.
    echo This will:
    echo   1. Start the relay server ^(background^)
    echo   2. Attach Claude session with given name
    echo.
    echo Example:
    echo   start-all.bat gboperator "C:\Users\mtoli\Documents\Code\GBOperatorHelper"
    echo ===============================================
    pause
    exit /b 1
)

if "%WORK_DIR%"=="" (
    set WORK_DIR=%CD%
)

echo ===============================================
echo  Starting Claude Relay System
echo ===============================================
echo.

:: Start server in background
echo [1/2] Starting relay server...
start "Claude Relay Server" /min cmd /c "cd /d "%~dp0server" && node index.js"
timeout /t 2 /nobreak >nul

:: Attach session
echo [2/2] Attaching session: %SESSION_NAME%
echo.

cd /d "%WORK_DIR%"
node "%~dp0server\attach.js" %SESSION_NAME% claude

pause
