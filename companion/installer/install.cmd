@echo off
rem Runs the installer with the execution policy relaxed for this process only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
