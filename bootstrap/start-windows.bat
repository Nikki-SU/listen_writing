@echo off
rem listen_writing launcher entry (Windows).
rem
rem Keep this file tiny and stable: it never needs to be rewritten. All real
rem logic lives in run-windows.bat, which the web page can update automatically
rem by dropping run-windows.bat.new here. We promote it BEFORE loading it, so
rem cmd never reads a batch file that is being overwritten.
rem
rem Pure ASCII + CRLF is mandatory (cmd reads batch files byte by byte).

setlocal
cd /d "%~dp0"

if not exist "run-windows.bat.new" goto run
if exist "run-windows.bat" del /q "run-windows.bat"
move /y "run-windows.bat.new" "run-windows.bat" >nul 2>nul

:run
if not exist "run-windows.bat" goto missing
call "run-windows.bat"
exit /b %errorlevel%

:missing
echo.
echo [ERROR] run-windows.bat is missing from this folder.
echo         Open the web page and write the launcher files once more.
pause
exit /b 1
