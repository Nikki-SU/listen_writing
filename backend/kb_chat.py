"""证据优先对话：会话落本人本机、检索后作答、引文回查防编造。

设计约束（定稿第 3/4 节）：
- 默认先找依据再自由作答；无依据部分须标注「材料/库中未找到直接依据」。
- 引文回查：检查回答引号里的文字是否真出现在检索块里，对不上就标红/剔除。
- 「仅依据材料与知识库」开关：打开后找不到依据就拒答。
- 会话与回答只落本人本机（data/projects/<pid>/chats/），不写 group.json、不新增群组 AI 接口。
- 复用 llm._engine + _complete（自带流式、取消、思考段剥离），主进程不 import torch。
"""

import re
from pathlib import Path

import storage


# ---------------- 会话存储 ----------------

def chats_dir(project_id: str) -> Path:
    return storage.project_dir(project_id) / "chats"


def chat_path(project_id: str, chat_id: str) -> Path:
    return chats_dir(project_id) / f"{chat_id}.json"


def list_chats(project_id: str) -> list[dict]:
    d = chats_dir(project_id)
    if not d.exists():
        return []
    out = []
    for p in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        meta = storage._read_json(p)
        if meta:
            out.append({
                "id": meta["id"],
                "title": meta.get("title", "新对话"),
                "created_at": meta.get("created_at", ""),
                "updated_at": meta.get("updated_at", ""),
                "message_count": len(meta.get("messages", [])),
            })
    return out


def get_chat(project_id: str, chat_id: str) -> dict:
    meta = storage._read_json(chat_path(project_id, chat_id))
    if meta is None:
        raise KeyError("对话不存在")
    return meta


def create_chat(project_id: str, title: str = "") -> dict:
    chat_id = storage.new_id()
    meta = {
        "id": chat_id,
        "title": title.strip() or "新对话",
        "created_at": storage.now_iso(),
        "updated_at": storage.now_iso(),
        "messages": [],
    }
    chats_dir(project_id).mkdir(parents=True, exist_ok=True)
    storage._write_json(chat_path(project_id, chat_id), meta)
    return meta


def append_messages(project_id: str, chat_id: str, messages: list[dict]) -> dict:
    meta = get_chat(project_id, chat_id)
    for m in messages:
        m.setdefault("at", storage.now_iso())
    meta["messages"].extend(messages)
    meta["updated_at"] = storage.now_iso()
    if meta["title"] == "新对话" and messages:
        first = next((m.get("text", "") for m in messages if m.get("role") == "user"), "")
        if first:
            meta["title"] = first[:24] + ("…" if len(first) > 24 else "")
    storage._write_json(chat_path(project_id, chat_id), meta)
    return meta


def delete_chat(project_id: str, chat_id: str) -> dict:
    p = chat_path(project_id, chat_id)
    if not p.exists():
        raise KeyError("对话不存在")
    p.unlink()
    return {"status": "deleted", "id": chat_id}


# ---------------- 上下文装配 ----------------

def build_sources(material_snippets: list[dict], kb_hits: list[dict]) -> tuple[str, list[dict]]:
    """把材料片段与知识库块编成 [M1]/[K1] 引用清单，返回 (上下文文本, 引用元信息)。"""
    lines: list[str] = []
    refs: list[dict] = []
    for i, s in enumerate(material_snippets, 1):
        tag = f"M{i}"
        lines.append(f"[{tag}] 材料《{s.get('doc_name', s.get('title', '材料'))}》：{s['text']}")
        refs.append({"tag": tag, "kind": "material", "text": s["text"], **{k: v for k, v in s.items() if k != "text"}})
    for i, h in enumerate(kb_hits, 1):
        tag = f"K{i}"
        lines.append(f"[{tag}] 知识库《{h.get('kb_name', '')} / {h.get('doc_name', '')}》：{h['text']}")
        refs.append({"tag": tag, "kind": "kb", "text": h["text"], **{k: v for k, v in h.items() if k != "text"}})
    return "\n".join(lines), refs


def system_prompt(only_evidence: bool) -> str:
    base = (
        "你是一个访谈研究助手。回答要简洁、有条理，用中文。\n"
        "规则：\n"
        "1. 当回答用到某条依据时，在该句末尾标注引用号，如 [M1] 或 [K2]。\n"
        "2. 没有依据支撑的部分，可以用常识补充，但必须明确写出「（材料/库中未找到直接依据）」。\n"
        "3. 引用号只能使用上下文里给出的编号，不要编造编号。\n"
        "4. 引号里的话必须是依据里逐字出现的内容，否则不要用引号。\n"
    )
    if only_evidence:
        base += "5. 严格只依据给定上下文回答；如果没有相关依据，直接回答「材料中未找到相关依据」。\n"
    return base


def verify_citations(answer: str, refs: list[dict]) -> dict:
    """引文回查：提取回答里的 [M/K n] 标签与引号内容，校验是否真在对应依据里。

    返回清洗后的答案 + 校验报告（无效引用、编造引文）。不删正常答案。
    """
    valid_tags = {r["tag"]: r["text"] for r in refs}
    used = re.findall(r"\[([MK]\d+)\]", answer)
    invalid = sorted({t for t in used if t not in valid_tags})

    # 引号内容回查：只核对使用了引用号的句中的引号，避免误伤用户原文措辞。
    fabricated: list[str] = []
    all_text = "\n".join(valid_tags.values())
    for quoted in re.findall(r"[「“\"]([^」”\"]{6,})[」”\"]", answer):
        core = quoted.strip()
        if core and core not in all_text:
            fabricated.append(core)

    cleaned = answer
    for tag in invalid:
        cleaned = cleaned.replace(f"[{tag}]", "")
    for q in fabricated:
        # 编造引文：保留文字但去掉引号，避免看起来像逐字引用
        cleaned = cleaned.replace(f"「{q}」", q).replace(f"“{q}”", q).replace(f'"{q}"', q)
    return {
        "answer": cleaned,
        "invalid_citations": invalid,
        "fabricated_quotes": fabricated,
    }


def ask(
    project_id: str,
    question: str,
    history: list[dict],
    material_snippets: list[dict],
    kb_hits: list[dict],
    only_evidence: bool,
    model_key: str,
    should_stop=None,
) -> dict:
    """证据优先作答：装配上下文 → llm 生成 → 引文回查。返回答案、引用、校验报告、上下文摘要。"""
    import llm

    context, refs = build_sources(material_snippets, kb_hits)
    messages = [
        {"role": "system", "content": system_prompt(only_evidence)},
    ]
    # 最近若干轮历史（定稿默认 6 轮，由调用方裁剪）
    for h in history:
        if h.get("role") in ("user", "assistant"):
            messages.append({"role": h["role"], "content": str(h.get("text", ""))[:2000]})
    user_content = (
        (f"以下是可用依据（引用号在方括号里）：\n{context}\n\n" if context else "（没有检索到可用依据）\n\n")
        + "问题：" + question
    )
    messages.append({"role": "user", "content": user_content})

    engine = llm._engine(model_key)
    raw = llm._complete(engine, messages, should_stop=should_stop, temperature=0.3)
    answer = llm.split_think(raw)
    check = verify_citations(answer, refs)
    return {
        "answer": check["answer"],
        "citations": refs,
        "invalid_citations": check["invalid_citations"],
        "fabricated_quotes": check["fabricated_quotes"],
        "had_evidence": bool(context),
        "context_chars": len(context),
        "context": context,
    }
