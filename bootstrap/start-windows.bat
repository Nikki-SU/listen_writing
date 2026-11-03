@echo off
rem listen_writing one-click launcher for Windows (ASCII-only content on purpose:
rem cmd parses batch files in the OEM codepage; keep output English, docs stay in README.md)
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+ from https://www.python.org/downloads/
    echo then double-click this file again.
    pause
    exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating virtual environment ...
    python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Failed to create Python environment. Is Python really installed?
    pause
    exit /b 1
)
set "PY=.venv\Scripts\python.exe"
echo [2/3] Installing dependencies (first run only) ...
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 "%PY%" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
echo [3/3] Preparing speech model (first run downloads about 500MB) ...
"%PY%" backend\preload.py
echo.
echo ============================================================
echo  Starting listen_writing backend on http://127.0.0.1:7850
echo  Keep this window open. Go back to the web page and
echo  it will connect automatically in a few seconds.
echo ============================================================
"%PY%" backend\main.py
pause
