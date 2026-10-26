@echo off
rem ---------------------------------------------------------------------------
rem Builds the native overlay (Release, hybrid RAG on) and runs the core tests.
rem   scripts\windows\build.bat          configure + build + core tests
rem   scripts\windows\build.bat --lean   no ONNX Runtime (BM25 only, energy VAD)
rem Log: build\build.log. The first run downloads GoogleTest and ONNX Runtime.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."
set "PRESET=windows-release"
if /I "%~1"=="--lean" set "PRESET=windows-lean"
if not exist build mkdir build
set "LOG=%CD%\build\build.log"
echo RealTimeAI build (%PRESET%) %date% %time% > "%LOG%"
echo == RealTimeAI: building %PRESET% (a few minutes) ==

rem The running overlay locks its .exe: close it first.
taskkill /F /T /IM rtai_overlay.exe /IM rtai_app.exe >nul 2>&1

rem Visual Studio developer environment (cl, link, cmake, ninja).
set "VS="
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2^>nul`) do set "VS=%%i"
if not defined VS (
    echo [ERROR] Visual Studio with "Desktop development with C++" was not found.
    goto :failed
)
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
where cmake >nul 2>&1 || set "PATH=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin;%PATH%"

echo [configure] >> "%LOG%"
cmake --preset %PRESET% >> "%LOG%" 2>&1 || goto :failed
echo [build] >> "%LOG%"
cmake --build --preset %PRESET% >> "%LOG%" 2>&1 || goto :failed
echo [tests] >> "%LOG%"
build\bin\Release\core_tests.exe --gtest_brief=1 >> "%LOG%" 2>&1
if errorlevel 1 (echo TESTS FAILED >> "%LOG%" & echo Tests FAILED, see build\build.log) else (echo TESTS PASSED >> "%LOG%")
echo BUILD OK >> "%LOG%"
echo Build OK: build\bin\Release\rtai_app.exe
goto :end

:failed
echo BUILD FAILED >> "%LOG%"
echo Build FAILED. Details in build\build.log

:end
if not defined CI timeout /t 8 >nul
endlocal
