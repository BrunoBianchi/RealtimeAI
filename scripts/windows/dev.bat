@echo off
rem ---------------------------------------------------------------------------
rem TEST VERSION: rebuilds the overlay from the current code and opens the
rem dashboard from source, so every run tests exactly what is in this folder.
rem   scripts\windows\dev.bat           build (incremental, fast after the first) + open
rem   scripts\windows\dev.bat --skip    open without rebuilding
rem Dev runs never auto-update and show the version as X.Y.Z+dev.<commit>.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0..\.."

if not exist "apps\dashboard\node_modules\electron\dist\electron.exe" (
    echo == Installing dependencies (first run only) ==
    call npm ci --no-audit --no-fund || goto :failed
    call npm --prefix apps\dashboard ci --no-audit --no-fund || goto :failed
)

if /I not "%~1"=="--skip" (
    set "RTAI_VERSION="
    call "%~dp0build.bat" --no-pause --skip-tests || (
        if not exist "build\bin\Release\rtai_app.exe" goto :failed
        echo [WARN] Incremental native build skipped; using existing rtai_app.exe.
    )
)
if not exist "build\bin\Release\rtai_app.exe" (
    echo [ERROR] The overlay is not built yet. Run without --skip.
    goto :failed
)

echo == Opening the dashboard (test version) ==
call npm --prefix apps\dashboard run -s build:css
call "%~dp0start-dashboard.bat"
goto :end

:failed
echo Failed. See the messages above.
pause
:end
endlocal
