@echo off
REM ---------------------------------------------------------------------------
REM Roda o RealTimeAI AO VIVO: microfone (Voce) + audio do sistema (Outros)
REM -> Deepgram -> sugestoes do LLM no overlay. Grava a sessao em
REM %LOCALAPPDATA%\RealTimeAI\sessions.
REM
REM Chaves e opcoes em %LOCALAPPDATA%\RealTimeAI\config.ini (rtai_app.exe --config
REM ou Ctrl+Alt+O). Sem a chave do Deepgram o app abre o config e sai.
REM Use fone de ouvido para o microfone nao captar os outros.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"
chcp 65001 >nul

set "EXE=build\bin\Release\rtai_app.exe"
if not exist "%EXE%" (
    echo [ERRO] Nao encontrei %EXE%
    echo         Compile primeiro ^(veja o README: cmake --build build --config Release^).
    goto :end
)

echo == RealTimeAI ao vivo ==
echo Voce = microfone, Outros = audio do sistema.
echo Ctrl+Alt+Enter responde, Ctrl+Alt+S tela, Ctrl+Alt+K chat, Ctrl+Alt+Q encerra e salva.
echo.
"%EXE%" %*

:end
echo.
pause
endlocal
