@echo off
rem Listen Writing uninstaller (Windows).
rem Pure ASCII + CRLF is mandatory (cmd reads batch files byte by byte).

setlocal
cd /d "%~dp0"
set "LWDIR=%~dp0"
set "D=%LWDIR:~0,-1%"
set "APPURL=https://nikki-su.github.io/listen_writing/?uninstall=1"
title Listen Writing Uninstall

echo.
echo   Listen Writing - Uninstall
echo.
echo   1. Remove program, keep data\ (recordings and transcripts)
echo   2. Full uninstall: program + data\ + shortcuts + browser local data
echo   3. Cancel
echo.
choice /c 123 /n
if errorlevel 3 exit /b 0
if errorlevel 2 goto full
goto stop_keep

:full
set "MODE=full"
goto stop

:stop_keep
set "MODE=keep"

:stop
echo.
echo Stopping local backend and launcher windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:LWDIR; Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($d,'OrdinalIgnoreCase') } | ForEach-Object { taskkill /PID $_.Id /T /F | Out-Null }; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.Contains($d) -and $_.CommandLine -notlike '*uninstall-windows.bat*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }; $c=Get-NetTCPConnection -LocalPort 7850 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { taskkill /PID $c.OwningProcess /T /F | Out-Null }"
timeout /t 1 /nobreak >nul

echo Removing desktop and startup shortcuts...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $s=[Environment]::GetFolderPath('Startup'); Remove-Item (Join-Path $d 'Listen Writing.lnk') -ErrorAction SilentlyContinue; Remove-Item (Join-Path $s 'Listen Writing Backend.lnk') -ErrorAction SilentlyContinue"
del /q "%TEMP%\vc_redist.x64.exe" >nul 2>nul

if /I "%MODE%"=="full" goto full_delete
goto keep_delete

:full_delete
echo Clearing browser local data...
start "" "%APPURL%"
echo Scheduling full removal...
> "%TEMP%\lw_uninstall.bat" echo @echo off
>> "%TEMP%\lw_uninstall.bat" echo cd /d "%TEMP%"
>> "%TEMP%\lw_uninstall.bat" echo timeout /t 3 /nobreak ^>nul
>> "%TEMP%\lw_uninstall.bat" echo rmdir /s /q "%D%"
>> "%TEMP%\lw_uninstall.bat" echo start /b cmd /c del /q "%%~f0"
start "" /min "%TEMP%\lw_uninstall.bat"
echo.
echo Done. The folder will disappear in a few seconds.
echo If it remains, close any window using it and delete the folder manually.
cd /d "%TEMP%"
pause >nul
exit /b 0

:keep_delete
echo Scheduling program removal (data\ will be kept)...
> "%TEMP%\lw_uninstall.bat" echo @echo off
>> "%TEMP%\lw_uninstall.bat" echo cd /d "%TEMP%"
>> "%TEMP%\lw_uninstall.bat" echo timeout /t 3 /nobreak ^>nul
>> "%TEMP%\lw_uninstall.bat" echo rmdir /s /q "%D%\.runtime"
>> "%TEMP%\lw_uninstall.bat" echo rmdir /s /q "%D%\backend"
>> "%TEMP%\lw_uninstall.bat" echo del /q "%D%\requirements.txt" "%D%\run-windows.bat" "%D%\start-windows.bat" "%D%\run.sh" "%D%\start.sh" "%D%\start-mac.command" "%D%\uninstall-windows.bat" "%D%\uninstall.sh" "%D%\uninstall-mac.command" "%D%\README.md"
>> "%TEMP%\lw_uninstall.bat" echo start /b cmd /c del /q "%%~f0"
start "" /min "%TEMP%\lw_uninstall.bat"
echo.
echo Done. Only data\ remains in this folder.
cd /d "%TEMP%"
pause >nul
exit /b 0
