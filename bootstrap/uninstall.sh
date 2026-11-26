#!/usr/bin/env bash
# Listen Writing 卸载脚本（Linux / macOS）。
# 与 Windows 版同样的两种模式：保留 data，或连 data 一起删除。
set -u
cd "$(dirname "$0")" || exit 1
DIR="$(pwd)"
APPURL="https://nikki-su.github.io/listen_writing/?uninstall=1"

echo
echo "  Listen Writing - 卸载"
echo
echo "  1. 卸载程序，保留 data/（录音与转写稿）"
echo "  2. 彻底卸载：程序 + data/ + 浏览器本地数据"
echo "  3. 取消"
echo
read -r -p "请输入 1 / 2 / 3：" ans
case "$ans" in
  1) MODE=keep ;;
  2) MODE=full ;;
  *) exit 0 ;;
esac

echo "停止本地后端…"
pkill -f "$DIR/backend/main.py" 2>/dev/null || true
pkill -f "$DIR/.runtime/mineru" 2>/dev/null || true
sleep 1

if [ "$MODE" = "full" ]; then
  echo "清理浏览器本地数据…"
  if command -v open >/dev/null 2>&1; then open "$APPURL" >/dev/null 2>&1 || true; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$APPURL" >/dev/null 2>&1 || true; fi
  echo "计划删除整个文件夹…"
  ( sleep 2; cd /; rm -rf "$DIR" ) >/dev/null 2>&1 &
else
  echo "计划删除程序文件，保留 data/…"
  (
    sleep 2
    cd /
    rm -rf "$DIR/.runtime" "$DIR/backend"
    find "$DIR" -maxdepth 1 -type f -delete
  ) >/dev/null 2>&1 &
fi

echo
echo "完成。几秒后生效；现在可以关闭这个终端。"
