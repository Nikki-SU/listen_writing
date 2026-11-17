"""知识库检索：BM25 词法 + Embedding 向量，RRF 融合（混合检索）。

- 中文 BM25：单字 + bigram 切分，CPU 秒级、零新依赖。
- 向量：按库配置的 embedding 模型，索引落 data/kb/<kb_id>/index/<model>.jsonl。
- 多库检索：按各库 embedding_model 分组，分别查再 RRF 融合（定稿第 1 节）。
- 向量未就绪（模型没下/索引没建）时自动只用 BM25，不假装向量可用。
"""

import json
import math
import re

import kb

K1 = 1.5
B = 0.75
RRF_K = 60  # RRF 融合常数


def tokenize(text: str) -> list[str]:
    """切词：英文/数字按词，中文按单字 + 相邻 bigram。"""
    text = (text or "").lower()
    tokens: list[str] = []
    for m in re.finditer(r"[a-z0-9_]+", text):
        tokens.append(m.group())
    for seg in re.findall(r"[\u4e00-\u9fff]+", text):
        tokens.extend(seg)
        for i in range(len(seg) - 1):
            tokens.append(seg[i:i + 2])
    return tokens


def _bm25_score(query_tokens: list[str], docs_tokens: list[list[str]]) -> list[float]:
    n = len(docs_tokens)
    if not n or not query_tokens:
        return [0.0] * n
    avgdl = sum(len(d) for d in docs_tokens) / n
    df: dict[str, int] = {}
    for d in docs_tokens:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    out = []
    for d in docs_tokens:
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        dl = len(d)
        for q in query_tokens:
            f = tf.get(q, 0)
            if not f:
                continue
            idf = math.log(1 + (n - df.get(q, 0) + 0.5) / (df.get(q, 0) + 0.5))
            score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl))
        out.append(score)
    return out


# ---------------- 向量索引 ----------------

def index_path(kb_id: str, model_key: str) -> object:
    return kb.kb_dir(kb_id) / "index" / f"{model_key}.jsonl"


def build_index(kb_id: str, model_key: str, on_status=None) -> dict:
    """为库里所有 ready 文档的块算向量，落 index/<model>.jsonl。"""
    import kb_embed
    kb.get_library(kb_id)
    if not kb_embed.model_file(model_key):
        raise RuntimeError(f"向量模型 {model_key} 尚未下载")
    items = []
    docs_dir = kb.kb_dir(kb_id) / "docs"
    if docs_dir.exists():
        for sub in sorted(docs_dir.iterdir()):
            if not sub.is_dir():
                continue
            meta = kb.storage._read_json(kb.doc_meta_path(kb_id, sub.name))
            if not meta or meta.get("status") != "ready":
                continue
            for c in kb.load_chunks(kb_id, sub.name):
                items.append({"id": c["id"], "text": c["text"]})
    if not items:
        return {"built": 0, "model": model_key}
    if on_status:
        on_status(f"正在为 {len(items)} 个分块生成向量…")
    vectors = kb_embed.embed_texts([i["text"] for i in items], model_key)
    p = index_path(kb_id, model_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(str(p), "w", encoding="utf-8") as f:
        for item, vec in zip(items, vectors):
            f.write(json.dumps({"id": item["id"], "vec": vec}, ensure_ascii=False) + "\n")
    return {"built": len(items), "model": model_key}


def _load_index(kb_id: str, model_key: str) -> dict[str, list[float]]:
    p = index_path(kb_id, model_key)
    if not p.exists():
        return {}
    out = {}
    try:
        for line in open(str(p), encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            out[str(d["id"])] = d["vec"]
    except (json.JSONDecodeError, OSError):
        return {}
    return out


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


# ---------------- 混合检索 ----------------

def _corpus(library_ids: list[str]) -> list[dict]:
    corpus = []
    for kb_id in library_ids:
        try:
            lib = kb.get_library(kb_id)
        except kb.KbError:
            continue
        docs_dir = kb.kb_dir(kb_id) / "docs"
        if not docs_dir.exists():
            continue
        for d in docs_dir.iterdir():
            if not d.is_dir():
                continue
            meta = kb.storage._read_json(kb.doc_meta_path(kb_id, d.name))
            if not meta or meta.get("status") != "ready":
                continue
            for c in kb.load_chunks(kb_id, d.name):
                corpus.append({
                    "chunk": c, "kb_id": kb_id, "kb_name": lib["name"],
                    "doc_id": d.name, "doc_name": meta.get("name", d.name),
                    "embed_model": lib.get("embedding_model", ""),
                })
    return corpus


def search(query: str, library_ids: list[str], top_k: int = 8) -> dict:
    """混合检索。返回 hits + 说明本次用了哪些通道（前端如实显示）。"""
    qtokens = tokenize(query)
    corpus = _corpus(library_ids)
    if not corpus or not qtokens:
        return {"hits": [], "channels": [], "note": "无可用文档"}

    # --- BM25 通道（全库统一排）---
    bm = _bm25_score(qtokens, [tokenize(c["chunk"]["text"]) for c in corpus])
    bm_ranks = sorted(range(len(corpus)), key=lambda i: bm[i], reverse=True)

    channels = ["bm25"]
    vec_scores: dict[str, float] = {}
    # --- 向量通道：按各库 embedding_model 分组，分别查再融合 ---
    by_model: dict[str, list[int]] = {}
    for i, c in enumerate(corpus):
        model = c["embed_model"]
        if model:
            by_model.setdefault(model, []).append(i)
    if by_model:
        try:
            import kb_embed
            q_vecs = kb_embed.embed_texts([query], next(iter(by_model)))
            qv = q_vecs[0] if q_vecs else []
            if qv:
                channels.append("vector")
                for model, idxs in by_model.items():
                    vectors = _load_index(next(corpus[i]["kb_id"] for i in idxs), model)
                    if not vectors:
                        continue
                    # 若该库索引缺失，用当前模型现算（仅当查询库也用这个模型）
                    qvec = kb_embed.embed_texts([query], model)[0] if model != next(iter(by_model)) else qv
                    for i in idxs:
                        cid = corpus[i]["chunk"]["id"]
                        vec = vectors.get(cid)
                        if not vec:
                            ids = [corpus[j]["chunk"]["id"] for j in idxs]
                            texts = [corpus[j]["chunk"]["text"] for j in idxs]
                            fresh = kb_embed.embed_texts(texts, model)
                            vec = dict(zip(ids, fresh)).get(cid)
                        if vec:
                            vec_scores[cid] = _cosine(qvec, vec)
        except Exception:
            # 向量不可用（模型没下/加载失败）：静默降级 BM25，界面 channels 不含 vector
            pass

    # --- RRF 融合 ---
    vec_ranks = sorted(vec_scores, key=lambda k: vec_scores[k], reverse=True)
    rrf: dict[str, float] = {}
    def add_rrf(chunk_id: str, rank: int) -> None:
        rrf[chunk_id] = rrf.get(chunk_id, 0.0) + 1.0 / (RRF_K + rank + 1)
    for rank, i in enumerate(bm_ranks):
        if bm[i] > 0:
            add_rrf(corpus[i]["chunk"]["id"], rank)
    for rank, cid in enumerate(vec_ranks):
        if vec_scores[cid] > 0:
            add_rrf(cid, rank)

    indexed = list(enumerate(corpus))
    indexed.sort(key=lambda pair: rrf.get(pair[1]["chunk"]["id"], 0.0), reverse=True)
    hits = []
    for i, c in indexed:
        cid = c["chunk"]["id"]
        if rrf.get(cid, 0) <= 0:
            continue
        hits.append({
            "kind": "kb", "chunk_id": cid,
            "doc_id": c["doc_id"], "doc_name": c["doc_name"],
            "kb_id": c["kb_id"], "kb_name": c["kb_name"],
            "text": c["chunk"]["text"],
            "score": round(rrf[cid], 5),
            "bm25": round(bm[i], 3),
            "vector": round(vec_scores.get(cid, 0), 3),
        })
        if len(hits) >= top_k:
            break
    note = "BM25 + 向量混合" if "vector" in channels else "BM25 词法（向量模型未就绪）"
    return {"hits": hits, "channels": channels, "note": note}
