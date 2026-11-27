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

# 模型目录至少要有这么大才算下载完整（pipeline 模型合计约 1GB；保守取 300MB）。
MODEL_MIN_BYTES = 300 * 1024 * 1024
MODELS_MARKER = "models_ready"

# CPU 上单任务串行：一把全局锁（进程内足够，转换本身在子进程）
_convert_lock = threading.Lock()

_install_lock = threading.Lock()
_install_cancel = threading.Event()
_install_proc: subprocess.Popen | None = None
# 内存里是否真的有安装线程在跑。状态文件可能停在 running（后端重启/崩溃过），
# 只看状态会把「死掉的安装」误判为进行中，导致「重新安装」点不动。
_install_alive = False


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


def _dir_bytes(path: Path) -> int:
    """目录内文件总字节数；用于校验「模型是否真的下完整」。"""
    total = 0
    if not path.exists():
        return 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


def _models_bytes() -> int:
    return _dir_bytes(MODELS_DIR)


def _human_size(n: float) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.0f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def _models_ready() -> bool:
    """模型完整性：成功后写的标记 + 目录大小下限（防下载到一半就以为完成）。"""
    return (MODELS_DIR / MODELS_MARKER).is_file() and _models_bytes() >= MODEL_MIN_BYTES


def _done_stages() -> list[str]:
    return [str(x) for x in (_state().get("done_stages") or [])]


def _mark_stage(name: str) -> None:
    stages = _done_stages()
    if name not in stages:
        stages.append(name)
    _set_state(done_stages=stages)


def _py_ok(py: Path, code: str) -> bool:
    try:
        r = subprocess.run([str(py), "-P", "-c", code], capture_output=True, timeout=60)
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


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
    stages = _done_stages()
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
        # 断点续传：已完成的步骤、模型已下字节数，用于界面显示「继续安装」。
        "done_stages": stages,
        "resumable": bool(stages) and state.get("status") in ("interrupted", "failed", "cancelled"),
        "models_bytes": _models_bytes(),
        "models_required_bytes": MODEL_MIN_BYTES,
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
                [str(py), "-P", "-c", "import mineru; print(getattr(mineru,'__version__','ok'))"],
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


def _local_cache_env() -> dict:
    """所有第三方缓存都塞进项目文件夹，卸载时随文件夹一起消失。

    原则：不改系统环境、不写用户主目录、不碰全局 pip/npm；只在子进程里设环境变量。
    """
    env = dict(os.environ)
    cache = MODELS_DIR / "cache"
    env["PIP_CACHE_DIR"] = str(PROJECT_ROOT / ".runtime" / "pip-cache")
    env["MODELSCOPE_CACHE"] = str(cache / "modelscope")
    env["HF_HOME"] = str(MODELS_DIR / "hf-cache")
    env["YOLO_CONFIG_DIR"] = str(cache / "ultralytics")
    env["MPLCONFIGDIR"] = str(cache / "matplotlib")
    env["TORCH_HOME"] = str(cache / "torch")
    env["XDG_CACHE_HOME"] = str(cache)
    # XDG_CONFIG_HOME / XDG_DATA_HOME 也指到项目内：避免库往 ~/.config 写 token 或配置。
    env["XDG_CONFIG_HOME"] = str(cache / "config")
    env["XDG_DATA_HOME"] = str(cache / "data")
    # 不加载用户 site-packages：独立运行环境只认自己的依赖，避免和系统 Python 互相污染。
    env["PYTHONNOUSERSITE"] = "1"
    env["PIP_NO_INPUT"] = "1"
    return env


def _pip(py: Path, args: list[str], *, stage: str, progress: int,
         message: str, index: str | None = None) -> int:
    # 不传 --no-cache-dir：缓存落在 .runtime/pip-cache，中断后重试可直接复用已下好的 wheel。
    cmd = [str(py), "-P", "-m", "pip", "install", "--disable-pip-version-check",
           "--no-warn-script-location", "--prefer-binary",
           "--timeout", "30", "--retries", "2"]
    if index:
        cmd += ["-i", index]
    cmd += args
    return _run(cmd, stage=stage, progress=progress, message=message, env=_local_cache_env())


def _download_env(source: str) -> dict:
    env = _local_cache_env()
    env["MINERU_MODEL_SOURCE"] = source
    env["MINERU_TOOLS_CONFIG_JSON"] = str(MODELS_DIR / "mineru.json")
    env["HF_ENDPOINT"] = os.environ.get("HF_ENDPOINT", "https://hf-mirror.com")
    return env


def _convert_env() -> dict:
    env = _local_cache_env()
    env["MINERU_MODEL_SOURCE"] = "local"
    env["MINERU_TOOLS_CONFIG_JSON"] = str(MODELS_DIR / "mineru.json")
    env["MINERU_DEVICE_MODE"] = _device()
    return env


def _install_worker() -> None:
    global _install_alive, _install_proc
    py = _venv_python()
    try:
        if _disk_free_gb() < MIN_FREE_GB:
            raise RuntimeError(
                f"磁盘剩余 {_disk_free_gb():.1f}GB，PDF 转换组件至少需要 {MIN_FREE_GB:.0f}GB。"
            )

        # 1) 独立运行环境（便携 Python 升级后旧 venv 可能失效：pip 不通就重建）
        rebuilt = False
        if py.exists():
            try:
                probe_pip = subprocess.run([str(py), "-P", "-m", "pip", "--version"],
                                           capture_output=True, timeout=30)
                if probe_pip.returncode != 0:
                    shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
                    rebuilt = True
            except (subprocess.SubprocessError, OSError):
                shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
                rebuilt = True
        if not py.exists():
            _set_state(status="running", stage="venv", progress=2,
                       message="正在创建独立运行环境（不会动主程序依赖）…", error="")
            rc = _run([sys.executable, "-m", "venv", "--clear", str(RUNTIME_DIR)],
                      stage="venv", progress=5, message="正在创建独立运行环境…",
                      env=_local_cache_env())
            if rc != 0 or not py.exists():
                raise RuntimeError("创建独立运行环境失败（便携 Python 可能缺少 venv 组件）。")
            rebuilt = True
        if rebuilt:
            # 新 venv 里没有 torch / MinerU：旧步骤记录作废（模型在 venv 之外，可保留）。
            _set_state(done_stages=["venv"])
        _mark_stage("venv")
        _set_state(status="running", stage="venv", progress=8,
                   message="独立运行环境已就绪（沿用上次进度，不重复下载）")

        # 2) CPU 版 torch：已装则跳过（中断后重试不重装）
        if not _py_ok(py, "import torch"):
            _set_state(status="running", stage="torch", progress=12,
                       message="正在安装 CPU 版 PyTorch（约 200MB–1GB）…")
            rc = _pip(py, ["torch>=2.6,<3"], stage="torch", progress=20,
                      message="正在安装 CPU 版 PyTorch…", index=TORCH_INDEX)
            if rc != 0:
                # 国内直连 PyTorch 官方 wheel 源偶尔很慢；阿里云镜像同样提供 CPU wheel。
                rc = _pip(py, ["torch>=2.6,<3",
                               "-f", "https://mirrors.aliyun.com/pytorch-wheels/cpu/"],
                          stage="torch", progress=24,
                          message="官方 CPU 源不可用，尝试阿里云镜像…")
            if rc != 0:
                rc = _pip(py, ["torch>=2.6,<3"], stage="torch", progress=26,
                          message="镜像不可用，尝试默认源…")
            if rc != 0 or not _py_ok(py, "import torch"):
                raise RuntimeError("PyTorch 安装失败：请检查网络后重试（已下载部分会保留）。")
        _mark_stage("torch")
        _set_state(status="running", stage="torch", progress=32, message="PyTorch 已就绪")

        # 3) MinerU（固定 2.x）：清华镜像优先，官方源兜底；已装则跳过
        if not _py_ok(py, "import mineru"):
            _set_state(status="running", stage="mineru", progress=35,
                       message=f"正在安装 MinerU {MINERU_VERSION}（约 1–2GB）…")
            rc = 1
            for idx, index in enumerate(PIP_INDEXES):
                rc = _pip(py, ["-U", MINERU_SPEC],
                          stage="mineru", progress=40 + idx * 8,
                          message=f"正在安装 MinerU（源 {index.split('/')[2]}）…", index=index)
                if rc == 0:
                    break
            if rc != 0 or not _py_ok(py, "import mineru"):
                raise RuntimeError("MinerU 安装失败：清华镜像与官方源都不可用，请检查网络后重试。")
        _mark_stage("mineru")
        _set_state(status="running", stage="mineru", progress=58, message="MinerU 已就绪")

        # 4) 模型：已有完整模型就跳过；否则下载（ModelScope 优先，支持续传）
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        marker = MODELS_DIR / MODELS_MARKER
        if not _models_ready():
            # 旧标记可能与实际文件不符：文件不够大时先移除标记，重新补齐
            if marker.exists():
                marker.unlink(missing_ok=True)
            _set_state(status="running", stage="models", progress=62,
                       message="正在下载 MinerU 模型（约 1–2GB，可断点续传）…")
            rc = 1
            for source in ("modelscope", "huggingface"):
                rc = _run(
                    [str(py), "-P", "-m", "mineru.cli.models_download", "-s", source, "-m", "pipeline"],
                    stage="models", progress=70 if source == "modelscope" else 82,
                    message=f"正在从 {source} 下载模型…",
                    env=_download_env(source),
                )
                if rc == 0:
                    break
            if rc != 0:
                raise RuntimeError("MinerU 模型下载失败：可换网络后重试（已下载部分会保留）。")
            got = _models_bytes()
            if got < MODEL_MIN_BYTES:
                raise RuntimeError(
                    f"MinerU 模型不完整：只下载到 {_human_size(got)}，"
                    f"至少应有 {_human_size(MODEL_MIN_BYTES)}。请重试（会断点续传）。"
                )
            marker.write_text(storage.now_iso(), encoding="utf-8")
        _mark_stage("models")
        _set_state(status="running", stage="models", progress=90,
                   message=f"MinerU 模型已就绪（{_human_size(_models_bytes())}）")

        # 5) 自检
        _set_state(status="running", stage="verify", progress=95,
                   message="正在自检 MinerU…")
        rc = _run([str(py), "-P", "-c", "import mineru; print(mineru.__version__)"],
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
        _install_alive = False


def start_install(force: bool = False) -> dict:
    """后台安装 / 继续安装；重复调用不会起第二个任务。

    上次在安装途中关掉后端时，状态会停在 running；这里先判定为「已中断」，
    保留 done_stages 与已下载文件，本次直接从断点继续。
    `force=True` 表示「重新安装」：删除独立运行环境并清空步骤（模型保留），
    不会影响主程序依赖与系统环境。
    """
    with _install_lock:
        global _install_alive
        info = install_info()
        # 只有内存里真有安装线程时才拒绝「重新安装」；状态文件里的 running
        # 可能是后端重启前留下的，那种情况必须允许重装，否则按钮看起来像假的。
        if force and not _install_alive:
            shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
            (MODELS_DIR / MODELS_MARKER).unlink(missing_ok=True)
            _set_state(status="not_installed", stage="", progress=0, done_stages=[],
                       error="", message="准备重新安装（模型会保留）", auto_install=True)
            info = install_info()
        if info["running"] and _install_alive:
            return info
        if info["running"] and not _install_alive:
            # 状态停在 running，但没有活线程：判定为上次被中断，保留断点继续。
            _set_state(status="interrupted", stage=_state().get("stage", ""), progress=0,
                       message="上次安装被中断，可继续安装（断点续传，不会重下已完成部分）",
                       error="", finished_at=storage.now_iso())
            info = install_info()
        if probe()["available"]:
            # 已装好：补一个完成时间，界面才能显示「安装完成 · 时间」。
            _set_state(status="done", stage="done", progress=100,
                       message="PDF 转换组件已就绪", error="",
                       finished_at=_state().get("finished_at") or storage.now_iso())
            return install_info()
        _install_cancel.clear()
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        # 追加日志而不是清空：中断后的现场对排查安装失败有用。
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"\n{storage.now_iso()} 开始/继续安装 MinerU {MINERU_VERSION}\n")
        _set_state(status="running", stage="prepare", progress=0,
                   message="准备安装（已完成的步骤会跳过）…", error="", auto_install=True,
                   started_at=_state().get("started_at") or storage.now_iso(), finished_at="")
        _install_alive = True
        threading.Thread(target=_install_worker, daemon=True).start()
        return install_info()


def cancel_install() -> dict:
    """停止安装；未在运行时则清除断点进度（下次从头开始）。

    运行中取消：保留已下载文件与 done_stages，下次仍可「继续安装」断点续传。
    """
    running = _install_alive and install_info()["running"]
    _install_cancel.set()
    proc = _install_proc
    if proc is not None:
        try:
            proc.terminate()
        except OSError:
            pass
    if running:
        _set_state(status="cancelled", stage="cancelled", progress=0,
                   message="安装已停止；已下载的部分会保留，下次可继续安装",
                   error="", finished_at=storage.now_iso())
    else:
        (MODELS_DIR / MODELS_MARKER).unlink(missing_ok=True)
        _set_state(status="not_installed", stage="", progress=0, done_stages=[],
                   message="已清除安装进度，下次启动不再自动安装；可在设置页手动安装",
                   error="", auto_install=False, finished_at=storage.now_iso())
    return install_info()


def ensure_installed(on_status=None, poll: float = 2.0) -> dict:
    """供 preload 使用：首次启动时同步等待安装完成；已安装立即返回。

    - 上次中断：自动断点续传；
    - 用户明确「取消并清除进度」：不再自动安装，尊重用户选择；
    - 失败不抛异常（返回最终 state），由调用方决定是否继续启动后端。
    """
    if probe()["available"]:
        return install_info()
    if _state().get("auto_install") is False:
        info = install_info()
        if on_status:
            on_status("[组件] 用户已取消自动安装 MinerU，跳过；可在设置页手动安装。")
        return info
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
    cmd = [str(py), "-P", "-m", "mineru.cli.client",
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
