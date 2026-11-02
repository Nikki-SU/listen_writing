# 接口契约

> 前后端分开写时，双端子 Agent 都要先读本文件，以它作为唯一的接口纪律。

## 通用约定

- **协议**：HTTP（本地回环），后端是纯标准库 `http.server`，无第三方框架。
- **地址**：`http://127.0.0.1:7850`（本机）。前端经浏览器 fetch；未来局域网协作用户 IP 替代。
- **数据格式**：请求 / 响应体一律 `application/json; charset=utf-8`，字段用 `snake_case`。
- **CORS**：后端返回 `Access-Control-Allow-Origin: *`（本地单机 + 文件/Pages 源），骨架阶段放开收窄后续再说。
- **错误约定**：非 JSON 或未知路径一律 `404`，返回 `{"error": "<可读原因>"}`；字段名字典化，不静默给空值 / 0（对应《工程纪律》「先约束，再容错」）。

## 接口清单

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| H-1 | 后端 | `GET /api/health` | 无 | `{"status":"ok"}` | 前端启动后用来确认后端在线 |
| V-1 | 后端 | `GET /api/version` | 无 | `{"version":{"frontend":1,"backend":1,"model":1,"data":1}}` | 软件四段版本号 |
| P-1 | 后端 | `POST /api/projects` | `{"name":"项目名","description":"说明"}` | `{"project":{...}}` | 创建项目（description 可空） |
| P-2 | 后端 | `GET /api/projects` | 无 | `{"projects":[{...}]}` | 列出全部项目（按创建倒序） |
| R-1 | 后端 | `POST /api/projects/{project_id}/recordings` | **raw 音频字节**（非 JSON）+ 头 `X-Filename`、`X-Format` | `{"recording":{...}}` | 上传录音，落 `audio.{ext}` 后**异步启动转写** |
| R-3 | 后端 | `GET /api/projects/{project_id}/recordings` | 无 | `{"recordings":[{...}]}` | 列出项目下录音（仅元数据，按创建倒序） |
| R-2 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}` | 无 | `{"recording":{...},"transcribe":{...},"sentences":[...]}` | 录音详情 + 转写状态 + 分句列表 |

> R-1 是唯一的非 JSON 请求：请求体是音频原始字节，`X-Filename` 带扩展名（如 `访谈1.mp3`）、`X-Format` 取值 `wav / mp3 / m4a / wma`。前端用 `fetch` 把 `File` 的 `ArrayBuffer` 直接作为 body。

## 数据目录结构（人可读文本）

```
data/
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

- 项目版本号 `stage.seq`（阶段.阶段内序号）：阶段 0 初始转写落 `versions/0.1.json`。
- 转写状态对象 `transcribe`：`{"status":"pending|transcribing|done|error","progress":0~100,"error":""}`，随 `recording.json` 持久化；`transcribing` 期间进度实时更新。

## 字段与命名约定

- **命名**：一律 `snake_case`；`id` 为各实体主键（字符串，如录音 id）。前后端同名字段绝不改名，否则对不上。
- **软件版本号**：四段整数 `frontend / backend / model / data`，各自独立递增；提交时只 bump 对应段（定义见 `backend/models.py` 的 `APP_VERSION`）。
- **项目版本号**（与软件版本号是两码事）：每条录音一条版本线，版本 = `stage.seq`（阶段.阶段内序号），见 `backend/models.py` 的 `VersionRef`。