"""知识库检索：BM25 词法检索（零新依赖、CPU 秒级）。

中文没有空格分词，这里用「连续汉字 bigram +  ASCII 词」混合切分，
足以在访谈稿/论文类文本上做关键词级召回。向量检索（embedding）留作阶段 B。
"""

import math
import re

import kb

K1 = 1.5
B = 0.75


def tokenize(text: str) -> list[str]:
    """切词：英文/数字按词，中文按单字 + 相邻 bigram。"""
    text = (text or "").lower()
    tokens: list[str] = []
    # 英数词
    for m in re.finditer(r"[a-z0-9_]+", text):
        tokens.append(m.group())
    # 中文单字 + bigram
    han = re.findall(r"[\u4e00-\u9fff]+", text)
    for seg in han:
        tokens.extend(seg)  # 单字
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


def search(
    query: str,
    library_ids: list[str],
    top_k: int = 8,
) -> list[dict]:
    """在给定库集合里检索，返回按分数降序的块（带库名/文档名用于引用）。"""
    qtokens = tokenize(query)
    if not qtokens:
        return []
    corpus: list[dict] = []
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
                    "chunk": c,
                    "kb_id": kb_id,
                    "kb_name": lib["name"],
                    "doc_id": d.name,
                    "doc_name": meta.get("name", d.name),
                })
    if not corpus:
        return []
    scores = _bm25_score(qtokens, [tokenize(c["chunk"]["text"]) for c in corpus])
    ranked = sorted(zip(corpus, scores), key=lambda x: x[1], reverse=True)
    out = []
    for item, score in ranked:
        if score <= 0:
            continue
        out.append({
            "kind": "kb",
            "chunk_id": item["chunk"]["id"],
            "doc_id": item["doc_id"],
            "doc_name": item["doc_name"],
            "kb_id": item["kb_id"],
            "kb_name": item["kb_name"],
            "text": item["chunk"]["text"],
            "score": round(score, 4),
        })
        if len(out) >= top_k:
            break
    return out
