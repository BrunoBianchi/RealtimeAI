@echo off
rem Installs the Node tooling (git hooks, dashboard) for development.
setlocal
cd /d "%~dp0..\.."
echo == RealTimeAI: preparing the development environment ==
where git >nul 2>&1 || (echo Install Git for Windows: https://git-scm.com/download/win & goto :end)
where npm >nul 2>&1 || (echo Install Node.js 22 LTS: https://nodejs.org & goto :end)
echo [1/2] Root tooling (husky, commitlint)...
call npm ci --no-audit --no-fund || goto :failed
echo [2/2] Dashboard (electron, electron-updater, electron-builder)...
call npm --prefix apps\dashboard ci --no-audit --no-fund || goto :failed
echo.
echo Ready. Git hooks are active (pre-commit, commit-msg, pre-push).
echo Next: scripts\windows\build.bat, then scripts\windows\start-dashboard.bat
goto :end
:failed
echo Failed. See the messages above.
:end
pause
endlocal
