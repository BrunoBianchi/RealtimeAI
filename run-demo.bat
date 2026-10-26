@echo off
REM ---------------------------------------------------------------------------
REM Roda o RealTimeAI em modo DEMO (sem microfone, sem rede, sem chaves).
REM Abre o HUD com uma conversa roteirizada dos dois lados e grava a sessao.
REM
REM Uso:
REM   run-demo.bat             -> HUD (esta janela mostra o log)
REM   run-demo.bat --console   -> sem HUD, saida no console
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

echo == RealTimeAI demo ==
echo Atalhos: Ctrl+Alt+Enter responde, Ctrl+Alt+S tela, Ctrl+Alt+K chat, Ctrl+Alt+Q encerra e salva.
echo.
"%EXE%" --demo %*

:end
echo.
pause
endlocal
