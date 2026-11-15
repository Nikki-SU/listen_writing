#!/usr/bin/env bash
# listen_writing 启动入口（Linux / macOS）。
# 这个文件保持极小且稳定，永远不需要重新写入；真正逻辑在可自动更新的 run.sh。
# 网页更新写 run.sh.new，这里在加载前换入，避免覆盖正在执行的脚本。
set -u
cd "$(dirname "$0")" || exit 1

if [ -f run.sh.new ]; then
  mv -f run.sh.new run.sh
fi
if [ ! -f run.sh ]; then
  echo "[错误] 缺少 run.sh，请回到网页重新写入一次启动文件。"
  read -r -p "按回车关闭..." _
  exit 1
fi
exec bash run.sh
