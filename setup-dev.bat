@echo off
setlocal
cd /d "%~dp0"
echo == RealTimeAI: preparando o ambiente de desenvolvimento ==
where git >nul 2>&1 || (echo Instale o Git for Windows: https://git-scm.com/download/win & goto :end)
where npm >nul 2>&1 || (echo Instale o Node.js 22 LTS: https://nodejs.org & goto :end)
if not exist .git (
  git init -b main
)
echo [1/2] Dependencias da raiz (husky, commitlint)...
call npm install --no-audit --no-fund || goto :failed
echo [2/2] Dependencias do dashboard (electron, electron-updater, electron-builder)...
call npm --prefix dashboard install --no-audit --no-fund || goto :failed
echo.
echo Pronto. Hooks do git ativos (pre-commit, commit-msg, pre-push).
goto :end
:failed
echo Falhou. Veja as mensagens acima.
:end
pause
endlocal
