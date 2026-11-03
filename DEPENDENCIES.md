# 依赖记录

> 改动时都要查本文件（对应工程纪律第 10 条）。

## A. 安装的库依赖

| 库 | 版本 | 用途 | 可能变更点 / 备注 |
|---|---|---|---|
| faster-whisper | 1.2.1 | ASR 转写引擎（阶段 0 初始转写） | 换引擎 / 换模型大小时在此变更；见 `transcriber.py` |
| ctranslate2 | 4.8.1 | whisper 的 CTranslate2 CPU 推理引擎 | faster-whisper 直接依赖，已确认有 Python 3.14 的 cp314 wheel |
| av | 17.1.0 | 音频解码 + 时长探测 | faster-whisper 传递依赖；`main._probe_duration_sec` 直接 import 使用 |
| tokenizers | 0.22.1 | 字节对编码分词 | faster-whisper 传递依赖 |
| huggingface-hub | — | 模型下载，支持 `HF_ENDPOINT` 镜像 | 下载源默认官方、失败降级 hf-mirror.com（见 `transcriber.py`） |
| onnxruntime | 1.31.0 | VAD 可选依赖 | faster-whisper 传递依赖 |

> Python 3.14.8 下以上依赖均有可用 wheel（ctranslate2 4.8.1 提供 cp314 包），已实测安装 + 转写跑通。
> 模型下载源：sandbox 屏蔽 huggingface.co，已用 GitHub release 镜像验证模型加载/转写链路；最终用户经 hf-mirror.com 兜底。

## B. 自定义函数依赖

> 记录自己写的函数，以及调用它时用到的字段；函数变更时据此判断字段是否还保留、不保留时引用处要如何改。

### 关键字段联动（改一处必须同步其余）

1. **句子（Sentence）7 字段**：`id / recording_id / index / text / start_ms / end_ms / speaker`
   - 定义处：`storage.SENTENCE_COLUMNS`（CSV 表头）
   - 写出处：`main._run_transcribe`（组装 dict）
   - 消费处：前端 `types.ts` 的 `Sentence`、`App.tsx` 分句渲染
2. **转写状态对象**：`transcribe: {status, progress, error}`
   - 定义处：`storage.create_recording`（初始化 pending）
   - 更新处：`storage.set_transcribe`
   - 消费处：前端 `types.ts` 的 `TranscribeStatus`、`App.tsx` 进度轮询与状态标签

### 函数清单

| 函数 | 所属文件 | 输入 / 输出 | 被依赖的字段 / 参数 | 引用处 |
|---|---|---|---|---|
| `new_id` / `now_iso` | `storage.py` | 无 → id / ISO 时间戳 | 生成规则统一 | `main._run_transcribe`（句子 id、版本 timestamp） |
| `create_project` / `list_projects` / `get_project` | `storage.py` | 项目 CRUD | `id / name / description / created_at` | `main` 各项目路由；前端 `types.Project` |
| `create_recording` / `get_recording` / `list_recordings` / `update_recording` | `storage.py` | 录音 CRUD | `id / project_id / name / audio_path / format / duration_sec / transcribe` | `main._upload_recording`、`_run_transcribe`；前端 `types.Recording` |
| `save_audio` | `storage.py` | (pid, rid, fmt, bytes) → audio_path | `fmt` 决定扩展名 `audio.{ext}` | `main._upload_recording` 回填 `audio_path` |
| `save_sentences` / `load_sentences` | `storage.py` | 句子 CSV 读写 | `SENTENCE_COLUMNS` 七列 | `main._run_transcribe` 落盘、`do_GET` R-2 读回 |
| `save_transcript_md` | `storage.py` | 正文稿 Markdown | （无字段依赖） | `main._run_transcribe` |
| `save_version` | `storage.py` | (pid, rid, stage, seq, dict) → JSON | `recording_id / stage / seq / parent / author_nick / timestamp / sentence_ids` | `main._run_transcribe` 落 `versions/0.1.json` |
| `Transcriber.transcribe`（抽象） | `transcriber.py` | (audio_path, on_progress) → `[{start_ms,end_ms,text,speaker}]` | 返回元素四字段 | `main._run_transcribe` |
| `FasterWhisperTranscriber` | `transcriber.py` | 具体引擎实现 | 环境变量 `LISTEN_WRITING_MODEL` / `LISTEN_WRITING_MODEL_SIZE` | `transcriber.default_transcriber` |
| `default_transcriber` | `transcriber.py` | 无 → Transcriber 实例 | — | `main` 模块级 `_transcriber` |
| `needs_download` / `ensure_model` | `transcriber.py` | 无 → bool（模型是否就绪） | 环境变量 `LISTEN_WRITING_MODEL` / `LISTEN_WRITING_MODEL_SIZE` | `preload.py` 预下载；`_load_model` 内部判断 |
| `preload.main` | `preload.py` | 无 → int（0 就绪 / 1 失败不阻塞） | 调 `default_transcriber`；启动器在**用户文件夹根目录**执行 `python backend/preload.py`，内部按包路径 import `transcriber` | `bootstrap/start-*.sh`、`start-windows.bat` |
| `_probe_duration_sec` | `main.py` | audio_path → float 秒 | 依赖 `av` | `main._run_transcribe` 回填 `duration_sec` |
| `_run_transcribe` | `main.py` | (pid, rid) → 后台线程编排 | 编排 `storage.*` + `transcriber.transcribe` | `main._upload_recording` 启动线程 |
| `_sentences_to_markdown` | `main.py` | list[sentence] → str | 用 `start_ms / speaker / text` | `main._run_transcribe` |

### 格式白名单联动（改一处必须同步其余三处）

`main.AUDIO_FORMATS`（权威）↔ `api.ts AUDIO_FORMATS` ↔ `App.tsx` input `accept` ↔ `API_CONTRACT.md` R-1。
当前值：`wav / mp3 / m4a / wma / flac / ogg / opus / aac / aiff`；解码由 PyAV 内置，见 `main._format_from_filename`。

### 引导部署文件联动（改一处必须同步）

- `backend/*.py` 或 `bootstrap/*` 改动 → 重新 `npm run build`（prebuild 自动重生成 `src/bootstrapFiles.ts`）→ 重新部署，用户写入的启动文件才是新版。
- `frontend/scripts/embed-backend.mjs`：清单来源 = `backend/{main,models,storage,transcriber,preload}.py` + `backend/requirements.txt`（映射为用户根目录 `requirements.txt`）+ `bootstrap/*`。加新后端文件必须把它加进 embed 清单。
- 启动器（`bootstrap/start-*`）假设目录结构：根目录有 `backend/`、`requirements.txt`、启动器自身；改嵌入布局必须同步启动器里的相对路径。
- `BootstrapGuide.tsx` 消费 `BOOTSTRAP_FILES`（写入 + 下载兜底）；`App.tsx` 在 `health === 'down'` 时渲染它并每 2 秒探测重连。