"""首次部署的组件预下载：由启动器调用，一次性把「本机配置允许的东西」都备齐。

用户明确："下载这个配置允许的所有的东西，第一次的时候让他们自动地去下"。
所以这里不只下转写/LLM 模型，还包括：
- 实时录音用的 SenseVoice 轻量模型；
- 知识库检索用的 Embedding 模型（95MB）；
- PDF 入库用的 MinerU（按内存/磁盘/GPU 选 CPU pipeline 档），装不上不阻塞启动。

已在本机的全部跳过；失败只打印警告，后端照常启动，界面会给出可重试的入口。
"""

import ctypes
import os
import subprocess
import sys

import kb_embed
import llm
import mineru
import storage
from transcriber import ASR_MODELS, transcriber_for

LLM_LADDER = ["qwen3-1.7b", "qwen3-4b", "qwen2.5-7b"]


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


def _min_ram_gb(value) -> float:
    try:
        return float(str(value).lower().replace("gb", "").strip())
    except (TypeError, ValueError):
        return 999.0


def asr_targets(gb: float, chosen: str) -> list[str]:
    """本机配置允许的全部转写档位：选中的 + 所有 min_ram <= 本机内存的档位。

    用户明确「配置允许的，要自动下载它以及比它更低配的东西」。
    """
    out = [chosen]
    for key, spec in ASR_MODELS.items():
        if key != chosen and _min_ram_gb(spec.get("min_ram")) <= gb:
            out.append(key)
    return out


def llm_targets(chosen: str) -> list[str]:
    """选中档位及其以下的所有 LLM 档位（按显存/内存阶梯，不越级）。"""
    if chosen not in LLM_LADDER:
        return [chosen]
    return LLM_LADDER[: LLM_LADDER.index(chosen) + 1]


def ensure_asr(key: str) -> None:
    try:
        t = transcriber_for(key)
    except Exception as e:
        print(f"[模型] 转写档位 {key} 的运行时不可用：{e}")
        return
    if not t.needs_download():
        print(f"[模型] 转写模型已在本地：{t.model_ref}")
        return
    print(f"[模型] 下载转写模型：{t.model_ref}（请保持本窗口开启）")
    try:
        # Whisper 的 ensure_model 会把模型装进内存；预下载只需要文件，避免多档同时占 RAM。
        spec = ASR_MODELS.get(key) or {}
        if spec.get("engine") == "faster-whisper":
            from faster_whisper.utils import download_model
            download_model(t.size)
            ok = True
        else:
            ok = t.ensure_model()
    except Exception as e:  # noqa: BLE001 - 单档失败不影响其它档
        print(f"[模型] 转写模型下载失败：{e}")
        return
    if ok:
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


def ensure_embedding() -> None:
    key = kb_embed.DEFAULT_EMBED_MODEL
    spec = kb_embed.EMBED_MODELS.get(key, {})
    if kb_embed.model_file(key) is not None:
        print(f"[模型] 向量模型已在本地：{spec.get('label', key)}")
        return
    print(f"[模型] 下载向量模型：{spec.get('label', key)}（约 {spec.get('expected', 0)/1e6:.0f}MB）")
    try:
        kb_embed.ensure_model(key, on_status=lambda msg: print(f"[模型] {msg}"))
        print("[模型] 向量模型就绪。")
    except Exception as e:  # noqa: BLE001 - 失败只降级 BM25
        print(f"[模型] 向量模型下载失败（知识库先用 BM25 词法检索）：{e}")


def ensure_mineru() -> None:
    if os.environ.get("LISTEN_WRITING_SKIP_MINERU") == "1":
        print("[组件] 已按环境变量跳过 MinerU 安装。")
        return
    info = mineru.probe()
    if info.get("available"):
        print(f"[组件] PDF 转换组件已就绪：MinerU {info.get('version') or ''}".strip())
        return
    if float(info.get("disk_free_gb") or 0) < mineru.MIN_FREE_GB:
        print(f"[组件] 磁盘剩余不足 {mineru.MIN_FREE_GB:.0f}GB，跳过 MinerU；"
              "以后可在知识库页手动安装。")
        return
    print("[组件] 首次安装 PDF 转换组件（MinerU + torch + 模型，约 5–8GB，耗时较长）…")
    final = mineru.ensure_installed(on_status=lambda msg: print(msg))
    if final.get("status") == "done":
        print("[组件] PDF 转换组件就绪。")
    else:
        print(f"[组件] MinerU 安装失败（PDF 暂不可用，仍可导入 md/txt/docx）：{final.get('error') or final.get('message')}")


def main() -> int:
    gb = total_ram_gb()
    print(f"[模型] 检测到本机内存约 {gb:.1f}GB，按此选择模型档位。")
    settings = storage.get_settings()
    asr = settings.get("asr_model") or pick_asr(gb)
    # LLM 档位按配置自动选一次（没手动选过时）；写回后界面与实际下载一致。
    llm_key = settings.get("llm_model") or pick_llm(gb)
    storage.update_settings({"asr_model": asr, "llm_model": llm_key})
    print(f"[模型] 转写档位：{asr} · AI 档位：{llm_key}")
    if not llm.runtime_available():
        print("[模型] 本地 AI 运行时（llama-cpp-python）未安装：AI 对话/纠错不可用；"
              "不影响转写与 PDF。可重新运行启动器重试安装。")
    asr_list = asr_targets(gb, asr)
    llm_list = llm_targets(llm_key)
    print(f"[模型] 本机配置允许的转写档位：{'、'.join(asr_list)}")
    print(f"[模型] 本机配置允许的 AI 档位：{'、'.join(llm_list)}")
    print("[模型] 首次会下载：以上档位的全部模型、向量模型，以及 PDF 转换组件。")
    for key in asr_list:
        ensure_asr(key)
    # 先下本机默认档（最大的那个），再下更低档；中断时至少默认档可用。
    for key in reversed(llm_list):
        ensure_llm(key)
    ensure_embedding()
    ensure_mineru()
    return 0


if __name__ == "__main__":
    sys.exit(main())
