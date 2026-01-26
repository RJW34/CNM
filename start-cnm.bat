@echo off
:: Start Celio's Network Machine Server
title CNM Server - Celio's Network Machine

cd /d "%~dp0server"

echo ===============================================
echo  Celio's Network Machine
echo  Ruby ^& Sapphire Link Server
echo ===============================================
echo  Port: 3001
echo  URL:  https://walterfam.xyz/cnm
echo ===============================================
echo.

npm start
pause
