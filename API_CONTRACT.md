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

## 字段与命名约定

- **命名**：一律 `snake_case`；`id` 为各实体主键（字符串，如录音 id）。前后端同名字段绝不改名，否则对不上。
- **软件版本号**：四段整数 `frontend / backend / model / data`，各自独立递增；提交时只 bump 对应段（定义见 `backend/models.py` 的 `APP_VERSION`）。
- **项目版本号**（与软件版本号是两码事）：每条录音一条版本线，版本 = `stage.seq`（阶段.阶段内序号），见 `backend/models.py` 的 `VersionRef`。