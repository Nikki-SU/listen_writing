"""知识库：全局唯一的库 + 项目引用（kb_refs），文档只存一份、分块只存一份。

设计约束（来自定稿）：
- 库只有一份；项目元数据里只存 kb_refs: [library_id...]，不复制文件、不产生第二份索引。
- 每库可配自己的 embedding 模型（本阶段检索用 BM25 词法，模型字段先留档）。
- 目录：data/kb/<kb_id>/{kb.json, docs/<doc_id>/{source,markdown.md,chunks.jsonl}, index/}
- 删除库前要报告有多少项目引用（由 API 层调用 project_ref_count）。

本模块只做存储与词法检索，不 import torch / 不 import llm，保持主后端依赖干净。
"""

import json
import re
from pathlib import Path

import storage


# ---------------- 路径 ----------------

def kb_root() -> Path:
    return storage.DATA_ROOT / "kb"


def kb_dir(kb_id: str) -> Path:
    return kb_root() / kb_id


def kb_meta_path(kb_id: str) -> Path:
    return kb_dir(kb_id) / "kb.json"


def doc_dir(kb_id: str, doc_id: str) -> Path:
    return kb_dir(kb_id) / "docs" / doc_id


def doc_meta_path(kb_id: str, doc_id: str) -> Path:
    return doc_dir(kb_id, doc_id) / "doc.json"


def doc_markdown_path(kb_id: str, doc_id: str) -> Path:
    return doc_dir(kb_id, doc_id) / "markdown.md"


def doc_chunks_path(kb_id: str, doc_id: str) -> Path:
    return doc_dir(kb_id, doc_id) / "chunks.jsonl"


# ---------------- 错误 ----------------

class KbError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------- 库 CRUD ----------------

def list_libraries() -> list[dict]:
    root = kb_root()
    if not root.exists():
        return []
    out = []
    for path in sorted(root.iterdir()):
        if not path.is_dir():
            continue
        meta = storage._read_json(path / "kb.json")
        if meta is None:
            continue
        docs = [storage._read_json(doc_meta_path(meta["id"], d.name))
                for d in (path / "docs").iterdir() if d.is_dir()] if (path / "docs").exists() else []
        docs = [d for d in docs if d]
        meta["doc_count"] = len(docs)
        meta["chunk_count"] = sum(int(d.get("chunk_count", 0)) for d in docs)
        meta["ref_count"] = project_ref_count(meta["id"])
        out.append(meta)
    return out


def create_library(name: str, embedding_model: str = "") -> dict:
    name = (name or "").strip()
    if not name:
        raise KbError("知识库名称不能为空")
    kb_id = storage.new_id()
    meta = {
        "id": kb_id,
        "name": name,
        "embedding_model": embedding_model,
        "created_at": storage.now_iso(),
        "updated_at": storage.now_iso(),
    }
    kb_dir(kb_id).mkdir(parents=True, exist_ok=True)
    (kb_dir(kb_id) / "docs").mkdir(exist_ok=True)
    (kb_dir(kb_id) / "index").mkdir(exist_ok=True)
    storage._write_json(kb_meta_path(kb_id), meta)
    return meta


def get_library(kb_id: str) -> dict:
    meta = storage._read_json(kb_meta_path(kb_id))
    if meta is None:
        raise KbError("知识库不存在", 404)
    return meta


def update_library(kb_id: str, patch: dict) -> dict:
    meta = get_library(kb_id)
    if "name" in patch:
        name = str(patch["name"]).strip()
        if not name:
            raise KbError("知识库名称不能为空")
        meta["name"] = name
    if "embedding_model" in patch:
        meta["embedding_model"] = str(patch["embedding_model"]).strip()
    meta["updated_at"] = storage.now_iso()
    storage._write_json(kb_meta_path(kb_id), meta)
    return meta


def project_ref_count(kb_id: str) -> int:
    """被多少个项目引用（删库前的提示依据）。"""
    projects = storage.projects_dir()
    if not projects.exists():
        return 0
    n = 0
    for p in projects.iterdir():
        meta = storage._read_json(p / "project.json")
        if meta and kb_id in (meta.get("kb_refs") or []):
            n += 1
    return n


def delete_library(kb_id: str, force: bool = False) -> dict:
    get_library(kb_id)
    refs = project_ref_count(kb_id)
    if refs and not force:
        raise KbError(f"有 {refs} 个项目引用这个库，请先取消引用", 409)
    import shutil
    shutil.rmtree(kb_dir(kb_id))
    return {"status": "deleted", "id": kb_id, "removed_refs": refs}


# ---------------- 项目引用 ----------------

def list_project_refs(project_id: str) -> list[str]:
    meta = storage._read_json(storage.project_dir(project_id) / "project.json")
    if meta is None:
        raise KbError("项目不存在", 404)
    return list(meta.get("kb_refs") or [])


def add_project_ref(project_id: str, kb_id: str) -> dict:
    get_library(kb_id)
    path = storage.project_dir(project_id) / "project.json"
    meta = storage._read_json(path)
    if meta is None:
        raise KbError("项目不存在", 404)
    refs = list(meta.get("kb_refs") or [])
    if kb_id not in refs:
        refs.append(kb_id)
        meta["kb_refs"] = refs
        storage._write_json(path, meta)
    return {"kb_refs": refs}


def remove_project_ref(project_id: str, kb_id: str) -> dict:
    path = storage.project_dir(project_id) / "project.json"
    meta = storage._read_json(path)
    if meta is None:
        raise KbError("项目不存在", 404)
    refs = [r for r in (meta.get("kb_refs") or []) if r != kb_id]
    meta["kb_refs"] = refs
    storage._write_json(path, meta)
    return {"kb_refs": refs}


# ---------------- 分块 ----------------

def chunk_text(text: str, max_chars: int = 800, overlap: int = 120) -> list[dict]:
    """按段落优先、超长段落再滑窗切分；返回带稳定序号的块（id 在入库时生成）。

    中文以字符计；overlap 让跨块句子不至于丢失上下文。
    """
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return []
    # 段落：连续空行分段；同时照顾标题行。
    raw_paras = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    chunks: list[str] = []
    for para in raw_paras:
        if len(para) <= max_chars:
            chunks.append(para)
            continue
        start = 0
        while start < len(para):
            end = min(start + max_chars, len(para))
            if end < len(para):
                # 尽量断在句号/分号处，减少半句
                cut = max(para.rfind("。", start + max_chars // 2, end),
                          para.rfind("；", start + max_chars // 2, end),
                          para.rfind("\n", start + max_chars // 2, end))
                if cut > start:
                    end = cut + 1
            chunks.append(para[start:end].strip())
            if end >= len(para):
                break
            start = max(start + 1, end - overlap)
    return [{"index": i, "text": c} for i, c in enumerate(chunks) if c]


def save_chunks(kb_id: str, doc_id: str, chunks: list[dict]) -> list[dict]:
    """给每个块写稳定 id（doc_id + 序号），落 chunks.jsonl。"""
    out = []
    for c in chunks:
        out.append({
            "id": f"{doc_id}:{c['index']}",
            "doc_id": doc_id,
            "index": c["index"],
            "text": c["text"],
        })
    d = doc_dir(kb_id, doc_id)
    d.mkdir(parents=True, exist_ok=True)
    storage._atomic_write_text(
        doc_chunks_path(kb_id, doc_id),
        "\n".join(json.dumps(c, ensure_ascii=False) for c in out) + ("\n" if out else ""),
    )
    return out


def load_chunks(kb_id: str, doc_id: str) -> list[dict]:
    path = doc_chunks_path(kb_id, doc_id)
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out
