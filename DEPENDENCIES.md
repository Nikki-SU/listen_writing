# 依赖记录

> 改动时都要查本文件（对应工程纪律第 10 条）。

## A. 安装的库依赖

| 库 | 版本 | 用途 | 可能变更点 / 备注 |
|---|---|---|---|
| Python 运行时 | 3.12.16（python-build-standalone `20261026`） | 用户电脑上**没有也不需要**系统 Python；启动器首次把便携 CPython 下载到 `.runtime/` | 升级会连带影响所有 wheel 兼容性；见下方「运行组件」 |
| faster-whisper | 1.2.1 | ASR 转写引擎（阶段 0 初始转写） | 换引擎 / 换模型大小时在此变更；见 `transcriber.py` |
| ctranslate2 | 4.8.1 | whisper 的 CTranslate2 CPU 推理引擎 | faster-whisper 直接依赖；3.12 用 cp312 wheel |
| av | 17.1.0 | 音频解码 + 时长探测 | faster-whisper 传递依赖；`main._probe_duration_sec` 直接 import 使用；**它内置 FFmpeg，因此用户机器无需安装 FFmpeg** |
| tokenizers | 0.22.1 | 字节对编码分词 | faster-whisper 传递依赖 |
| huggingface-hub | `>=0.21,<2` | 模型下载，支持 `HF_ENDPOINT` 镜像 | 下载源默认官方、失败降级 hf-mirror.com（见 `transcriber.py`）；2.0 起接口可能变，故封顶 |
| onnxruntime | — | VAD 可选依赖 | faster-whisper 传递依赖 |

### 运行组件（首次自动下载，用户零安装）

| 组件 | 来源 / 大小 | 说明 |
|---|---|---|
| 便携 CPython 3.12.16 | GitHub `astral-sh/python-build-standalone` release `20261026`，install_only 包：Windows x64 47MB / macOS 25MB / Linux x64 68MB | 解压到用户文件夹 `.runtime/`；依赖直接装进这份运行时（不建 venv） |
| 语音模型 | HuggingFace `Systran/faster-whisper-small` ≈ 500MB（官方 → hf-mirror.com 兜底） | 也可离线：放入 `data/models/whisper-small/` 即优先使用 |
| Microsoft VC++ 运行库（`MSVCP140.dll`） | 仅 Windows；官方 `https://aka.ms/vs/17/release/vc_redist.x64.exe` | `ctranslate2.dll` 依赖它，便携 Python 只带 vcruntime140 不带 msvcp140；启动器自检 `import av, ctranslate2` 失败时自动下载安装（需一次 UAC 确认），失败则给出手动安装链接 |

- Windows 解压依赖系统自带 `tar.exe`（Win10 1803+ / Win11）；下载优先 `curl.exe`，缺失则回退 PowerShell。
- macOS / Linux 解压用系统 `tar`，下载用 `curl`（缺失回退 `wget`）。
- 选 3.12 而非更高版本：ctranslate2 / onnxruntime / av 的 wheel 覆盖最稳；并且 `av` 是 cp311-abi3，3.12 可用。
- 实测：Linux x64 全流程（下载运行时 → 装依赖 → 转写）跑通；Windows/macOS 脚本逻辑同构，未在真机执行（见 TODO.md）。

### 网络与下载纪律（改启动器前必读）

国内网络下 github.com release 经常不可达，因此两个启动器都不是单源下载：

| 环节 | 顺序 | 校验 |
|---|---|---|
| 便携 Python 包 | `github.com` → `https://gh-proxy.com/` → `https://ghproxy.net/` | 每次下载后用官方 `SHA256SUMS` 里的 hash 校验；不符即删文件换下一个源 |
| pip 依赖 | 清华 `https://pypi.tuna.tsinghua.edu.cn/simple` → 官方 PyPI | `--timeout 20 --retries 2`，失败自动换源 |
| whisper 模型 | 官方 HuggingFace → `hf-mirror.com` | `HF_HUB_ETAG_TIMEOUT=5` / `HF_HUB_DOWNLOAD_TIMEOUT=20`；切镜像时置 `HF_HUB_DISABLE_XET=1` |

- **SHA256 是硬编码在脚本里的**，不是下载时从网络取（否则源被劫持就失去意义）。当前 5 条：
  - Windows x64 `590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5`（在 `start-windows.bat` 的 `SHA`）
  - mac arm64 `fbf4afe…f14e`、mac x64 `a962e47…69f3`、linux x64 `6a79e92…b89de`、linux arm64 `a945427…032b`（在 `start.sh` 的 `case` 分支）
  - 升级 `PYTAG`/`PYVER` 时必须按官方 `SHA256SUMS` 同步这 5 条，漏一条 → 该平台永远校验失败。
- `curl` 参数 `--connect-timeout 10 --speed-limit 1024 --speed-time 20 --retry 2`：连接 10s 超时、低于 1KB/s 持续 20s 放弃，避免国内墙下长时间卡死。
- 第三方代理只作**传输通道**，最终文件必须过官方 hash；不要新增「只下不校验」的源。

### 依赖锁版本纪律

`requirements.txt` 里凡是 faster-whisper 的传递依赖，都要显式锁死版本，不能交给 pip 挑最新：

- 实测教训：只锁 `faster-whisper==1.2.1` 时 pip 装了 `av 19`，而 av 19 移除了 `open(metadata_errors=...)`，转写全部报 `open() got an unexpected keyword argument 'metadata_errors'`。
- 升级任何一条前，必须重新跑一遍**真实转写**（上传音频 → 拿到分句），不能只看 `pip install` 成功。

> 沙箱屏蔽 huggingface.co 与 hf-mirror.com，模型自动下载链路无法在此实测；已用 GitHub release 模型验证加载/转写链路，最终用户经 hf-mirror.com 兜底。

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
| `FasterWhisperTranscriber` | `transcriber.py` | 具体引擎实现 | `model_ref` 属性（本地目录优先）；环境变量 `LISTEN_WRITING_MODEL` / `LISTEN_WRITING_MODEL_SIZE` | `transcriber.default_transcriber` |
| `offline_model_dir` | `transcriber.py` | size → `data/models/whisper-<size>` 路径 | 依赖 `storage.DATA_ROOT` | `FasterWhisperTranscriber.model_ref`、`needs_download` |
| `default_transcriber` | `transcriber.py` | 无 → Transcriber 实例 | — | `main` 模块级 `_transcriber` |
| `needs_download` / `ensure_model` | `transcriber.py` | 无 → bool（模型是否就绪） | 同 `model_ref` 解析顺序 | `preload.py` 预下载；`_load_model` 内部判断 |
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
- `start-mac.command` 只是转交 `start.sh`，不要把启动逻辑写回去（否则两份会漂移）。
- `start-windows.bat` **必须纯 ASCII + CRLF**：cmd 按字节读批处理，UTF-8 中文会让文件偏移错位、从行中间开始执行。`embed-backend.mjs` 会自动转 CRLF 并在发现非 ASCII 时**让 build 失败**；shell 脚本强制 LF（CRLF 会让 bash 报 `\r` 错误）。
- 携带 Python 运行时的版本/下载地址写在 `start-windows.bat` 的 `PYTAG`/`PYVER` 与 `start.sh` 同名变量里，两处必须同步改。
- 便携运行时落在用户文件夹 `.runtime/`（不建 venv）；改安装方式要同步 `start-*` 与 `README.md` 里的说明。
- `BootstrapGuide.tsx` 消费 `BOOTSTRAP_FILES`（写入 + 下载兜底）；`App.tsx` 在 `health === 'down'` 时渲染它并每 2 秒探测重连。