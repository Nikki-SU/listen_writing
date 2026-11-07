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
| 语音模型 | HuggingFace `Systran/faster-whisper-small` ≈ 500MB | 缓存位置由 `HF_HOME` 指向 `data/models/hf-cache/`（随项目文件夹走，不写系统盘用户目录）；也可离线：放入 `data/models/whisper-small/` 即优先使用 |
| Microsoft VC++ 运行库（`MSVCP140.dll`） | 仅 Windows；官方 `https://aka.ms/vs/17/release/vc_redist.x64.exe` | `ctranslate2.dll` 依赖它，便携 Python 只带 vcruntime140 不带 msvcp140；启动器自检 `import av, ctranslate2` 失败时自动下载安装（需一次 UAC 确认），失败则给出手动安装链接 |
| 本地 AI 运行时 `llama-cpp-python==0.3.36` | `https://abetlen.github.io/llama-cpp-python/whl/cpu`（官方 PyPI 只有源码包）；win_amd64 / macosx_11_0_arm64 / manylinux x86_64 预编译 wheel，约 30MB | 启动器在转写组件装完后单独装一次，失败不阻塞（AI 纠错如实提示「运行时未安装」，转写/校对/脱敏不受影响）；Intel Mac 无 wheel，会跳过 |
| AI 纠错模型 | HuggingFace `bartowski/Qwen_Qwen3-1.7B-GGUF`（Q4_K_M ≈1.3GB）/ `bartowski/Qwen_Qwen3-4B-GGUF`（≈2.5GB） | 不随启动器下载，首次点「AI 纠错」时按设置档位下载到 `data/models/llm/<档位>/`；国内自动走 `hf-mirror.com` |

- Windows 解压依赖系统自带 `tar.exe`（Win10 1803+ / Win11）；下载优先 `curl.exe`，缺失则回退 PowerShell。
- macOS / Linux 解压用系统 `tar`，下载用 `curl`（缺失回退 `wget`）。
- 选 3.12 而非更高版本：ctranslate2 / onnxruntime / av 的 wheel 覆盖最稳；并且 `av` 是 cp311-abi3，3.12 可用。
- 实测：Windows x64 已于 2026-11-05 真机跑通（下载运行时 → 装依赖 → 下模型 → 起服务 → 页面连上）；Linux x64 全流程跑通；macOS 脚本逻辑同构，未在真机执行（见 TODO.md）。

### 网络与下载纪律（改启动器前必读）

国内网络下 github.com release 经常不可达，因此两个启动器都不是单源下载：

| 环节 | 顺序 | 校验 |
|---|---|---|
| 便携 Python 包 | `github.com` → `https://gh-proxy.com/` → `https://ghproxy.net/` | 每次下载后用官方 `SHA256SUMS` 里的 hash 校验；不符即删文件换下一个源 |
| pip 依赖 | 清华 `https://pypi.tuna.tsinghua.edu.cn/simple` → 官方 PyPI | `--timeout 20 --retries 2`，失败自动换源 |
| 本地 AI 运行时 | 官方 CPU wheel 源 `abetlen.github.io`（PyPI 没有预编译包，源码安装需 cmake 工具链） | 装失败只提示、不退出；下次启动重试 |
| whisper 模型 | 导入时探测官方 `huggingface.co`（HEAD 模型接口，3s 超时）；不通则整个进程改用 `hf-mirror.com` | `HF_HUB_ETAG_TIMEOUT=5` / `HF_HUB_DOWNLOAD_TIMEOUT=20`；`HF_HUB_DISABLE_SYMLINKS_WARNING=1`；端点不通时置 `HF_HUB_DISABLE_XET=1`。**端点必须在 import 前定下**：huggingface_hub 1.x 运行中改 `constants.ENDPOINT` 不生效（已实测） |

- **SHA256 是硬编码在脚本里的**，不是下载时从网络取（否则源被劫持就失去意义）。当前 5 条：
  - Windows x64 `590dfcbe3a34c07301e6332e13e2188b98655cd072b08afa45a7998dc4c22bc5`（在 `start-windows.bat` 的 `SHA`）
  - mac arm64 `fbf4afe…f14e`、mac x64 `a962e47…69f3`、linux x64 `6a79e92…b89de`、linux arm64 `a945427…032b`（在 `start.sh` 的 `case` 分支）
  - 升级 `PYTAG`/`PYVER` 时必须按官方 `SHA256SUMS` 同步这 5 条，漏一条 → 该平台永远校验失败。
- `curl` 参数 `--connect-timeout 10 --speed-limit 1024 --speed-time 20 --retry 2`：连接 10s 超时、低于 1KB/s 持续 20s 放弃，避免国内墙下长时间卡死。
- 第三方代理只作**传输通道**，最终文件必须过官方 hash；不要新增「只下不校验」的源。

### 自动更新与重启约定（改启动器 / updater 前必读）

- **重启信号 = 退出码 86**：`backend/main.py` 的 `POST /api/restart` 回包后 `os._exit(86)`；`start-windows.bat` 用 `if errorlevel 86 goto restart`、`start.sh` 用 `[ "$code" -eq 86 ] || break` 回到开头重装依赖再启动。改其中任一处，三处必须同步（`main.py` / bat / sh）。
- **更新写回**只写 `frontend/src/bootstrapFiles.ts` 里的固定清单，路径来自 `embed-backend.mjs`；新增嵌入文件必须同时更新该脚本的清单。
- **目录句柄存 IndexedDB**（库名 `listen_writing`，store `handles`，键 `bootstrap`）；换域名 / 换浏览器等于丢句柄，更新会回退为「重新选文件夹」。
- **启动器脚本 `.bat/.sh/.command` 永不自动覆盖**（Windows cmd 边读边执行，覆盖正在运行的 bat 会错位）；embed 脚本给它们打 `launcher: true`。
- **页面版本号**由 `embed-backend.mjs` 从 `backend/models.py` 的 `APP_VERSION.frontend` 生成（`BUNDLE_VERSION`）。任何嵌入文件改动都必须 bump frontend 段，否则用户收不到更新提示。

### 依赖锁版本纪律

`requirements.txt` 里凡是 faster-whisper 的传递依赖，都要显式锁死版本，不能交给 pip 挑最新：

- 实测教训：只锁 `faster-whisper==1.2.1` 时 pip 装了 `av 19`，而 av 19 移除了 `open(metadata_errors=...)`，转写全部报 `open() got an unexpected keyword argument 'metadata_errors'`。
- 升级任何一条前，必须重新跑一遍**真实转写**（上传音频 → 拿到分句），不能只看 `pip install` 成功。

> 2026-11-05 实测修正：沙箱里官方 `huggingface.co` 不可达、`hf-mirror.com` 可用。已实测「导入时探测官方 → 自动改用镜像 → tiny 模型 75MB 下载成功 → 缓存落在 `data/models/hf-cache/`」整条链路，以及缓存命中后 `preload.py` 跳过下载、模型可加载并转写。

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
| `save_sentences` / `load_sentences` | `storage.py` | 句子 CSV 读写（原子替换） | `SENTENCE_COLUMNS` 七列 | `main._run_transcribe` 落盘、R-2 读回、R-7 单句修改 |
| `save_transcript_md` | `storage.py` | 正文稿 Markdown | （无字段依赖） | `main._run_transcribe`、`main._update_sentence` |
| `get_settings` / `update_settings` | `storage.py` | 读写 `data/settings.json` | `identity.nick / identity.device_code / asr_model / llm_model` | S-1 / S-2；版本作者名取 `identity.nick` |
| `ensure_current_version` | `storage.py` | 旧录音缺 `version` 时从版本文件回填 | `stage / seq / current` | R-2、R-7、`commit_version` |
| `commit_version` | `storage.py` | (pid, rid, sentences, diff, message, author, advance_stage, advance_to, redactions) → 版本 dict | 写 `versions/{stage}.{seq}.json`，快照 + diff + `redactions`；`advance_to` 直接推进到指定阶段；并回填 `recording.version` | R-7 单句修改、R-8 发言人、R-10~R-12 脱敏；AI 纠错（阶段 1） |
| `list_versions` / `get_version` / `save_version` | `storage.py` | 版本历史读取 / 落盘 | `version/stage/seq/parent/author_nick/timestamp/message/diff/sentences` | R-5 / R-6；`main._run_transcribe` 落 `0.1` |
| `_send_audio` | `main.py` | 音频流（支持 Range） | `recording.audio_path / format`；`AUDIO_MIME` | R-4 `<audio>` 播放与按句 seek |
| `_update_sentence` | `main.py` | 单句 PATCH 编排 | 非空 `text`；可选 `speaker`；可选 `advance_to`（0/1/2，只增不减）与 `source=ai_polish`（版本说明标注采纳）；阶段 ≥2 且文字变化时清除该句脱敏标记；成功后 `commit_version(..., redactions=marks)` | R-7；前端 `TranscriptPanel.saveEdit` / `acceptSuggestion` / `startEdit(..., 'ai_polish')` |
| `_update_speakers` | `main.py` | 发言人改名/合并/拆分编排 | `action` + `from/to/into/sentence_ids`；成功后带当前 `redactions` 提交版本 | R-8；前端 `renameSpeaker` / `mergeSpeaker` / 单句编辑框 |
| `DEFAULT_REDACTION_CATEGORIES` / `get_redaction_categories` / `save_redaction_categories` | `storage.py` | 项目级脱敏类别模板（`redaction.json`） | 字段 `id / name / placeholder / color / enabled`；类别 id 唯一 | R-13、R-11 类别管理面板 |
| `redactions_path` / `get_redactions` / `save_redactions` | `storage.py` | 录音级脱敏标记（`redactions.json`） | 字段 `id / sentence_id / start / end / category / placeholder / original` | R-9、R-10、R-12；导出 E-1 与版本快照 |
| `_add_redactions` | `main.py` | 新增标记编排 | 校验 `sentence_id` 存在、区间不越界/不重叠；首次标记推进阶段 2；返回 `{marks, version, current}` | R-10；前端 `markSelection` |
| `_delete_redaction` | `main.py` | 删除单个标记 | `mark_id`；成功后提交版本；返回 `{marks, version, current}` | R-12；前端 `renderText` 点击移除 |
| `_update_redaction_categories` | `main.py` | 保存类别模板 | 校验名称非空、id 唯一；返回类别表 | R-11；前端「管理类别」面板 |
| `_apply_redactions` | `main.py` | 按标记把句内区间替换成占位符 | `marks` 按 `start` 倒序替换 `sentence.text` | E-1 导出；阶段 ≥2 才生效 |
| `assign_speakers` | `diarize.py` | 本地 MFCC+基频 → k-means → 轮廓系数选 k | `Sentence.start_ms/end_ms`，写 `speaker`；numpy + PyAV | `main._run_transcribe` 转写完成后调用 |
| `_export_transcript` | `main.py` | MD/JSON 导出（当前或历史版本） | `version.sentences` 快照、`recording.name`、`format`/`version` 查询参数 | E-1；前端 `saveExport` |
| `Transcriber.transcribe`（抽象） | `transcriber.py` | (audio_path, on_progress) → `[{start_ms,end_ms,text,speaker}]` | 返回元素四字段 | `main._run_transcribe` |
| `FasterWhisperTranscriber` | `transcriber.py` | 具体引擎实现 | `size` 参数优先（设置页选择）→ 环境变量 `LISTEN_WRITING_MODEL` / `LISTEN_WRITING_MODEL_SIZE`；模型缓存 `HF_HOME=data/models/hf-cache` | `transcriber.transcriber_for` |
| `offline_model_dir` | `transcriber.py` | size → `data/models/whisper-<size>` 路径 | 依赖 `storage.DATA_ROOT` | `FasterWhisperTranscriber.model_ref`、`needs_download` |
| `ASR_MODELS` | `transcriber.py` | 转写选项表（id/label/min_ram/speed/note/available） | 唯一权威；`whisper-small/medium` 可用，Qwen3-ASR / SenseVoice 标记未内置 | S-1 `options.asr`、`_update_settings` 校验、`transcriber_for` |
| `transcriber_for(model_key)` | `transcriber.py` | key → Transcriber | 未内置运行时抛 `RuntimeError`（`_run_transcribe` 把原因写入转写状态） | `main._get_transcriber`、`preload.main` |
| `default_transcriber` | `transcriber.py` | 无 → Transcriber 实例 | 跟随 `settings.asr_model`，读设置失败退回 small | `preload.py`、兼容旧调用 |
| `needs_download` / `ensure_model` | `transcriber.py` | 无 → bool（模型是否就绪） | 检查 `model_ref` 目录；size 名再查 HF 缓存 `snapshots/*/model.bin` | `preload.py` 预下载（命中缓存时跳过下载提示） |
| `_hf_official_reachable` | `transcriber.py` | 无 → bool | HEAD `huggingface.co/api/models/Systran/faster-whisper-tiny`，3s 超时 | 模块导入时决定是否设 `HF_ENDPOINT=hf-mirror.com` |
| `preload.main` | `preload.py` | 无 → int（0 就绪 / 1 失败不阻塞） | 按 `settings.asr_model` 构建；启动器在**用户文件夹根目录**执行 `python backend/preload.py` | `bootstrap/start-*.sh`、`start-windows.bat` |
| `llm.LLM_MODELS` / `llm.options` | `llm.py` | AI 选项表 + `available`（运行时是否安装） | 唯一权威；GGUF 仓库为 bartowski Q4_K_M | S-1 `options.llm`、`_update_settings` 校验 |
| `llm.ensure_model` | `llm.py` | key → GGUF 路径（必要时下载） | `data/models/llm/<key>/`；复用 transcriber 的 HF 端点决策 | `llm._engine`、AI 纠错接口 |
| `llm.runtime_available` | `llm.py` | 无 → bool | `importlib.util.find_spec("llama_cpp")` | `llm.options`、`llm.polish`、R-14 前置校验 |
| `llm.polish` | `llm.py` | (sentences, model_key, on_status) → `[{sentence_id,index,before,after}]` | 分批 16 句；提示词带 `id + 制表符 + 原文`；只返回需改动的句子；`split_think` 清思考段；运行时缺失抛 `RuntimeError(RUNTIME_MISSING_MSG)` | `main._polish_recording`（R-14）；前端建议列表 |
| `llm._engine` / `llm._parse_changes` | `llm.py` | 按档位缓存 `llama_cpp.Llama`；容忍代码块/包裹的 JSON 解析 | 引擎缓存在进程内复用；解析失败抛可读错误 | `llm.polish` |
| `_polish_recording` | `main.py` | AI 纠错编排 | 校验录音/转写完成/模型名；运行时缺失 503；返回 `{suggestions, model}`，**不改正文** | R-14；前端 `runPolish` |
| `collab.DEFAULT_ROLES` / `VALID_CAPS` / `PLAYBACK_MODES` | `collab.py` | 五角色权限模板、合法能力、三种播放模式 | `RoleCaps` 与 API_CONTRACT G-10 同步；`owner` 必须保留 `roles/manage` | `collab._require`、`update_roles`、`get_group` |
| `collab._require` / `_caps` / `_is_reviewer` | `collab.py` | 设备 → 成员 → 能力校验 | 调用者身份来自 `main._collab_device`；无权限抛 `CollabError(403)` | 所有 G 接口 |
| `collab.create_group` / `list_groups` / `get_group` / `delete_group` | `collab.py` | 群组 CRUD 与配对码 | `code` 6 位唯一；落 `data/groups/{gid}/group.json`；`my_role/my_role_name/member_count` 供前端 | G-1~G-5 |
| `collab.join_group` / `members` / `update_member` / `decide_member_request` / `remove_member` / `update_roles` | `collab.py` | 入群、成员与权限管理 | 入群仅 `reader/reviewer`；管理员提名管理员进 `member_requests`；角色模板可改名/改 caps | G-3、G-6~G-10；前端成员页 |
| `collab.add_material` / `list_materials` / `get_material` | `collab.py` | 材料快照（当前版本）与审查者视图 | 快照字段 `sentences/base_sentences/redactions/audio_path/stage/version/history`；审查者 `_visible` 只放 stage≥2、`from main import _apply_redactions` 脱敏、历史截断、`review_mode=true` | G-11~G-13；前端材料页 |
| `collab.create_proposal` / `decide_proposal` / `list_proposals` | `collab.py` | 逐句提案与合并 | 同句已被覆盖时先标 `conflict` 并 409，再次调用强制应用；版本 `_version_next` + history | G-14~G-16 |
| `collab.merge_snapshot` | `collab.py` | 有副本模式三方合并 | 入参 `base_sentences/current/incoming` 逐句比对；双改同句返回 `status=conflict`；`force=true` 冲突句采用本地版本 | G-17；前端本地草稿编辑 |
| `collab.request_playback` / `decide_playback` / `playback_target` / `consume_playback` | `collab.py` | 播放审批门禁 | 三模式 `burn/permanent/timed`；`cast` 校验申请设备、状态、过期；burn 只在 `consume` 后置 `used` | G-18~G-22；前端 `<audio>` |
| `collab.access_log` / `_log` | `collab.py` | 访问留痕 | 上限 500 条；需 `members` 能力 | G-23；前端访问留痕页 |
| `_collab_device` / `_collab_nick` / `_collab_call` | `main.py` | 协作身份解析与异常转 JSON | body/query `device_code` 缺省取本机设置；`CollabError.status` 映射 HTTP | 所有 G 路由 |
| `_stream_file` | `main.py` | 通用音频流（Range） | `_send_audio` 与 G-22 门禁音频共用 | R-4、G-22 |
| `_probe_duration_sec` | `main.py` | audio_path → float 秒 | 依赖 `av` | `main._run_transcribe` 回填 `duration_sec` |
| `_run_transcribe` | `main.py` | (pid, rid) → 后台线程编排 | 编排 `storage.*` + `transcriber.transcribe` | `main._upload_recording` 启动线程 |
| `_sentences_to_markdown` | `main.py` | list[sentence] → str | 用 `start_ms / speaker / text` | `main._run_transcribe` |

### 格式白名单联动（改一处必须同步其余三处）

`main.AUDIO_FORMATS`（权威）↔ `api.ts AUDIO_FORMATS` ↔ `App.tsx` input `accept` ↔ `API_CONTRACT.md` R-1。
当前值：`wav / mp3 / m4a / wma / flac / ogg / opus / aac / aiff`；解码由 PyAV 内置，见 `main._format_from_filename`。

### 引导部署文件联动（改一处必须同步）

- `backend/*.py` 或 `bootstrap/*` 改动 → 重新 `npm run build`（prebuild 自动重生成 `src/bootstrapFiles.ts`）→ 重新部署，用户写入的启动文件才是新版。
- `frontend/scripts/embed-backend.mjs`：清单来源 = `backend/{main,models,storage,transcriber,diarize,llm,collab,preload}.py` + `backend/requirements.txt`（映射为用户根目录 `requirements.txt`）+ `bootstrap/*`。加新后端文件必须把它加进 embed 清单（`diarize.py` 曾漏掉，用户机器会直接 ImportError；`collab.py` 已加入）。
- 启动器（`bootstrap/start-*`）假设目录结构：根目录有 `backend/`、`requirements.txt`、启动器自身；改嵌入布局必须同步启动器里的相对路径。
- `start-mac.command` 只是转交 `start.sh`，不要把启动逻辑写回去（否则两份会漂移）。
- `start-windows.bat` **必须纯 ASCII + CRLF**：cmd 按字节读批处理，UTF-8 中文会让文件偏移错位、从行中间开始执行。`embed-backend.mjs` 会自动转 CRLF 并在发现非 ASCII 时**让 build 失败**；shell 脚本强制 LF（CRLF 会让 bash 报 `\r` 错误）。
- 携带 Python 运行时的版本/下载地址写在 `start-windows.bat` 的 `PYTAG`/`PYVER` 与 `start.sh` 同名变量里，两处必须同步改。
- 便携运行时落在用户文件夹 `.runtime/`（不建 venv）；改安装方式要同步 `start-*` 与 `README.md` 里的说明。
- `BootstrapGuide.tsx` 消费 `BOOTSTRAP_FILES`（写入 + 下载兜底）；`App.tsx` 在 `health === 'down'` 时渲染它并每 2 秒探测重连。