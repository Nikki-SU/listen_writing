"""逐字稿解析：处理真实逐字稿的几种具体格式。

必须支持的格式（用户实际会导入的）：
  格式1 一行搞定（腾讯会议原文）：发言人A(00:00:04): 第一句正文。
  格式2 一行搞定（纯访谈稿）：  访谈者：你的专业是什么？
  格式3 markdown 分行（腾讯会议导出常见，带 ** 加粗）：
         **00:00:04**
         **发言人A**
         第一句正文。
        即：时间戳一行、发言人一行、正文一行（也可能是 发言人一行 + 时间戳一行）。
  格式4 markdown 同一行但加粗：**发言人A**(00:00:04): 正文 / **发言人A** 00:00:04 正文

解析结果：每句都尽量带上 speaker；只有确实没有发言人信息的行才留空。
"""

import re

# 时间戳：00:00:04 / 00:04 / 1:02:03，可带括号或方括号
_TS_CORE = r"(\d{1,2}):(\d{2})(?::(\d{2}))?"


def _clean(line: str) -> str:
    """去掉 markdown 装饰：加粗、列表符、引用符、表格竖线。"""
    s = line.strip()
    s = s.replace("**", "").replace("__", "")     # 先清加粗，避免残留单星号
    s = re.sub(r"^\s*[-*+>]\s*", "", s)            # 列表/引用
    s = s.strip("|").strip()                       # 表格
    s = s.strip("*").strip()                       # 残留单星号
    return s.strip()


def _is_time_only(s: str) -> int | None:
    """整行只有时间戳 → 返回毫秒；否则 None。"""
    m = re.match(r"^\s*[\[\(（]?\s*" + _TS_CORE + r"\s*[\]\)）]?\s*$", s)
    if not m:
        return None
    return _to_ms(m)


def _to_ms(m) -> int:
    if m.group(3) is not None:
        return (int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))) * 1000
    return int(m.group(1)) * 60 * 1000


def _to_ms_g(g, start: int) -> int:
    """从 groups 元组按起始下标取 (时/分/秒)。g[start]=时或分, g[start+1]=分或秒, g[start+2]=秒。"""
    a, b, c = g[start], g[start + 1], g[start + 2] if start + 2 < len(g) else None
    if c is not None:
        return (int(a) * 3600 + int(b) * 60 + int(c)) * 1000
    return (int(a) * 60 + int(b)) * 1000


def _split_inline(line: str) -> tuple[str, int | None, str] | None:
    """一行里同时含 发言人 + 可选时间 + 正文。返回 (who, ms, body) 或 None。

    先认「名字 + 时间戳 + 冒号 + 正文」（时间戳可带括号/方括号/裸写，昵称可含括号），
    再认「名字 + 冒号 + 正文」。时间戳用 数字:数字 结构，避免把昵称里的冒号当分隔。
    """
    s = line.strip()
    # 0) [时间] 名字：正文 —— 时间戳在行首
    m = re.match(r"^[\[\(（]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[\]\)）]\s*(.{1,30}?)\s*[:：]\s*(.+)$", s)
    if m and m.group(4).strip():
        g = m.groups()
        return m.group(4).strip(), _to_ms_g(g, 0), m.group(5).strip()
    # 1a) 名字 + (时间) 或 [时间] + 冒号 + 正文
    m = re.match(r"^(.{1,30}?)\s*[\(（\[]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[\)）\]]\s*[:：]\s*(.+)$", s)
    if m and m.group(1).strip():
        g = m.groups()
        ms = _to_ms_g(g, 1)
        return m.group(1).strip(), ms, m.group(5).strip()
    # 1b) 名字 + 裸时间 + 冒号 + 正文
    m = re.match(r"^(.{1,30}?)\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[:：]\s*(.+)$", s)
    if m and m.group(1).strip():
        g = m.groups()
        ms = _to_ms_g(g, 1)
        return m.group(1).strip(), ms, m.group(5).strip()
    # 2) 名字 + 冒号 + 正文（无时间戳）
    m = re.match(r"^([^:：]{1,30}?)\s*[:：]\s*(.+)$", s)
    if m:
        who = m.group(1).strip()
        if who and not re.fullmatch(r"\d{1,2}", who):
            return who, None, m.group(2).strip()
    return None


class _TimeGroups:
    """把 (m, 起始组号) 适配成 _to_ms 期望的 group(1/2/3) 结构。"""
    def __init__(self, m, start):
        self._m = m
        self._start = start
    def group(self, i):
        return self._m.group(self._start + i - 1)


def _looks_like_speaker(s: str) -> bool:
    """像不像一个纯发言人名：短、无句末标点、不是时间、不是长句。"""
    if not s or len(s) > 20:
        return False
    if _is_time_only(s) is not None:
        return False
    if re.search(r"[。！？!?；;，,]$", s):
        return False
    if len(s) > 10 and re.search(r"[，。！？,]", s):
        return False
    return True


def parse_transcript(text: str) -> tuple[str, list[tuple[str, int | None, str]], list[str]]:
    """返回 (题目, [(who, ms, body)], 发言人列表)。"""
    raw_lines = text.splitlines()
    first = next((ln for ln in raw_lines if ln.strip()), "")
    title = ""
    cleaned_first = _clean(first)
    if cleaned_first:
        # 题目只认 markdown「# 标题」——腾讯会议导出通常没有题目，猜别的会把第一句
        # 正文或昵称当标题删掉，宁可把内容多留一句让用户自己删，也绝不丢正文。
        if first.strip().startswith("#"):
            title = cleaned_first
    if title:
        # 只删掉题目那一行（按原行匹配）
        removed = False
        lines = []
        for ln in raw_lines:
            if not removed and ln is first:
                removed = True
                continue
            lines.append(ln)
    else:
        lines = raw_lines

    parsed: list[tuple[str, int | None, str]] = []
    cur_speaker = ""
    cur_ms: int | None = None
    pending_speaker = ""   # 上一行是纯发言人，等下一条内容
    pending_ms: int | None = None
    just_saw_time = False  # 刚读到一行「纯时间」：下一行按腾讯会议结构必是发言人

    for ln in lines:
        if not ln.strip():
            continue
        s = _clean(ln)

        # a) 整行是时间 → 记录，等待发言人/正文
        t = _is_time_only(s)
        if t is not None:
            cur_ms = t
            just_saw_time = True
            continue

        # b) 一行含发言人(+时间)+正文
        inline = _split_inline(s)
        if inline is not None:
            who, ms, body = inline
            if body:
                parsed.append((who, ms if ms is not None else cur_ms, body))
                cur_speaker, cur_ms = who, ms
                pending_speaker, pending_ms = "", None
            else:
                pending_speaker = who
                pending_ms = ms if ms is not None else cur_ms
            just_saw_time = False
            continue

        # c) 纯发言人（独占一行）。腾讯会议结构是「时间行 → 昵称行 → 正文行」，
        #    所以紧跟在时间行后的这一行一律当发言人，昵称五花八门也不必猜像不像。
        if just_saw_time or _looks_like_speaker(s):
            pending_speaker = s
            pending_ms = cur_ms
            just_saw_time = False
            continue

        # d) 正文：用待定发言人/时间，其次沿用上一位发言人
        who = pending_speaker or cur_speaker
        ms = pending_ms if pending_ms is not None else cur_ms
        parsed.append((who, ms, s))
        if pending_speaker:
            cur_speaker = pending_speaker
        pending_speaker, pending_ms = "", None
        just_saw_time = False

    speakers = list(dict.fromkeys(w for w, _, _ in parsed if w))
    return title, parsed, speakers
