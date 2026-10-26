@echo off
chcp 65001 >nul
cd /d "%~dp0overlay"
start "" "%~dp0overlay\rtai_overlay.exe" --no-launcher %*

