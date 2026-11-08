"""存储层：人可读文本落盘（JSON / CSV / Markdown + 音频二进制目录）。

目录结构见 API_CONTRACT.md「数据目录结构」。
数据根目录默认 <项目根>/data，可用环境变量 LISTEN_WRITING_DATA 覆盖
（引导部署时前端经 File System Access API 写入的启动器会把它指向用户本地路径）。
"""

import csv
import json
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

DATA_ROOT = Path(
    os.environ.get("LISTEN_WRITING_DATA", Path(__file__).resolve().parent.parent / "data")
)

SENTENCE_COLUMNS = ["id", "recording_id", "index", "text", "start_ms", "end_ms", "speaker"]

SETTINGS_PATH = DATA_ROOT / "settings.json"

# 默认设置：没有登录界面，昵称 + 设备码就是身份；模型选择在设置页随时可改。
DEFAULT_SETTINGS = {
    "identity": {"nick": "研究者", "device_code": ""},
    "asr_model": "whisper-small",
    "llm_model": "qwen3-4b",
}


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


def _atomic_write_text(path: Path, text: str) -> None:
    """先写同目录临时文件，再原子替换。

    前端在上传后立刻轮询录制详情，而转写线程同时在改写 recording.json；
    直接覆盖写会让并发读读到空文件或半截 JSON（曾导致详情请求断连）。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def _write_json(path: Path, data: dict) -> None:
    _atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


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


def delete_recording(project_id: str, recording_id: str) -> bool:
    """删除一条录音及其音频、句子、版本、脱敏标记（整目录删除）。"""
    d = recording_dir(project_id, recording_id)
    if not d.is_dir():
        return False
    shutil.rmtree(d)
    return True


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
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=SENTENCE_COLUMNS)
            writer.writeheader()
            for s in sentences:
                writer.writerow({c: s.get(c, "") for c in SENTENCE_COLUMNS})
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


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


# ---------- 设置（身份 / 模型选择） ----------


def get_settings() -> dict:
    """读取设置；首次调用时生成设备码并落盘，保证同一台设备始终是同一个身份。"""
    settings = _read_json(SETTINGS_PATH)
    if settings is None:
        settings = {
            "identity": {"nick": DEFAULT_SETTINGS["identity"]["nick"], "device_code": _new_id()},
            "asr_model": DEFAULT_SETTINGS["asr_model"],
            "llm_model": DEFAULT_SETTINGS["llm_model"],
        }
        _write_json(SETTINGS_PATH, settings)
        return settings
    # 兼容旧文件：缺字段时补默认值，不覆盖用户已设置的内容
    identity = settings.setdefault("identity", {})
    identity.setdefault("nick", DEFAULT_SETTINGS["identity"]["nick"])
    if not identity.get("device_code"):
        identity["device_code"] = _new_id()
        _write_json(SETTINGS_PATH, settings)
    settings.setdefault("asr_model", DEFAULT_SETTINGS["asr_model"])
    settings.setdefault("llm_model", DEFAULT_SETTINGS["llm_model"])
    return settings


def update_settings(fields: dict) -> dict:
    settings = get_settings()
    identity = fields.get("identity")
    if isinstance(identity, dict):
        if "nick" in identity and str(identity["nick"]).strip():
            settings["identity"]["nick"] = str(identity["nick"]).strip()
        if "device_code" in identity and str(identity["device_code"]).strip():
            settings["identity"]["device_code"] = str(identity["device_code"]).strip()
    for key in ("asr_model", "llm_model"):
        if fields.get(key):
            settings[key] = str(fields[key])
    _write_json(SETTINGS_PATH, settings)
    return settings


# ---------- 脱敏 ----------

# 建议起点标签（PRD 第 10 节）：可编辑的预设，不是不可变清单。
# 课题模板落在项目下，录音里的标记快照类别名与占位符，模板后续改名不影响历史版本。
DEFAULT_REDACTION_CATEGORIES = [
    {"id": "person", "name": "人名", "color": "#e5484d", "placeholder": "[人名]", "enabled": True},
    {"id": "place", "name": "地点/机构", "color": "#f76808", "placeholder": "[地点/机构]", "enabled": True},
    {"id": "date_contact", "name": "日期/联系方式", "color": "#1f6feb", "placeholder": "[日期/联系方式]", "enabled": True},
    {"id": "job", "name": "职业/身份", "color": "#7c3aed", "placeholder": "[职业/身份]", "enabled": True},
]


def redaction_template_path(project_id: str) -> Path:
    return project_dir(project_id) / "redaction.json"


def get_redaction_categories(project_id: str) -> list[dict]:
    """项目级类别模板；首次访问写入默认建议标签。"""
    data = _read_json(redaction_template_path(project_id))
    if data and isinstance(data.get("categories"), list) and data["categories"]:
        return data["categories"]
    categories = [dict(c) for c in DEFAULT_REDACTION_CATEGORIES]
    _write_json(redaction_template_path(project_id), {"categories": categories})
    return categories


def save_redaction_categories(project_id: str, categories: list[dict]) -> list[dict]:
    _write_json(redaction_template_path(project_id), {"categories": categories})
    return categories


def redactions_path(project_id: str, recording_id: str) -> Path:
    return recording_dir(project_id, recording_id) / "redactions.json"


def get_redactions(project_id: str, recording_id: str) -> list[dict]:
    data = _read_json(redactions_path(project_id, recording_id))
    if not data or not isinstance(data.get("marks"), list):
        return []
    return data["marks"]


def save_redactions(project_id: str, recording_id: str, marks: list[dict]) -> list[dict]:
    _write_json(redactions_path(project_id, recording_id), {"marks": marks})
    return marks


# ---------- 版本（阶段.阶段内序号） ----------


def versions_dir(project_id: str, recording_id: str) -> Path:
    return recording_dir(project_id, recording_id) / "versions"


def version_path(project_id: str, recording_id: str, stage: int, seq: int) -> Path:
    return versions_dir(project_id, recording_id) / f"{stage}.{seq}.json"


def list_versions(project_id: str, recording_id: str) -> list[dict]:
    root = versions_dir(project_id, recording_id)
    if not root.exists():
        return []
    versions = []
    for f in root.glob("*.json"):
        v = _read_json(f)
        if v:
            versions.append(v)
    versions.sort(key=lambda v: (v.get("stage", 0), v.get("seq", 0)))
    return versions


def get_version(project_id: str, recording_id: str, stage: int, seq: int) -> dict | None:
    return _read_json(version_path(project_id, recording_id, stage, seq))


def ensure_current_version(project_id: str, recording_id: str) -> dict | None:
    """兼容旧数据：录音没有 version 字段时，从已有版本文件中推导并回填。"""
    recording = get_recording(project_id, recording_id)
    if recording is None:
        return None
    current = recording.get("version")
    if current and current.get("current"):
        return current
    versions = list_versions(project_id, recording_id)
    if not versions:
        return None
    last = versions[-1]
    current = {
        "stage": last.get("stage", 0),
        "seq": last.get("seq", 1),
        "current": last.get("version", f"{last.get('stage', 0)}.{last.get('seq', 1)}"),
    }
    update_recording(project_id, recording_id, version=current)
    return current


def commit_version(
    project_id: str,
    recording_id: str,
    sentences: list[dict],
    diff: list[dict],
    message: str,
    author_nick: str = "",
    advance_stage: bool = False,
    advance_to: int | None = None,
    redactions: list[dict] | None = None,
) -> dict:
    """提交一次改动，产生新版本号。

    - 阶段内序号 +1；`advance_stage=True` 时阶段 +1、序号归 1（如 0→1 润色、1→2 脱敏）。
    - `advance_to` 允许跨阶段推进（用户未先润色就直接脱敏时，0→2）。
    - 版本 JSON 同时保存完整句子快照、脱敏标记与本次 diff：任意两版之间可复刻。
    """
    recording = get_recording(project_id, recording_id)
    current = (recording or {}).get("version") or ensure_current_version(project_id, recording_id)
    if not current:
        current = {"stage": 0, "seq": 0}
    if advance_to is not None and advance_to > current["stage"]:
        stage, seq = advance_to, 1
    elif advance_stage:
        stage, seq = current["stage"] + 1, 1
    else:
        stage, seq = current["stage"], current["seq"] + 1
    version = {
        "recording_id": recording_id,
        "version": f"{stage}.{seq}",
        "stage": stage,
        "seq": seq,
        "parent": f"{current['stage']}.{current['seq']}",
        "author_nick": author_nick,
        "timestamp": _now_iso(),
        "message": message,
        "diff": diff,
        "sentences": sentences,
        "redactions": redactions or [],
    }
    save_version(project_id, recording_id, stage, seq, version)
    update_recording(
        project_id,
        recording_id,
        version={"stage": stage, "seq": seq, "current": f"{stage}.{seq}"},
    )
    return version


# ---------- 正文稿（Markdown） ----------


def save_transcript_md(project_id: str, recording_id: str, text: str) -> None:
    path = recording_dir(project_id, recording_id) / "transcript.md"
    _atomic_write_text(path, text)


# ---------- 版本引用（JSON） ----------


def save_version(project_id: str, recording_id: str, stage: int, seq: int, version: dict) -> None:
    _write_json(
        recording_dir(project_id, recording_id) / "versions" / f"{stage}.{seq}.json",
        version,
    )