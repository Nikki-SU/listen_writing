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
| R-1 | 后端 | `POST /api/projects/{project_id}/recordings` | **raw 音频字节**（非 JSON）+ 头 `X-Filename`、`X-Format` | `{"recording":{...}}` | 上传录音，落 `audio.{ext}` 后**异步启动转写** |
| R-3 | 后端 | `GET /api/projects/{project_id}/recordings` | 无 | `{"recordings":[{...}]}` | 列出项目下录音（仅元数据，按创建倒序） |
| R-2 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}` | 无 | `{"recording":{...},"transcribe":{...},"sentences":[...]}` | 录音详情 + 转写状态 + 分句列表 |

> R-1 是唯一的非 JSON 请求：请求体是音频原始字节，`X-Filename` 带扩展名（如 `访谈1.mp3`）、`X-Format` 取值见下方格式白名单。前端用 `fetch` 把 `File` 直接作为 body。

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
            {stage}.{seq}.json          # 嵌套 → JSON（版本引用）
```

- 模型查找顺序：`LISTEN_WRITING_MODEL` 环境变量 → `data/models/whisper-{size}/` 本地目录 → 联网下载（官方 HuggingFace，失败降级 hf-mirror.com）。
- 项目版本号 `stage.seq`（阶段.阶段内序号）：阶段 0 初始转写落 `versions/0.1.json`。
- 转写状态对象 `transcribe`：`{"status":"pending|transcribing|done|error","progress":0~100,"error":""}`，随 `recording.json` 持久化；`transcribing` 期间进度实时更新。

## 字段与命名约定

- **命名**：一律 `snake_case`；`id` 为各实体主键（字符串，如录音 id）。前后端同名字段绝不改名，否则对不上。
- **软件版本号**：四段整数 `frontend / backend / model / data`，各自独立递增；提交时只 bump 对应段（定义见 `backend/models.py` 的 `APP_VERSION`）。
- **项目版本号**（与软件版本号是两码事）：每条录音一条版本线，版本 = `stage.seq`（阶段.阶段内序号），见 `backend/models.py` 的 `VersionRef`。

## 引导部署（bootstrap）

后端不在时，前端首屏渲染引导页（`BootstrapGuide.tsx`），三步把本地后端跑起来：

1. **写入启动文件**：用户点按钮选一个空文件夹，页面把嵌入的文件一键写进去（File System Access API；不支持的浏览器逐个下载兜底）。写入清单 = `frontend/src/bootstrapFiles.ts`，由 `frontend/scripts/embed-backend.mjs` 在 build 时从仓库生成：
   - `backend/{main,models,storage,transcriber,preload}.py`
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