# 依赖记录

> 改动时都要查本文件（对应工程纪律第 10 条）。

## A. 安装的库依赖

| 库 | 版本 | 用途 | 可能变更点 / 备注 |
|---|---|---|---|
| （无） | — | 骨架阶段零第三方依赖，仅 Python 标准库（`http.server` / `threading` / `dataclasses` / `json`） | 后续引入 ASR / LLM 推理库时在此登记 |

## B. 自定义函数依赖

> 记录自己写的函数，以及调用它时用到的字段；函数变更时据此判断字段是否还保留、不保留时引用处要如何改。

| 函数 | 所属文件 | 输入 / 输出 | 被依赖的字段 / 参数 | 引用处 |
|---|---|---|---|---|
| `APP_VERSION` | `backend/models.py` | 常量 dict：`{frontend, backend, model, data}` 四段整数 | 各段版本号 | `backend/main.py` 的 `GET /api/version` |
| `Handler._send_json` | `backend/main.py` | payload(dict) + status → 写 JSON 响应 | `status` 参数、CORS 头 | `do_GET` 各分支 |