"""MinerU 转换组件：独立 venv + 子进程 CLI，主后端绝不 import torch/mineru。

设计约束（定稿第 2 节）：
- 独立 venv：.runtime/mineru/，独立模型目录 data/models/mineru/，与主运行时隔离。
- 主后端锁 transformers 5.13.1 / tokenizers 0.22.1，依赖会打架，因此只用子进程。
- 16G/512G：pipeline + CPU、method=txt 优先，扫描页才 OCR；单任务串行。
- PDF 不是可选能力：首次导入时安装；装不上如实报告不可用，md/txt/docx 仍可用。
- 真实耗时/内存峰值标「待实测」，这里不写死数字。

安装做成后台任务：POST 触发 → 状态文件 + 日志 → 前端轮询。
主进程只做「探测 / 安装 / 调用 / 解析产物」，不 import 任何重型包。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import storage

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = PROJECT_ROOT / ".runtime" / "mineru"
MODELS_DIR = storage.DATA_ROOT / "models" / "mineru"
STATE_PATH = storage.DATA_ROOT / "mineru_state.json"
LOG_PATH = storage.DATA_ROOT / "mineru_install.log"

# 固定 2.x：4.x 的 CLI 是另一套（mineru parse / 远程 tier），与本项目「本地 pipeline + CPU」不兼容。
MINERU_VERSION = "2.7.6"
MINERU_SPEC = f"mineru[pipeline]=={MINERU_VERSION}"
PIP_INDEXES = (
    "https://pypi.tuna.tsinghua.edu.cn/simple",
    "https://pypi.org/simple",
)
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"
MIN_FREE_GB = 8.0

# CPU 上单任务串行：一把全局锁（进程内足够，转换本身在子进程）
_convert_lock = threading.Lock()

_install_lock = threading.Lock()
_install_cancel = threading.Event()
_install_proc: subprocess.Popen | None = None


def _venv_python() -> Path:
    if os.name == "nt":
        return RUNTIME_DIR / "Scripts" / "python.exe"
    return RUNTIME_DIR / "bin" / "python"


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


def _has_cuda() -> bool:
    return bool(shutil.which("nvidia-smi"))


def _profile_suggestion() -> str:
    gb = _ram_gb()
    if gb < 30:
        return "pipeline-cpu-txt"
    if _has_cuda():
        return "pipeline-cuda"
    return "pipeline-cpu"


def _device() -> str:
    """默认 CPU。CUDA 需要另装 GPU 版 torch，当前不自动开，避免「有显卡但 torch 是 CPU 版」的假加速。"""
    try:
        configured = storage.get_settings().get("mineru_device")
    except Exception:
        configured = None
    return configured if configured in ("cpu", "cuda") else "cpu"


# ---------------- 状态 ----------------

def _state() -> dict:
    return storage._read_json(STATE_PATH) or {}


def _set_state(**patch) -> dict:
    state = _state()
    state.update(patch)
    state["updated_at"] = storage.now_iso()
    storage._write_json(STATE_PATH, state)
    return state


def set_state(status: str, detail: str = "") -> dict:
    return _set_state(status=status, detail=detail)


def _log_tail(path: Path = LOG_PATH, lines: int = 12) -> list[str]:
    if not path.exists():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [x for x in text[-lines:] if x.strip()]


def install_info() -> dict:
    state = _state()
    return {
        "status": state.get("status", "not_installed"),
        "stage": state.get("stage", ""),
        "progress": int(state.get("progress") or 0),
        "message": state.get("message", ""),
        "error": state.get("error", ""),
        "log_tail": _log_tail(),
        "started_at": state.get("started_at", ""),
        "finished_at": state.get("finished_at", ""),
        "running": state.get("status") == "running",
    }


def probe() -> dict:
    """探测 MinerU 是否可用；只读，不改状态。安装进行中不反复 import（避免锁文件）。"""
    py = _venv_python()
    available = False
    version = ""
    running = _state().get("status") == "running"
    if py.exists() and not running:
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
    return {
        "available": available,
        "version": version,
        "venv_path": str(RUNTIME_DIR),
        "models_path": str(MODELS_DIR),
        "installed": py.exists(),
        "ram_gb": round(_ram_gb(), 1),
        "disk_free_gb": round(_disk_free_gb(), 1),
        "disk_required_gb": MIN_FREE_GB,
        "cuda": _has_cuda(),
        "device": _device(),
        "profile_suggestion": _profile_suggestion(),
        "timing_note": "CPU 上的真实耗时与内存峰值待真机实测",
        "pinned_version": MINERU_VERSION,
        "install": install_info(),
    }


def status() -> dict:
    return probe()


# ---------------- 安装 --------------

def _run(cmd: list[str], *, stage: str, progress: int, message: str,
         env: dict | None = None, log: Path = LOG_PATH) -> int:
    """跑子进程并把输出写日志；支持取消。返回退出码，不抛异常。"""
    global _install_proc
    _set_state(status="running", stage=stage, progress=progress, message=message, error="")
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "a", encoding="utf-8", errors="replace") as fh:
        fh.write(f"\n===== {storage.now_iso()} · {stage} =====\n")
        fh.write("$ " + " ".join(cmd) + "\n")
        fh.flush()
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, env=env,
            )
        except OSError as e:
            fh.write(f"[启动失败] {e}\n")
            return 127
        _install_proc = proc
        assert proc.stdout is not None
        for line in proc.stdout:
            if _install_cancel.is_set():
                proc.terminate()
                break
            fh.write(line)
            fh.flush()
            text = line.strip()
            if text:
                _set_state(status="running", stage=stage, progress=progress,
                           message=text[:240])
        rc = proc.wait()
        _install_proc = None
    if _install_cancel.is_set():
        return -2
    return rc


def _pip(py: Path, args: list[str], *, stage: str, progress: int,
         message: str, index: str | None = None) -> int:
    cmd = [str(py), "-m", "pip", "install", "--disable-pip-version-check",
           "--no-warn-script-location", "--timeout", "30", "--retries", "2"]
    if index:
        cmd += ["-i", index]
    cmd += args
    return _run(cmd, stage=stage, progress=progress, message=message)


def _download_env(source: str) -> dict:
    env = dict(os.environ)
    env["MINERU_MODEL_SOURCE"] = source
    env["MINERU_TOOLS_CONFIG_JSON"] = str(MODELS_DIR / "mineru.json")
    env["MODELSCOPE_CACHE"] = str(MODELS_DIR / "cache")
    env["HF_HOME"] = str(MODELS_DIR / "hf-cache")
    env["HF_ENDPOINT"] = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")
    return env


def _convert_env() -> dict:
    env = dict(os.environ)
    env["MINERU_MODEL_SOURCE"] = "local"
    env["MINERU_TOOLS_CONFIG_JSON"] = str(MODELS_DIR / "mineru.json")
    env["MODELSCOPE_CACHE"] = str(MODELS_DIR / "cache")
    env["HF_HOME"] = str(MODELS_DIR / "hf-cache")
    env["MINERU_DEVICE_MODE"] = _device()
    return env


def _install_worker() -> None:
    py = _venv_python()
    try:
        if _disk_free_gb() < MIN_FREE_GB:
            raise RuntimeError(
                f"磁盘剩余 {_disk_free_gb():.1f}GB，PDF 转换组件至少需要 {MIN_FREE_GB:.0f}GB。"
            )

        # 1) 独立运行环境（便携 Python 升级后旧 venv 可能失效：pip 不通就重建）
        if py.exists():
            try:
                probe_pip = subprocess.run([str(py), "-m", "pip", "--version"],
                                           capture_output=True, timeout=30)
                if probe_pip.returncode != 0:
                    shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
            except (subprocess.SubprocessError, OSError):
                shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
        if not py.exists():
            _set_state(status="running", stage="venv", progress=2,
                       message="正在创建独立运行环境（不会动主程序依赖）…", error="")
            rc = _run([sys.executable, "-m", "venv", "--clear", str(RUNTIME_DIR)],
                      stage="venv", progress=5, message="正在创建独立运行环境…")
            if rc != 0 or not py.exists():
                raise RuntimeError("创建独立运行环境失败（便携 Python 可能缺少 venv 组件）。")
        _set_state(status="running", stage="venv", progress=8, message="独立运行环境已就绪")

        # 2) CPU 版 torch：先按 CPU wheel 装，避免 Linux 默认拖入 CUDA
        _set_state(status="running", stage="torch", progress=12,
                   message="正在安装 CPU 版 PyTorch（约 200MB–1GB）…")
        rc = _pip(py, ["--no-cache-dir", "torch>=2.6,<3"], stage="torch", progress=20,
                  message="正在安装 CPU 版 PyTorch…", index=TORCH_INDEX)
        if rc != 0:
            # 国内直连 PyTorch 官方 wheel 源偶尔很慢；阿里云镜像同样提供 CPU wheel。
            rc = _pip(py, ["--no-cache-dir", "torch>=2.6,<3",
                           "-f", "https://mirrors.aliyun.com/pytorch-wheels/cpu/"],
                      stage="torch", progress=24,
                      message="官方 CPU 源不可用，尝试阿里云镜像…")
        if rc != 0:
            rc = _pip(py, ["--no-cache-dir", "torch>=2.6,<3"], stage="torch", progress=26,
                      message="镜像不可用，尝试默认源…")
        if rc != 0:
            raise RuntimeError("PyTorch 安装失败：请检查网络后重试。")

        # 3) MinerU（固定 2.x）：清华镜像优先，官方源兜底
        _set_state(status="running", stage="mineru", progress=35,
                   message=f"正在安装 MinerU {MINERU_VERSION}（约 1–2GB）…")
        rc = 1
        for idx, index in enumerate(PIP_INDEXES):
            rc = _pip(py, ["--no-cache-dir", "-U", MINERU_SPEC],
                      stage="mineru", progress=40 + idx * 8,
                      message=f"正在安装 MinerU（源 {index.split('/')[2]}）…", index=index)
            if rc == 0:
                break
        if rc != 0:
            raise RuntimeError("MinerU 安装失败：清华镜像与官方源都不可用，请检查网络后重试。")

        # 4) 模型：默认 ModelScope（国内更稳），失败再 HuggingFace 镜像
        _set_state(status="running", stage="models", progress=62,
                   message="正在下载 MinerU 模型（约 1–2GB，请保持网络）…")
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        rc = 1
        for source in ("modelscope", "huggingface"):
            rc = _run(
                [str(py), "-m", "mineru.cli.models_download", "-s", source, "-m", "pipeline"],
                stage="models", progress=70 if source == "modelscope" else 82,
                message=f"正在从 {source} 下载模型…",
                env=_download_env(source),
            )
            if rc == 0:
                break
        if rc != 0:
            raise RuntimeError("MinerU 模型下载失败：可换网络后重试，或手动放置模型。")

        # 5) 自检
        _set_state(status="running", stage="verify", progress=95,
                   message="正在自检 MinerU…")
        rc = _run([str(py), "-c", "import mineru; print(mineru.__version__)"],
                  stage="verify", progress=97, message="正在自检 MinerU…")
        if rc != 0:
            raise RuntimeError("MinerU 已安装但导入失败，详见安装日志。")

        _set_state(status="done", stage="done", progress=100,
                   message="PDF 转换组件已就绪", error="",
                   finished_at=storage.now_iso())
    except Exception as e:  # noqa: BLE001 - 安装失败要给人话
        if _install_cancel.is_set():
            _set_state(status="cancelled", stage="cancelled", progress=0,
                       message="安装已取消", error="", finished_at=storage.now_iso())
        else:
            _set_state(status="failed", stage="failed", progress=0,
                       message=str(e), error=str(e), finished_at=storage.now_iso())
    finally:
        _install_proc = None
        _install_cancel.clear()


def start_install() -> dict:
    """后台安装；重复调用不会起第二个任务。"""
    with _install_lock:
        info = install_info()
        if info["running"]:
            # 进程重启后状态文件可能停在 running（没有活线程）：超过 2 分钟视为中断。
            try:
                age = (datetime.now(timezone.utc)
                       - datetime.fromisoformat(str(_state().get("updated_at") or ""))).total_seconds()
            except (ValueError, TypeError):
                age = 9999
            if age > 120:
                _set_state(status="failed", stage="failed", progress=0,
                           message="上次安装中断，请重试", error="上次安装中断", finished_at=storage.now_iso())
            else:
                return info
        if probe()["available"]:
            _set_state(status="done", stage="done", progress=100,
                       message="PDF 转换组件已就绪", error="")
            return install_info()
        _install_cancel.clear()
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "w", encoding="utf-8") as fh:
            fh.write(f"{storage.now_iso()} 开始安装 MinerU {MINERU_VERSION}\n")
        _set_state(status="running", stage="prepare", progress=0,
                   message="准备安装…", error="",
                   started_at=storage.now_iso(), finished_at="")
        threading.Thread(target=_install_worker, daemon=True).start()
        return install_info()


def cancel_install() -> dict:
    _install_cancel.set()
    proc = _install_proc
    if proc is not None:
        try:
            proc.terminate()
        except OSError:
            pass
    return install_info()


def ensure_installed(on_status=None, poll: float = 2.0) -> dict:
    """供 preload 使用：首次启动时同步等待安装完成；已安装立即返回。

    失败不抛异常（返回最终 state），由调用方决定是否继续启动后端。
    """
    if probe()["available"]:
        return install_info()
    if _disk_free_gb() < MIN_FREE_GB:
        _set_state(status="failed", stage="failed", progress=0,
                   message=f"磁盘剩余 {_disk_free_gb():.1f}GB，PDF 转换组件至少需要 {MIN_FREE_GB:.0f}GB",
                   error="disk_low", finished_at=storage.now_iso())
        return install_info()
    info = start_install()
    last = ""
    while info.get("running"):
        line = f"[组件] {info.get('stage') or '准备'} {info.get('progress') or 0}% {info.get('message') or ''}".strip()
        if on_status and line != last:
            on_status(line)
            last = line
        time.sleep(poll)
        info = install_info()
    if on_status:
        on_status(f"[组件] MinerU 安装结束：{info.get('status')} {info.get('error') or ''}".strip())
    return info


# ---------------- 转换 --------------

def _page_bounds(pages: str) -> tuple[int | None, int | None]:
    """把 "1,3-5" 这类 1-based 页码范围折算成 MinerU 的 0-based start/end。

    MinerU CLI 只接受连续的 start/end；离散页会按最小–最大范围转换，
    不静默丢弃，调用方负责把这一点告诉用户。
    """
    pages = (pages or "").strip()
    if not pages:
        return None, None
    nums: list[int] = []
    for part in pages.split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)-(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a < 1 or b < a:
                raise ValueError(f"页码范围不合法：{part}")
            nums.extend([a, b])
            continue
        if re.fullmatch(r"\d+", part):
            n = int(part)
            if n < 1:
                raise ValueError(f"页码必须从 1 开始：{part}")
            nums.append(n)
            continue
        raise ValueError(f"页码范围不合法：{part}")
    if not nums:
        return None, None
    return min(nums) - 1, max(nums) - 1


def convert_pdf(
    pdf_path: Path, out_dir: Path,
    method: str = "auto",
    pages: str = "",
    should_stop=None,
) -> Path:
    """子进程调用 MinerU 把 PDF 转成 Markdown，返回 markdown.md 路径。"""
    info = probe()
    if not info["available"]:
        raise RuntimeError("文档转换组件（MinerU）未安装或不可用；请先在知识库页安装。")
    if method not in ("auto", "txt", "ocr"):
        method = "auto"
    py = _venv_python()
    out_dir.mkdir(parents=True, exist_ok=True)
    start, end = _page_bounds(pages)
    cmd = [str(py), "-m", "mineru.cli.client",
           "-p", str(pdf_path), "-o", str(out_dir),
           "-m", method, "-b", "pipeline", "-d", _device(), "--source", "local"]
    if start is not None:
        cmd += ["-s", str(start)]
    if end is not None:
        cmd += ["-e", str(end)]
    log = out_dir / "mineru.log"
    with _convert_lock:
        with open(log, "a", encoding="utf-8", errors="replace") as fh:
            fh.write("$ " + " ".join(cmd) + "\n")
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, env=_convert_env())
            assert proc.stdout is not None
            for line in proc.stdout:
                if should_stop and should_stop():
                    proc.terminate()
                    raise InterruptedError("转换已取消")
                fh.write(line)
        rc = proc.wait()
    if rc != 0:
        tail = "\n".join(_log_tail(log, 8))
        raise RuntimeError(f"MinerU 转换失败（退出码 {rc}）。{tail}")
    mds = sorted(out_dir.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not mds:
        raise RuntimeError("MinerU 未产出 Markdown，可能是扫描页需要 OCR。")
    return mds[0]
