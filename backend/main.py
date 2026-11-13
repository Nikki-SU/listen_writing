"""listen_writing 本地后端。

产品本体：本地后端承载模型、推理、文件读写、局域网协作。
职责分层：models（类型定义）· storage（人可读文本落盘）· transcriber（可插拔 ASR）· main（HTTP 路由 + 转写调度）。

阶段 0 初始转写已实现：创建项目 → 上传录音 → 后台转写 → 分句落盘 → 生成版本引用。
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import av
import numpy as np

import audio
import transcriber
import collab
import diarize
import leaf
import llm
import peers
import storage
from models import APP_VERSION
from transcriber import ASR_MODELS, asr_options, transcriber_for

PORT = int(os.environ.get("LISTEN_WRITING_PORT") or 7850)
HOST = "0.0.0.0"  # 局域网节点需要被其他机器访问；非局域网接口在 Handler 里限制本机回环

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

# 转写线程与用户编辑都会读改写 sentences.csv：串行化，避免边出边改时互相覆盖。
_sentence_io_lock = threading.Lock()

# AI 长任务（纠错）：后台线程跑，每批把结果写进 job，前端轮询即可逐批看到。
# 不落盘：进程重启后任务丢失，前端看到 idle 重跑即可（模型结果本身没有持久价值）。
_ai_jobs: dict[str, dict] = {}
_ai_jobs_lock = threading.Lock()


def _ai_job_key(project_id: str, recording_id: str, kind: str) -> str:
    return f"{kind}:{project_id}/{recording_id}"


def _ai_job_get(key: str) -> dict:
    with _ai_jobs_lock:
        job = _ai_jobs.get(key)
        if job is None:
            return {"status": "idle", "processed": 0, "total": 0, "message": "", "model": "", "error": ""}
        # 拷一份再返回：后台线程还在改同一个 dict，序列化时不能拿引用。
        return {
            "status": job["status"],
            "processed": job["processed"],
            "total": job["total"],
            "message": job["message"],
            "model": job["model"],
            "error": job["error"],
            "suggestions": list(job.get("suggestions") or []),
            # 整理断句用：边跑边追加的句子预览
            "sentences": list(job.get("sentences") or []),
            "before": job.get("before", 0),
            "after": job.get("after", 0),
        }


def _ai_jobs_running(key: str) -> bool:
    with _ai_jobs_lock:
        job = _ai_jobs.get(key)
        return bool(job and job["status"] == "running")


def _ai_job_cancel(key: str) -> dict:
    """请求停止任务：只置标记，后台线程在下一个 token 处退出，不会硬杀进程。"""
    with _ai_jobs_lock:
        job = _ai_jobs.get(key)
        if job is not None and job["status"] == "running":
            job["cancel"] = True
            job["message"] = "正在停止…"
    return _ai_job_get(key)

# 引擎按设置里的模型档位缓存：换档才重建，重复转写不必反复加载模型。
_engine_lock = threading.Lock()
_engines: dict[str, object] = {}


def _get_transcriber(model_key: str):
    with _engine_lock:
        if model_key not in _engines:
            _engines[model_key] = transcriber_for(model_key)
        return _engines[model_key]


# ---------- 实时录音（边说边转写） ----------
#
# 浏览器用 getUserMedia 采集 16kHz/mono/s16le PCM，按约 1 秒一批 POST 过来；
# 后端把 PCM 追加到 live.pcm，够 2 秒就切一次静音并只识别新增片段，界面因此
# 能边录边看到句子，而不是录完再干等整段转写。
_live_lock = threading.Lock()
_live_sessions: dict[str, dict] = {}

# 精转档位排序：实时为了低延迟只能落在轻量档；停止后只有设置里选了更高档才重转，
# 避免把 SenseVoice 的实时草稿反而覆盖成 Whisper small。
_ASR_RANK = {"whisper-small": 1, "sensevoice-small": 2, "qwen3-asr-0.6b": 3, "whisper-medium": 3}


def _live_asr_key() -> str:
    """实时优先 SenseVoice（轻、快），其次 Whisper small。

    必须选“模型已下载”的档位：否则第一块 PCM 会在请求线程里同步下载
    几百 MB 模型，浏览器看起来就是一直转圈，正是要避免的“干等”。
    """
    for key in ("sensevoice-small", "whisper-small"):
        if not _asr_downloaded(key):
            continue
        try:
            transcriber_for(key)
            return key
        except Exception:
            continue
    raise RuntimeError(
        "实时转写模型还没下载完：请等首启引导/设置页下载 SenseVoice 或 Whisper small 后再录"
    )


def _live_flush(session: dict, force: bool = False) -> list[dict]:
    with session["lock"]:
        path: Path = session["pcm_path"]
        if not path.is_file():
            return []
        raw = path.read_bytes()
        total = len(raw) // 2
        start = int(session.get("processed") or 0)
        if total <= start:
            return []
        if not force and total - start < 16000 * 2:
            return []

        samples = np.frombuffer(raw[start * 2:], dtype="<i2").astype(np.float32) / 32768.0
        engine = _get_transcriber(session["engine"])
        regions = audio.split_speech(samples)
        added: list[dict] = []
        consumed = 0
        for idx, (begin, end) in enumerate(regions):
            last = idx == len(regions) - 1
            # 最后一段可能还在说话，留 0.6 秒尾巴到下一批，避免把词切成两半。
            if last and not force and len(samples) - end < int(16000 * 0.6):
                break
            seg = samples[begin:end]
            if seg.size < 1600:
                consumed = end
                continue
            fd, tmp_name = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            tmp = Path(tmp_name)
            try:
                tmp.write_bytes(audio.wav_bytes(seg))
                parts = engine.transcribe(str(tmp))
            finally:
                try:
                    tmp.unlink()
                except OSError:
                    pass
            text = " ".join(str(p.get("text") or "").strip() for p in parts).strip()
            if text:
                sentence = {
                    "id": storage.new_id(),
                    "recording_id": session["recording_id"],
                    "index": len(session["sentences"]),
                    "text": text,
                    "start_ms": int((start + begin) / 16000 * 1000),
                    "end_ms": int((start + end) / 16000 * 1000),
                    "speaker": "",
                }
                session["sentences"].append(sentence)
                added.append(sentence)
                # 句级声纹特征：实时界面同样要区分说话人，不能等整段结束才算。
                try:
                    feature = diarize._sentence_feature(seg, 0, len(seg))
                except Exception:
                    feature = np.zeros(diarize.N_MFCC * 2 + 2)
                session.setdefault("features", []).append(feature)
            consumed = end

        if consumed:
            session["processed"] = start + consumed
        # 每次有新增句子就重算一次说话人：句子越多越准，界面拿到的始终是同一套标签。
        features = session.get("features") or []
        if added and len(features) >= 3:
            try:
                labels = diarize.assign_from_features(features)
                for sentence, label in zip(session["sentences"], labels):
                    sentence["speaker"] = label
            except Exception:
                pass
        if added:
            pid, rid = session["project_id"], session["recording_id"]
            storage.save_sentences(pid, rid, session["sentences"])
            storage.update_recording(pid, rid, duration_sec=round(session["processed"] / 16000, 2))
        # 返回整份列表而不是只返回新增：说话人标签会随后续句子重算，前端整体替换。
        return list(session["sentences"])


# ---------- 模型管理器（引导配置里自动下载千问等模型） ----------

_model_jobs: dict[str, dict] = {}
_model_jobs_lock = threading.Lock()


def _asr_downloaded(key: str) -> bool:
    spec = ASR_MODELS.get(key)
    if spec is None:
        return False
    engine = spec.get("engine")
    try:
        if engine == "faster-whisper":
            return not transcriber.FasterWhisperTranscriber(size=spec.get("size")).needs_download()
        if engine == "sensevoice":
            return (transcriber.SENSEVOICE_DIR / "model.int8.onnx").is_file()
        if engine == "qwen3-asr":
            return (transcriber.QWEN_ASR_DIR / "model.safetensors").is_file()
    except Exception:
        return False
    return False


def models_state() -> dict:
    """设置 / 首启引导用的模型清单：是否已下载、运行时是否可用、下载任务进度。"""
    asr = []
    for key, spec in ASR_MODELS.items():
        try:
            transcriber_for(key)
            available = True
        except Exception:
            available = False
        asr.append({
            **spec,
            "kind": "asr",
            "available": available,
            "downloaded": _asr_downloaded(key),
        })
    llm_ready = llm.runtime_available()
    llm_items = []
    for key, spec in llm.LLM_MODELS.items():
        llm_items.append({
            **spec,
            "kind": "llm",
            "available": llm_ready,
            "downloaded": llm.model_file(key) is not None,
        })
    with _model_jobs_lock:
        jobs = sorted(
            _model_jobs.values(), key=lambda j: j.get("started_at", ""), reverse=True
        )[:20]
    return {
        "asr": asr,
        "llm": llm_items,
        "jobs": jobs,
        "runtime": {"llm": llm_ready},
    }


def _set_job(job: dict, **fields) -> None:
    with _model_jobs_lock:
        job.update(fields)


def _run_model_job(job: dict) -> None:
    try:
        key = job["key"]
        if job["kind"] == "asr":
            spec = ASR_MODELS[key]
            engine = spec.get("engine")
            if engine == "sensevoice":
                ok = transcriber._ensure_sensevoice(
                    lambda msg: _set_job(job, message=msg, progress=25)
                )
            elif engine == "qwen3-asr":
                ok = transcriber._ensure_qwen_asr(
                    lambda msg: _set_job(job, message=msg, progress=25)
                )
            else:
                _set_job(job, message=f"正在下载 {job['label']}（首次约数百 MB，请保持网络畅通）…", progress=25)
                ok = transcriber.FasterWhisperTranscriber(size=spec.get("size")).ensure_model()
            if not ok:
                raise RuntimeError("下载失败，请检查网络后重试")
        else:
            def on_progress(done: int, total: int, speed: float) -> None:
                pct = min(95, 5 + int(90 * done / total)) if total else 5
                text = f"已下载 {done / 1e6:.0f}MB"
                if total:
                    text += f" / {total / 1e6:.0f}MB"
                if speed > 0:
                    text += f" · {speed / 1e6:.1f}MB/s"
                    if total and done < total:
                        text += f" · 剩余约 {max(1, int((total - done) / speed / 60))} 分钟"
                _set_job(job, message=text, progress=pct, received=done, total=total)

            llm.ensure_model(
                key,
                on_status=lambda msg: _set_job(job, message=msg),
                on_progress=on_progress,
                should_stop=lambda: job.get("cancel", False),
            )
        if job.get("cancel"):
            _set_job(job, status="cancelled", message="已停止")
        else:
            _set_job(job, status="done", progress=100, message="已就绪")
    except llm.Cancelled:
        _set_job(
            job, status="cancelled", message="已停止下载（已下载部分保留，再点下载会续传）"
        )
    except Exception as e:  # noqa: BLE001 - 下载失败原因要原样告诉用户
        _set_job(job, status="error", error=str(e), message=f"下载失败：{e}")


def start_model_job(kind: str, key: str) -> dict:
    catalog = ASR_MODELS if kind == "asr" else llm.LLM_MODELS if kind == "llm" else None
    if catalog is None:
        raise ValueError("kind 只能是 asr 或 llm")
    if key not in catalog:
        raise ValueError(f"未知模型：{key}")
    with _model_jobs_lock:
        for job in _model_jobs.values():
            if job.get("kind") == kind and job.get("key") == key and job.get("status") == "running":
                return job
        job = {
            "id": storage.new_id(),
            "kind": kind,
            "key": key,
            "label": catalog[key].get("label", key),
            "status": "running",
            "message": "准备下载…",
            "progress": 5,
            "error": "",
            "started_at": storage.now_iso(),
            "cancel": False,
            "received": 0,
            "total": 0,
        }
        _model_jobs[job["id"]] = job
    threading.Thread(target=_run_model_job, args=(job,), daemon=True).start()
    return job


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
        storage.set_transcribe(
            project_id, recording_id, "transcribing", 0, message="正在准备转写引擎…"
        )

        # 转写引擎按设置里选中的档位构建；未内置运行时的档位会在这里明确报错，
        # 错误原样写进转写状态，界面能直接看到原因。
        asr_key = storage.get_settings().get("asr_model") or "whisper-small"
        engine = _get_transcriber(asr_key)
        storage.update_recording(project_id, recording_id, asr_model=asr_key)
        storage.set_transcribe(
            project_id, recording_id, "transcribing", 0,
            message="正在加载模型并解码音频（首次使用需要下载模型，可能较久）…",
        )

        def on_progress(p: int) -> None:
            storage.set_transcribe(
                project_id, recording_id, "transcribing", p,
                message="正在转写…" if p > 0 else "正在加载模型并解码音频…",
            )

        # 边转边出：每识别一句就合入磁盘，最多等 2 秒；用户此刻的修改也会被保留。
        pending: list[dict] = []
        last_flush = [time.monotonic()]

        def flush(force: bool = False) -> None:
            if not pending:
                return
            if not force and len(pending) < 3 and time.monotonic() - last_flush[0] < 2.0:
                return
            batch = list(pending)
            pending.clear()
            last_flush[0] = time.monotonic()
            with _sentence_io_lock:
                merged = storage.load_sentences(project_id, recording_id)
                for seg in batch:
                    merged.append({
                        "id": storage.new_id(),
                        "recording_id": recording_id,
                        "index": len(merged),
                        "text": seg["text"],
                        "start_ms": seg["start_ms"],
                        "end_ms": seg["end_ms"],
                        "speaker": seg.get("speaker", ""),
                    })
                storage.save_sentences(project_id, recording_id, merged)
                storage.save_transcript_md(
                    project_id, recording_id, _sentences_to_markdown(merged)
                )

        def on_sentence(seg: dict) -> None:
            pending.append(seg)
            flush()

        engine.transcribe(audio_path, on_progress, on_sentence)
        flush(force=True)

        with _sentence_io_lock:
            sentences = storage.load_sentences(project_id, recording_id)

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
            "redactions": [],
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


def _replace_transcript(
    project_id: str,
    recording_id: str,
    engine_key: str,
    base_version: str | None = None,
    message: str = "",
    keep_draft_on_error: bool = False,
) -> None:
    """用指定模型整段重转并覆盖现有句子（实时草稿 / 旧模型的转写）。

    `base_version` 非空时只在“用户还没改过这一版”时覆盖，避免吞掉停止后已经
    做出的编辑。精转失败保留实时草稿（keep_draft_on_error），重试失败则如实报错。
    """
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
        engine = _get_transcriber(engine_key)
        collected: list[dict] = []

        def on_progress(p: int) -> None:
            storage.set_transcribe(project_id, recording_id, "transcribing", p)

        def on_sentence(seg: dict) -> None:
            collected.append({
                "id": storage.new_id(),
                "recording_id": recording_id,
                "index": len(collected),
                "text": seg["text"],
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "speaker": seg.get("speaker", ""),
            })

        engine.transcribe(audio_path, on_progress, on_sentence)

        current = (storage.get_recording(project_id, recording_id) or {}).get("version") or {}
        if base_version and current.get("current") != base_version:
            storage.set_transcribe(project_id, recording_id, "done", 100)
            return
        if not collected:
            storage.set_transcribe(project_id, recording_id, "done", 100)
            return

        diarize.assign_speakers(audio_path, collected)
        with _sentence_io_lock:
            storage.save_sentences(project_id, recording_id, collected)
            storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(collected))
        storage.commit_version(
            project_id,
            recording_id,
            collected,
            [],
            message or f"重新转写（{ASR_MODELS[engine_key]['label']}）",
            author_nick=storage.get_settings()["identity"]["nick"],
        )
        storage.update_recording(project_id, recording_id, asr_model=engine_key)
        storage.set_transcribe(project_id, recording_id, "done", 100)
    except Exception as e:  # noqa: BLE001 - 失败原因要如实落盘
        if keep_draft_on_error:
            storage.set_transcribe(project_id, recording_id, "done", 100)
        else:
            storage.set_transcribe(project_id, recording_id, "error", 0, str(e))
    finally:
        with _transcribe_lock:
            _transcribing.discard(key)


def _sentence_snapshot(s: dict) -> dict:
    """版本快照：文字 + 发言人 + 时间戳，保证任意版本都能独立复刻与导出。"""
    return {
        "id": s["id"],
        "index": s["index"],
        "text": s["text"],
        "speaker": s.get("speaker", ""),
        "start_ms": s.get("start_ms", 0),
        "end_ms": s.get("end_ms", 0),
    }


def _speaker_roster(recording: dict, sentences: list[dict]) -> list[str]:
    """发言人花名册：已登记的名字 + 句子里实际用到的名字，去重保序。

    花名册单独存在 recording.json 的 `speakers` 字段里，这样即使一条录音只有
    一个发言人，用户也能先新增“发言人2”，再逐句指派。
    """
    roster: list[str] = []
    for name in list(recording.get("speakers") or []):
        name = str(name or "").strip()
        if name and name not in roster:
            roster.append(name)
    for s in sentences:
        name = str(s.get("speaker") or "").strip()
        if name and name not in roster:
            roster.append(name)
    return roster


def _apply_redactions(sentences: list[dict], marks: list[dict]) -> list[dict]:
    """把脱敏标记替换成占位符（从后往前替换，避免坐标偏移）。"""
    grouped: dict[str, list[dict]] = {}
    for m in marks:
        grouped.setdefault(m.get("sentence_id", ""), []).append(m)
    out = []
    for s in sentences:
        text = s.get("text", "")
        for m in sorted(grouped.get(s.get("id", ""), []), key=lambda x: x.get("start", 0), reverse=True):
            start, end = int(m.get("start", 0)), int(m.get("end", 0))
            if 0 <= start < end <= len(text):
                text = text[:start] + str(m.get("placeholder") or "[已脱敏]") + text[end:]
        out.append({**s, "text": text})
    return out


def _sentences_to_markdown(sentences: list[dict]) -> str:
    lines = ["# 转写稿", ""]
    for s in sentences:
        start = int(s.get("start_ms", 0))
        stamp = f"[{start // 60000:02d}:{start // 1000 % 60:02d}]"
        speaker = f"**{s.get('speaker')}** " if s.get("speaker") else ""
        lines.append(f"{stamp} {speaker}{s.get('text', '')}")
    lines.append("")
    return "\n".join(lines)


def _without_sources(sentences: list[dict]) -> list[dict]:
    """剔除只供预览对照的 source_ids，CSV 只有固定列，不能把它带进落盘/版本。"""
    return [{k: v for k, v in s.items() if k != "source_ids"} for s in sentences]


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format, Range, X-Leaf-Token")
        # Chrome 私有网络访问（PNA）：https 的 Pages 页面请求 http://127.0.0.1 时，
        # 预检要求后端显式允许；本地回环地址本身可信，放开不影响安全边界。
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        peers.after_request(self)

    def _send_html(self, html: str, status=200):
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        peers.after_request(self)

    def _leaf_token(self) -> str:
        token = self.headers.get("X-Leaf-Token") or ""
        if token:
            return token
        return (parse_qs(urlparse(self.path).query).get("leaf_token") or [""])[0]

    def _guard_lan(self, path: str) -> bool:
        """非回环地址只开放 P2P 面、群组接口和已配对的手机叶子节点。

        数据不出局域网，但也不等于把整台机器的项目文件暴露给同网段任意设备。
        """
        client = (self.client_address or ("",))[0]
        if client in ("127.0.0.1", "::1", "localhost"):
            return True
        if path == "/m" or path == "/api/leaf/verify":
            return True
        if path.startswith("/api/peer/") or path.startswith("/api/groups") or path in ("/api/health", "/api/version"):
            return True
        # 手机配对后带 token：只放开项目/录音的读写，不放开本机专属的设置与模型管理。
        if leaf.token_ok(self._leaf_token()) and path.startswith("/api/projects"):
            return True
        self._send_json({"error": "该接口仅允许本机访问", "code": "local_only"}, status=403)
        return False

    def _peer_identity_ok(self, query: dict) -> bool:
        """项目 / 录音同步只对「昵称 + 设备码一致」的同人设备开放。"""
        mine = storage.get_settings()["identity"]
        device = (query.get("device_code") or [""])[0]
        nick = (query.get("nick") or [""])[0]
        return device == mine.get("device_code") and nick == mine.get("nick")

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    # ---- 协作路由的小工具：设备身份默认取本机设置，也允许跨设备请求显式带入 ----

    def _collab_device(self, data: dict | None = None) -> str:
        if isinstance(data, dict) and data.get("device_code"):
            return str(data["device_code"])
        q = parse_qs(urlparse(self.path).query)
        if q.get("device_code"):
            return q["device_code"][0]
        return storage.get_settings()["identity"]["device_code"]

    def _collab_nick(self, data: dict | None = None) -> str:
        if isinstance(data, dict) and data.get("nick"):
            return str(data["nick"])
        return storage.get_settings()["identity"]["nick"]

    def _collab_call(self, fn):
        try:
            self._send_json(fn())
        except collab.CollabError as e:
            self._send_json({"error": str(e)}, status=e.status)

    def _join_and_announce(self, code: str, device: str, nick: str, role: str) -> dict:
        """本机加入群组后，把成员身份告知群主节点，跨机才看得到这个成员。"""
        result = collab.join_group(code, device, nick, role)
        group = collab.try_load_group(result["id"])
        if group is not None:
            peers.push_join(group, device, nick, role)
        return result

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename, X-Format, Range, X-Leaf-Token")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if not self._guard_lan(path):
            return
        if peers.maybe_forward(self):
            return

        if path == "/m":
            self._send_html(leaf.page())
            return
        if path == "/api/leaf/info":
            # 配对码只给本机看：同网段设备拿到码就能冒充手机，配对就失去意义。
            self._send_json({
                "code": leaf.state()["code"],
                "urls": leaf.urls(PORT),
                "port": PORT,
            })
            return
        if path == "/api/health":
            self._send_json({"status": "ok"})
            return
        if path == "/api/version":
            self._send_json({"version": APP_VERSION})
            return
        if path == "/api/peers":
            self._send_json(peers.snapshot())
            return
        if path == "/api/peer/info":
            self._send_json({
                "instance": peers.INSTANCE,
                "http_port": peers.HTTP_PORT,
                "identity": storage.get_settings()["identity"],
                "groups": [g.get("id") for g in collab.try_all_groups()],
            })
            return

        q = parse_qs(urlparse(self.path).query)

        m = _match(path, r"^/api/peer/groups/by-code/([^/]+)$")
        if m:
            group = next((g for g in collab.try_all_groups() if g.get("code") == m[0]), None)
            if group is None:
                self._send_json({"error": "配对码不存在或已失效"}, status=404)
                return
            if collab.code_expired(group):
                self._send_json({"error": "配对码已过期，请让群主重新生成"}, status=410)
                return
            device = (q.get("device_code") or [""])[0]
            # 加入前还不是成员：只返回群组预览，绝不把材料原文交给未加入的节点。
            self._send_json(collab.sanitized_group(group, device))
            return

        m = _match(path, r"^/api/peer/groups/([^/]+)/snapshot$")
        if m:
            device = (q.get("device_code") or [""])[0]
            try:
                self._send_json(peers.snapshot_group(m[0], device))
            except collab.CollabError as e:
                self._send_json({"error": str(e)}, status=e.status)
            return

        m = _match(path, r"^/api/peer/projects$")
        if m:
            if not self._peer_identity_ok(q):
                self._send_json({"error": "仅同人设备可同步"}, status=403)
                return
            projects = []
            for project in storage.list_projects():
                projects.append({**project, "recordings": storage.list_recordings(project["id"])})
            self._send_json({"projects": projects})
            return

        m = _match(path, r"^/api/peer/projects/([^/]+)/recordings/([^/]+)/bundle$")
        if m:
            if not self._peer_identity_ok(q):
                self._send_json({"error": "仅同人设备可同步"}, status=403)
                return
            project_id, recording_id = m
            project = storage.get_project(project_id)
            recording = storage.get_recording(project_id, recording_id)
            if project is None or recording is None:
                self._send_json({"error": "recording not found"}, status=404)
                return
            self._send_json({
                "project": project,
                "recording": recording,
                "sentences": storage.load_sentences(project_id, recording_id),
                "redactions": storage.get_redactions(project_id, recording_id),
                "categories": storage.get_redaction_categories(project_id),
                "versions": storage.list_versions(project_id, recording_id),
            })
            return

        m = _match(path, r"^/api/peer/projects/([^/]+)/recordings/([^/]+)/audio$")
        if m:
            if not self._peer_identity_ok(q):
                self._send_json({"error": "仅同人设备可同步"}, status=403)
                return
            recording = storage.get_recording(*m)
            if recording is None:
                self._send_json({"error": "recording not found"}, status=404)
                return
            audio = Path(recording.get("audio_path") or "")
            if not audio.is_file():
                self._send_json({"error": "audio file missing"}, status=404)
                return
            self._stream_file(audio, AUDIO_MIME.get(recording.get("format", ""), "application/octet-stream"))
            return

        if path == "/api/projects":
            self._send_json({"projects": storage.list_projects()})
            return
        if path == "/api/settings":
            self._send_json({
                "settings": storage.get_settings(),
                # 选项表由后端唯一定义（transcriber.ASR_MODELS / llm.LLM_MODELS），
                # 前端只负责渲染，避免两端各写一份标签后逐渐漂移。
                "options": {"asr": asr_options(), "llm": llm.options()},
            })
            return
        if path == "/api/models":
            self._send_json(models_state())
            return

        q = parse_qs(urlparse(self.path).query)
        device = self._collab_device()

        if path == "/api/groups":
            self._collab_call(lambda: {
                "groups": collab.list_groups(device, self._collab_nick()),
                "identity": storage.get_settings()["identity"],
            })
            return

        # 审批门禁的音频流：没有批准（或烧毁/过期）一律 403，且不暴露可下载直链。
        m = _match(path, r"^/api/groups/([^/]+)/materials/([^/]+)/audio$")
        if m:
            approval_id = (q.get("approval_id") or [""])[0]
            try:
                audio_path, fmt, _approval = collab.playback_target(m[0], m[1], approval_id, device)
            except collab.CollabError as e:
                self._send_json({"error": str(e)}, status=e.status)
                return
            self._stream_file(audio_path, AUDIO_MIME.get(fmt, "application/octet-stream"))
            return

        for pattern, fn in (
            (r"^/api/groups/([^/]+)/materials$", lambda g: collab.list_materials(g, device)),
            (r"^/api/groups/([^/]+)/materials/([^/]+)/versions/([^/]+)$", lambda g, mid, v: collab.get_material_version(g, mid, v, device)),
            (r"^/api/groups/([^/]+)/materials/([^/]+)$", lambda g, mid: collab.get_material(g, mid, device)),
            (r"^/api/groups/([^/]+)/members$", lambda g: collab.members(g, device)),
            (r"^/api/groups/([^/]+)/grants$", lambda g: collab.list_grants(g, device)),
            (r"^/api/groups/([^/]+)/proposals$", lambda g: collab.list_proposals(g, device)),
            (r"^/api/groups/([^/]+)/approvals$", lambda g: collab.list_approvals(g, device)),
            (r"^/api/groups/([^/]+)/access$", lambda g: collab.access_log(g, device)),
            (r"^/api/groups/([^/]+)$", lambda g: collab.get_group(g, device)),
        ):
            m = _match(path, pattern)
            if m:
                self._collab_call(lambda m=m, fn=fn: fn(*m))
                return

        m = _match(path, r"^/api/projects/([^/]+)/redaction$")
        if m:
            if storage.get_project(m[0]) is None:
                self._send_json({"error": "project not found"}, status=404)
                return
            self._send_json({"categories": storage.get_redaction_categories(m[0])})
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/redactions$")
        if m:
            if storage.get_recording(*m) is None:
                self._send_json({"error": "recording not found"}, status=404)
                return
            self._send_json({"marks": storage.get_redactions(*m)})
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
            sentences = storage.load_sentences(project_id, recording_id)
            self._send_json({
                "recording": recording,
                "transcribe": recording.get("transcribe", {"status": "pending", "progress": 0, "error": ""}),
                "sentences": sentences,
                "redactions": storage.get_redactions(project_id, recording_id),
                "speakers": _speaker_roster(recording, sentences),
            })
            return

        # AI 纠错是后台长任务：前端轮询这个接口拿「已检查多少句 + 已出的建议」。
        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/polish$")
        if m:
            self._send_json(_ai_job_get(_ai_job_key(m[0], m[1], "polish")))
            return

        # 断句整理同理：轮询拿「已整理多少片段 + 当前合并结果」。
        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/resegment$")
        if m:
            self._send_json(_ai_job_get(_ai_job_key(m[0], m[1], "resegment")))
            return

        self._send_json({"error": "not found"}, status=404)

    def do_PATCH(self):
        path = urlparse(self.path).path
        if not self._guard_lan(path):
            return
        if peers.maybe_forward(self):
            return

        if path == "/api/settings":
            self._update_settings()
            return

        m = _match(path, r"^/api/groups/([^/]+)/members/([^/]+)$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.update_member(
                m[0], m[1], str(data.get("role") or ""), device, str(data.get("nick") or "")
            ))
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
            version.setdefault("redactions", [])
            sentences = version.get("sentences") or []
        else:
            sentences = storage.load_sentences(project_id, recording_id)
            version = {
                "version": current.get("current", ""),
                "stage": current.get("stage", 0),
                "seq": current.get("seq", 1),
                "message": "",
                "author_nick": "",
                "timestamp": "",
                "redactions": storage.get_redactions(project_id, recording_id),
            }

        if not sentences:
            self._send_json({"error": "该版本缺少句子快照，无法导出"}, status=409)
            return

        # 阶段 2 起导出物必须替换敏感信息；阶段 0/1 的版本保持原样（历史可复刻）。
        stage = int(version.get("stage") or 0)
        redactions = version.get("redactions") or []
        desensitized = stage >= 2 and bool(redactions)
        if desensitized:
            sentences = _apply_redactions(sentences, redactions)
        # 导出物绝不携带原文片段：标记里的 original 只用于界面回退。
        export_marks = [
            {
                "sentence_id": m.get("sentence_id"),
                "start": m.get("start"),
                "end": m.get("end"),
                "placeholder": m.get("placeholder"),
                "category": m.get("category_name"),
            }
            for m in redactions
        ]

        name = str(recording.get("name") or "transcript").rsplit(".", 1)[0]
        safe = "".join(c for c in name if c.isalnum() or c in "-_") or "transcript"
        if fmt == "md":
            body = (
                f"# {name}\n\n"
                f"- 版本：{version.get('version', '')}\n"
                f"- 导出时间：{storage.now_iso()}\n"
                + ("- 已脱敏：敏感信息已替换为占位符\n" if desensitized else "")
                + "\n"
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
                "desensitized": desensitized,
                "redactions": export_marks,
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
        identity = data.get("identity")
        if isinstance(identity, dict) and "device_code" in identity:
            code = str(identity.get("device_code") or "").strip()
            # 设备码会出现在配对与同步请求里：限制长度与字符，避免空码或 URL 特殊字符。
            if len(code) < 4 or len(code) > 64:
                self._send_json({"error": "设备码需为 4–64 个字符"}, status=400)
                return
            if not re.fullmatch(r"[A-Za-z0-9._:-]+", code):
                self._send_json({"error": "设备码只能包含字母、数字与 . _ : -"}, status=400)
                return
            data["identity"] = {**identity, "device_code": code}
        self._send_json({"settings": storage.update_settings(data)})

    def _live_start(self, project_id: str):
        if storage.get_project(project_id) is None:
            self._send_json({"error": "project not found"}, status=404)
            return
        data = self._read_json_body() or {}
        name = str(data.get("name") or "").strip() or f"实时录音 {time.strftime('%m-%d %H:%M')}"
        # 先确认模型可用，避免失败时在列表里留下一条空录音。
        try:
            engine_key = _live_asr_key()
        except Exception as e:  # noqa: BLE001 - 运行时缺失要明确告知
            self._send_json({"error": str(e)}, status=503)
            return
        recording = storage.create_recording(project_id, name, "wav")
        rid = recording["id"]
        pcm_path = storage.recording_dir(project_id, rid) / "live.pcm"
        pcm_path.write_bytes(b"")
        storage.set_transcribe(project_id, rid, "transcribing", 0)
        session = {
            "project_id": project_id,
            "recording_id": rid,
            "pcm_path": pcm_path,
            "engine": engine_key,
            "sentences": [],
            "processed": 0,
            "lock": threading.RLock(),
        }
        with _live_lock:
            _live_sessions[f"{project_id}/{rid}"] = session
        self._send_json(
            {"recording": storage.get_recording(project_id, rid), "asr_model": engine_key},
            status=201,
        )

    def _live_chunk(self, project_id: str, recording_id: str):
        with _live_lock:
            session = _live_sessions.get(f"{project_id}/{recording_id}")
        if session is None:
            self._send_json({"error": "实时录音会话不存在或已结束"}, status=404)
            return
        body = self._read_body()
        if not body:
            self._send_json({"sentences": [], "duration_sec": 0})
            return
        if len(body) > 4 * 1024 * 1024:
            self._send_json({"error": "单个音频块过大"}, status=413)
            return
        with session["lock"]:
            with open(session["pcm_path"], "ab") as fh:
                fh.write(body)
        try:
            all_sentences = _live_flush(session)
        except Exception as e:  # noqa: BLE001 - 模型下载 / 推理失败返回给界面提示
            self._send_json({"sentences": [], "error": str(e)}, status=503)
            return
        duration = round(
            (session["pcm_path"].stat().st_size // 2) / 16000, 2
        )
        self._send_json({"sentences": all_sentences, "duration_sec": duration})

    def _live_stop(self, project_id: str, recording_id: str):
        with _live_lock:
            session = _live_sessions.pop(f"{project_id}/{recording_id}", None)
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if session is None:
            self._send_json({"error": "实时录音会话不存在或已结束"}, status=404)
            return
        try:
            _live_flush(session, force=True)
        except Exception:
            pass
        raw = session["pcm_path"].read_bytes()
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        wav_path = storage.save_audio(project_id, recording_id, "wav", audio.wav_bytes(samples))
        duration = round(len(samples) / 16000, 2)
        sentences = session["sentences"]
        if not sentences:
            storage.update_recording(
                project_id, recording_id, audio_path=wav_path, duration_sec=duration
            )
            storage.set_transcribe(project_id, recording_id, "error", 0, "没有识别到语音，请检查麦克风音量")
            self._send_json({"recording": storage.get_recording(project_id, recording_id), "sentences": []})
            return
        # 整段音频到手后再跑一次全量聚类：实时阶段是边录边估的标签，
        # 到这里用完整音频复核，最终稿的说话人划分与「上传录音」走同一套算法。
        diarize.assign_speakers(wav_path, sentences)
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
            "message": "实时录音初始转写",
            "diff": [],
            "sentences": sentences,
            "redactions": [],
        })
        storage.update_recording(
            project_id,
            recording_id,
            audio_path=wav_path,
            duration_sec=duration,
            version={"stage": 0, "seq": 1, "current": "0.1"},
        )
        storage.set_transcribe(project_id, recording_id, "done", 100)
        # 实时只能用轻量档先出草稿；停止后按设置里的更高档模型整段精转一遍，
        # 慢一点没关系。用户若在精转完成前已编辑（版本号已变），则不覆盖。
        selected = storage.get_settings().get("asr_model") or ""
        if (
            selected
            and _ASR_RANK.get(selected, 0) > _ASR_RANK.get(session["engine"], 0)
            and _asr_downloaded(selected)
        ):
            message = f"精转写（{ASR_MODELS[selected]['label']}）"
            storage.set_transcribe(project_id, recording_id, "transcribing", 0)
            threading.Thread(
                target=_replace_transcript,
                args=(project_id, recording_id, selected, "0.1", message, True),
                daemon=True,
            ).start()
        try:
            session["pcm_path"].unlink()
        except OSError:
            pass
        self._send_json({
            "recording": storage.get_recording(project_id, recording_id),
            "sentences": sentences,
        })

    def _retry_transcribe(self, project_id: str, recording_id: str):
        """转写失败 / 用户想重跑时手动重试；旧状态先复位，避免界面卡在 error。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if not Path(recording.get("audio_path") or "").is_file():
            self._send_json({"error": "音频文件不在本机，无法重转写"}, status=409)
            return
        with _transcribe_lock:
            if f"{project_id}/{recording_id}" in _transcribing:
                self._send_json({"error": "该录音正在转写中"}, status=409)
                return
        storage.set_transcribe(project_id, recording_id, "transcribing", 0)
        asr_key = storage.get_settings().get("asr_model") or "whisper-small"
        # 重试是重做整条录音，必须覆盖旧句子；原来的增量追加会把整篇复制一遍。
        threading.Thread(
            target=_replace_transcript, args=(project_id, recording_id, asr_key), daemon=True
        ).start()
        self._send_json({"ok": True, "status": "transcribing"})

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
        status = (recording.get("transcribe") or {}).get("status")
        # 边出边改：转写中就允许改已出现的句子，不必等整段跑完。
        if status not in ("done", "transcribing"):
            self._send_json({"error": "转写尚未开始，暂不能修改"}, status=409)
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
        # 采纳 AI 纠错时把版本推进到阶段 1（文字润色）；普通修改不带这两个字段。
        advance_to = data.get("advance_to")
        if advance_to is not None:
            if isinstance(advance_to, bool) or not isinstance(advance_to, int) or advance_to < 0 or advance_to > 2:
                self._send_json({"error": "advance_to 必须是 0/1/2 的整数"}, status=400)
                return
        source = data.get("source")
        if source is not None and source != "ai_polish":
            self._send_json({"error": "source 仅支持 ai_polish"}, status=400)
            return
        new_speaker = target_speaker = None

        with _sentence_io_lock:
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

        # 转写还没跑完：先落盘让用户改，等整段结束再统一生成 0.1 版本。
        if status == "transcribing":
            self._send_json({"sentence": target, "version": None, "current": ""})
            return

        parts = []
        if before["text"] != text:
            parts.append("文字")
        if before["speaker"] != new_speaker:
            parts.append("发言人")
        message = f"第 {target['index'] + 1} 句" + "、".join(parts) + "修改"
        if source == "ai_polish":
            message = "AI 纠错采纳：" + message

        # 阶段 2 之后改文字：旧标记的坐标随之失效，必须清掉这一句的标记并留下提示，
        # 否则导出会把错误位置的文字替换成占位符。
        marks = storage.get_redactions(project_id, recording_id)
        if before["text"] != text and marks:
            current_stage = (storage.ensure_current_version(project_id, recording_id) or {}).get("stage", 0)
            if current_stage >= 2:
                stale = [m for m in marks if m.get("sentence_id") == sentence_id]
                if stale:
                    marks = [m for m in marks if m.get("sentence_id") != sentence_id]
                    storage.save_redactions(project_id, recording_id, marks)
                    message += f"；清除该句 {len(stale)} 处已失效的脱敏标记"

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
            advance_to=advance_to,
            redactions=marks,
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
        roster = _speaker_roster(recording, sentences)
        changed = []

        if action == "create":
            # 先登记名字，再逐句指派。否则一条录音只有 1 个发言人时，
            # 界面上没有第二个名字可选，用户就无法拆分说话人。
            name = str(data.get("name") or "").strip()
            if not name:
                self._send_json({"error": "name 不能为空"}, status=400)
                return
            if len(name) > 40:
                self._send_json({"error": "发言人名称最多 40 个字"}, status=400)
                return
            if name in roster:
                self._send_json({"error": "该发言人已存在"}, status=409)
                return
            roster.append(name)
            storage.update_recording(project_id, recording_id, speakers=roster)
            current = storage.ensure_current_version(project_id, recording_id) or {}
            self._send_json({
                "sentences": sentences,
                "speakers": roster,
                "version": None,
                "current": current.get("current", ""),
            })
            return
        if action == "rename":
            old = str(data.get("from") or "").strip()
            new = str(data.get("to") or "").strip()
            if not old or not new:
                self._send_json({"error": "from / to 不能为空"}, status=400)
                return
            if old == new:
                self._send_json({"error": "新旧名称相同"}, status=400)
                return
            if any(s.get("speaker") == new for s in sentences) or new in roster:
                self._send_json({"error": "该名称已存在，如需合并请使用 merge"}, status=409)
                return
            for s in sentences:
                if s.get("speaker") == old:
                    before = _sentence_snapshot(s)
                    s["speaker"] = new
                    changed.append((before, _sentence_snapshot(s)))
            roster = [new if x == old else x for x in roster]
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
            roster = [x for x in roster if x != source]
            if into not in roster:
                roster.append(into)
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
            if speaker not in roster:
                roster.append(speaker)
            message = f"第 {'、'.join(str(s['index'] + 1) for s in sentences if s['id'] in id_set)} 句改标为「{speaker}」"
        else:
            self._send_json({"error": "action must be create / rename / merge / assign"}, status=400)
            return

        if not changed:
            self._send_json({"error": "没有需要修改的句子"}, status=409)
            return

        storage.save_sentences(project_id, recording_id, sentences)
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))
        storage.update_recording(project_id, recording_id, speakers=roster)
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
            project_id, recording_id, sentences, diff, message=message, author_nick=nick,
            redactions=storage.get_redactions(project_id, recording_id),
        )
        self._send_json({
            "sentences": sentences,
            "speakers": roster,
            "version": version,
            "current": version["version"],
        })

    def _merge_sentences(self, project_id: str, recording_id: str):
        """手动合并相邻句子：ASR 常按逗号/停顿切句，用户批量勾选后合成一句。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能合并句子"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        # 两种入参：sentence_ids（单组，旧接口）或 groups（一次多组，供「间隔上色」批量合并）。
        raw_groups = data.get("groups")
        if raw_groups is not None:
            if not isinstance(raw_groups, list) or not raw_groups:
                self._send_json({"error": "groups 必须是非空数组"}, status=400)
                return
            group_ids = []
            for raw in raw_groups:
                if not isinstance(raw, list):
                    self._send_json({"error": "groups 里每一项都必须是句子 id 数组"}, status=400)
                    return
                ids = [str(x) for x in raw]
                if len(ids) >= 2:
                    group_ids.append(ids)
            if not group_ids:
                self._send_json({"error": "每组至少两句"}, status=400)
                return
        else:
            ids = data.get("sentence_ids")
            if not isinstance(ids, list) or len(ids) < 2:
                self._send_json({"error": "请至少选择两句"}, status=400)
                return
            group_ids = [[str(x) for x in ids]]

        with _sentence_io_lock:
            sentences = storage.load_sentences(project_id, recording_id)
            pos = {s["id"]: i for i, s in enumerate(sentences)}
            ranges = []
            for ids in group_ids:
                if any(x not in pos for x in ids):
                    self._send_json({"error": "所选句子已不存在（可能被其他端修改），请刷新后重试"}, status=400)
                    return
                positions = sorted(pos[x] for x in ids)
                if len(set(positions)) != len(positions):
                    self._send_json({"error": "同一句不能重复出现在合并组里"}, status=400)
                    return
                first, last = positions[0], positions[-1]
                # 只能合并相邻句子：跳过中间句会让文字顺序错乱。
                if last - first + 1 != len(positions):
                    self._send_json({"error": "只能合并相邻的句子，请连续选择"}, status=400)
                    return
                ranges.append((first, last))
            ranges.sort()
            for a, b in zip(ranges, ranges[1:]):
                if a[1] >= b[0]:
                    self._send_json({"error": "合并组之间不能重叠"}, status=400)
                    return

            new_sentences = []
            cursor = 0
            removed_ids = set()
            pairs = []  # (合并前快照, 合并后的句子对象)
            merged_log = []
            for first, last in ranges:
                new_sentences.extend(sentences[cursor:first])
                group = sentences[first:last + 1]
                merged_text = llm.join_sentences([str(s.get("text") or "") for s in group])
                speaker = next((s.get("speaker") for s in group if s.get("speaker")), "")
                merged = {
                    **group[0],
                    "text": merged_text,
                    "speaker": speaker,
                    "end_ms": group[-1].get("end_ms", group[0].get("end_ms", 0)),
                }
                new_sentences.append(merged)
                pairs.append((_sentence_snapshot(group[0]), merged))
                removed_ids.update(s["id"] for s in group[1:])
                merged_log.append((first + 1, last + 1, len(group)))
                cursor = last + 1
            new_sentences.extend(sentences[cursor:])
            sentences = new_sentences
            for i, s in enumerate(sentences):
                s["index"] = i

            storage.save_sentences(project_id, recording_id, sentences)
            storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(sentences))

            # 被合并掉的句子其脱敏坐标已无意义；首句只是追加文字，标记仍然有效。
            marks = storage.get_redactions(project_id, recording_id)
            kept_marks = []
            dropped = 0
            for m in marks:
                if str(m.get("sentence_id") or "") in removed_ids:
                    dropped += 1
                    continue
                kept_marks.append(m)
            if dropped:
                storage.save_redactions(project_id, recording_id, kept_marks)

        if len(merged_log) == 1:
            first_no, last_no, count = merged_log[0]
            message = f"合并第 {first_no}–{last_no} 句（{count} 句并 1 句）"
        else:
            total = sum(item[2] for item in merged_log)
            message = f"批量合并 {len(merged_log)} 组（{total} 句并 {len(merged_log)} 句）"
        if dropped:
            message += f"；清除被合并句的 {dropped} 处脱敏标记"
        diff = [{
            "sentence_id": merged["id"],
            "index": merged["index"],
            "op": "replace",
            "before": before,
            "after": _sentence_snapshot(merged),
        } for before, merged in pairs]
        nick = storage.get_settings()["identity"]["nick"]
        version = storage.commit_version(
            project_id,
            recording_id,
            sentences,
            diff,
            message=message,
            author_nick=nick,
            redactions=kept_marks,
        )
        self._send_json({
            "sentences": sentences,
            "redactions": kept_marks,
            "version": version,
            "current": version["version"],
        })

    def _add_redactions(self, project_id: str, recording_id: str):
        """新增脱敏标记。坐标基于原句文字，提交版本并推进到阶段 2。

        标记快照类别名与占位符，之后改模板不会改变历史版本的语义。
        """
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能脱敏"}, status=409)
            return
        data = self._read_json_body()
        if data is None:
            return
        incoming = data.get("marks")
        if not isinstance(incoming, list) or not incoming:
            self._send_json({"error": "marks 必须是非空数组"}, status=400)
            return

        sentences = storage.load_sentences(project_id, recording_id)
        by_id = {s["id"]: s for s in sentences}
        categories = {c["id"]: c for c in storage.get_redaction_categories(project_id)}
        marks = storage.get_redactions(project_id, recording_id)
        added, diff = [], []

        for item in incoming:
            if not isinstance(item, dict):
                self._send_json({"error": "mark 项必须是对象"}, status=400)
                return
            sid = str(item.get("sentence_id") or "")
            target = by_id.get(sid)
            if target is None:
                self._send_json({"error": f"句子不存在：{sid}"}, status=400)
                return
            category = categories.get(str(item.get("category_id") or ""))
            if category is None:
                self._send_json({"error": "类别不存在，请先在类别管理里创建"}, status=400)
                return
            text = target.get("text", "")
            try:
                start, end = int(item.get("start")), int(item.get("end"))
            except (TypeError, ValueError):
                self._send_json({"error": "start / end 必须是整数"}, status=400)
                return
            while start < end and text[start].isspace():
                start += 1
            while end > start and text[end - 1].isspace():
                end -= 1
            if start < 0 or end > len(text) or start >= end:
                self._send_json({"error": "标记位置超出句子范围"}, status=400)
                return
            if any(
                m.get("sentence_id") == sid and start < int(m.get("end", 0)) and end > int(m.get("start", 0))
                for m in marks
            ):
                self._send_json({"error": "与已有脱敏标记重叠"}, status=400)
                return

            original = text[start:end]
            mark = {
                "id": storage.new_id(),
                "sentence_id": sid,
                "start": start,
                "end": end,
                "original": original,
                "category_id": category["id"],
                "category_name": category["name"],
                "placeholder": category.get("placeholder") or f"[{category['name']}]",
                "color": category.get("color", "#e5484d"),
                "timestamp": storage.now_iso(),
            }
            marks.append(mark)
            added.append(mark)
            diff.append({
                "sentence_id": sid,
                "index": target["index"],
                "kind": "redaction",
                "category": category["name"],
                "before": original,
                "after": mark["placeholder"],
            })

        order = {s["id"]: s["index"] for s in sentences}
        marks.sort(key=lambda m: (order.get(m.get("sentence_id", ""), 0), int(m.get("start", 0))))
        storage.save_redactions(project_id, recording_id, marks)
        version = storage.commit_version(
            project_id,
            recording_id,
            [_sentence_snapshot(s) for s in sentences],
            diff,
            message=f"新增 {len(added)} 处脱敏标记",
            author_nick=storage.get_settings()["identity"]["nick"],
            advance_to=2,
            redactions=marks,
        )
        self._send_json({"marks": marks, "version": version, "current": version["version"]})

    def _delete_redaction(self, project_id: str, recording_id: str, mark_id: str):
        """移除一处脱敏标记；同样提交版本，保证“撤掉”也留痕。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        marks = storage.get_redactions(project_id, recording_id)
        target = next((m for m in marks if m.get("id") == mark_id), None)
        if target is None:
            self._send_json({"error": "mark not found"}, status=404)
            return
        remaining = [m for m in marks if m.get("id") != mark_id]
        storage.save_redactions(project_id, recording_id, remaining)
        sentences = storage.load_sentences(project_id, recording_id)
        index = next((s["index"] for s in sentences if s["id"] == target.get("sentence_id")), 0)
        diff = [{
            "sentence_id": target.get("sentence_id"),
            "index": index,
            "kind": "redaction",
            "category": target.get("category_name", ""),
            "before": target.get("placeholder", ""),
            "after": target.get("original", ""),
        }]
        version = storage.commit_version(
            project_id,
            recording_id,
            [_sentence_snapshot(s) for s in sentences],
            diff,
            message="移除 1 处脱敏标记",
            author_nick=storage.get_settings()["identity"]["nick"],
            redactions=remaining,
        )
        self._send_json({"marks": remaining, "version": version, "current": version["version"]})

    def _delete_recording(self, project_id: str, recording_id: str):
        """删除录音：音频、转写句子、所有版本与脱敏标记一起删掉。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        # 只认本进程内真的在跑的转写。recording.json 里的 transcribing 可能是上次
        # 进程被杀/重启留下的孤儿状态，不能因为它就永久拒绝删除。
        key = f"{project_id}/{recording_id}"
        with _transcribe_lock:
            running = key in _transcribing
        if running:
            self._send_json({"error": "这条录音正在转写，等转写结束（或失败）后再删除"}, status=409)
            return
        if not storage.delete_recording(project_id, recording_id):
            self._send_json({"error": "recording not found"}, status=404)
            return
        self._send_json({"ok": True})

    def _polish_recording(self, project_id: str, recording_id: str):
        """AI 语义纠错：只给建议，不改正文；采纳由用户逐句 PATCH 完成。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能进行 AI 纠错"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        model_key = str(
            data.get("model")
            or storage.get_settings().get("llm_model")
            or llm.DEFAULT_LLM_MODEL
        )
        if model_key not in llm.LLM_MODELS:
            self._send_json({"error": f"未知的 AI 模型：{model_key}"}, status=400)
            return
        # 运行时没装时明确拒绝，而不是返回空建议假装成功（工程纪律「不许 hack」）。
        if not llm.runtime_available():
            self._send_json({"error": llm.RUNTIME_MISSING_MSG}, status=503)
            return
        # 模型没下载时不能在这个请求线程里同步拉几 GB：界面会长时间无反馈、像卡死。
        # 明确让前端先走模型下载任务，下载完成后再点。
        if llm.model_file(model_key) is None:
            self._send_json({
                "error": f"AI 模型「{llm.LLM_MODELS[model_key]['label']}」尚未下载，请先在「设置 → AI 模型」下载",
                "need_download": {"kind": "llm", "key": model_key},
            }, status=409)
            return

        sentences = storage.load_sentences(project_id, recording_id)
        items = [s for s in sentences if str(s.get("text") or "").strip()]
        if not items:
            self._send_json({"error": "没有可校对的句子"}, status=409)
            return

        key = _ai_job_key(project_id, recording_id, "polish")
        if _ai_jobs_running(key):
            # 已经跑起来了：返回当前进度，前端继续轮询，不再起第二个线程。
            self._send_json(_ai_job_get(key), status=202)
            return

        total = len(items)
        job = {
            "status": "running",
            "processed": 0,
            "total": total,
            "message": "正在加载模型…",
            "model": model_key,
            "error": "",
            "suggestions": [],
            "cancel": False,
        }
        with _ai_jobs_lock:
            _ai_jobs[key] = job

        def on_status(message: str) -> None:
            with _ai_jobs_lock:
                job["message"] = message

        def on_batch(found: list[dict], processed: int) -> None:
            with _ai_jobs_lock:
                job["suggestions"] = list(found)
                job["processed"] = processed
                job["message"] = f"已检查 {processed}/{total} 句，发现 {len(found)} 条建议"

        def run() -> None:
            try:
                result = llm.polish(
                    items, model_key, on_status, on_batch,
                    should_stop=lambda: job.get("cancel", False),
                )
            except llm.Cancelled:
                with _ai_jobs_lock:
                    job["status"] = "cancelled"
                    job["message"] = f"已停止，保留已完成的 {len(job.get('suggestions') or [])} 条建议"
                return
            except Exception as e:  # noqa: BLE001 - 下载/推理失败原因要原样告知用户
                with _ai_jobs_lock:
                    job["status"] = "error"
                    job["error"] = f"AI 纠错失败：{e}"
                return
            with _ai_jobs_lock:
                job["suggestions"] = result
                job["status"] = "done"
                job["processed"] = total
                job["message"] = f"完成，共 {len(result)} 条建议"

        # 1 小时录音 4B CPU 上要 20 分钟以上：必须立即返回，让前端边跑边轮询。
        threading.Thread(target=run, daemon=True).start()
        self._send_json(_ai_job_get(key), status=202)

    def _resegment_recording(self, project_id: str, recording_id: str):
        """AI 整理断句：把按停顿切碎的片段合并成人类可读的句子。

        默认只返回预览；`apply=true` 才写入新版本（阶段 1）。已有脱敏标记时拒绝，
        因为合并会改变句 id 与字符坐标，旧标记会错位。
        """
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能整理断句"}, status=409)
            return
        if storage.get_redactions(project_id, recording_id):
            self._send_json({"error": "已有脱敏标记，整理断句会让标记错位；请先撤销标记再整理"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        model_key = str(
            data.get("model")
            or storage.get_settings().get("llm_model")
            or llm.DEFAULT_LLM_MODEL
        )
        if model_key not in llm.LLM_MODELS:
            self._send_json({"error": f"未知的 AI 模型：{model_key}"}, status=400)
            return
        if not llm.runtime_available():
            self._send_json({"error": llm.RUNTIME_MISSING_MSG}, status=503)
            return
        if llm.model_file(model_key) is None:
            self._send_json({
                "error": f"AI 模型「{llm.LLM_MODELS[model_key]['label']}」尚未下载，请先在「设置 → AI 模型」下载",
                "need_download": {"kind": "llm", "key": model_key},
            }, status=409)
            return

        sentences = storage.load_sentences(project_id, recording_id)
        if not sentences:
            self._send_json({"error": "没有可整理的句子"}, status=409)
            return

        items = [s for s in sentences if str(s.get("text") or "").strip()]
        key = _ai_job_key(project_id, recording_id, "resegment")
        # 预览和「应用」之间稿子可能被改过：用签名确认预览结果仍然对应当前正文，
        # 对不上就重算，绝不把旧结果硬套到新稿子上（工程纪律「不许 hack」）。
        signature = "\n".join(f"{s['id']}:{s.get('text', '')}" for s in sentences)
        applied = bool(data.get("apply"))

        if applied:
            merged: list[dict] | None = None
            with _ai_jobs_lock:
                job = _ai_jobs.get(key)
                if job and job["status"] == "done" and job.get("signature") == signature:
                    merged = list(job["sentences"])
            if merged is None:
                try:
                    merged = llm.resegment(items, model_key)
                except Exception as e:  # noqa: BLE001 - 下载/推理失败原因要原样告知用户
                    self._send_json({"error": f"AI 整理断句失败：{e}"}, status=503)
                    return
        else:
            if _ai_jobs_running(key):
                self._send_json(_ai_job_get(key), status=202)
                return
            total = len(items)
            job = {
                "status": "running",
                "processed": 0,
                "total": total,
                "message": "正在加载模型…",
                "model": model_key,
                "error": "",
                "suggestions": [],
                "sentences": [],
                "before": len(sentences),
                "after": 0,
                "signature": signature,
                "cancel": False,
            }
            with _ai_jobs_lock:
                _ai_jobs[key] = job

            def on_status(message: str) -> None:
                with _ai_jobs_lock:
                    job["message"] = message

            def on_batch(partial: list[dict], processed: int) -> None:
                with _ai_jobs_lock:
                    job["sentences"] = list(partial)
                    job["processed"] = processed
                    job["after"] = len(partial)
                    job["message"] = (
                        f"已整理 {processed}/{total} 个片段，{len(sentences)} 句 → {len(partial)} 句"
                    )

            def run() -> None:
                try:
                    result = llm.resegment(
                        items, model_key, on_status, on_batch,
                        should_stop=lambda: job.get("cancel", False),
                    )
                except llm.Cancelled:
                    with _ai_jobs_lock:
                        job["status"] = "cancelled"
                        job["message"] = "已停止整理，下面是已完成的部分"
                    return
                except Exception as e:  # noqa: BLE001 - 失败原因原样告知用户
                    with _ai_jobs_lock:
                        job["status"] = "error"
                        job["error"] = f"AI 整理断句失败：{e}"
                    return
                with _ai_jobs_lock:
                    job["sentences"] = result
                    job["status"] = "done"
                    job["processed"] = total
                    job["after"] = len(result)
                    job["message"] = f"完成，{len(sentences)} 句 → {len(result)} 句"

            threading.Thread(target=run, daemon=True).start()
            self._send_json(_ai_job_get(key), status=202)
            return

        storage.save_sentences(project_id, recording_id, _without_sources(merged))
        storage.save_transcript_md(project_id, recording_id, _sentences_to_markdown(_without_sources(merged)))
        nick = storage.get_settings()["identity"]["nick"]
        version = storage.commit_version(
            project_id,
            recording_id,
            _without_sources(merged),
            [],
            message=f"AI 整理断句（{len(sentences)} 句 → {len(merged)} 句）",
            author_nick=nick,
            advance_to=1,
            redactions=[],
        )
        self._send_json({
            "sentences": merged,
            "before": len(sentences),
            "after": len(merged),
            "version": version,
            "current": (version or {}).get("current", ""),
            "model": model_key,
        })

    def _suggest_redactions(self, project_id: str, recording_id: str):
        """AI 智能脱敏：只返回带偏移的建议，用户确认后走既有 addRedactions 落盘。"""
        recording = storage.get_recording(project_id, recording_id)
        if recording is None:
            self._send_json({"error": "recording not found"}, status=404)
            return
        if (recording.get("transcribe") or {}).get("status") != "done":
            self._send_json({"error": "转写尚未完成，暂不能进行 AI 脱敏"}, status=409)
            return

        data = self._read_json_body()
        if data is None:
            return
        model_key = str(
            data.get("model")
            or storage.get_settings().get("llm_model")
            or llm.DEFAULT_LLM_MODEL
        )
        if model_key not in llm.LLM_MODELS:
            self._send_json({"error": f"未知的 AI 模型：{model_key}"}, status=400)
            return
        if not llm.runtime_available():
            self._send_json({"error": llm.RUNTIME_MISSING_MSG}, status=503)
            return
        if llm.model_file(model_key) is None:
            self._send_json({
                "error": f"AI 模型「{llm.LLM_MODELS[model_key]['label']}」尚未下载，请先在「设置 → AI 模型」下载",
                "need_download": {"kind": "llm", "key": model_key},
            }, status=409)
            return

        categories = storage.get_redaction_categories(project_id)
        asked = data.get("categories")
        if isinstance(asked, list) and asked:
            wanted = {str(c) for c in asked}
            categories = [c for c in categories if str(c.get("id")) in wanted]
        categories = [c for c in categories if c.get("enabled", True) is not False]
        if not categories:
            self._send_json({"error": "请先在脱敏面板启用至少一个类别"}, status=409)
            return

        sentences = storage.load_sentences(project_id, recording_id)
        if not sentences:
            self._send_json({"error": "没有可检查的句子"}, status=409)
            return

        try:
            suggestions = llm.redact(sentences, categories, model_key)
        except Exception as e:  # noqa: BLE001 - 下载/推理失败原因要原样告知用户
            self._send_json({"error": f"AI 脱敏失败：{e}"}, status=503)
            return

        self._send_json({"suggestions": suggestions, "model": model_key})

    def _update_redaction_categories(self, project_id: str):
        """项目级脱敏类别模板：增删、改名、改占位符、启停。"""
        if storage.get_project(project_id) is None:
            self._send_json({"error": "project not found"}, status=404)
            return
        data = self._read_json_body()
        if data is None:
            return
        categories = data.get("categories")
        if not isinstance(categories, list) or not categories:
            self._send_json({"error": "categories 必须是非空数组"}, status=400)
            return
        seen_ids = set()
        cleaned = []
        for c in categories:
            if not isinstance(c, dict):
                self._send_json({"error": "类别项必须是对象"}, status=400)
                return
            name = str(c.get("name") or "").strip()
            placeholder = str(c.get("placeholder") or "").strip()
            if not name:
                self._send_json({"error": "类别名不能为空"}, status=400)
                return
            cid = str(c.get("id") or "").strip() or storage.new_id()
            if cid in seen_ids:
                self._send_json({"error": f"类别 id 重复：{cid}"}, status=400)
                return
            seen_ids.add(cid)
            if not placeholder:
                placeholder = f"[{name}]"
            cleaned.append({
                "id": cid,
                "name": name,
                "placeholder": placeholder,
                "color": str(c.get("color") or "#e5484d"),
                "enabled": bool(c.get("enabled", True)),
            })
        storage.save_redaction_categories(project_id, cleaned)
        self._send_json({"categories": cleaned})

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
        self._stream_file(audio_path, AUDIO_MIME.get(recording.get("format", ""), "application/octet-stream"))

    def _stream_file(self, audio_path: Path, mime: str):
        """支持 Range 的文件流；本地音频与协作材料播放共用。"""
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
        if not self._guard_lan(path):
            return
        if peers.maybe_forward(self):
            return

        if path == "/api/leaf/verify":
            if leaf.too_many_attempts():
                self._send_json({"error": "配对码错误次数过多，请 10 分钟后再试"}, status=429)
                return
            data = self._read_json_body()
            if data is None:
                return
            token = leaf.verify(str(data.get("code") or ""))
            if not token:
                leaf.note_failure()
                self._send_json({"error": "配对码不正确"}, status=403)
                return
            self._send_json({"ok": True, "token": token})
            return
        m = _match(path, r"^/api/models/jobs/([^/]+)/cancel$")
        if m:
            with _model_jobs_lock:
                job = _model_jobs.get(m[0])
                if job is not None and job.get("status") == "running":
                    job["cancel"] = True
                    job["message"] = "正在停止…"
                snapshot = dict(job) if job else {"error": "任务不存在"}
            self._send_json({"job": snapshot})
            return

        if path == "/api/models/download":
            data = self._read_json_body()
            if data is None:
                return
            try:
                job = start_model_job(str(data.get("kind") or "asr"), str(data.get("key") or ""))
            except ValueError as e:
                self._send_json({"error": str(e)}, status=400)
                return
            self._send_json({"job": job}, status=202)
            return

        if path == "/api/peers":
            data = self._read_json_body()
            if data is None:
                return
            try:
                peer = peers.register_peer(
                    str(data.get("url") or ""),
                    str(data.get("device_code") or ""),
                    str(data.get("nick") or ""),
                )
            except Exception as e:
                self._send_json({"error": f"连接节点失败：{e}"}, status=502)
                return
            self._send_json({"peer": peer or {}, "peers": peers.peers()})
            return

        m = _match(path, r"^/api/peer/groups/([^/]+)/snapshot$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            q = parse_qs(urlparse(self.path).query)
            device = (q.get("device_code") or [""])[0]
            try:
                self._send_json(peers.merge_snapshot(m[0], data, device))
            except collab.CollabError as e:
                self._send_json({"error": str(e)}, status=e.status)
            return

        m = _match(path, r"^/api/peer/groups/([^/]+)/join$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            try:
                group = collab.load_group(m[0])
                if str(data.get("code") or "") != group.get("code"):
                    raise collab.CollabError("配对码不匹配", status=403)
                self._send_json(collab.join_group(
                    str(data.get("code") or ""),
                    str(data.get("device_code") or ""),
                    str(data.get("nick") or ""),
                    str(data.get("role") or "reader"),
                ))
            except collab.CollabError as e:
                self._send_json({"error": str(e)}, status=e.status)
            return

        if path == "/api/projects":
            self._create_project()
            return

        # ---- 局域网协作 ----
        if path == "/api/groups":
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            nick = self._collab_nick(data)
            self._collab_call(lambda: collab.create_group(
                str(data.get("name") or ""),
                str(data.get("mode") or "authoritative"),
                device,
                nick,
                data.get("code_days") or 30,
            ))
            return

        if path == "/api/groups/join":
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            nick = self._collab_nick(data)
            role = str(data.get("role") or "reader")
            code = str(data.get("code") or "")
            # 跨机协作：本机没有这个配对码时，先向发现到的节点要一份群组快照。
            peers.import_group_by_code(code)
            self._collab_call(lambda: self._join_and_announce(code, device, nick, role))
            return

        m = _match(path, r"^/api/groups/([^/]+)/grants$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.create_grant(
                m[0],
                device,
                str(data.get("target") or ""),
                data.get("caps") or [],
                str(data.get("scope") or "material"),
                data.get("material_ids") or [],
                data.get("uses"),
                data.get("days"),
                str(data.get("note") or ""),
            ))
            return

        m = _match(path, r"^/api/groups/([^/]+)/materials$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            project_id = str(data.get("project_id") or "")
            recording_id = str(data.get("recording_id") or "")
            self._collab_call(lambda: collab.add_material(m[0], project_id, recording_id, device))
            return

        m = _match(path, r"^/api/groups/([^/]+)/materials/([^/]+)/proposals$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.create_proposal(
                m[0], m[1],
                str(data.get("sentence_id") or ""),
                str(data.get("after") or ""),
                device,
            ))
            return

        m = _match(path, r"^/api/groups/([^/]+)/materials/([^/]+)/merge$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            sentences = data.get("sentences")
            if not isinstance(sentences, list):
                self._send_json({"error": "sentences 必须是数组"}, status=400)
                return
            self._collab_call(lambda: collab.merge_snapshot(
                m[0], m[1],
                str(data.get("parent") or ""),
                sentences,
                device,
                bool(data.get("force", False)),
            ))
            return

        m = _match(path, r"^/api/groups/([^/]+)/materials/([^/]+)/playback$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.request_playback(
                m[0], m[1],
                str(data.get("mode") or ""),
                data.get("days", 7),
                device,
            ))
            return

        m = _match(path, r"^/api/groups/([^/]+)/proposals/merge$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            ids = data.get("proposal_ids")
            if ids is not None and not isinstance(ids, list):
                self._send_json({"error": "proposal_ids 必须是数组"}, status=400)
                return
            self._collab_call(lambda: collab.merge_proposals(
                m[0],
                [str(i) for i in ids] if isinstance(ids, list) else None,
                device,
                bool(data.get("mine_only", False)),
                bool(data.get("force", False)),
            ))
            return

        m = _match(path, r"^/api/groups/([^/]+)/proposals/([^/]+)/decide$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            accept = bool(data.get("accept", True))
            self._collab_call(lambda: collab.decide_proposal(m[0], m[1], accept, device))
            return

        m = _match(path, r"^/api/groups/([^/]+)/approvals/([^/]+)/consume$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.consume_playback(m[0], m[1], device))
            return

        m = _match(path, r"^/api/groups/([^/]+)/approvals/([^/]+)/decide$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            approve = bool(data.get("approve", True))
            self._collab_call(lambda: collab.decide_playback(m[0], m[1], approve, device))
            return

        m = _match(path, r"^/api/groups/([^/]+)/member_requests/([^/]+)/decide$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            approve = bool(data.get("approve", True))
            self._collab_call(lambda: collab.decide_member_request(m[0], m[1], approve, device))
            return

        m = _match(path, r"^/api/groups/([^/]+)/roles$")
        if m:
            data = self._read_json_body()
            if data is None:
                return
            device = self._collab_device(data)
            self._collab_call(lambda: collab.update_roles(
                m[0],
                str(data.get("role") or ""),
                data.get("caps") or [],
                str(data.get("name") or ""),
                device,
            ))
            return

        if path == "/api/restart":
            # 页面把新代码写回用户文件夹后调用；启动器约定退出码 86 = 重新读取文件并重启。
            # 先回包再退出，避免前端拿不到响应。若不是通过启动器运行，进程直接结束。
            self._send_json({"status": "restarting"})
            threading.Timer(0.3, lambda: os._exit(86)).start()
            return

        m = _match(path, r"^/api/projects/([^/]+)/redaction$")
        if m:
            self._update_redaction_categories(m[0])
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/redactions$")
        if m:
            self._add_redactions(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/polish/cancel$")
        if m:
            self._send_json(_ai_job_cancel(_ai_job_key(m[0], m[1], "polish")))
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/resegment/cancel$")
        if m:
            self._send_json(_ai_job_cancel(_ai_job_key(m[0], m[1], "resegment")))
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/polish$")
        if m:
            self._polish_recording(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/resegment$")
        if m:
            self._resegment_recording(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/sentences/merge$")
        if m:
            self._merge_sentences(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/redactions/suggest$")
        if m:
            self._suggest_redactions(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/transcribe$")
        if m:
            self._retry_transcribe(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/live$")
        if m:
            self._live_start(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/live/chunk$")
        if m:
            self._live_chunk(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/live/stop$")
        if m:
            self._live_stop(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings$")
        if m:
            self._upload_recording(m[0])
            return

        self._send_json({"error": "not found"}, status=404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if not self._guard_lan(path):
            return
        if peers.maybe_forward(self):
            return

        m = _match(path, r"^/api/groups/([^/]+)/grants/([^/]+)$")
        if m:
            # 跨机时请求由群主节点代执行，身份仍取请求里带的 device_code。
            data = self._read_json_body()
            if data is None:
                return
            self._collab_call(lambda: collab.revoke_grant(m[0], m[1], self._collab_device(data)))
            return

        m = _match(path, r"^/api/peers/([^/]+)$")
        if m:
            peers.remove_peer(unquote(m[0]))
            self._send_json({"peers": peers.peers()})
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)/redactions/([^/]+)$")
        if m:
            self._delete_redaction(*m)
            return

        m = _match(path, r"^/api/projects/([^/]+)/recordings/([^/]+)$")
        if m:
            self._delete_recording(*m)
            return

        m = _match(path, r"^/api/groups/([^/]+)/members/([^/]+)$")
        if m:
            self._collab_call(lambda: collab.remove_member(m[0], m[1], self._collab_device()))
            return

        m = _match(path, r"^/api/groups/([^/]+)$")
        if m:
            device = self._collab_device()
            try:
                collab.delete_group(m[0], device)
            except collab.CollabError as e:
                self._send_json({"error": str(e)}, status=e.status)
                return
            self._send_json({"status": "deleted"})
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
    if m is None:
        return None
    # 无捕获组的正则只用于判存在；空元组是假值，必须返回真值，否则整条路由永远命中不了。
    return m.groups() if m.groups() else True


def _recover_interrupted_transcriptions() -> None:
    """把上次进程被杀/重启留下的 transcribing 状态改成可重试的失败状态。

    转写状态落在 recording.json 里，但真正执行它的线程在内存中；进程退出后线程
    没了，状态却还是“转写中”，于是界面上永远显示转写中、删除也被误拦。
    """
    for project in storage.list_projects():
        for rec in storage.list_recordings(project["id"]):
            if (rec.get("transcribe") or {}).get("status") == "transcribing":
                storage.set_transcribe(
                    project["id"], rec["id"], "error", 0,
                    "上次转写被中断（后端重启），请点「重新转写」",
                )


if __name__ == "__main__":
    _recover_interrupted_transcriptions()
    peers.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"listen_writing backend listening on http://{HOST}:{PORT}")
    server.serve_forever()