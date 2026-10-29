@echo off
rem Starts the Electron dashboard from the source tree (no console window).
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
set "APP=%~dp0..\..\apps\dashboard"
if not exist "%APP%\node_modules\electron\dist\electron.exe" (
    echo Dashboard dependencies are missing. Run scripts\windows\setup-dev.bat first.
    pause
    exit /b 1
)
rem Close any stale tray/background dashboard instance so changes always load fresh.
taskkill /F /IM electron.exe /IM RealTimeAI.exe >nul 2>&1
cd /d "%APP%"
call npm run -s build:css >nul 2>&1
start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%" %*
