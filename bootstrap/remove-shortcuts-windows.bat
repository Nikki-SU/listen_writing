@echo off
rem Remove the desktop / startup shortcuts without touching program or data.
rem This file is independent of start-windows.bat, so it works even on old installs.

setlocal
cd /d "%~dp0"

echo Removing desktop and startup shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $s=[Environment]::GetFolderPath('Startup'); Remove-Item (Join-Path $d 'Listen Writing.lnk') -ErrorAction SilentlyContinue; Remove-Item (Join-Path $s 'Listen Writing Backend.lnk') -ErrorAction SilentlyContinue"

if exist ".runtime\shortcuts_v2" del /q ".runtime\shortcuts_v2"
if exist ".runtime\shortcuts_created" del /q ".runtime\shortcuts_created"
if not exist ".runtime" mkdir ".runtime"
type nul > ".runtime\no_shortcuts"

echo Done. The app will no longer auto-start at login.
echo To restore shortcuts, delete .runtime\no_shortcuts and run start-windows.bat once.
pause >nul
exit /b 0
