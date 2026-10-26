@echo off
rem ---------------------------------------------------------------------------
rem RealTimeAI LIVE: microphone (You) + system audio (Others) -> Deepgram ->
rem LLM suggestions on the HUD. Sessions go to %LOCALAPPDATA%\RealTimeAI\sessions.
rem Keys and options: %LOCALAPPDATA%\RealTimeAI\config.ini (rtai_app.exe --config
rem or Ctrl+Alt+O). Without the Deepgram key the app opens the config and exits.
rem Use headphones so the microphone does not pick up the other side.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."
set "EXE=build\bin\Release\rtai_app.exe"
if not exist "%EXE%" (
    echo [ERROR] %EXE% not found. Build it first: scripts\windows\build.bat
    goto :end
)
echo == RealTimeAI live ==
echo You = microphone, Others = system audio.
echo Ctrl+Alt+Enter answers, Ctrl+Alt+S screen, Ctrl+Alt+K chat, Ctrl+Alt+Q quits and saves.
echo.
"%EXE%" %*
:end
echo.
pause
endlocal
