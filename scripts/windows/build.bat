@echo off
rem ---------------------------------------------------------------------------
rem Builds the native overlay (Release, hybrid RAG on) and runs the core tests.
rem   scripts\windows\build.bat              configure + build + core tests
rem   scripts\windows\build.bat --lean       no ONNX Runtime (BM25 only, energy VAD)
rem   scripts\windows\build.bat --no-pause   do not wait at the end (used by other scripts)
rem   scripts\windows\build.bat --skip-tests skip running core_tests.exe for fast dev loop
rem   set RTAI_VERSION=2.1.0-local.1         version baked into rtai_app.exe (default: dev)
rem Log: build\build.log. The first run downloads GoogleTest and ONNX Runtime.
rem Exit code 0 = build OK (test failures are reported but do not fail it).
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul
cd /d "%~dp0..\.."
set "PRESET=windows-release"
set "PAUSE_AT_END=1"
set "SKIP_TESTS="
if defined CI set "PAUSE_AT_END="
:args
if "%~1"=="" goto :args_done
if /I "%~1"=="--lean" set "PRESET=windows-lean"
if /I "%~1"=="--no-pause" set "PAUSE_AT_END="
if /I "%~1"=="--skip-tests" set "SKIP_TESTS=1"
shift
goto :args
:args_done

if not exist build mkdir build
set "LOG=%CD%\build\build.log"
echo RealTimeAI build (%PRESET%) %date% %time% > "%LOG%"
echo == RealTimeAI: building %PRESET% (a few minutes the first time) ==

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

rem Always pass the version: an empty value resets a previous packaged build to "dev".
echo [configure] >> "%LOG%"
cmake --preset %PRESET% "-DRTAI_VERSION_STRING=%RTAI_VERSION%" >> "%LOG%" 2>&1 || goto :failed
echo [build] >> "%LOG%"
cmake --build --preset %PRESET% >> "%LOG%" 2>&1 || goto :failed
if defined SKIP_TESTS (
    echo [tests] skipped (--skip-tests) >> "%LOG%"
    goto :after_tests
)
echo [tests] >> "%LOG%"
build\bin\Release\core_tests.exe --gtest_brief=1 >> "%LOG%" 2>&1
if errorlevel 1 (echo TESTS FAILED >> "%LOG%" & echo Tests FAILED, see build\build.log) else (echo TESTS PASSED >> "%LOG%")
:after_tests
echo BUILD OK >> "%LOG%"
for /f "delims=" %%v in ('build\bin\Release\rtai_app.exe --version') do echo Build OK: build\bin\Release\rtai_app.exe (%%v)
set "RC=0"
goto :end

:failed
echo BUILD FAILED >> "%LOG%"
echo Build FAILED. Details in build\build.log
set "RC=1"

:end
if defined PAUSE_AT_END pause
endlocal & exit /b %RC%
