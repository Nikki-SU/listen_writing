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
import json
import logging
import os
import re
import threading
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

RUNTIME_MISSING_MSG = (
    "本地 AI 运行时（llama-cpp-python）尚未安装，无法调用语义纠错/脱敏。"
    "请重新运行启动器，它会自动安装缺失组件。"
)

# 推理引擎按模型档位缓存：一次装载后复用，避免每次纠错都重新读几 GB 的 GGUF。
_engine_lock = threading.Lock()
_engines: dict[str, object] = {}

# llama.cpp 的 Llama 实例不保证并发安全：同一时刻只跑一个纠错任务，其余排队。
_infer_lock = threading.Lock()

# 一次提示词塞多少句：太多会超出上下文、也更容易让模型漏句；16 句实测较稳。
POLISH_BATCH = 16


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
    """去掉 Qwen3 的思考段，只留最终答案。

    GGUF 模板下思考段可能是 ` thinking… response`，也可能带 Qwen 的私有结束标记
    `<｜end▁of▁thinking｜>`（两种都兼容）。
    """
    text = re.sub(r"<think(?:ing)?>.*?</think(?:ing)?>", "", text, flags=re.S)
    text = re.sub(r"<think(?:ing)?>.*?<｜end▁of▁thinking｜>", "", text, flags=re.S)
    text = re.sub(r"^.*?<｜end▁of▁thinking｜>", "", text, flags=re.S)
    return text.strip()


_POLISH_SYSTEM = (
    "你是中文访谈转写稿的校对员。只修正明显的同音字/错别字、漏字、重复词、标点与语病；"
    "不改变说话人原意，不删信息，不做文风改写。"
    '只输出一个 JSON 数组，元素形如 {"id": "句子 id", "text": "修改后的完整句子"}；'
    "没有需要修改的句子就输出 []。不要输出解释，也不要包代码块。 /no_think"
)


def _engine(model_key: str):
    """按档位装载 llama.cpp 引擎（首次会触发 GGUF 下载）。"""
    with _engine_lock:
        if model_key not in _engines:
            from llama_cpp import Llama

            path = ensure_model(model_key)
            _engines[model_key] = Llama(
                model_path=str(path),
                n_ctx=4096,
                n_threads=max(1, (os.cpu_count() or 4) // 2),
                verbose=False,
            )
        return _engines[model_key]


def _polish_messages(batch: list[dict]) -> list[dict]:
    lines = "\n".join(f"{s['id']}\t{s.get('text', '')}" for s in batch)
    return [
        {"role": "system", "content": _POLISH_SYSTEM},
        {"role": "user", "content": "句子列表（每行：id + 制表符 + 原文）：\n" + lines},
    ]


def _parse_changes(raw: str) -> list[dict]:
    """解析模型输出。容忍代码块、前后废话与 {"changes":[...]} 包裹。"""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text).strip()
    data = None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\[.*\]", text, flags=re.S)
        if m:
            try:
                data = json.loads(m.group(0))
            except json.JSONDecodeError:
                data = None
    if isinstance(data, dict):
        data = data.get("changes") or data.get("sentences") or data.get("result")
    if not isinstance(data, list):
        raise RuntimeError(f"AI 返回内容不是 JSON 数组：{text[:120]}")
    return [item for item in data if isinstance(item, dict)]


def polish(
    sentences: list[dict],
    model_key: str | None = None,
    on_status: Callable[[str], None] | None = None,
) -> list[dict]:
    """AI 语义纠错：只返回建议，不改正文。

    返回 [{sentence_id, index, before, after}]；调用方负责让用户逐条接受。
    运行时未安装时抛 `RuntimeError(RUNTIME_MISSING_MSG)`，接口原样转给界面。
    """
    if not runtime_available():
        raise RuntimeError(RUNTIME_MISSING_MSG)
    key = model_key or DEFAULT_LLM_MODEL
    if key not in LLM_MODELS:
        raise ValueError(f"未知的 AI 模型：{key}")

    items = [s for s in sentences if str(s.get("text") or "").strip()]
    if not items:
        return []

    engine = _engine(key)
    suggestions: list[dict] = []
    with _infer_lock:
        for start in range(0, len(items), POLISH_BATCH):
            batch = items[start:start + POLISH_BATCH]
            if on_status:
                on_status(f"正在校对第 {start + 1}–{start + len(batch)} 句…")
            resp = engine.create_chat_completion(
                messages=_polish_messages(batch),
                temperature=0.2,
                top_p=0.9,
                max_tokens=min(2048, max(256, len(batch) * 160)),
            )
            raw = split_think((resp["choices"][0]["message"]["content"] or ""))
            known = {s["id"]: s for s in batch}
            for change in _parse_changes(raw):
                sid = str(change.get("id") or "")
                after = str(change.get("text") or "").strip()
                original = known.get(sid)
                if original is None or not after:
                    continue
                before = str(original.get("text") or "")
                if after == before:
                    continue
                suggestions.append({
                    "sentence_id": sid,
                    "index": int(original.get("index", 0)),
                    "before": before,
                    "after": after,
                })
    return suggestions
