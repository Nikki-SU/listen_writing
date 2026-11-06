# 接口契约

> 前后端分开写时，双端子 Agent 都要先读本文件，以它作为唯一的接口纪律。

## 通用约定

- **协议**：HTTP（本地回环），后端是纯标准库 `http.server`，无第三方框架。
- **地址**：`http://127.0.0.1:7850`（本机）。前端经浏览器 fetch；未来局域网协作用户 IP 替代。
- **数据格式**：请求 / 响应体一律 `application/json; charset=utf-8`，字段用 `snake_case`。
- **CORS**：后端返回 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Private-Network: true`（后者是 https 的 Pages 页面请求 http://127.0.0.1 时 Chrome 私有网络访问预检的要求；`OPTIONS` 预检返回 204 + 同样的头）。
- **错误约定**：非 JSON 或未知路径一律 `404`，返回 `{"error": "<可读原因>"}`；字段名字典化，不静默给空值 / 0（对应《工程纪律》「先约束，再容错」）。

## 接口清单

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| H-1 | 后端 | `GET /api/health` | 无 | `{"status":"ok"}` | 前端启动后用来确认后端在线 |
| V-1 | 后端 | `GET /api/version` | 无 | `{"version":{"frontend":1,"backend":1,"model":1,"data":1}}` | 软件四段版本号；`frontend` 段同时代表「嵌入文件整包」的版本，用于判断本地后端是否过期 |
| U-1 | 后端 | `POST /api/restart` | 无 | `{"status":"restarting"}` | 更新本地文件后重启后端：回包后进程以**退出码 86** 结束，启动器据此重装依赖并重启；不是 86 时启动器正常退出 |
| P-1 | 后端 | `POST /api/projects` | `{"name":"项目名","description":"说明"}` | `{"project":{...}}` | 创建项目（description 可空） |
| P-2 | 后端 | `GET /api/projects` | 无 | `{"projects":[{...}]}` | 列出全部项目（按创建倒序） |
| R-1 | 后端 | `POST /api/projects/{project_id}/recordings?name=...&format=...` | **raw 音频字节**（非 JSON）+ **query 参数** `name`（原文件名，UTF-8 百分号编码）、`format`（取值见下方白名单） | `{"recording":{...}}` | 上传录音，落 `audio.{ext}` 后**异步启动转写** |
| R-3 | 后端 | `GET /api/projects/{project_id}/recordings` | 无 | `{"recordings":[{...}]}` | 列出项目下录音（仅元数据，按创建倒序） |
| R-2 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}` | 无 | `{"recording":{...},"transcribe":{...},"sentences":[...],"redactions":[...]}` | 录音详情 + 转写状态 + 分句列表 + 脱敏标记；`recording.version` 为当前版本 `{stage,seq,current}`，`recording.asr_model` 为实际用过的转写档位 |
| R-4 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/audio` | 可选 `Range: bytes=...` | 音频字节流（`200` / `206`） | `<audio>` 播放与按句跳转；支持 Range 才能任意 seek |
| R-5 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/versions` | 无 | `{"versions":[{version,stage,seq,parent,author_nick,timestamp,message,changes}],"current":{...}}` | 版本历史（元数据，不含句子快照） |
| R-6 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/versions/{stage}.{seq}` | 无 | `{"version":{...version, diff, sentences:[...]}}` | 单个版本：完整句子快照 + 本次 diff，可复刻 |
| R-7 | 后端 | `PATCH /api/projects/{project_id}/recordings/{recording_id}/sentences/{sentence_id}` | `{"text":"修改后的单句","speaker":"可选，发言人","advance_to":"可选，0/1/2","source":"可选，仅 ai_polish"}` | `{"sentence":{...},"version":{...},"current":"1.2"}` | 单句文字/发言人修改；成功后自动提交新版本（阶段内序号 +1）。带 `advance_to` 时把版本推进到该阶段（只增不减）；`source=ai_polish` 时版本说明标注「AI 纠错采纳」 |
| R-8 | 后端 | `PATCH /api/projects/{project_id}/recordings/{recording_id}/speakers` | `{"action":"rename","from","to"}` 或 `{"action":"merge","from","into"}` 或 `{"action":"assign","sentence_ids":[...],"speaker"}` | `{"sentences":[...],"version":{...},"current":"0.3"}` | 发言人改名 / 合并 / 单句拆分；每次操作提交一个版本 |
| R-9 | 后端 | `GET /api/projects/{project_id}/redaction` | 无 | `{"categories":[RedactionCategory…]}` | 项目级脱敏类别模板（首次访问写入 4 个建议起点标签） |
| R-10 | 后端 | `POST /api/projects/{project_id}/redaction` | `{"categories":[{id,name,placeholder,color,enabled}…]}` | `{"categories":[...]}` | 保存类别模板（增删/改名/占位符/颜色/启停）；类别名不能为空、id 不能重复 |
| R-11 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/redactions` | 无 | `{"marks":[RedactionMark…]}` | 录音的脱敏标记（坐标基于原句文字；另随 R-2 详情返回） |
| R-12 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/redactions` | `{"marks":[{sentence_id,start,end,category_id}…]}` | `{"marks":[...],"version":{...},"current":"2.1"}` | 新增标记；越界/与已有标记重叠/类别不存在返回 400；首次标记把版本推进到阶段 2 |
| R-13 | 后端 | `DELETE /api/projects/{project_id}/recordings/{recording_id}/redactions/{mark_id}` | 无 | `{"marks":[...],"version":{...},"current":"2.2"}` | 移除标记，同样提交版本留痕 |
| R-14 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/polish` | `{"model":"可选，缺省取设置里的 llm_model"}` | `{"suggestions":[{sentence_id,index,before,after}…],"model":"qwen3-4b"}` | AI 语义纠错：只返回建议、**不改正文**；用户逐条用 R-7（`advance_to=1,source=ai_polish`）采纳。运行时未安装返回 503（正文为可读原因），转写未完成/无句子 409，模型非法 400 |
| E-1 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/export?format=md\|json&version={stage}.{seq}` | 无 | 文件流（`Content-Disposition: attachment`） | 默认导出当前版本；带 `version` 导出历史版本；MD 便于送审，JSON 保留发言人/时间戳/句子映射。**阶段 ≥2 且存在标记时，导出的句子已替换为占位符，JSON 不含 `original`** |
| S-1 | 后端 | `GET /api/settings` | 无 | `{"settings":{"identity":{"nick","device_code"},"asr_model","llm_model"},"options":{"asr":[ModelOption…],"llm":[ModelOption…]}}` | 本机身份与模型选择；首次调用生成设备码。`options` 在 `transcriber.ASR_MODELS` / `llm.LLM_MODELS` 唯一定义，前端只渲染 |
| S-2 | 后端 | `PATCH /api/settings` | 同 S-1 `settings` 的任意子集 | `{"settings":{...}}` | 修改昵称 / 设备码 / 模型选择；空昵称不生效。`asr_model` 不在 `ASR_MODELS`、`llm_model` 不在 `LLM_MODELS` 时返回 400 |

### 局域网协作（G 系列）

所有 G 接口都可以用 `device_code` 指定调用者身份：POST/PATCH 放请求体，GET/DELETE 放 query；缺省取本机 `settings.identity.device_code`。前端同一后端下默认就是本机身份。权限不足统一 `403`，实体不存在 `404`，参数不合法 `400`。

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| G-1 | 后端 | `GET /api/groups` | 无 | `{"groups":[GroupSummary…],"identity":{nick,device_code}}` | 本机可见的全部群组 |
| G-2 | 后端 | `POST /api/groups` | `{"name","mode":"authoritative\|replica"}` | `{"group":GroupSummary}` | 建群，创建者为群主，返回 6 位配对码 |
| G-3 | 后端 | `POST /api/groups/join` | `{"code","role":"reader\|reviewer","nick?"}` | `{"group":GroupSummary}` | 凭配对码入群；角色只能只读/审查者，其他角色 400 |
| G-4 | 后端 | `GET /api/groups/{gid}` | 无 | `{"group":GroupSummary}` | 群组详情（含 `my_role/my_role_name/member_count`） |
| G-5 | 后端 | `DELETE /api/groups/{gid}` | 无 | `{"ok":true}` | 仅群主可解散 |
| G-6 | 后端 | `GET /api/groups/{gid}/members` | 无 | `{"members":[…], "roles":{role:Role}, "member_requests":[…], "owner_device":""}` | 成员、角色模板与待群主批准的管理员任免 |
| G-7 | 后端 | `PATCH /api/groups/{gid}/members/{device}` | `{"role"}` | `{"member":…}` 或 `{"pending":…}` | 管理员可任免下级；管理员提名管理员返回 `pending`，等群主 G-9 决定 |
| G-8 | 后端 | `DELETE /api/groups/{gid}/members/{device}` | 无 | `{"members":[…]}` | 不能移除群主；管理员不能移除管理员 |
| G-9 | 后端 | `POST /api/groups/{gid}/member_requests/{rid}/decide` | `{"approve":bool}` | `{"member_requests":[…]}` | 仅群主 |
| G-10 | 后端 | `POST /api/groups/{gid}/roles` | `{"role","name","caps":[…]}` | `{"roles":{role:Role}}` | 自定义五级权限；能力见下；群主必须保留 `roles` 与 `manage` |
| G-11 | 后端 | `GET /api/groups/{gid}/materials` | 无 | `{"materials":[MaterialMeta…]}` | 审查者只返回阶段 ≥2 的材料 |
| G-12 | 后端 | `POST /api/groups/{gid}/materials` | `{"project_id","recording_id"}` | `{"material":MaterialMeta}` | 管理员及以上灌入**当前版本**快照（句子/脱敏/音频路径/阶段/版本） |
| G-13 | 后端 | `GET /api/groups/{gid}/materials/{mid}` | 无 | `{"material":MaterialDetail,"review_mode":bool,"can_play":bool,"approval?":…}` | 审查者返回阶段 ≥2 的脱敏正文、历史截断到阶段 2 之前、`review_mode=true` |
| G-14 | 后端 | `POST /api/groups/{gid}/materials/{mid}/proposals` | `{"sentence_id","after"}` | `{"proposal":…}` | 读写及以上提交逐句修改提案，不改正文 |
| G-15 | 后端 | `GET /api/groups/{gid}/proposals` | 无 | `{"proposals":[…]}` | 群组内全部提案 |
| G-16 | 后端 | `POST /api/groups/{gid}/proposals/{pid}/decide` | `{"accept":bool}` | `{"proposal":…,"material":…}` | 需 `merge` 能力；同一句已被覆盖时先标 `conflict` 并返回 409，再次调用即强制采用提案 |
| G-17 | 后端 | `POST /api/groups/{gid}/materials/{mid}/merge` | `{"parent","sentences":[…],"force?":bool}` | `{"status":"merged\|conflict","conflicts?":[…],"version?"}` 或 `{"material":…}` 错误 | 有副本模式的节点三方合并（base/current/incoming）；冲突返回 `status=conflict` 并列出 `base/current/incoming`；`force=true` 时冲突句采用本地版本 |
| G-18 | 后端 | `POST /api/groups/{gid}/materials/{mid}/playback` | `{"mode":"burn\|permanent\|timed","days?":1~365}` | `{"approval":…}` | 申请播放；同一设备已有 pending 时 409 |
| G-19 | 后端 | `GET /api/groups/{gid}/approvals` | 无 | `{"approvals":[…]}` | 有 `approve` 能力看全部，否则只看自己的申请 |
| G-20 | 后端 | `POST /api/groups/{gid}/approvals/{aid}/decide` | `{"approve":bool}` | `{"approval":…}` | 需 `approve` 能力；timed 批准时写入 `expires_at` |
| G-21 | 后端 | `POST /api/groups/{gid}/approvals/{aid}/consume` | 无 | `{"approval":…}` | 阅后即焚在 `<audio>` 播完后由前端上报；未上报前不会失效 |
| G-22 | 后端 | `GET /api/groups/{gid}/materials/{mid}/audio?approval_id={aid}` | 可选 `Range` | 音频字节流（`200`/`206`） | **门禁**：审批不存在/非申请设备/已用/已过期/材料无音频一律 403，页面拿不到直链；支持 Range |
| G-23 | 后端 | `GET /api/groups/{gid}/access` | 无 | `{"access":[…]}` | 访问留痕，需 `members` 能力；上限 500 条 |

`RoleCaps`：`view / edit / submit / merge / material / approve / members / roles / review / manage`。默认五角色 `owner/admin/editor/reader/reviewer` 可改名与增删能力（权限模板不硬编码）。

`ModelOption = {id,label,min_ram,speed,note,available}`；`available=false` 表示本机运行时尚未内置，前端置灰并显示「本机未内置」，选了也不会被后端接受（转写会返回明确错误，不假装成功）。

`RedactionCategory = {id,name,placeholder,color,enabled}`；`RedactionMark = {id,sentence_id,start,end,original,category_id,category_name,placeholder,color,timestamp}`。`start/end` 以**原句文字**为坐标（渲染时不替换、只加彩色底纹，保证选区坐标不漂移）；`original` 只用于界面回退与 diff，导出物必须剥离。

> R-1 是唯一的非 JSON 请求：请求体是音频原始字节，`name` 带原文件名（如 `访谈1.mp3`）、`format` 取值见下方格式白名单。前端用 `fetch` 把 `File` 直接作为 body，参数走 `URLSearchParams`（自动 UTF-8 编码）。
>
> **文件名禁止放 HTTP 头**：头字段只能是 ISO-8859-1，中文文件名会让浏览器 `fetch` 直接抛 `TypeError: Failed to read the 'headers' property ... non ISO-8859-1 code point`（用户实测踩过）。后端仍兼容读取旧的 `X-Filename` / `X-Format` 头，仅为过渡，新代码不要再发。

**音频格式白名单**（`X-Format` / 扩展名，改任何一处必须同步其余三处）：
`wav / mp3 / m4a / wma / flac / ogg / opus / aac / aiff`
- 定义处：后端 `main.AUDIO_FORMATS`（唯一权威来源）
- 同步处：前端 `api.ts` 的 `AUDIO_FORMATS`、`App.tsx` 上传 `input` 的 `accept`、本文件 R-1
- 解码：全部由后端 PyAV（faster-whisper 内部解码层）原生解码，用户不需要自己转格式

## 数据目录结构（人可读文本）

```
data/
  models/
    whisper-{size}/                     # 可选：离线模型目录（存在则优先使用，不联网下载）
    hf-cache/                           # 联网下载的模型缓存（HF_HOME 指向这里，换机拷走文件夹即带走）
  projects/
    {project_id}/
      project.json                      # 嵌套 → JSON
      recordings/
        {recording_id}/
          recording.json                # 嵌套 → JSON（含时长 / 格式 / 转写状态）
          audio.{ext}                   # 音频二进制（唯一落目录的二进制）
          sentences.csv                 # 行式 → CSV（列：id,recording_id,index,text,start_ms,end_ms,speaker）
          transcript.md                 # 正文稿 → Markdown
          versions/
            {stage}.{seq}.json          # 嵌套 → JSON（版本：diff + 完整句子快照，可复刻）
  settings.json                         # 本机身份（昵称 + 设备码）与模型选择
  groups/
    {group_id}/
      group.json                        # 群组：配对码 / 模式 / 角色模板 / 成员 / 材料快照 / 提案 / 审批 / 留痕
```

- 模型查找顺序：`LISTEN_WRITING_MODEL` 环境变量 → `data/models/whisper-{size}/` 本地目录 → 联网下载（官方 HuggingFace，失败降级 hf-mirror.com），缓存落在项目文件夹 `data/models/hf-cache/`（不写系统盘的用户目录）。
- 项目版本号 `stage.seq`（阶段.阶段内序号）：阶段 0 初始转写落 `versions/0.1.json`；每次单句修改在同一阶段内 `seq+1`（如 `0.2`）；阶段升级时 `seq` 重置为 1（如 `1.1`）。
- 版本 JSON 必含：`version/stage/seq/parent/author_nick/timestamp/message/diff/sentences`。`diff` 形如 `[{sentence_id,index,op:"replace",before:{...},after:{...}}]`；`sentences` 为该版本完整快照，用于任意两版复刻。
- 转写状态对象 `transcribe`：`{"status":"pending|transcribing|done|error","progress":0~100,"error":""}`，随 `recording.json` 持久化；`transcribing` 期间进度实时更新。

## 字段与命名约定

- **命名**：一律 `snake_case`；`id` 为各实体主键（字符串，如录音 id）。前后端同名字段绝不改名，否则对不上。
- **软件版本号**：四段整数 `frontend / backend / model / data`，各自独立递增；提交时只 bump 对应段（定义见 `backend/models.py` 的 `APP_VERSION`）。
- **项目版本号**（与软件版本号是两码事）：每条录音一条版本线，版本 = `stage.seq`（阶段.阶段内序号），见 `backend/models.py` 的 `VersionRef`。

## 引导部署（bootstrap）

后端不在时，前端首屏渲染引导页（`BootstrapGuide.tsx`），三步把本地后端跑起来：

1. **写入启动文件**：用户点按钮选一个空文件夹，页面把嵌入的文件一键写进去（File System Access API；不支持的浏览器逐个下载兜底）。写入清单 = `frontend/src/bootstrapFiles.ts`，由 `frontend/scripts/embed-backend.mjs` 在 build 时从仓库生成：
   - `backend/{main,models,storage,transcriber,preload,llm,collab}.py`
   - `requirements.txt`（写到用户文件夹根目录，启动器在根目录执行 `pip install -r requirements.txt`）
   - `start-windows.bat` / `start-mac.command` / `start.sh` / `README.md`（来源：仓库 `bootstrap/`）
2. **运行启动器**：Windows 双击 bat；macOS 终端 `bash` + 拖入 `.command`；Linux `bash start.sh`。启动器**不要求系统已装 Python**：首次自动下载便携 CPython 到用户文件夹 `.runtime/` → 依赖装进这份运行时 → `python backend/preload.py` 预下载模型（失败不阻塞）→ 启动 `backend/main.py`。
3. **自动重连**：后端离线期间前端每 2 秒探测 `/api/health`，通了自动进入主界面。

### 自动检查更新（update）

已部署的用户不需要重新下载文件就能跟上新版本：

1. **检查**：构建时 `embed-backend.mjs` 从 `backend/models.py` 读出 `APP_VERSION` 写进 `bootstrapFiles.ts` 的 `BUNDLE_VERSION`；页面连上后端后比对 `/api/version` 的 `frontend` 段，落后就显示顶部横幅「本地后端还是旧版本」。检查只读，不改文件。
2. **写入**：用户点「更新本地文件」后，用 IndexedDB 里存过的目录句柄（引导页写入时保存）申请一次写权限；没有句柄或权限被拒时回退到「重新选文件夹」。只重写**内容有差异**的文件，绝不碰 `data/`、`.runtime/` 与用户其它文件。
3. **启动器不覆盖**：`.bat` / `.sh` / `.command` 即使有差异也不写回（Windows 的 cmd 边读边执行，覆盖正在运行的 bat 会让命令错位），横幅会提示用户重新写入一次。
4. **重启**：写完后 `POST /api/restart`，启动器收到退出码 86 后重新 `pip install` + 重启，页面轮询 `/api/health` 自动恢复。旧版后端没有该接口（404），此时横幅提示用户手动关闭窗口重开一次；之后即可自动重启。

> 版本纪律：任何嵌入文件（后端代码 / requirements / 启动器 / README）有改动，都必须 bump `APP_VERSION.frontend`，否则页面不会提示更新。

约束：
- 启动器假设目录结构为「用户文件夹根目录下有 `backend/` 与 `requirements.txt`」，改嵌入文件布局必须同步改启动器与 embed 脚本。
- 后端 / bootstrap 源码改动后重新 `npm run build` 即重新嵌入，无手工同步步骤。