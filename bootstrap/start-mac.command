#!/usr/bin/env bash
# macOS 启动入口：只负责转交给 start.sh，避免逻辑两份。
# 用法：在终端输入 "bash "（注意空格），把本文件拖进终端，按回车。
set -u
exec bash "$(dirname "$0")/start.sh"
