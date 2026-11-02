# To Do List（项目坑记录）

> 记录人类与 AI 协作过程中项目遇到的坑 / 空壳 / 待填项（对应工程纪律「空壳必须声明、征得同意并记住」）。
> 默认语义：除非人类明确说「以后也不做」，否则这里每条都视为「以后要做」。

## 待办 / 坑

- [ ] 前端 `api.ts` 硬编码 `BACKEND = http://127.0.0.1:7850`；Pages 是 https，浏览器会拦 mixed content。需落实「引导部署」：首次打开 Pages → 引导选本地路径 → File System Access API 写入本地后端/模型/启动器 → 再连本地后端。（阶段 0 已实现业务接口，但「引导部署」这条基线仍未做）
- [ ] **模型下载源**：后端 `transcriber.py` 已做「官方 HF 失败 → 自动降级 hf-mirror.com」兜底；但首次转写前仍需联网下载模型（small 约 460MB）。非技术用户需要「引导部署」环节自动准备好模型，或给出明确的首次下载提示。sandbox 屏蔽 huggingface.co，测试用 GitHub release 镜像验证过加载/转写链路。
- [ ] **录音格式白名单**：当前仅 `wav / mp3 / m4a / wma`（泛化到 `models.Recording.format`）。`av` 实际能解码 flac / ogg 等更多格式，后续若专业录音笔常见 flac，可放宽白名单并同步前端 `accept` 与 `api.formatOf`。
- [ ] **转写进度粒度**：`faster-whisper` 按句 yield 才更新进度，长句/无音段时进度会跳变。当前够用，若需更平滑可加 VAD 分块进度。
- [ ] 后续阶段仍未实现（结构化空壳，已声明）：阶段 1 文字润色、阶段 2 脱敏、协作（配对码组群 + git 式合并 + 四级权限）、审查模式。