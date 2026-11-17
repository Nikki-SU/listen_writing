"""MinerU 转换组件：以独立 venv + 子进程 CLI 运行，主后端绝不 import torch/mineru。

设计约束（定稿第 2 节）：
- 独立 venv：.runtime/mineru/，独立模型目录 data/models/mineru/，与主运行时隔离。
- 主后端锁 transformers 5.13.1 / tokenizers 0.22.1，依赖会打架，因此只用子进程。
- 16G/512G：pipeline + CPU、method=txt 优先，扫描页才 OCR；单任务串行。
- 装不上：如实报告不可用，PDF 按钮禁用；md/txt/docx 仍可用。
- 真实耗时/内存峰值标「待实测」，这里不写死数字。

注意：venv 的创建/依赖安装由启动器负责（见 bootstrap）。本模块只做「探测 + 调用 + 解析产物」。
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import storage

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = PROJECT_ROOT / ".runtime" / "mineru"
MODELS_DIR = storage.DATA_ROOT / "models" / "mineru"
STATE_PATH = storage.DATA_ROOT / "mineru_state.json"

# CPU 上单任务串行：一把全局锁（进程内足够，转换本身在子进程）
import threading
_convert_lock = threading.Lock()


def _venv_python() -> Path:
    if os.name == "nt":
        return RUNTIME_DIR / "Scripts" / "python.exe"
    return RUNTIME_DIR / "bin" / "python"


def probe() -> dict:
    """探测 MinerU 是否可用；只读，不改状态。"""
    py = _venv_python()
    available = False
    version = ""
    if py.exists():
        try:
            r = subprocess.run(
                [str(py), "-c", "import mineru; print(getattr(mineru,'__version__','ok'))"],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode == 0:
                available = True
                version = (r.stdout or "ok").strip().splitlines()[0]
        except (subprocess.SubprocessError, OSError):
            available = False
    gb = _ram_gb()
    profile = "pipeline-cpu-txt" if gb < 30 else "pipeline-cpu"
    state = storage._read_json(STATE_PATH) or {}
    return {
        "available": available,
        "version": version,
        "venv_path": str(RUNTIME_DIR),
        "models_path": str(MODELS_DIR),
        "installed": py.exists(),
        "ram_gb": round(gb, 1),
        "disk_free_gb": round(_disk_free_gb(), 1),
        "profile_suggestion": profile,
        "timing_note": "CPU 上的真实耗时与内存峰值待真机实测",
        "state": state.get("status", "not_installed"),
    }


def _ram_gb() -> float:
    try:
        import preload
        return preload.total_ram_gb()
    except Exception:
        return 8.0


def _disk_free_gb() -> float:
    try:
        return shutil.disk_usage(str(storage.DATA_ROOT)).free / (1024 ** 3)
    except OSError:
        return 0.0


def set_state(status: str, detail: str = "") -> dict:
    state = {
        "status": status,
        "detail": detail,
        "updated_at": storage.now_iso(),
    }
    storage._write_json(STATE_PATH, state)
    return state


def convert_pdf(
    pdf_path: Path, out_dir: Path,
    method: str = "txt",
    pages: str = "",
    should_stop=None,
) -> Path:
    """子进程调用 MinerU 把 PDF 转成 Markdown，返回 markdown.md 路径。

    不在主进程 import 任何 torch/mineru 模块；输出目录里的 markdown 即为产物。
    pages 形如 "1,3-5"；method=txt|ocr|auto。
    """
    info = probe()
    if not info["available"]:
        raise RuntimeError("文档转换组件（MinerU）未安装或不可用")
    py = _venv_python()
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [str(py), "-m", "mineru.cli.client", "-p", str(pdf_path), "-o", str(out_dir),
           "-m", method, "-b", "pipeline", "-d", "cpu"]
    if pages:
        cmd += ["-f", str(pages)]
    env = dict(os.environ)
    env["MINERU_MODEL_SOURCE"] = "local"
    env["MINERU_MODEL_PATH"] = str(MODELS_DIR)
    with _convert_lock:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, env=env)
        assert proc.stdout is not None
        for line in proc.stdout:
            if should_stop and should_stop():
                proc.terminate()
                raise InterruptedError("转换已取消")
        rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"MinerU 转换失败（退出码 {rc}）")
    mds = list(out_dir.rglob("*.md"))
    if not mds:
        raise RuntimeError("MinerU 未产出 Markdown，可能是扫描页需 OCR")
    return mds[0]
