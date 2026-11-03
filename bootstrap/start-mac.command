#!/usr/bin/env bash
# listen_writing one-click launcher for macOS / Linux.
# macOS: drag this file into a Terminal window after typing "bash "
# Linux: bash start.sh
set -u
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 not found. Install Python 3.10+ first: https://www.python.org/downloads/"
  read -r -p "Press Enter to close..." _
  exit 1
fi
if [ ! -x ".venv/bin/python" ]; then
  echo "[1/3] Creating virtual environment ..."
  python3 -m venv .venv || { echo "[ERROR] venv creation failed."; read -r -p "Press Enter to close..." _; exit 1; }
fi
PY=.venv/bin/python
echo "[2/3] Installing dependencies (first run only) ..."
"$PY" -m pip install -r requirements.txt || "$PY" -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
echo "[3/3] Preparing speech model (first run downloads about 500MB) ..."
"$PY" backend/preload.py
echo
echo "============================================================"
echo " Starting listen_writing backend on http://127.0.0.1:7850"
echo " Keep this window open. Go back to the web page and"
echo " it will connect automatically in a few seconds."
echo "============================================================"
exec "$PY" backend/main.py
