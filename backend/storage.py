"""存储层：人可读文本落盘（JSON / CSV / Markdown + 音频二进制目录）。

目录结构见 API_CONTRACT.md「数据目录结构」。
数据根目录默认 <项目根>/data，可用环境变量 LISTEN_WRITING_DATA 覆盖
（引导部署时前端经 File System Access API 写入的启动器会把它指向用户本地路径）。
"""

import csv
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_ROOT = Path(
    os.environ.get("LISTEN_WRITING_DATA", Path(__file__).resolve().parent.parent / "data")
)

SENTENCE_COLUMNS = ["id", "recording_id", "index", "text", "start_ms", "end_ms", "speaker"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def now_iso() -> str:
    """对外暴露的当前时间戳（ISO 8601 UTC），统一从 storage 取。"""
    return _now_iso()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def new_id() -> str:
    """对外暴露的短 id 生成（例如句子主键），统一从 storage 取，保证生成规则一致。"""
    return _new_id()


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


# ---------- 项目 ----------


def projects_dir() -> Path:
    return DATA_ROOT / "projects"


def project_dir(project_id: str) -> Path:
    return projects_dir() / project_id


def create_project(name: str, description: str = "") -> dict:
    project = {
        "id": _new_id(),
        "name": name,
        "description": description or "",
        "created_at": _now_iso(),
    }
    _write_json(project_dir(project["id"]) / "project.json", project)
    return project


def list_projects() -> list[dict]:
    root = projects_dir()
    if not root.exists():
        return []
    projects = []
    for d in root.iterdir():
        if d.is_dir():
            p = _read_json(d / "project.json")
            if p:
                projects.append(p)
    projects.sort(key=lambda p: p.get("created_at", ""), reverse=True)
    return projects


def get_project(project_id: str) -> dict | None:
    return _read_json(project_dir(project_id) / "project.json")


# ---------- 录音 ----------


def recordings_dir(project_id: str) -> Path:
    return project_dir(project_id) / "recordings"


def recording_dir(project_id: str, recording_id: str) -> Path:
    return recordings_dir(project_id) / recording_id


def create_recording(project_id: str, name: str, fmt: str) -> dict:
    recording = {
        "id": _new_id(),
        "project_id": project_id,
        "name": name,
        "audio_path": "",  # 保存音频后回填
        "format": fmt,
        "duration_sec": 0.0,
        "created_at": _now_iso(),
        "transcribe": {"status": "pending", "progress": 0, "error": ""},
    }
    _write_json(recording_dir(project_id, recording["id"]) / "recording.json", recording)
    return recording


def save_audio(project_id: str, recording_id: str, fmt: str, data: bytes) -> str:
    ext = fmt.lower()
    audio_path = recording_dir(project_id, recording_id) / f"audio.{ext}"
    audio_path.write_bytes(data)
    return str(audio_path)


def get_recording(project_id: str, recording_id: str) -> dict | None:
    return _read_json(recording_dir(project_id, recording_id) / "recording.json")


def list_recordings(project_id: str) -> list[dict]:
    """列出项目下全部录音（按创建倒序），仅元数据、不含句子全文。"""
    root = recordings_dir(project_id)
    if not root.exists():
        return []
    recordings = []
    for d in root.iterdir():
        if d.is_dir():
            r = _read_json(d / "recording.json")
            if r:
                recordings.append(r)
    recordings.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    return recordings


def update_recording(project_id: str, recording_id: str, **fields) -> dict | None:
    recording = get_recording(project_id, recording_id)
    if recording is None:
        return None
    recording.update(fields)
    _write_json(recording_dir(project_id, recording_id) / "recording.json", recording)
    return recording


def set_transcribe(project_id: str, recording_id: str, status: str, progress: int, error: str = "") -> None:
    update_recording(
        project_id, recording_id,
        transcribe={"status": status, "progress": progress, "error": error},
    )


# ---------- 句子（CSV） ----------


def _sentences_path(project_id: str, recording_id: str) -> Path:
    return recording_dir(project_id, recording_id) / "sentences.csv"


def save_sentences(project_id: str, recording_id: str, sentences: list[dict]) -> None:
    path = _sentences_path(project_id, recording_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=SENTENCE_COLUMNS)
        writer.writeheader()
        for s in sentences:
            writer.writerow({c: s.get(c, "") for c in SENTENCE_COLUMNS})


def load_sentences(project_id: str, recording_id: str) -> list[dict]:
    path = _sentences_path(project_id, recording_id)
    if not path.exists():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        sentences = []
        for row in reader:
            sentences.append({
                "id": row["id"],
                "recording_id": row["recording_id"],
                "index": int(row["index"]),
                "text": row["text"],
                "start_ms": int(row["start_ms"]),
                "end_ms": int(row["end_ms"]),
                "speaker": row["speaker"],
            })
    return sentences


# ---------- 正文稿（Markdown） ----------


def save_transcript_md(project_id: str, recording_id: str, text: str) -> None:
    path = recording_dir(project_id, recording_id) / "transcript.md"
    path.write_text(text, encoding="utf-8")


# ---------- 版本引用（JSON） ----------


def save_version(project_id: str, recording_id: str, stage: int, seq: int, version: dict) -> None:
    _write_json(
        recording_dir(project_id, recording_id) / "versions" / f"{stage}.{seq}.json",
        version,
    )