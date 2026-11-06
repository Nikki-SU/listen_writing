"""listen_writing 本地后端。

产品本体：本地后端承载模型、推理、文件读写、局域网协作。
职责分层：models（类型定义）· storage（人可读文本落盘）· transcriber（可插拔 ASR）· main（HTTP 路由 + 转写调度）。

阶段 0 初始转写已实现：创建项目 → 上传录音 → 后台转写 → 分句落盘 → 生成版本引用。
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlparse

import av

import diarize
import llm
import storage
from models import APP_VERSION
from transcriber import ASR_MODELS, transcriber_for

PORT = 7850
HOST = "127.0.0.1"

# 上传格式白名单：由 PyAV（faster-whisper 内部解码层）原生解码，用户无需自己转格式。
# 改这里必须同步：前端 api.formatOf、App.tsx 的 input accept、API_CONTRACT.md R-1。
AUDIO_FORMATS = ("wav", "mp3", "m4a", "wma", "flac", "ogg", "opus", "aac", "aiff")

# <audio> 需要的 MIME；不在表里的用二进制流，浏览器仍能靠扩展名/内容嗅探播放。
AUDIO_MIME = {
    "wav": "audio/wav",
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "wma": "audio/x-ms-wma",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
    "aiff": "audio/aiff",
}

# 转写是长任务，用后台线程执行；同一录音不会并发转写两次（上传即单次触发）。
_transcribe_lock = threading.Lock()
_transcribing: set[str] = set()  # "project_id/recording_id"

# 引擎按设置里的模型档位缓存：换档才重建，重复转写不必反复加载模型。
_engine_lock = threading.Lock()
_engines: dict[str, object] = {}


def _get_transcriber(model_key: str):
    with _engine_lock:
        if model_key not in _engines:
            _engines[model_key] = transcriber_for(model_key)
        return _engines[model_key]


def _probe_duration_sec(audio_path: str) -> float:
    """用 PyAV 探测音频时长（秒），失败返回 0.0 不阻塞主流程。"""
    try:
        with av.open(audio_path) as container:
            if container.duration:
                return float(container.duration / av.time_base)
            stream = container.streams.audio[0]
            return float(stream.duration * stream.time_base) if stream.duration else 0.0
    except Exception:
        return 0.0


def _run_transcribe(project_id: str, recording_id: str) -> None:
    key = f"{project_id}/{recording_id}"
    with _transcribe_lock:
        if key in _transcribing:
            return
        _transcribing.add(key)

    try:
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            return
        audio_path = recording["audio_path"]
        storage.set_transcribe(project_id, recording_id, "transcribing", 0)

        # 转写引擎按设置里选中的档位构建；未内置运行时的档位会在这里明确报错，
        # 错误原样写进转写状态，界面能直接看到原因。
        asr_key = storage.get_settings().get("asr_model") or "whisper-small"
        engine = _get_transcriber(asr_key)
        storage.update_recording(project_id, recording_id, asr_model=asr_key)

        def on_progress(p: int) -> None:
            storage.set_transcribe(project_id, recording_id, "transcribing", p)

        segments = engine.transcribe(audio_path, on_progress)

        sentences = []
        for idx, seg in enumerate(segments):
            sentences.append({
                "id": storage.new_id(),
                "recording_id": recording_id,
                "index": idx,
                "text": seg["text"],
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "speaker": seg["speaker"],
            })

        # 本地说话人聚类：失败不影响转写，只是不标发言人
        diarize.assign_speakers(audio_path, sentences)

        storage.save_sentences(project_id, recording_id, sentences)
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))
        storage.save_version(project_id, recording_id, 0, 1, {
            "recording_id": recording_id,
            "version": "0.1",
            "stage": 0,
            "seq": 1,
            "parent": "",
            "author_nick": storage.get_settings()["identity"]["nick"],
            "timestamp": storage.now_iso(),
            "message": "初始转写",
            "diff": [],
            "sentences": sentences,
        })
        duration = _probe_duration_sec(audio_path)
        storage.update_recording(
            project_id,
            recording_id,
            duration_sec=duration,
            version={"stage": 0, "seq": 1, "current": "0.1"},
        )
        storage.set_transcribe(project_id, recording_id, "done", 100)
    except Exception as e:  # noqa: BLE001 - 转写失败要如实落盘
        storage.set_transcribe(project_id, recording_id, "error", 0, str(e))
    finally:
        with _transcribe_lock:
            _transcribing.discard(key)


def _sentence_snapshot(s: dict) -> dict:
    """版本 diff 的句子快照：文字 + 发言人，保证可复刻。"""
    return {
        "id": s["id"],
        "index": s["index"],
        "text": s["text"],
        "speaker": s.get("speaker", ""),
    }


def _sentences_to_markdown(sentences: list[dict]) -> str:
    lines = ["# 转写稿", ""]
    for s in sentences:
        stamp = f"[{s['start_ms'] // 60000:02d}:{s['start_ms'] // 1000 % 60:02d}]"
        speaker = f"**{s['speaker']}** " if s["speaker"] else ""
        lines.append(f"{stamp} {speaker}{s['text']}")
    lines.append("")
    return "\n".join(lines)


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format, Range")
        # Chrome 私有网络访问（PNA）：https 的 Pages 页面请求 http://127.0.0.1 时，
        # 预检要求后端显式允许；本地回环地址本身可信，放开不影响安全边界。
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format, Range")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/health":
            self._send_json({"status": "ok"})
            return
        if path == "/api/version":
            self._send_json({"version": APP_VERSION})
            return
        if path == "/api/projects":
            self._send_json({"projects": storage.list_projects()})
            return
        if path == "/api/settings":
            self._send_json({
                "settings": storage.get_settings(),
                # 选项表由后端唯一定义（transcriber.ASR_MODELS / llm.LLM_MODELS），
                # 前端只负责渲染，避免两端各写一份标签后逐渐漂移。
                "options": {"asr": list(ASR_MODELS.values()), "llm": llm.options()},
            })
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/audio$")
        if m:
            self._send_audio(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/export$")
        if m:
            self._export_transcript(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/versions$")
        if m:
            project_id, recording_id = m
            if storage.get_recording(project_id, recording_id) is None:
                self._send_json({"error": "recording not found"}, status=404)
                return
            current = (storage.get_recording(project_id, recording_id) or {}).get("version")
            versions = []
            for v in storage.list_versions(project_id, recording_id):
                versions.append({
                    "version": v.get("version") or f"{v.get('stage', 0)}.{v.get('seq', 1)}",
                    "stage": v.get("stage"),
                    "seq": v.get("seq"),
                    "parent": v.get("parent", ""),
                    "author_nick": v.get("author_nick", ""),
                    "timestamp": v.get("timestamp", ""),
                    "message": v.get("message", ""),
                    "changes": len(v.get("diff") or []),
                })
            self._send_json({"versions": versions, "current": current})
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/versions/(\d+)\.(\d+)$")
        if m:
            project_id, recording_id, stage, seq = m
            version = storage.get_version(project_id, recording_id, int(stage), int(seq))
            if version is None:
                self._send_json({"error": "version not found"}, status=404)
                return
            # 旧数据兼容：早期版本文件只存了 sentence_ids，没有 diff / 快照
            version.setdefault("version", f"{stage}.{seq}")
            version.setdefault("diff", [])
            version.setdefault("sentences", [])
            version.setdefault("message", "")
            version.setdefault("author_nick", "")
            version.setdefault("timestamp", "")
            self._send_json({"version": version})
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings$")
        if m:
            if storage.get_project(m[0]) is None:
                self._send_json({"error": "project not found"}, status=404)
                return
            self._send_json({"recordings": storage.list_recordings(m[0])})
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)$")
        if m:
            project_id, recording_id = m
            recording = storage.get_recording(project_id, recording_id)
            if recording is None:
                self._send_json({"error": "recording not found"}, status=404)
                return
            current = storage.ensure_current_version(project_id, recording_id)
            if current and not recording.get("version"):
                recording["version"] = current
            self._send_json({
                "recording": recording,
                "transcribe": recording.get("transcribe", {"status": "pending", "progress": 0, "error": ""}),
                "sentences": storage.load_sentences(project_id, recording_id),
            })
            return

        self._send_json({"error": "not found"}, status=404)

    def do_PATCH(self):
        path = urlparse(self.path).path

        if path == "/api/settings":
            self._update_settings()
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/speakers$")
        if m:
            self._update_speakers(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/sentences/([^/]+)$")
        if m:
            self._update_sentence(*m)
            return

        self._send_json({"error": "not found"}, status=404)

    def _export_transcript(self, project_id: str, recording_id: str):
        """导出 Markdown / JSON；默认当前版本，可指定历史版本。"""
        from urllib.parse import quote

        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        query = parse_qs(urlparse(self.path).query)
        fmt = (query.get("format") or ["md"])[0]
        if fmt not in ("md", "json"):
            self._send_json({"error": "format must be md or json"}, status=400)
            return

        current = storage.ensure_current_version(project_id, recording_id) or {}
        wanted = (query.get("version") or [current.get("current", "")])[0]
        if wanted:
            try:
                stage, seq = wanted.split(".")
                version = storage.get_version(project_id, recording_id, int(stage), int(seq))
            except ValueError:
                version = None
            if version is None:
                self._send_json({"error": "version not found"}, status=404)
                return
            version.setdefault("version", wanted)
            version.setdefault("diff", [])
            version.setdefault("message", "")
            version.setdefault("author_nick", "")
            version.setdefault("timestamp", "")
            sentences = version.get("sentences") or []
        else:
            sentences = storage.load_sentences(project_id, recording_id)
            version = {"version": current.get("current", ""), "stage": 0, "seq": 1, "message": "", "author_nick": "", "timestamp": ""}

        if not sentences:
            self._send_json({"error": "该版本缺少句子快照，无法导出"}, status=409)
            return

        name = str(recording.get("name") or "transcript").rsplit(".", 1)[0]
        safe = "".join(c for c in name if c.isalnum() or c in "-_") or "transcript"
        if fmt == "md":
            body = (
                f"# {name}\n\n"
                f"- 版本：{version.get('version', '')}\n"
                f"- 导出时间：{storage.now_iso()}\n\n"
                + _sentences_to_markdown(sentences)
            ).encode("utf-8")
            ctype = "text/markdown; charset=utf-8"
        else:
            import json as _json

            speakers = []
            for s in sentences:
                if s.get("speaker") and s["speaker"] not in speakers:
                    speakers.append(s["speaker"])
            payload = {
                "recording": {"id": recording_id, "name": recording.get("name", "")},
                "version": {
                    "version": version.get("version", ""),
                    "stage": version.get("stage"),
                    "seq": version.get("seq"),
                    "message": version.get("message", ""),
                    "author_nick": version.get("author_nick", ""),
                    "timestamp": version.get("timestamp", ""),
                },
                "speakers": speakers,
                "sentences": [
                    {
                        "id": s.get("id"),
                        "index": s.get("index"),
                        "text": s.get("text"),
                        "start_ms": s.get("start_ms"),
                        "end_ms": s.get("end_ms"),
                        "speaker": s.get("speaker", ""),
                    }
                    for s in sentences
                ],
                "exported_at": storage.now_iso(),
            }
            body = _json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            ctype = "application/json; charset=utf-8"

        display_name = f"{safe or 'transcript'}-{version.get('version', 'current')}.{fmt}"
        # HTTP 头只能是 latin-1：filename 用 ASCII 兜底，中文名放 filename*（RFC 5987）
        ascii_name = f"transcript-{version.get('version', 'current')}.{fmt}"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Content-Disposition",
            f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(display_name)}",
        )
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self.end_headers()
        self.wfile.write(body)

    def _update_settings(self):
        data = self._read_json_body()
        if data is None:
            return
        asr = data.get("asr_model")
        if asr is not None and asr not in ASR_MODELS:
            self._send_json({"error": f"未知的转写模型：{asr}"}, status=400)
            return
        llm_key = data.get("llm_model")
        if llm_key is not None and llm_key not in llm.LLM_MODELS:
            self._send_json({"error": f"未知的 AI 模型：{llm_key}"}, status=400)
            return
        self._send_json({"settings": storage.update_settings(data)})

    def _read_json_body(self):
        try:
            data = json.loads(self._read_body().decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return None
        if not isinstance(data, dict):
            self._send_json({"error": "invalid json"}, status=400)
            return None
        return data

    def _update_sentence(self, project_id: str, recording_id: str, sentence_id: str):
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能修改"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            self._send_json({"error": "text is required"}, status=400)
            return
        text = text.strip()
        raw_speaker = data.get("speaker")
        if raw_speaker is not None and not isinstance(raw_speaker, str):
            self._send_json({"error": "speaker must be a string"}, status=400)
            return
        new_speaker = target_speaker = None

        sentences = storage.load_sentences(project_id, recording_id)
        target = next((s for s in sentences if s["id"] == sentence_id), None)
        if target is None:
            self._send_json({"error": "sentence not found"}, status=404)
            return
        target_speaker = target.get("speaker", "")
        new_speaker = target_speaker if raw_speaker is None else raw_speaker.strip()
        if target["text"] == text and target_speaker == new_speaker:
            current = storage.ensure_current_version(project_id, recording_id)
            self._send_json({"sentence": target, "version": current, "current": (current or {}).get("current", "")})
            return

        before = _sentence_snapshot(target)
        target["text"] = text
        target["speaker"] = new_speaker
        storage.save_sentences(project_id, recording_id, sentences)
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))

        parts = []
        if before["text"] != text:
            parts.append("文字")
        if before["speaker"] != new_speaker:
            parts.append("发言人")
        message = f"第 {target['index'] + 1} 句" + "、".join(parts) + "修改"
        diff = [{
            "sentence_id": target["id"],
            "index": target["index"],
            "op": "replace",
            "before": before,
            "after": _sentence_snapshot(target),
        }]
        nick = storage.get_settings()["identity"]["nick"]
        version = storage.commit_version(
            project_id,
            recording_id,
            sentences,
            diff,
            message=message,
            author_nick=nick,
        )
        self._send_json({"sentence": target, "version": version, "current": version["version"]})

    def _update_speakers(self, project_id: str, recording_id: str):
        """发言人改名 / 合并 / 单句拆分。任何一次操作都提交一个版本。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能修改"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        action = data.get("action")
        sentences = storage.load_sentences(project_id, recording_id)
        changed = []

        if action == "rename":
            old = str(data.get("from") or "").strip()
            new = str(data.get("to") or "").strip()
            if not old or not new:
                self._send_json({"error": "from / to 不能为空"}, status=400)
                return
            if old == new:
                self._send_json({"error": "新旧名称相同"}, status=400)
                return
            if any(s.get("speaker") == new for s in sentences):
                self._send_json({"error": "该名称已存在，如需合并请使用 merge"}, status=409)
                return
            for s in sentences:
                if s.get("speaker") == old:
                    before = _sentence_snapshot(s)
                    s["speaker"] = new
                    changed.append((before, _sentence_snapshot(s)))
            message = f"发言人「{old}」改名为「{new}」"
        elif action == "merge":
            source = str(data.get("from") or "").strip()
            into = str(data.get("into") or "").strip()
            if not source or not into or source == into:
                self._send_json({"error": "合并双方必须不同"}, status=400)
                return
            if not any(s.get("speaker") == source for s in sentences):
                self._send_json({"error": "要合并的发言人不存在"}, status=404)
                return
            for s in sentences:
                if s.get("speaker") == source:
                    before = _sentence_snapshot(s)
                    s["speaker"] = into
                    changed.append((before, _sentence_snapshot(s)))
            message = f"发言人「{source}」并入「{into}」"
        elif action == "assign":
            speaker = str(data.get("speaker") or "").strip()
            ids = data.get("sentence_ids")
            if not speaker:
                self._send_json({"error": "speaker 不能为空"}, status=400)
                return
            if not isinstance(ids, list) or not ids:
                self._send_json({"error": "sentence_ids 不能为空"}, status=400)
                return
            id_set = {str(x) for x in ids}
            for s in sentences:
                if s["id"] in id_set and s.get("speaker") != speaker:
                    before = _sentence_snapshot(s)
                    s["speaker"] = speaker
                    changed.append((before, _sentence_snapshot(s)))
            if not changed:
                self._send_json({"error": "所选句子已经是该发言人"}, status=409)
                return
            message = f"第 {'、'.join(str(s['index'] + 1) for s in sentences if s['id'] in id_set)} 句改标为「{speaker}」"
        else:
            self._send_json({"error": "action must be rename / merge / assign"}, status=400)
            return

        if not changed:
            self._send_json({"error": "没有需要修改的句子"}, status=409)
            return

        storage.save_sentences(project_id, recording_id, sentences)
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))
        diff = [
            {
                "sentence_id": after["id"],
                "index": after["index"],
                "op": "replace",
                "before": before,
                "after": after,
            }
            for before, after in changed
        ]
        nick = storage.get_settings()["identity"]["nick"]
        version = storage.commit_version(
            project_id, recording_id, sentences, diff, message=message, author_nick=nick
        )
        self._send_json({
            "sentences": sentences,
            "version": version,
            "current": version["version"],
        })

    def _send_audio(self, project_id: str, recording_id: str):
        """音频流：支持 Range，浏览器 <audio> 才能精确跳转到任意句子。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        audio_path = Path(recording.get("audio_path") or "")
        if not audio_path.is_file():
            self._send_json({"error": "audio file missing"}, status=404)
            return

        size = audio_path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get("Range") or ""
        if range_header.startswith("bytes="):
            spec = range_header[len("bytes="):].split(",")[0].strip()
            first, _, last = spec.partition("-")
            try:
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                else:
                    length = int(last)
                    start = max(0, size - length)
                    end = size - 1
            except ValueError:
                start, end = 0, size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            end = min(end, size - 1)
            status = 206

        length = end - start + 1
        mime = AUDIO_MIME.get(recording.get("format", ""), "application/octet-stream")
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        with audio_path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/projects":
            self._create_project()
            return

        if path == "/api/restart":
            # 页面把新代码写回用户文件夹后调用；启动器约定退出码 86 = 重新读取文件并重启。
            # 先回包再退出，避免前端拿不到响应。若不是通过启动器运行，进程直接结束。
            self._send_json({"status": "restarting"})
            threading.Timer(0.3, lambda: os._exit(86)).start()
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings$")
        if m:
            self._upload_recording(m[0])
            return

        self._send_json({"error": "not found"}, status=404)

    def _create_project(self):
        try:
            data = json.loads(self._read_body().decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return
        name = (data.get("name") or "").strip()
        if not name:
            self._send_json({"error": "name is required"}, status=400)
            return
        project = storage.create_project(name, data.get("description", ""))
        self._send_json({"project": project}, status=201)

    def _upload_recording(self, project_id: str):
        if storage.get_project(project_id) is None:
            self._send_json({"error": "project not found"}, status=404)
            return
        # 文件名/格式从 query 读（前端用 URLSearchParams 编码，支持中文名）；
        # 仍兼容旧的 X-Filename / X-Format 头，便于旧页面直接对上新后端。
        q = parse_qs(urlparse(self.path).query)
        filename = (q.get("name") or [self.headers.get("X-Filename") or "recording"])[0]
        fmt = (q.get("format") or [self.headers.get("X-Format") or ""])[0].strip().lower()
        if fmt not in AUDIO_FORMATS:
            fmt = _format_from_filename(filename)
        if fmt is None:
            self._send_json({"error": "unsupported audio format"}, status=400)
            return

        body = self._read_body()
        if not body:
            self._send_json({"error": "empty audio"}, status=400)
            return

        recording = storage.create_recording(project_id, filename, fmt)
        audio_path = storage.save_audio(project_id, recording["id"], fmt, body)
        storage.update_recording(project_id, recording["id"], audio_path=audio_path)
        recording = storage.get_recording(project_id, recording["id"])

        threading.Thread(
            target=_run_transcribe, args=(project_id, recording["id"]), daemon=True
        ).start()

        self._send_json({"recording": recording}, status=201)


def _format_from_filename(filename: str) -> str | None:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ext if ext in AUDIO_FORMATS else None


def _match(path: str, pattern: str):
    import re
    m = re.match(pattern, path)
    return m.groups() if m else None


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listen_writing backend listening on http://{HOST}:{PORT}")
    server.serve_forever()