"""首次部署的模型预下载：由启动器（bootstrap/ 下的一键启动脚本）调用。

设计（对应《工程纪律.md》第 7 条「不给用户添麻烦」）：
- 启动窗口里就完成模型下载并显示进度，用户不需要理解任何概念。
- 失败不阻塞启动：后端照常起服务，首次转写时会自动重试（transcriber.ensure_model）。
"""

import sys

from storage import get_settings
from transcriber import transcriber_for


def main() -> int:
    key = get_settings().get("asr_model") or "whisper-small"
    try:
        t = transcriber_for(key)
    except Exception as e:
        # 用户选中的档位还没有本地运行时：不阻塞启动，改用时界面会给出明确提示。
        print(f"[模型] 当前选择不可用：{e}")
        return 0
    if not t.needs_download():
        print(f"[模型] 已在本地，跳过下载：{t.model_ref}")
        return 0
    print(f"[模型] 开始下载语音模型：{t.model_ref}")
    print("[模型] 首次约 500MB，取决于网速可能需要几分钟到十几分钟，请保持本窗口开启……")
    if t.ensure_model():
        print("[模型] 就绪。")
        return 0
    print("[模型] 下载失败（不影响启动，首次转写时会自动重试）。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
