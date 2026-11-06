"""本地 LLM：AI 语义纠错与脱敏标记的推理引擎。

与 `transcriber.py` 同构的分层：
- 设置只存模型 key（`data/settings.json` 的 `llm_model`），这里负责把 key 翻成 GGUF 文件；
- 模型是量化后的 GGUF，首次使用时下载到 `data/models/llm/<key>/`，随项目文件夹走；
- 推理走 `llama-cpp-python`（CPU），不联网、不依赖任何外部服务；
- 运行时未安装时明确报错，由接口把原因原样返回给界面，不伪造结果。

下载源复用 `transcriber.py` 在进程启动时做出的判断（官方 HuggingFace 不通时已切到
hf-mirror.com），且 `HF_HOME` 同样落在项目文件夹。
"""

import importlib.util
import logging
import re
from pathlib import Path
from typing import Callable

from storage import DATA_ROOT

logger = logging.getLogger(__name__)

# 三个选项与 PRD 第 9 节一致；这里是唯一权威定义，S-1 直接把它返回给前端。
LLM_MODELS: dict[str, dict] = {
    "qwen3-1.7b": {
        "id": "qwen3-1.7b",
        "label": "Qwen3-1.7B Q4",
        "min_ram": "8GB",
        "speed": "速度较快",
        "note": "最低配置默认回退档",
        "repo": "bartowski/Qwen3-1.7B-GGUF",
    },
    "qwen3-4b": {
        "id": "qwen3-4b",
        "label": "Qwen3-4B Q4",
        "min_ram": "16GB",
        "speed": "精度与速度折中",
        "note": "中间平衡档；默认",
        "repo": "bartowski/Qwen3-4B-GGUF",
    },
    "qwen2.5-7b": {
        "id": "qwen2.5-7b",
        "label": "Qwen2.5-7B Q4",
        "min_ram": "16GB",
        "speed": "约 1–5 tok/s，较慢",
        "note": "精度优先档",
        "repo": "bartowski/Qwen2.5-7B-Instruct-GGUF",
    },
}

DEFAULT_LLM_MODEL = "qwen3-4b"

_runtime_missing_msg = (
    "本地 AI 运行时（llama-cpp-python）尚未安装，无法调用语义纠错/脱敏。"
    "请重新运行启动器，它会自动安装缺失组件。"
)


def runtime_available() -> bool:
    """本地推理运行时是否可用（只看模块能否导入，不加载模型）。"""
    return importlib.util.find_spec("llama_cpp") is not None


def options() -> list[dict]:
    """带 `available` 的选项表：前端据此置灰未就绪的档位。"""
    ready = runtime_available()
    return [
        {**spec, "available": ready} for spec in LLM_MODELS.values()
    ]


def model_dir(model_key: str) -> Path:
    return DATA_ROOT / "models" / "llm" / model_key


def model_file(model_key: str) -> Path | None:
    """已下载好的 GGUF（优先 Q4_K_M 单文件）。"""
    d = model_dir(model_key)
    if not d.is_dir():
        return None
    files = sorted(d.rglob("*.gguf"))
    if not files:
        return None
    preferred = [f for f in files if "q4_k_m" in f.name.lower() and "mmproj" not in f.name.lower()]
    return (preferred or files)[0]


def _pick_remote_file(repo_id: str) -> str:
    """在仓库里挑一个 Q4_K_M 的 GGUF 单文件（兼容不同仓库的命名大小写）。"""
    from huggingface_hub import HfApi

    files = HfApi().list_repo_files(repo_id)
    cands = [
        f for f in files
        if f.lower().endswith(".gguf") and "q4_k_m" in f.lower() and "mmproj" not in f.lower()
    ]
    if not cands:
        raise RuntimeError(f"模型仓库 {repo_id} 里没有找到 Q4_K_M 的 GGUF 文件")
    # 只有一个文件时直接用；多个分片时取第一片（llama.cpp 支持按分片自动拼接）
    return sorted(cands)[0]


def ensure_model(model_key: str, on_status: Callable[[str], None] | None = None) -> Path:
    """确保选中档位的 GGUF 在本地；必要时联网下载。返回文件路径。"""
    spec = LLM_MODELS.get(model_key)
    if spec is None:
        raise ValueError(f"未知的 AI 模型：{model_key}")
    existing = model_file(model_key)
    if existing is not None:
        return existing

    if on_status:
        on_status(f"正在下载 {spec['label']}（首次使用，约 1–5GB）…")
    from huggingface_hub import hf_hub_download

    filename = _pick_remote_file(spec["repo"])
    path = hf_hub_download(
        repo_id=spec["repo"],
        filename=filename,
        local_dir=str(model_dir(model_key)),
    )
    logger.info("AI 模型已就绪：%s", path)
    return Path(path)


def split_think(text: str) -> str:
    """去掉 Qwen3 的思考段（`…`），只留最终答案。"""
    return re.sub(r"^\s*.*?<｜end▁of▁thinking｜>", "", text, flags=re.S).strip()
