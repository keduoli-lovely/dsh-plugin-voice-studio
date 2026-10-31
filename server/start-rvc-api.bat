@echo off
chcp 65001 >nul
rem 用法：在 RVC 根目录双击/运行本脚本，或  start-rvc-api.bat [端口] [RVC根目录]
set PORT=%~1
if "%PORT%"=="" set PORT=7866
set RVCROOT=%~2
if "%RVCROOT%"=="" set RVCROOT=%CD%
if exist "%RVCROOT%\runtime\python.exe" (
  "%RVCROOT%\runtime\python.exe" "%~dp0rvc-api.py" --host 0.0.0.0 --port %PORT% --rvc-root "%RVCROOT%"
) else (
  python "%~dp0rvc-api.py" --host 0.0.0.0 --port %PORT% --rvc-root "%RVCROOT%"
)
pause
