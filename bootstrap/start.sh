#!/usr/bin/env bash
# listen_writing 一键启动器（Linux / macOS）。
# 不要求电脑里已安装 Python：首次运行会把一份便携 Python 下载到 .runtime/，
# 依赖也装进这份运行时里，随后启动本地后端。
#
# 网络：GitHub 官方源优先，不通再依次尝试国内代理源；每个下载都用官方 SHA256 校验，
# 校验不过就丢弃换下一个源（避免拿到损坏或被篡改的文件）。

set -u
cd "$(dirname "$0")"

PYTAG=20261026
PYVER=3.12.16
GHBASE="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTAG}"

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64|aarch64)
        TRIPLE=aarch64-apple-darwin
        SHA=fbf4afef53c2a6b72bb741bc06d5671a9dfaf87bd84e5aa73ac9b3d0d589f14e
        ;;
      *)
        TRIPLE=x86_64-apple-darwin
        SHA=a962e47df522889eaa7ff0d6a56203f1079f68aabb65ffdbe8455f362bc769f3
        ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64|amd64)
        TRIPLE=x86_64-unknown-linux-gnu
        SHA=6a79e922e50006b601f29e688407659da1c2b86ebcd4e9c7254cf234be8b89de
        ;;
      aarch64|arm64)
        TRIPLE=aarch64-unknown-linux-gnu
        SHA=a945427411dc6851a1393533b74a4a1ac434321ae397f2ec69897a9b4fde032b
        ;;
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

PKG="cpython-${PYVER}+${PYTAG}-${TRIPLE}-install_only.tar.gz"
PY=.runtime/bin/python3

hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 依次尝试：GitHub 官方 → 国内代理 → 国内代理。下载后校验 SHA256，不符即丢弃。
fetch_runtime() {
  for url in \
    "${GHBASE}/${PKG}" \
    "https://gh-proxy.com/${GHBASE}/${PKG}" \
    "https://ghproxy.net/${GHBASE}/${PKG}"
  do
    echo "      下载地址：${url}"
    rm -f python-runtime.tar.gz
    if command -v curl >/dev/null 2>&1; then
      curl -L --fail --connect-timeout 10 --speed-limit 1024 --speed-time 20 \
        --retry 2 --retry-delay 2 -o python-runtime.tar.gz "$url"
    elif command -v wget >/dev/null 2>&1; then
      wget -T 20 -t 2 -O python-runtime.tar.gz "$url"
    else
      echo "[错误] 这台电脑没有 curl 或 wget，无法下载运行组件。"
      return 1
    fi || { echo "      该地址不可用，换下一个……"; continue; }

    if [ "$(hash_of python-runtime.tar.gz)" = "$SHA" ]; then
      return 0
    fi
    echo "      校验不通过（文件损坏或被篡改），丢弃并换下一个……"
    rm -f python-runtime.tar.gz
  done
  return 1
}

if [ ! -x "$PY" ]; then
  echo "[1/4] 首次准备自带的 Python 运行时（约 25–70MB，你不需要自己安装 Python）……"
  mkdir -p .runtime
  fetch_runtime || {
    echo "[错误] 所有下载源都不通或校验失败。可能是网络屏蔽了 github.com。"
    echo "        可以换一个网络（例如手机热点）后重新运行；"
    echo "        或让能上网的电脑下载这个文件，放到本文件夹里再运行："
    echo "        ${PKG}"
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

while :; do
echo "[3/4] 首次安装组件（约 600MB，需要联网）……"
"$PY" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 \
  -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple || {
  echo "      国内镜像失败，改用官方源重试……"
  "$PY" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 20 --retries 2 -r requirements.txt || {
    echo "[错误] 组件安装失败，请检查网络后重新运行。"
    read -r -p "按回车关闭..." _
    exit 1
  }
}

# AI 语义纠错运行时：PyPI 只有源码包，必须从项目自带的 CPU wheel 源装。
# 失败不阻塞启动（转写、校对、脱敏都不依赖它），界面会如实提示未安装。
if ! "$PY" -c "import llama_cpp" >/dev/null 2>&1; then
  echo "[3/4] 安装本地 AI 运行时（可选，约 30MB）……"
  "$PY" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 \
    llama-cpp-python==0.3.36 \
    --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu >/dev/null 2>&1 || {
    echo "      AI 纠错运行时安装失败（不影响录音转写）；下次运行启动器会自动重试。"
  }
fi

# Qwen3-ASR 需要 torch。PyPI 默认包在 Linux 上会拖入 CUDA/NVIDIA 依赖（数 GB），
# 所以明确从 CPU wheel 源安装。失败不阻塞（Whisper / SenseVoice 照常可用），
# 设置页会把该档如实标为「本机运行时未安装」。
if ! "$PY" -c "import torch" >/dev/null 2>&1; then
  echo "[3/4] 安装 Qwen3-ASR 运行时（可选，约 200MB）……"
  "$PY" -m pip install --disable-pip-version-check --no-warn-script-location --timeout 30 --retries 2 \
    torch==2.15.0 \
    --index-url https://download.pytorch.org/whl/cpu \
    --extra-index-url https://pypi.tuna.tsinghua.edu.cn/simple >/dev/null 2>&1 || {
    echo "      Qwen3-ASR 运行时安装失败（不影响 Whisper / SenseVoice）；下次运行启动器会自动重试。"
  }
fi

echo "[4/4] 准备语音模型（首次约 500MB）……"
"$PY" backend/preload.py

echo
echo "============================================================"
echo " 访谈录音台 本地后端正在启动：http://127.0.0.1:7850"
echo " 请保持本窗口开启；关掉窗口就等于停止后端。"
echo "============================================================"
echo
"$PY" backend/main.py
code=$?
# 退出码 86 = 页面把新文件写回了文件夹，要求重启。回到开头重装依赖，
# 这样 requirements.txt 有变化时也能生效；其它退出码则正常结束。
[ "$code" -eq 86 ] || break
echo
echo "[更新] 本地文件已更新，正在重新安装组件并重启后端……"
done
