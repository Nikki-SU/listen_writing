"""首次部署的模型预下载：由启动器调用，一次性把转写 + AI 模型都备齐。

设计（用户明确："首启引导就该按配置装齐所有模型，别到处弹'模型没下载'"）：
- 先探测本机内存，按档位选一个跑得动的 ASR + 一个 LLM，写回设置（界面显示的档位与实际装的一致）。
- 启动窗口里下载完两个模型并显示进度，用户不需要理解任何概念，也不需要再手动下载。
- 已在本机的跳过；失败不阻塞启动，首次使用时后端会给出明确提示。
"""

import ctypes
import subprocess
import sys

import llm
import storage
from transcriber import transcriber_for


def total_ram_gb() -> float:
    """跨平台探测物理内存（GB）；探测不到时保守返回 8GB。"""
    try:
        if sys.platform == "win32":
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            return stat.ullTotalPhys / (1024 ** 3)
        if sys.platform == "darwin":
            out = subprocess.check_output(['sysctl', '-n', 'hw.memsize'], text=True)
            return int(out.strip()) / (1024 ** 3)
        with open('/proc/meminfo', encoding='utf-8') as f:
            for line in f:
                if line.startswith('MemTotal:'):
                    return int(line.split()[1]) / (1024 ** 2)
    except Exception:
        pass
    return 8.0


def pick_llm(gb: float) -> str:
    if gb >= 30:
        return "qwen2.5-7b"
    if gb >= 12:
        return "qwen3-4b"
    return "qwen3-1.7b"


def pick_asr(gb: float) -> str:
    if gb >= 16:
        return "whisper-medium"
    return "whisper-small"


def ensure_asr(key: str) -> None:
    try:
        t = transcriber_for(key)
    except Exception as e:
        print(f"[模型] 转写档位 {key} 的运行时不可用：{e}")
        return
    if not t.needs_download():
        print(f"[模型] 转写模型已在本地：{t.model_ref}")
        return
    print(f"[模型] 下载转写模型：{t.model_ref}（首次约 500MB，请保持本窗口开启）")
    if t.ensure_model():
        print("[模型] 转写模型就绪。")
    else:
        print("[模型] 转写模型下载失败（首次转写时会自动重试）。")


def ensure_llm(key: str) -> None:
    if llm.model_file(key) is not None:
        print(f"[模型] AI 模型已在本地：{key}")
        return
    label = llm.LLM_MODELS.get(key, {}).get('label', key)
    print(f"[模型] 下载 AI 模型：{label}（首次约 2–4GB，请保持本窗口开启）")
    try:
        llm.ensure_model(key, on_status=lambda msg: print(f"[模型] {msg}"))
        print("[模型] AI 模型就绪。")
    except Exception as e:
        # 下载失败不阻塞启动：AI 功能使用时会给明确提示。
        print(f"[模型] AI 模型下载失败（不影响转写）：{e}")


def main() -> int:
    gb = total_ram_gb()
    print(f"[模型] 检测到本机内存约 {gb:.1f}GB，按此选择模型档位。")
    settings = storage.get_settings()
    asr = settings.get("asr_model") or pick_asr(gb)
    # LLM 档位按配置自动选一次（没手动选过时）；写回后界面与实际下载一致。
    llm_key = settings.get("llm_model") or pick_llm(gb)
    storage.update_settings({"asr_model": asr, "llm_model": llm_key})
    print(f"[模型] 转写档位：{asr} · AI 档位：{llm_key}")
    ensure_asr(asr)
    ensure_llm(llm_key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
