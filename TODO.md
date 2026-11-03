# To Do List（项目坑记录）

> 记录人类与 AI 协作过程中项目遇到的坑 / 空壳 / 待填项（对应工程纪律「空壳必须声明、征得同意并记住」）。
> 默认语义：除非人类明确说「以后也不做」，否则这里每条都视为「以后要做」。

## 已填的坑

- [x] **引导部署**（2026-11-03）：Pages 首屏检测后端离线 → 引导页三步（一键写入启动文件 → 运行启动器 → 每 2 秒自动重连）。写入清单由 `frontend/scripts/embed-backend.mjs` 在 build 时从 `backend/` + `bootstrap/` 生成，无双维护。后端加了 `Access-Control-Allow-Private-Network` 头过 Chrome PNA 预检。
- [x] **模型首次下载**（2026-11-03）：启动器内 `backend/preload.py` 预下载模型（失败不阻塞启动，首次转写自动重试）；转写进度 <5% 时页面显示「可能在下载模型」提示。
- [x] **录音格式白名单**（2026-11-03）：扩展为 `wav/mp3/m4a/wma/flac/ogg/opus/aac/aiff`，解码全部由后端 PyAV 内置完成（不再让用户自己转格式）；flac 已端到端实测转写跑通。
- [x] **不再假设用户装了 Python**（2026-11-03）：启动器首次自动下载便携 CPython 到 `.runtime/`（GitHub python-build-standalone，Win 47MB / mac 25MB / Linux 68MB），依赖装进这份运行时，不建 venv、不碰系统环境。用户电脑即使完全没有 Python 也能用。
- [x] **Windows 缺 MSVCP140.dll**（2026-11-03）：核查发现 `ctranslate2.dll` 依赖 `MSVCP140.dll`（便携 Python 只带 vcruntime140，不带 msvcp140），干净 Windows 会 `DLL load failed`。启动器在装依赖后 `import av, ctranslate2` 自检，失败则自动下载并静默安装微软官方 VC++ 运行库，需用户点一次 UAC「是」；装不上时给出官方链接让用户手动装。
- [x] **下载没有考虑国内网络环境**（2026-11-03，用户指出）：原来只给 GitHub 一个源，国内常无法访问；从第三方镜像下可执行文件又不校验，有被篡改的风险。已改为：官方 GitHub → `gh-proxy.com` → `ghproxy.net` 三源依次尝试，每次下载后用官方 `SHA256SUMS` 里的 hash 校验，不符即删掉换源；`curl` 加 `--connect-timeout 10 --speed-limit 1024 --speed-time 20` 让死链快速失败，没有 curl 的 Windows 回退 PowerShell。pip 改为清华镜像优先、官方源兜底；HuggingFace 探测超时缩到 5s/20s 并在降级镜像时关掉 xet。
- [x] **依赖版本浮动导致转写全挂**（2026-11-03，真机报错暴露）：`requirements.txt` 只锁了 faster-whisper，pip 自动装到 av 19，`av 19` 移除了 `open(metadata_errors=...)` 参数，faster-whisper 1.2.1 直接报错、所有转写失败。已锁 `ctranslate2==4.8.1`、`av==17.1.0`、`tokenizers==0.22.1`、`huggingface-hub>=0.21,<2`；在 Linux 完整链路重装后实测转写成功。
- [x] **Windows 批处理中文导致 cmd 错位执行**（2026-11-03，用户真机实测暴露）：`.bat` 里写了中文注释，cmd 按字节读文件，UTF-8 中文被按 GBK 拆成不同字符数，文件偏移错位 → 从行中间开始执行（报 `untime` / `ownloads` / `026"`，还误触发 `time` 命令）。已改：`.bat` 纯 ASCII，`embed-backend.mjs` 自动转 CRLF 且检测到非 ASCII 直接让 build 失败；shell 脚本强制 LF。

## 待办 / 坑

- [ ] **Windows / macOS 启动器未真机执行**：只在 Linux x64 实测了全流程（下载运行时→装依赖→转写）。三份脚本逻辑同构，但仍需在真 Windows / 真 macOS 上各跑一次才算通过。这是最优先要补的验证。
- [ ] **Windows 需要 Win10 1803+ 才有内置 `tar.exe`**：更老的系统会在解压步骤给出明确报错。若将来要覆盖老系统，可改用 python.org 的 zip 版（PowerShell 可直接解压）。
- [ ] **macOS / Linux 启动仍需一条终端命令**（Windows 已真双击）：mac 上 File System Access API 写出的文件没有执行位，`.command` 双击会报权限错误，当前方案是「bash + 拖入」。后续可探索安装时自赋执行位或打包 .pkg / AppImage。
- [ ] **镜像站可用性会变**：`gh-proxy.com` / `ghproxy.net` 当前实测可用（`ghfast.top`、`mirror.ghproxy.com` 已不可用），但第三方代理随时可能失效。若用户反馈「所有源都不通」，优先检查这两个域名，并考虑增加更多候选源。
- [ ] **Windows 侧 SHA 校验 / PowerShell 下载分支未执行过**：Linux 侧 `fetch_runtime` 的三源 + 校验已实测；Windows 的 `:try_download` / `:verify_download` 只做了静态审查，需真机跑到一次校验失败换源的场景才算验证。
- [ ] **升级便携 Python 必须同步 5 个 SHA256**：`PYTAG`/`PYVER` 变更时，官方 `SHA256SUMS` 里 Windows x64、mac arm64、mac x64、linux x64、linux arm64 五条 hash 要一起更新，漏一条会导致该平台永远校验失败。
- [ ] **hf-mirror 兜底未在真实网络实测**：sandbox 屏蔽 huggingface.co 和 hf-mirror.com，`transcriber.py` 的镜像降级逻辑只能靠代码审查 + 本地路径模型实测转写链路。需要一个真实网络环境验证「官方失败 → 自动切镜像」真的发生。
- [ ] **转写进度粒度**：faster-whisper 按句 yield 才更新进度，长句/无音段时进度会跳变。当前够用，若需更平滑可加 VAD 分块进度。
- [ ] 后续阶段仍未实现（结构化空壳，已声明）：阶段 1 文字润色、阶段 2 脱敏、协作（配对码组群 + git 式合并 + 四级权限）、审查模式。
