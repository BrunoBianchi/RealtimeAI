@echo off
rem ---------------------------------------------------------------------------
rem INSTALLER: builds everything and creates dist\RealTimeAI-Setup-<version>.exe,
rem the same one-click installer the releases ship (Start menu shortcut,
rem uninstaller, auto-update).
rem   scripts\windows\package.bat                 version 2.1.0-local.<date-time>
rem   scripts\windows\package.bat 2.1.0-beta.2    any explicit semver
rem A local version sorts below the next release, so an installed local build
rem updates itself to the real version when it ships.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."

where node >nul 2>&1 || (echo Install Node.js 22 LTS: https://nodejs.org & goto :failed)
if not exist "apps\dashboard\node_modules\electron-builder" (
    echo == Installing dependencies (first run only) ==
    call npm ci --no-audit --no-fund || goto :failed
    call npm --prefix apps\dashboard ci --no-audit --no-fund || goto :failed
)

set "VERSION=%~1"
if not defined VERSION for /f "delims=" %%v in ('node scripts\version.mjs --local') do set "VERSION=%%v"
if not defined VERSION goto :failed
for /f "delims=" %%c in ('git rev-parse --short HEAD 2^>nul') do set "COMMIT=%%c"
echo == RealTimeAI installer %VERSION% ==

echo [1/3] Native overlay...
set "RTAI_VERSION=%VERSION%"
call "%~dp0build.bat" --no-pause || goto :failed

echo [2/3] Staging the overlay into the app...
set "NATIVE=apps\dashboard\native"
if exist "%NATIVE%" rmdir /s /q "%NATIVE%"
mkdir "%NATIVE%"
copy /Y build\bin\Release\rtai_app.exe "%NATIVE%\" >nul || goto :failed
if exist build\bin\Release\onnxruntime.dll copy /Y build\bin\Release\onnxruntime.dll "%NATIVE%\" >nul
> apps\dashboard\build-info.json echo {"version":"%VERSION%","channel":"local","commit":"%COMMIT%","flagsUrl":"https://raw.githubusercontent.com/BrunoBianchi/RealtimeAI/main/apps/dashboard/flags.json"}
node scripts\version.mjs notes --version %VERSION% > apps\dashboard\assets\release-notes.md

echo [3/3] Installer (electron-builder)...
pushd apps\dashboard
call npm run -s build:css || (popd & goto :failed)
call npx electron-builder --win nsis --x64 --publish never -c.extraMetadata.version=%VERSION% || (popd & goto :failed)
popd

if not exist dist mkdir dist
copy /Y "apps\dashboard\release\RealTimeAI-Setup-%VERSION%.exe" dist\ >nul || goto :failed
echo.
echo Installer ready: dist\RealTimeAI-Setup-%VERSION%.exe
explorer /select,"%CD%\dist\RealTimeAI-Setup-%VERSION%.exe"
goto :end

:failed
echo Packaging FAILED. See the messages above (native build log: build\build.log).
:end
pause
endlocal
