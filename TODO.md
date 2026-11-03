# To Do List（项目坑记录）

> 记录人类与 AI 协作过程中项目遇到的坑 / 空壳 / 待填项（对应工程纪律「空壳必须声明、征得同意并记住」）。
> 默认语义：除非人类明确说「以后也不做」，否则这里每条都视为「以后要做」。

## 已填的坑

- [x] **引导部署**（2026-11-03）：Pages 首屏检测后端离线 → 引导页三步（一键写入启动文件 → 运行启动器 → 每 2 秒自动重连）。写入清单由 `frontend/scripts/embed-backend.mjs` 在 build 时从 `backend/` + `bootstrap/` 生成，无双维护。后端加了 `Access-Control-Allow-Private-Network` 头过 Chrome PNA 预检。
- [x] **模型首次下载**（2026-11-03）：启动器内 `backend/preload.py` 预下载模型（失败不阻塞启动，首次转写自动重试）；转写进度 <5% 时页面显示「可能在下载模型」提示。
- [x] **录音格式白名单**（2026-11-03）：扩展为 `wav/mp3/m4a/wma/flac/ogg/opus/aac/aiff`，解码全部由后端 PyAV 内置完成（不再让用户自己转格式）；flac 已端到端实测转写跑通。

## 待办 / 坑

- [ ] **macOS / Linux 启动仍需一条终端命令**（Windows 已真双击）：mac 上 File System Access API 写出的文件没有执行位，`.command` 双击会报权限错误，当前方案是「bash + 拖入」。后续可探索安装时自赋执行位或打包 .pkg / AppImage。
- [ ] **hf-mirror 兜底未在真实网络实测**：sandbox 屏蔽 huggingface.co 和 hf-mirror.com，`transcriber.py` 的镜像降级逻辑只能靠代码审查 + 本地路径模型实测转写链路。需要一个真实网络环境验证「官方失败 → 自动切镜像」真的发生。
- [ ] **转写进度粒度**：faster-whisper 按句 yield 才更新进度，长句/无音段时进度会跳变。当前够用，若需更平滑可加 VAD 分块进度。
- [ ] 后续阶段仍未实现（结构化空壳，已声明）：阶段 1 文字润色、阶段 2 脱敏、协作（配对码组群 + git 式合并 + 四级权限）、审查模式。
