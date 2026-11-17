"""文档 → Markdown 转换。无重型依赖：

- .md/.txt：直接读文本
- .docx：标准库 zipfile + ElementTree 解析标题/段落/表格成 Markdown（版式不保证）
- .pdf：走 MinerU 子进程 CLI（见 mineru.py），装不上明确降级，不假装可用

本模块不 import torch / transformers，保持主后端依赖干净。
"""

import re
import zipfile
import xml.etree.ElementTree as ET

import kb

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def extract_markdown(filename: str, data: bytes) -> tuple[str, str]:
    """返回 (markdown 文本, 转换方式)。无法处理时抛 kb.KbError。"""
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("md", "markdown", "txt"):
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("gbk", errors="replace")
        return text, "direct"
    if ext == "docx":
        return docx_to_markdown(data), "docx-builtin"
    if ext == "pdf":
        raise kb.KbError("PDF 需先安装文档转换组件（MinerU）", 422)
    raise kb.KbError(f"暂不支持的文件类型：.{ext}（支持 md/txt/docx/pdf）")


def _node_text(node: ET.Element) -> str:
    parts = []
    for t in node.iter(W_NS + "t"):
        parts.append(t.text or "")
    return "".join(parts).strip()


def _para_style(node: ET.Element) -> str:
    ppr = node.find(W_NS + "pPr")
    if ppr is None:
        return ""
    style = ppr.find(W_NS + "pStyle")
    if style is None:
        return ""
    return style.get(W_NS + "val", "")


def docx_to_markdown(data: bytes) -> str:
    """极简 docx → md：标题（Heading1-6 / 中文标题样式）、段落、表格。脚注/编号保真度有限。"""
    try:
        with zipfile.ZipFile(__import__("io").BytesIO(data)) as z:
            xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as e:
        raise kb.KbError(f"docx 解析失败：{e}")
    root = ET.fromstring(xml)
    body = root.find(W_NS + "body")
    if body is None:
        return ""
    lines: list[str] = []
    for child in body:
        tag = child.tag
        if tag == W_NS + "p":
            text = _node_text(child)
            if not text:
                continue
            style = _para_style(child).lower()
            m = re.search(r"heading\s*([1-6])", style)
            if m:
                level = int(m.group(1))
                lines.append("#" * level + " " + text)
            elif "title" in style:
                lines.append("# " + text)
            else:
                lines.append(text)
        elif tag == W_NS + "tbl":
            rows: list[list[str]] = []
            for tr in child.findall(W_NS + "tr"):
                cells = [_node_text(tc).replace("|", "\\|") for tc in tr.findall(W_NS + "tc")]
                rows.append(cells)
            if rows:
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                lines.append("| " + " | ".join(rows[0]) + " |")
                lines.append("| " + " | ".join(["---"] * width) + " |")
                for r in rows[1:]:
                    lines.append("| " + " | ".join(r) + " |")
    return "\n\n".join(lines)
