@echo off
rem listen_writing one-click launcher for Windows.
rem
rem IMPORTANT: this file must stay pure ASCII with CRLF line endings.
rem cmd.exe reads batch files byte by byte; any non-ASCII character makes its
rem file offset drift and the file starts executing from the middle of lines.
rem The web page explains every step in Chinese, so users are not left guessing.
rem
rem No system Python is required: on first run this downloads a private portable
rem CPython into .runtime\ and installs dependencies into it.
rem
rem Downloads go through several sources (GitHub official first, then domestic
rem proxies) because github.com release downloads are often slow or unreachable
rem in mainland China. Every attempt is verified against the official SHA256,
rem so a broken or tampered mirror is rejected instead of executed.

setlocal
cd /d "%~dp0"

set "PYTAG=20261026"
set "PYVER=3.12.16"
set "GHBASE=https://github.com/astral-sh/python-build-standalone/releases/download/%PYTAG%"
set "PKG=cpython-%PYVER%+%PYTAG%-x86_64-pc-windows-msvc-install_only.tar.gz"
set "SHA=590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5"
set "PY=.runtime\python.exe"

if exist "%PY%" goto have_runtime

echo.
echo [1/4] Preparing a private Python runtime (one time, about 50 MB)
echo        You do NOT need to install Python on this computer.
if not exist ".runtime" mkdir ".runtime"

call :try_download "%GHBASE%/%PKG%"
if not errorlevel 1 goto unpack
call :try_download "https://gh-proxy.com/%GHBASE%/%PKG%"
if not errorlevel 1 goto unpack
call :try_download "https://ghproxy.net/%GHBASE%/%PKG%"
if not errorlevel 1 goto unpack
goto download_failed

:unpack
echo [2/4] Unpacking runtime ...
where tar >nul 2>nul
if errorlevel 1 goto no_tar
tar -xzf "python-runtime.tar.gz" -C ".runtime" --strip-components=1
if errorlevel 1 goto unpack_failed
del /q "python-runtime.tar.gz"

:have_runtime
if not exist "%PY%" goto runtime_missing

:install_deps
echo [3/4] Installing components (first run only, about 300 MB, needs internet)
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
if not errorlevel 1 goto check_native
echo        Mirror failed, retrying with the official index ...
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 -r requirements.txt
if errorlevel 1 goto pip_failed

:check_native
rem ctranslate2 / av dlls need MSVCP140.dll, which the portable Python does not ship.
rem A clean Windows would fail with "DLL load failed", so check and install the
rem official Microsoft runtime library when missing.
"%PY%" -c "import av, ctranslate2" >nul 2>nul
if not errorlevel 1 goto preload

echo.
echo [3.5/4] Missing Microsoft runtime library (MSVCP140.dll).
echo          Installing it now. A Windows permission window will pop up,
echo          please click "Yes" to allow the installation.
set "VCREDIST=%TEMP%\vc_redist.x64.exe"
if exist "%VCREDIST%" del /q "%VCREDIST%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $env:VCREDIST -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 goto vc_manual
start "" /wait "%VCREDIST%" /install /quiet /norestart
"%PY%" -c "import av, ctranslate2" >nul 2>nul
if not errorlevel 1 goto preload

:vc_manual
echo.
echo [ERROR] The Microsoft runtime library is still missing.
echo         Install it manually, then double-click this file again:
echo         https://aka.ms/vs/17/release/vc_redist.x64.exe
pause
exit /b 1

:preload
echo [4/4] Preparing the speech model (first run downloads about 500 MB)
"%PY%" backend\preload.py

echo.
echo ============================================================
echo  listen_writing backend is starting:
echo      http://127.0.0.1:7850
echo  Keep this window open while you use the web page.
echo ============================================================
echo.
"%PY%" backend\main.py
rem Exit code 86 means the web page wrote updated files and asked for a restart.
rem Loop back through pip install so a changed requirements.txt also takes effect.
if errorlevel 86 goto restart

echo.
echo Backend stopped. Press any key to close this window.
pause >nul
exit /b 0

:restart
echo.
echo [INFO] Local files were updated. Reinstalling components and restarting ...
goto install_deps

rem ---------------------------------------------------------------
rem Download one source into python-runtime.tar.gz and verify it.
rem Returns 0 only when the file downloaded AND matched the official hash.
rem ---------------------------------------------------------------
:try_download
if exist "python-runtime.tar.gz" del /q "python-runtime.tar.gz"
echo        Downloading runtime from: %~1
where curl >nul 2>nul
if errorlevel 1 goto try_download_ps
curl -L --fail --connect-timeout 10 --speed-limit 1024 --speed-time 20 --retry 2 --retry-delay 2 -o "python-runtime.tar.gz" "%~1"
if errorlevel 1 exit /b 1
goto verify_download

:try_download_ps
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%~1' -OutFile 'python-runtime.tar.gz' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 exit /b 1

:verify_download
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=(Get-FileHash -Algorithm SHA256 -Path 'python-runtime.tar.gz').Hash.ToLower(); if ($h -ne '%SHA%') { exit 1 }"
if errorlevel 1 goto checksum_bad
if not exist "python-runtime.tar.gz" exit /b 1
exit /b 0

:checksum_bad
echo        Checksum mismatch, discarding this download and trying next source.
del /q "python-runtime.tar.gz"
exit /b 1

:download_failed
echo.
echo [ERROR] Could not download the runtime package from any source.
echo         Your network may block github.com. Options:
echo         1. Connect to another network (for example a phone hotspot) and run this file again.
echo         2. Download this file on another computer, put it next to this file:
echo            %PKG%
pause
exit /b 1

:no_tar
echo.
echo [ERROR] Windows cannot unpack .tar.gz on this computer.
echo         Please use Windows 10 (version 1803 or newer) or Windows 11.
pause
exit /b 1

:unpack_failed
echo.
echo [ERROR] Could not unpack the runtime package.
echo         Delete the folder .runtime and double-click this file again.
pause
exit /b 1

:runtime_missing
echo.
echo [ERROR] Python runtime is not ready.
echo         Delete the folder .runtime and double-click this file again.
pause
exit /b 1

:pip_failed
echo.
echo [ERROR] Could not install the components.
echo         Check your internet connection, then double-click this file again.
pause
exit /b 1
