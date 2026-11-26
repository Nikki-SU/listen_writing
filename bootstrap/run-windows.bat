@echo off
rem listen_writing launcher body for Windows.
rem
rem This file is loaded by start-windows.bat. It is safe for the web page to
rem replace on update: the new version is dropped as run-windows.bat.new and
rem swapped in by start-windows.bat BEFORE this file is opened.
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
set "LWDIR=%~dp0"
set "APPURL=https://nikki-su.github.io/listen_writing/"

rem --remove-shortcuts: delete the desktop / startup shortcuts and exit.
if /I "%~1"=="--remove-shortcuts" goto remove_shortcuts

rem If the backend is already running, just open the page and leave it alone.
powershell -NoProfile -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:7850/api/health').StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 goto already_running

set "PYTAG=20261026"
set "PYVER=3.12.16"
set "GHBASE=https://github.com/astral-sh/python-build-standalone/releases/download/%PYTAG%"
rem Domestic mirrors of the GitHub release: no user proxy and no third-party gh-proxy.
rem Both return exactly the official file (SHA256 verified against SHA256SUMS).
set "NJU=https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/%PYTAG%"
set "HW=https://mirrors.huaweicloud.com/github-release/astral-sh/python-build-standalone/%PYTAG%"
set "PKG=cpython-%PYVER%+%PYTAG%-x86_64-pc-windows-msvc-install_only.tar.gz"
set "SHA=590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5"
set "PY=.runtime\python.exe"

:preflight
rem Warnings only, not fatal: later steps show clearer errors for low disk / 32-bit.
if "%PROCESSOR_ARCHITECTURE%"=="x86" if not defined PROCESSOR_ARCHITEW6432 echo [WARN] 32-bit Windows is not supported. Please use 64-bit Windows 10/11.
for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "[int]((Get-PSDrive %SystemDrive:~0,1%).Free/1GB)"`) do set "FREE_GB=%%F"
if not defined FREE_GB goto skip_disk
if %FREE_GB% LSS 8 echo [WARN] Only %FREE_GB% GB free. First run needs about 8 GB (runtime + models + PDF component).
:skip_disk

if exist "%PY%" goto have_runtime

echo.
echo [1/4] Preparing a private Python runtime (one time, about 50 MB)
echo        You do NOT need to install Python on this computer.
if not exist ".runtime" mkdir ".runtime"

rem Domestic mirrors first (no user proxy), then official GitHub, then third-party proxies.
call :try_download "%NJU%/%PKG%"
if not errorlevel 1 goto unpack
call :try_download "%HW%/%PKG%"
if not errorlevel 1 goto unpack
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

rem Create desktop + startup shortcuts once. The startup shortcut uses --silent
rem so it starts the backend at login without opening a browser window.
if exist ".runtime\shortcuts_created" goto install_deps
if exist ".runtime\no_shortcuts" goto install_deps
echo [2.5/4] Creating desktop and startup shortcuts ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $s=[Environment]::GetFolderPath('Startup'); $t=Join-Path $env:LWDIR 'start-windows.bat'; $a=$ws.CreateShortcut((Join-Path $d 'Listen Writing.lnk')); $a.TargetPath=$env:APPURL; $a.Save(); $b=$ws.CreateShortcut((Join-Path $s 'Listen Writing Backend.lnk')); $b.TargetPath=$t; $b.WorkingDirectory=$env:LWDIR; $b.Arguments='--silent'; $b.WindowStyle=7; $b.Save()"
if errorlevel 1 goto shortcuts_failed
type nul > ".runtime\shortcuts_created"
goto install_deps

:shortcuts_failed
echo        [WARN] Could not create shortcuts. You can still run start-windows.bat manually.

:install_deps
echo [3/4] Installing components (first run only, about 600 MB, needs internet)
if exist ".runtime\install.log" del /q ".runtime\install.log"
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
rem Jump to the OPTIONAL runtimes, not straight to check_native. The old code
rem skipped the AI runtime whenever this mirror worked, so the web page always
rem said "runtime not installed" no matter how many times the files were replaced.
if not errorlevel 1 goto check_native
echo        Mirror failed, retrying with the official index ...
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 -r requirements.txt
if errorlevel 1 goto pip_failed
goto check_native

:ai_runtime
rem AI correction runtime: PyPI only ships sources. Install the CPU wheel from the
rem project wheel index. Failure is not fatal - transcription still works and the
rem web page reports that the AI runtime is missing.
"%PY%" -c "import llama_cpp" >nul 2>nul
if not errorlevel 1 goto torch_runtime
echo        Installing the optional local AI runtime (about 30 MB) ...
echo        Details are written to .runtime\install.log
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 --only-binary llama-cpp-python llama-cpp-python==0.3.36 --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu >>".runtime\install.log" 2>&1
if not errorlevel 1 goto ai_runtime_check
echo        Wheel index unreachable, trying the direct download ...
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 "https://gh-proxy.com/https://github.com/abetlen/llama-cpp-python/releases/download/v0.3.36/llama_cpp_python-0.3.36-py3-none-win_amd64.whl" >>".runtime\install.log" 2>&1
if errorlevel 1 goto ai_runtime_failed

:ai_runtime_check
"%PY%" -c "import llama_cpp" >nul 2>nul
if not errorlevel 1 goto torch_runtime
echo        [WARN] Local AI runtime installed but cannot be loaded (missing DLL?).
echo               See .runtime\install.log for details.
goto torch_runtime

:ai_runtime_failed
echo        [WARN] Local AI runtime not installed (transcription is unaffected).
echo               See .runtime\install.log ; it is retried on every launch.
goto torch_runtime

:torch_runtime
rem Qwen3-ASR needs torch. The PyPI Windows wheel is CPU-only, so no CUDA deps.
rem Failure is not fatal: Whisper / SenseVoice still work and the settings page
rem reports this option as unavailable on this machine.
"%PY%" -c "import torch" >nul 2>nul
if not errorlevel 1 goto preload
echo        Installing the Qwen3-ASR runtime (optional, about 200 MB) ...
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 torch==2.15.0 -i https://pypi.tuna.tsinghua.edu.cn/simple >>".runtime\install.log" 2>&1
if not errorlevel 1 goto preload
"%PY%" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 torch==2.15.0 >>".runtime\install.log" 2>&1
if not errorlevel 1 goto preload
echo        [WARN] Qwen3-ASR runtime not installed (Whisper / SenseVoice are unaffected;
echo               see .runtime\install.log ; retried next run).
goto preload

:check_native
rem ctranslate2 / av dlls need MSVCP140.dll, which the portable Python does not ship.
rem A clean Windows would fail with "DLL load failed", so check and install the
rem official Microsoft runtime library when missing.
"%PY%" -c "import av, ctranslate2" >nul 2>nul
if not errorlevel 1 goto ai_runtime

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
if not errorlevel 1 goto ai_runtime

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
echo  Interview Recorder backend is starting:
echo      http://127.0.0.1:7850
echo  Keep this window open while you use the web page.
echo ============================================================
echo.
if /I not "%~1"=="--silent" (
  echo [INFO] Opening the workbench page in your browser...
  start "" "%APPURL%"
) else (
  echo [INFO] Silent startup: open the page when you need it.
)
"%PY%" backend\main.py
rem Exit code 86 means the web page wrote updated files and asked for a restart.
rem Start a FRESH process through start-windows.bat, so a replaced run file is
rem re-read from disk instead of continuing inside the old one.
if errorlevel 86 goto restart

echo.
echo Backend stopped. Press any key to close this window.
pause >nul
exit /b 0

:restart
echo.
echo [INFO] Local files were updated. Reinstalling components and restarting ...
start "" "%~dp0start-windows.bat" %*
exit /b 0

:already_running
rem Backend is already up: this is the "click the icon / page again" path.
if /I not "%~1"=="--silent" start "" "%APPURL%"
exit /b 0

:remove_shortcuts
echo Removing desktop and startup shortcuts ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws=New-Object -ComObject WScript.Shell; $d=[Environment]::GetFolderPath('Desktop'); $s=[Environment]::GetFolderPath('Startup'); Remove-Item (Join-Path $d 'Listen Writing.lnk') -ErrorAction SilentlyContinue; Remove-Item (Join-Path $s 'Listen Writing Backend.lnk') -ErrorAction SilentlyContinue"
if exist ".runtime\shortcuts_created" del /q ".runtime\shortcuts_created"
type nul > ".runtime\no_shortcuts"
echo Done. The app will no longer auto-start at login.
pause >nul
exit /b 0

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
if errorlevel 1 goto try_download_ps
goto verify_download

:try_download_ps
rem curl does not use the Windows system proxy; PowerShell Invoke-WebRequest does.
rem So when curl fails (including corporate proxy networks), retry the same source with PowerShell.
if exist "python-runtime.tar.gz" del /q "python-runtime.tar.gz"
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
