@echo off
rem ---------------------------------------------------------------------------
rem RealTimeAI DEMO: no microphone, no network, no keys. Opens the HUD with a
rem scripted conversation on both sides and saves the session.
rem   scripts\windows\run-demo.bat             HUD (this window shows the log)
rem   scripts\windows\run-demo.bat --console   no HUD, output in the console
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."
set "EXE=build\bin\Release\rtai_app.exe"
if not exist "%EXE%" (
    echo [ERROR] %EXE% not found. Build it first: scripts\windows\build.bat
    goto :end
)
echo == RealTimeAI demo ==
echo Ctrl+Alt+Enter answers, Ctrl+Alt+S screen, Ctrl+Alt+K chat, Ctrl+Alt+Q quits and saves.
echo.
"%EXE%" --demo %*
:end
echo.
pause
endlocal
