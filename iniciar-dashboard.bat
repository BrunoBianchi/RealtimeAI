@echo off
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0apps\dashboard"
start "" "%~dp0apps\dashboard\node_modules\electron\dist\electron.exe" "%~dp0apps\dashboard" %*

