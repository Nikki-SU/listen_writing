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

# bge-m3：中文 / 多语检索，Q4_K_M 单文件约 418MB，ModelScope 与 hf-mirror 都有，
# CPU 上可用。之前指向的 gpustack/bge-small-zh-v1.5-GGUF 仓库实际不存在（下载 404），
# 导致「向量模型一直下载不了」——这里换成真实存在的仓库。
EMBED_MODELS: dict[str, dict] = {
    "bge-m3": {
        "label": "BGE-M3 中文向量",
        "repo": "gpustack/bge-m3-GGUF",
        "file": "bge-m3-Q4_K_M.gguf",
        "expected": 437_778_496,
        "dim": 1024,
    },
}
DEFAULT_EMBED_MODEL = "bge-m3"
# 老版本库文件里记的是 bge-small-zh（当时模型根本下不下来，没有实际向量），
# 统一别名到现在的真实模型，避免旧库检索直接报「未知模型」。
_ALIASES = {"bge-small-zh": "bge-m3", "bge-small-zh-v1.5": "bge-m3"}
MODELSCOPE = "https://modelscope.cn/models"


def _canonical(key: str) -> str:
    return _ALIASES.get(key, key)


def embed_root() -> Path:
    return storage.DATA_ROOT / "models" / "embed"


def model_dir(key: str) -> Path:
    return embed_root() / _canonical(key)


def model_file(key: str) -> Path | None:
    spec = EMBED_MODELS.get(_canonical(key))
    if not spec:
        return None
    p = model_dir(key) / spec["file"]
    return p if p.is_file() else None


def ensure_model(key: str, on_status=None, on_progress=None, should_stop=None) -> Path:
    """确保 embedding 模型在本地，复用 llm 的断点续传下载（带镜像源兜底）。"""
    key = _canonical(key)
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
    # 国内优先：ModelScope 有同名 GGUF 镜像；其次 hf-mirror；官方只兜底。
    urls = [f"{MODELSCOPE}/{spec['repo']}/resolve/master/{spec['file']}"]
    for base in llm._endpoints():
        urls.append(f"{base}/{spec['repo']}/resolve/main/{spec['file']}")
    for url in urls:
        host = url.split("://", 1)[-1].split("/")[0]
        if on_status:
            on_status(f"正在从 {host} 下载向量模型 {spec['label']}（约 {spec['expected']/1e6:.0f}MB）…")
        try:
            llm._download(url, part, on_progress, should_stop, spec["expected"])
            got = part.stat().st_size if part.is_file() else 0
            if spec["expected"] and got < spec["expected"] * 0.6:
                part.unlink(missing_ok=True)
                raise RuntimeError(
                    f"下载不完整：只拿到 {got / 1e6:.0f}MB，预期约 {spec['expected'] / 1e6:.0f}MB"
                )
            part.replace(dest)
            return dest
        except llm.Cancelled:
            raise
        except Exception as e:  # noqa: BLE001 - 换源
            last_error = e
            llm._dead_endpoints.add(url)
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
    key = _canonical(key)
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
