#!/usr/bin/env bash
# macOS 卸载入口：只负责转交给 uninstall.sh。
set -u
exec bash "$(dirname "$0")/uninstall.sh"
