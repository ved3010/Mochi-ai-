@echo off
title Furry AI Cat Companion
cd /d "%~dp0"
set ELECTRON_ENABLE_LOGGING=true
echo ========================================================
echo    Starting Furry AI Cat Companion (Logs Enabled)...
echo ========================================================
call npx electron --enable-logging .
pause
