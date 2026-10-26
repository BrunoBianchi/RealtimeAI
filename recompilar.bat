@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "LOG=%~dp0recompilar.log"
echo RealTimeAI rebuild %date% %time% > "%LOG%"
echo == RealTimeAI: rebuilding (a few minutes) ==
rem The running app locks its .exe: close it first.
taskkill /F /IM rtai_overlay.exe /T >nul 2>&1
taskkill /F /IM rtai_app.exe /T >nul 2>&1
set "VS=C:\Program Files\Microsoft Visual Studio\18\Community"
if not exist "%VS%\VC\Auxiliary\Build\vcvars64.bat" for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do set "VS=%%i"
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
set "CMAKE=%VS%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
rem Hybrid RAG: embeddings via ONNX Runtime (downloaded by CMake on the first run).
echo [configure] >> "%LOG%"
"%CMAKE%" -S . -B build -DRTAI_ENABLE_EMBEDDINGS=ON >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
echo [build] >> "%LOG%"
"%CMAKE%" --build build --config Release --parallel >> "%LOG%" 2>&1
if errorlevel 1 goto :failed
copy /Y build\bin\Release\rtai_app.exe overlay\rtai_app.exe >> "%LOG%" 2>&1
copy /Y build\bin\Release\rtai_app.exe overlay\rtai_overlay.exe >> "%LOG%" 2>&1
if exist build\bin\Release\onnxruntime.dll copy /Y build\bin\Release\onnxruntime.dll overlay\onnxruntime.dll >> "%LOG%" 2>&1
echo [tests] >> "%LOG%"
build\bin\Release\core_tests.exe --gtest_brief=1 >> "%LOG%" 2>&1
if errorlevel 1 (echo TESTS FAILED >> "%LOG%") else (echo TESTS PASSED >> "%LOG%")
echo BUILD OK >> "%LOG%"
echo Build OK. Details in recompilar.log
goto :end
:failed
echo BUILD FAILED >> "%LOG%"
echo Build FAILED. Details in recompilar.log
:end
timeout /t 8 >nul
endlocal
