"""本地 LLM：AI 语义纠错与脱敏标记的推理引擎。

与 `transcriber.py` 同构的分层：
- 设置只存模型 key（`data/settings.json` 的 `llm_model`），这里负责把 key 翻成 GGUF 文件；
- 模型是量化后的 GGUF，首次使用时下载到 `data/models/llm/<key>/`，随项目文件夹走；
- 推理走 `llama-cpp-python`（CPU），不联网、不依赖任何外部服务；
- 运行时未安装时明确报错，由接口把原因原样返回给界面，不伪造结果。

下载源复用 `transcriber.py` 在进程启动时做出的判断（官方 HuggingFace 不通时已切到
hf-mirror.com），且 `HF_HOME` 同样落在项目文件夹。
"""

import difflib
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
        "repo": "bartowski/Qwen_Qwen3-1.7B-GGUF",
    },
    "qwen3-4b": {
        "id": "qwen3-4b",
        "label": "Qwen3-4B Q4",
        "min_ram": "16GB",
        "speed": "精度与速度折中",
        "note": "中间平衡档；默认",
        "repo": "bartowski/Qwen_Qwen3-4B-GGUF",
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
# 断句整理要看到上下文才判断得出“哪些碎片属于同一句”，一次给 60 句。
RESEGMENT_BATCH = 60


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
    "你是中文访谈转写稿的校对员。逐句检查输入，修正明显的同音字/错别字、漏字、重复词、"
    "标点与语病，删掉无意义的语气词（呃、呃那个）；不改变说话人原意，不删信息，不做文风改写。"
    '只输出一个 JSON 数组，元素形如 {"id": "句子 id", "text": "修改后的完整句子"}；'
    "只包含确实改动过的句子，没改的句子不要出现；全部无需修改就输出 []。"
    '示例：输入 "a\\t我们门今天开会呃" 输出 [{"id":"a","text":"我们今天开会"}]。'
    "不要输出解释，也不要包代码块。 /no_think"
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


def _iter_json_objects(text: str):
    """从可能被截断/带废话的文本里逐个抠出顶层对象。

    小模型经常在 max_tokens 处被硬截断，最后一个对象不完整；此时整段 json.loads
    必然失败，但前面完整的对象都是可用的，逐条解析能救回大部分建议。
    """
    i = 0
    while True:
        start = text.find("{", i)
        if start < 0:
            return
        depth = 0
        in_str = False
        escaped = False
        end = -1
        for j in range(start, len(text)):
            ch = text[j]
            if in_str:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        if end < 0:
            return
        yield text[start:end + 1]
        i = end + 1


def _parse_changes(raw: str) -> list[dict]:
    """解析模型输出。容忍代码块、前后废话、{"changes":[...]} 包裹与输出被截断。"""
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
        # 逐对象抢救：只保留模型要求的结构（id/ids + text），乱码对象自然被丢弃。
        salvaged = []
        for chunk in _iter_json_objects(text):
            try:
                obj = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict) and ("id" in obj or "ids" in obj):
                salvaged.append(obj)
        if salvaged:
            return salvaged
        raise RuntimeError(
            "AI 返回的内容不是可解析的 JSON（可能被截断）。请重试一次；"
            f"若反复出现，请在设置里换更大的模型。原始输出：{text[:120]}"
        )
    return [item for item in data if isinstance(item, dict)]


_REDACT_SYSTEM = (
    "你是中文访谈转写稿的隐私审查员。根据给定的敏感类别，逐句找出需要脱敏的原文片段。"
    "只标记真正属于该类别的连续原文（人名、电话、地址、单位、病情等），不要改写句子、不要合并片段、"
    "不要标记普通词语。只输出一个 JSON 数组，元素形如 "
    '{"id": "句子 id", "quote": "原文中连续出现的敏感片段", "category": "类别 id"}；'
    "quote 必须与原文逐字一致（不要加省略号或空格）；没有敏感内容就输出 []。"
    "不要输出解释，也不要包代码块。 /no_think"
)


def _redact_messages(batch: list[dict], categories: list[dict]) -> list[dict]:
    cat_lines = "\n".join(
        f"{c.get('id')}\t{c.get('label') or c.get('id')}" for c in categories
    )
    lines = "\n".join(f"{s['id']}\t{s.get('text', '')}" for s in batch)
    return [
        {"role": "system", "content": _REDACT_SYSTEM},
        {
            "role": "user",
            "content": (
                "敏感类别（每行：类别 id + 制表符 + 说明）：\n" + cat_lines
                + "\n\n句子列表（每行：id + 制表符 + 原文）：\n" + lines
            ),
        },
    ]


def redact(
    sentences: list[dict],
    categories: list[dict],
    model_key: str | None = None,
    on_status: Callable[[str], None] | None = None,
) -> list[dict]:
    """AI 智能脱敏：返回带字符偏移的标记建议，不直接改正文。

    模型只负责指出「哪段原文属于哪个类别」，字符偏移由服务端在原文里定位，
    避免模型给出错误下标把无关文字涂掉。
    """
    if not runtime_available():
        raise RuntimeError(RUNTIME_MISSING_MSG)
    key = model_key or DEFAULT_LLM_MODEL
    if key not in LLM_MODELS:
        raise ValueError(f"未知的 AI 模型：{key}")
    cats = [c for c in categories if c.get("id")]
    if not cats:
        return []
    placeholders = {
        str(c.get("id")): (c.get("placeholder") or f"[{c.get('label') or c.get('id')}]")
        for c in cats
    }
    items = [s for s in sentences if str(s.get("text") or "").strip()]
    if not items:
        return []

    engine = _engine(key)
    suggestions: list[dict] = []
    with _infer_lock:
        for start in range(0, len(items), POLISH_BATCH):
            batch = items[start:start + POLISH_BATCH]
            if on_status:
                on_status(f"正在扫描第 {start + 1}–{start + len(batch)} 句…")
            resp = engine.create_chat_completion(
                messages=_redact_messages(batch, cats),
                temperature=0.1,
                top_p=0.9,
                max_tokens=min(2048, max(256, len(batch) * 120)),
            )
            raw = split_think((resp["choices"][0]["message"]["content"] or ""))
            if not raw:
                continue
            known = {s["id"]: s for s in batch}
            for item in _parse_changes(raw):
                sid = str(item.get("id") or "")
                quote = str(item.get("quote") or "").strip()
                category = str(item.get("category") or "")
                original = known.get(sid)
                if original is None or not quote or category not in placeholders:
                    continue
                text = str(original.get("text") or "")
                start_at = text.find(quote)
                if start_at < 0:
                    # 模型偶尔会补标点或截断，逐字定位失败就跳过，绝不猜下标。
                    continue
                suggestions.append({
                    "sentence_id": sid,
                    "index": int(original.get("index", 0)),
                    "start": start_at,
                    "end": start_at + len(quote),
                    "quote": quote,
                    "category_id": category,
                    "placeholder": placeholders[category],
                })
    # 同一句里重叠的建议只保留最长的那条，避免前端生成嵌套标记。
    by_sentence: dict[str, list[dict]] = {}
    for s in suggestions:
        by_sentence.setdefault(s["sentence_id"], []).append(s)
    result: list[dict] = []
    for items in by_sentence.values():
        items.sort(key=lambda x: (x["start"], -(x["end"] - x["start"])))
        kept: list[dict] = []
        for item in items:
            if any(item["start"] < k["end"] and k["start"] < item["end"] for k in kept):
                continue
            kept.append(item)
        result.extend(kept)
    result.sort(key=lambda x: (x["index"], x["start"]))
    return result


_RESEGMENT_SYSTEM = (
    "你是中文访谈转写稿的断句编辑。语音识别按停顿切出的碎片经常半句一断。"
    "请只把确实属于同一句话的连续碎片合并；一条碎片如果已经是完整句子（尤其是已带句号、问号、"
    "感叹号，或本身语义完整），就让它单独成句，不要为了凑长句硬并。"
    '只输出一个 JSON 数组，元素形如 {"ids": ["id1", "id2"], "text": "合并后的完整句子"}；'
    "从第一组到最后一组必须按输入顺序覆盖所有 id，每个 id 恰好出现一次，不能漏句、不能改顺序；"
    "每组一般 1–4 条碎片，合并后不要超过约 60 字；"
    "text 只做断句、补标点、去掉单独成片的语气词（呃、嗯、那个），不增加原文没有的信息，不改写事实。"
    "示例：输入 a\\t呃那个 / b\\t我们明天 / c\\t早上九点开会 / d\\t你觉得呢 / e\\t可以"
    '输出 [{"ids":["a","b","c"],"text":"我们明天早上九点开会。"},{"ids":["d","e"],"text":"你觉得呢？可以。"}]'
    "不要输出解释，也不要包代码块。 /no_think"
)


def _resegment_messages(batch: list[dict]) -> list[dict]:
    lines = "\n".join(f"{s['id']}\t{s.get('text', '')}" for s in batch)
    return [
        {"role": "system", "content": _RESEGMENT_SYSTEM},
        {"role": "user", "content": "碎片列表（每行：id + 制表符 + 原文）：\n" + lines},
    ]


def _norm_text(text: str) -> str:
    """只保留文字与数字，用于校验 AI 没有增删事实。"""
    return re.sub(r"[\s\W_]+", "", text or "")


# 整条碎片只是语气词时，允许 AI 在合并结果里丢掉它（如「呃那个」）。
# 只认这类独立成片的词，不碰句中的「这个/那个」，避免误删指代。
_FILLER_ONLY = re.compile(r"^(?:呃|额|嗯|啊|哦|噢|欸|诶|那个)+$")

_PUNCT_RE = re.compile(r"[，。！？；：、,.!?;:]")
# 已经带句末标点的碎片就是一句完整的话，绝不能再和下一句合并。
_STRONG_END = re.compile(r"[。！？!?…]+$")


_SENTENCE_END = "。！？!?…"
_ANY_END = "，。！？；：、,.!?;:…"


def join_sentences(parts: list[str]) -> str:
    """按中文书写习惯拼接碎片，而不是把字硬粘在一起。

    - 中间碎片没有标点 → 补「，」；已有标点（ASR 常给逗号）→ 原样保留；
    - 最后一片没有句末标点 → 补「。」；以逗号/分号收尾 → 换成「。」。
    """
    texts = [str(p or "").strip() for p in parts]
    texts = [t for t in texts if t]
    if not texts:
        return ""
    last = len(texts) - 1
    joined: list[str] = []
    for i, text in enumerate(texts):
        if i < last:
            if text[-1] not in _ANY_END:
                text += "，"
        else:
            if text[-1] in "，、；：,;:":
                text = text[:-1].rstrip() + "。"
            elif text[-1] not in _SENTENCE_END:
                text += "。"
        joined.append(text)
    return "".join(joined)


def _merge_group(group: list[dict], text: str) -> dict:
    content = [s for s in group if not _FILLER_ONLY.match(_norm_text(str(s.get("text") or "")))]
    source = content or group
    base = join_sentences([str(s.get("text") or "") for s in source])
    candidate = (text or "").strip()
    # 只接受“只动标点/空格/语气词”的改写；一旦与原文实体不一致就退回逐字拼接，
    # 宁可句子不好读，也不能让 AI 悄悄改掉访谈内容。退回时用去掉语气词的 base，
    # 避免「呃那个」这类独立语气词一直粘在句首。
    merged_text = candidate if candidate and _norm_text(candidate) == _norm_text(base) else base
    if merged_text and merged_text[-1] in "，、；：,;:":
        merged_text = merged_text[:-1].rstrip()
    if merged_text and merged_text[-1] not in _SENTENCE_END:
        merged_text += "。"
    speaker = next((s.get("speaker") for s in group if s.get("speaker")), "")
    return {
        "id": group[0]["id"],
        "recording_id": group[0].get("recording_id", ""),
        "text": merged_text,
        "start_ms": group[0].get("start_ms", 0),
        "end_ms": group[-1].get("end_ms", 0),
        "speaker": speaker,
        # 给预览界面做「原文碎片 → 新句子」左右对照；落盘前会剔除。
        "source_ids": [s["id"] for s in group],
    }


def resegment(
    sentences: list[dict],
    model_key: str | None = None,
    on_status: Callable[[str], None] | None = None,
) -> list[dict]:
    """AI 断句整理：把 ASR 的碎片合并成可读句子，返回整份新句子列表。

    服务端校验每个 id 恰好用一次且顺序不变；模型只提议分组与标点，
    文字内容仍以原文为准，避免长文整理时悄悄改写事实。
    """
    if not runtime_available():
        raise RuntimeError(RUNTIME_MISSING_MSG)
    key = model_key or DEFAULT_LLM_MODEL
    if key not in LLM_MODELS:
        raise ValueError(f"未知的 AI 模型：{key}")

    items = [s for s in sentences if str(s.get("text") or "").strip()]
    if len(items) <= 1:
        return sentences

    engine = _engine(key)
    result: list[dict] = []
    with _infer_lock:
        for start in range(0, len(items), RESEGMENT_BATCH):
            batch = items[start:start + RESEGMENT_BATCH]
            if on_status:
                on_status(f"正在整理第 {start + 1}–{start + len(batch)} 句…")
            resp = engine.create_chat_completion(
                messages=_resegment_messages(batch),
                temperature=0.1,
                top_p=0.9,
                max_tokens=min(4096, max(512, len(batch) * 120)),
            )
            raw = split_think((resp["choices"][0]["message"]["content"] or ""))
            groups = _parse_changes(raw) if raw else []

            pos = {s["id"]: i for i, s in enumerate(batch)}
            cursor = 0
            for g in groups:
                ids = [str(x) for x in (g.get("ids") or []) if str(x) in pos]
                # 只接受从当前游标开始的连续片段，乱序/漏 id 的分组一律跳过；
                # 超过 8 条的分组视为模型“整段硬并”，同样跳过，保留原碎片。
                if not ids or len(ids) > 8:
                    continue
                first = pos[ids[0]]
                if first < cursor:
                    continue
                while cursor < first:
                    result.append({**batch[cursor], "source_ids": [batch[cursor]["id"]]})
                    cursor += 1
                valid = True
                for offset, sid in enumerate(ids):
                    if pos[sid] != first + offset:
                        valid = False
                        break
                if not valid:
                    continue
                group = batch[first:first + len(ids)]
                # 不跨过已经带句末标点的碎片：那是完整一句，再并就是错句。
                cut = len(group)
                for k in range(len(group) - 1):
                    if _STRONG_END.search(str(group[k].get("text") or "").strip()):
                        cut = k + 1
                        break
                if cut < len(group):
                    group = group[:cut]
                    text = ""  # 模型给的 text 覆盖了被截掉的句子，只能退回逐字拼接
                else:
                    text = str(g.get("text") or "")
                result.append(_merge_group(group, text))
                cursor = first + len(group)
            while cursor < len(batch):
                result.append({**batch[cursor], "source_ids": [batch[cursor]["id"]]})
                cursor += 1

    for i, s in enumerate(result):
        s["index"] = i
    return result


def _safe_polish(before: str, after: str) -> bool:
    """纠错建议的改动幅度守卫。

    允许同音字、错别字、标点、语气词的修改；不允许把半句补成另一句、
    也不允许整句改写。用长度比例 + 字符相似度双重约束，宁可少给建议。
    """
    a = _norm_text(before)
    b = _norm_text(after)
    if not a or not b:
        return False
    if a == b:
        # 只动了标点：允许补标点，不允许把句末标点删掉（会把稿子越改越难读）。
        return len(_PUNCT_RE.findall(after)) > len(_PUNCT_RE.findall(before))
    ratio = len(b) / len(a)
    if ratio < 0.5 or ratio > 1.7:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.5


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
    failed_batches = 0
    batch_count = 0
    last_error = ""
    with _infer_lock:
        for start in range(0, len(items), POLISH_BATCH):
            batch = items[start:start + POLISH_BATCH]
            batch_count += 1
            if on_status:
                on_status(f"正在校对第 {start + 1}–{start + len(batch)} 句…")
            resp = engine.create_chat_completion(
                messages=_polish_messages(batch),
                temperature=0.2,
                top_p=0.9,
                # 中文 + JSON 包装下 160 tokens/句偏紧，长句会在数组中间被硬截断。
                max_tokens=min(3072, max(512, len(batch) * 240)),
            )
            raw = split_think((resp["choices"][0]["message"]["content"] or ""))
            if not raw:
                continue
            known = {s["id"]: s for s in batch}
            try:
                changes = _parse_changes(raw)
            except RuntimeError as e:
                # 单批输出坏了不该拖垮整段稿子：记下来继续后面的批次。
                failed_batches += 1
                last_error = str(e)
                logger.warning("纠错批次解析失败（%s）：%s", start, e)
                continue
            for change in changes:
                sid = str(change.get("id") or "")
                after = str(change.get("text") or "").strip()
                original = known.get(sid)
                if original is None or not after:
                    continue
                before = str(original.get("text") or "")
                if after == before:
                    continue
                if not _safe_polish(before, after):
                    # 模型偶尔会把「呃那个」补成一句完整的话（凭空加事实）。
                    # 纠错只允许改错别字/标点/语气词，改动幅度异常的一律丢弃。
                    logger.warning("丢弃疑似改写的纠错建议：%r -> %r", before, after)
                    continue
                suggestions.append({
                    "sentence_id": sid,
                    "index": int(original.get("index", 0)),
                    "before": before,
                    "after": after,
                })
    if batch_count and failed_batches == batch_count:
        # 全部批次都解析失败才报错；部分失败时把已成功的建议照常返回。
        raise RuntimeError(last_error or "AI 纠错失败：模型输出无法解析")
    return suggestions
