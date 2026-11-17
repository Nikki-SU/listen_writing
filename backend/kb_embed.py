"""Embedding 向量检索：独立的 embedding GGUF，用 llama.cpp 的 embedding 模式。

设计约束（定稿第 1 节）：
- 每个库可配自己的 embedding 模型；多库检索时按各库模型分别查、再融合（见 kb_search）。
- 16G 上限制同时装载的模型数（LRU 缓存，超过上限卸载最久未用的）。
- 复用 llm 的断点续传下载框架，但模型放 data/models/embed/，与生成式 LLM 隔离。
- 主进程仍不 import torch；llama_cpp 是 CPU wheel，与生成式模型共用同一套运行时。

embedding 未就绪（模型没下载）时，kb_search 自动只用 BM25，界面如实显示，不假装向量可用。
"""

import json
import os
import threading
from collections import OrderedDict
from pathlib import Path

import storage
import llm

# bge-small-zh-v1.5：小、中文好、CPU 快，Q8_0 单文件约 95MB，16G 友好。
# repo/文件名写死，避免额外的一次仓库查询（国内网络下可能长时间无响应，照搬 llm 的纪律）。
EMBED_MODELS: dict[str, dict] = {
    "bge-small-zh": {
        "label": "BGE 中文小模型",
        "repo": "gpustack/bge-small-zh-v1.5-GGUF",
        "file": "bge-small-zh-v1.5-Q8_0.gguf",
        "expected": 95_000_000,
        "dim": 512,
    },
}
DEFAULT_EMBED_MODEL = "bge-small-zh"


def embed_root() -> Path:
    return storage.DATA_ROOT / "models" / "embed"


def model_dir(key: str) -> Path:
    return embed_root() / key


def model_file(key: str) -> Path | None:
    spec = EMBED_MODELS.get(key)
    if not spec:
        return None
    p = model_dir(key) / spec["file"]
    return p if p.is_file() else None


def ensure_model(key: str, on_status=None, on_progress=None, should_stop=None) -> Path:
    """确保 embedding 模型在本地，复用 llm 的断点续传下载（带镜像源兜底）。"""
    spec = EMBED_MODELS.get(key)
    if not spec:
        raise ValueError(f"未知的 embedding 模型：{key}")
    existing = model_file(key)
    if existing:
        return existing
    dest_dir = model_dir(key)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / spec["file"]
    part = dest.with_suffix(dest.suffix + ".part")
    last_error = None
    for base in llm._endpoints():
        host = base.split("://", 1)[-1].split("/")[0]
        if on_status:
            on_status(f"正在从 {host} 下载向量模型 {spec['label']}（约 {spec['expected']/1e6:.0f}MB）…")
        url = f"{base}/{spec['repo']}/resolve/main/{spec['file']}"
        try:
            llm._download(url, part, on_progress, should_stop, spec["expected"])
            part.replace(dest)
            return dest
        except llm.Cancelled:
            raise
        except Exception as e:  # noqa: BLE001 - 换源
            last_error = e
            llm._dead_endpoints.add(base)
    raise RuntimeError(f"向量模型下载失败：{last_error}")


# LRU 引擎缓存：同时装载数量按内存档位限制（16G 只装 1 个，32G+ 装 2 个）
_engine_lock = threading.Lock()
_engines: OrderedDict[str, object] = OrderedDict()


def _max_loaded() -> int:
    try:
        import preload
        return 1 if preload.total_ram_gb() < 30 else 2
    except Exception:
        return 1


def _engine(key: str):
    with _engine_lock:
        if key in _engines:
            _engines.move_to_end(key)
            return _engines[key]
        path = model_file(key)
        if not path:
            raise RuntimeError(f"向量模型 {key} 尚未下载")
        from llama_cpp import Llama
        eng = Llama(
            model_path=str(path),
            n_ctx=512,
            n_threads=max(1, (os.cpu_count() or 4) // 2),
            embedding=True,
            verbose=False,
        )
        _engines[key] = eng
        # 超限卸载最久未用的（close 释放内存）
        while len(_engines) > _max_loaded():
            _, old = _engines.popitem(last=False)
            try:
                old.close()  # type: ignore[attr-defined]
            except Exception:
                pass
        return eng


def embed_texts(texts: list[str], key: str) -> list[list[float]]:
    """把文本批量转成向量。llama.cpp 的 create_embedding 逐条返回。"""
    if not texts:
        return []
    eng = _engine(key)
    out: list[list[float]] = []
    for t in texts:
        vec = eng.create_embedding(t)  # type: ignore[attr-defined]
        # llama.cpp 返回结构可能是 dict（含 data[0].embedding）或直接 list
        if isinstance(vec, dict):
            data = vec.get("data") or []
            emb = data[0].get("embedding") if data else []
        elif isinstance(vec, list) and vec and isinstance(vec[0], dict):
            emb = vec[0].get("embedding") or []
        else:
            emb = vec  # type: ignore[assignment]
        out.append([float(x) for x in emb])
    return out


def status() -> dict:
    """前端展示：哪些向量模型就绪、同时装载上限。"""
    return {
        "models": [
            {"key": k, "label": v["label"], "ready": model_file(k) is not None}
            for k, v in EMBED_MODELS.items()
        ],
        "max_loaded": _max_loaded(),
        "loaded": list(_engines.keys()),
    }
