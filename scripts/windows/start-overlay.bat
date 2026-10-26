@echo off
rem Starts the overlay HUD directly (without the dashboard). Extra arguments
rem are passed through, e.g. --demo or --console.
chcp 65001 >nul
set "EXE=%~dp0..\..\build\bin\Release\rtai_app.exe"
if not exist "%EXE%" (
    echo Overlay not built yet. Run scripts\windows\build.bat first.
    pause
    exit /b 1
)
cd /d "%~dp0..\..\build\bin\Release"
start "" "%EXE%" --no-launcher %*
