@echo off
:: Attach a Claude session to the relay for remote monitoring
:: Usage: attach-session.bat <session-name> [working-directory]
::
:: Examples:
::   attach-session.bat myproject
::   attach-session.bat myproject "C:\Users\mtoli\Documents\Code\MyProject"

setlocal enabledelayedexpansion

set SESSION_NAME=%~1
set WORK_DIR=%~2

if "%SESSION_NAME%"=="" (
    echo ===============================================
    echo  Claude Session Attach
    echo ===============================================
    echo.
    echo Usage: attach-session.bat ^<session-name^> [working-directory]
    echo.
    echo Examples:
    echo   attach-session.bat myproject
    echo   attach-session.bat gboperator "C:\Path\To\Project"
    echo.
    echo Session name is required.
    echo ===============================================
    pause
    exit /b 1
)

if "%WORK_DIR%"=="" (
    set WORK_DIR=%CD%
)

title Claude Session: %SESSION_NAME%

cd /d "%WORK_DIR%"

echo ===============================================
echo  Attaching Claude Session
echo ===============================================
echo  Session:   %SESSION_NAME%
echo  Directory: %WORK_DIR%
echo ===============================================
echo.

node "%~dp0server\attach.js" %SESSION_NAME% claude

pause
