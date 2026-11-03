"""listen_writing 本地后端。

产品本体：本地后端承载模型、推理、文件读写、局域网协作。
职责分层：models（类型定义）· storage（人可读文本落盘）· transcriber（可插拔 ASR）· main（HTTP 路由 + 转写调度）。

阶段 0 初始转写已实现：创建项目 → 上传录音 → 后台转写 → 分句落盘 → 生成版本引用。
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from urllib.parse import urlparse

import av

import storage
from models import APP_VERSION
from transcriber import default_transcriber

PORT = 7850
HOST = "127.0.0.1"

# 上传格式白名单：由 PyAV（faster-whisper 内部解码层）原生解码，用户无需自己转格式。
# 改这里必须同步：前端 api.formatOf、App.tsx 的 input accept、API_CONTRACT.md R-1。
AUDIO_FORMATS = ("wav", "mp3", "m4a", "wma", "flac", "ogg", "opus", "aac", "aiff")

_transcriber = default_transcriber()

# 转写是长任务，用后台线程执行；同一录音不会并发转写两次（上传即单次触发）。
_transcribe_lock = threading.Lock()
_transcribing: set[str] = set()  # "project_id/recording_id"


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

        def on_progress(p: int) -> None:
            storage.set_transcribe(project_id, recording_id, "transcribing", p)

        segments = _transcriber.transcribe(audio_path, on_progress)

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

        storage.save_sentences(project_id, recording_id, sentences)
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))
        storage.save_version(project_id, recording_id, 0, 1, {
            "recording_id": recording_id,
            "stage": 0,
            "seq": 1,
            "parent": "",
            "author_nick": "",
            "timestamp": storage.now_iso(),
            "sentence_ids": [s["id"] for s in sentences],
        })
        duration = _probe_duration_sec(audio_path)
        storage.update_recording(project_id, recording_id, duration_sec=duration)
        storage.set_transcribe(project_id, recording_id, "done", 100)
    except Exception as e:  # noqa: BLE001 - 转写失败要如实落盘
        storage.set_transcribe(project_id, recording_id, "error", 0, str(e))
    finally:
        with _transcribe_lock:
            _transcribing.discard(key)


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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format")
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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format")
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
            self._send_json({
                "recording": recording,
                "transcribe": recording.get("transcribe", {"status": "pending", "progress": 0, "error": ""}),
                "sentences": storage.load_sentences(project_id, recording_id),
            })
            return

        self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/projects":
            self._create_project()
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
        filename = self.headers.get("X-Filename") or "recording"
        fmt = (self.headers.get("X-Format") or "").strip().lower()
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