#!/usr/bin/env bash
# listen_writing 一键启动器（Linux / macOS）。
# 不要求电脑里已安装 Python：首次运行会把一份便携 Python 下载到 .runtime/，
# 依赖也装进这份运行时里，随后启动本地后端。

set -u
cd "$(dirname "$0")"

PYTAG=20261026
PYVER=3.12.16

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64) TRIPLE=aarch64-apple-darwin ;;
      *) TRIPLE=x86_64-apple-darwin ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64) TRIPLE=x86_64-unknown-linux-gnu ;;
      aarch64|arm64) TRIPLE=aarch64-unknown-linux-gnu ;;
      *)
        echo "[错误] 暂不支持此 CPU 架构：$(uname -m)"
        read -r -p "按回车关闭..." _
        exit 1
        ;;
    esac
    ;;
  *)
    echo "[错误] 暂不支持当前系统：$(uname -s)"
    read -r -p "按回车关闭..." _
    exit 1
    ;;
esac

URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTAG}/cpython-${PYVER}+${PYTAG}-${TRIPLE}-install_only.tar.gz"
PY=.runtime/bin/python3

if [ ! -x "$PY" ]; then
  echo "[1/4] 首次准备自带的 Python 运行时（约 25–70MB，你不需要自己安装 Python）……"
  mkdir -p .runtime
  rm -f python-runtime.tar.gz
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 --retry-delay 2 -o python-runtime.tar.gz "$URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -O python-runtime.tar.gz "$URL"
  else
    echo "[错误] 这台电脑没有 curl 或 wget，无法下载运行组件。"
    read -r -p "按回车关闭..." _
    exit 1
  fi || {
    echo "[错误] 下载运行组件失败，请检查网络后重新运行。"
    read -r -p "按回车关闭..." _
    exit 1
  }

  echo "[2/4] 解压运行时……"
  tar -xzf python-runtime.tar.gz -C .runtime --strip-components=1 || {
    echo "[错误] 解压失败，请删除 .runtime 文件夹后重新运行。"
    read -r -p "按回车关闭..." _
    exit 1
  }
  rm -f python-runtime.tar.gz
fi

if [ ! -x "$PY" ]; then
  echo "[错误] Python 运行时未就绪，请删除 .runtime 文件夹后重新运行。"
  read -r -p "按回车关闭..." _
  exit 1
fi

echo "[3/4] 首次安装组件（约 300MB，需要联网）……"
"$PY" -m pip install --disable-pip-version-check -r requirements.txt || {
  echo "      官方源失败，改用国内镜像重试……"
  "$PY" -m pip install --disable-pip-version-check -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple || {
    echo "[错误] 组件安装失败，请检查网络后重新运行。"
    read -r -p "按回车关闭..." _
    exit 1
  }
}

echo "[4/4] 准备语音模型（首次约 500MB）……"
"$PY" backend/preload.py

echo
echo "============================================================"
echo " listen_writing 本地后端正在启动：http://127.0.0.1:7850"
echo " 请保持本窗口开启；关掉窗口就等于停止后端。"
echo "============================================================"
echo
exec "$PY" backend/main.py
