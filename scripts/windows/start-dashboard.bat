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
cd /d "%APP%"
start "" "%APP%\node_modules\electron\dist\electron.exe" "%APP%" %*
