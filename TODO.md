# To Do List（项目坑记录）

> 记录人类与 AI 协作过程中项目遇到的坑 / 空壳 / 待填项（对应工程纪律「空壳必须声明、征得同意并记住」）。
> 默认语义：除非人类明确说「以后也不做」，否则这里每条都视为「以后要做」。

## 已填的坑

- [x] **引导部署**（2026-11-03）：Pages 首屏检测后端离线 → 引导页三步（一键写入启动文件 → 运行启动器 → 每 2 秒自动重连）。写入清单由 `frontend/scripts/embed-backend.mjs` 在 build 时从 `backend/` + `bootstrap/` 生成，无双维护。后端加了 `Access-Control-Allow-Private-Network` 头过 Chrome PNA 预检。
- [x] **模型首次下载**（2026-11-03）：启动器内 `backend/preload.py` 预下载模型（失败不阻塞启动，首次转写自动重试）；转写进度 <5% 时页面显示「可能在下载模型」提示。
- [x] **录音格式白名单**（2026-11-03）：扩展为 `wav/mp3/m4a/wma/flac/ogg/opus/aac/aiff`，解码全部由后端 PyAV 内置完成（不再让用户自己转格式）；flac 已端到端实测转写跑通。
- [x] **不再假设用户装了 Python**（2026-11-03）：启动器首次自动下载便携 CPython 到 `.runtime/`（GitHub python-build-standalone，Win 47MB / mac 25MB / Linux 68MB），依赖装进这份运行时，不建 venv、不碰系统环境。用户电脑即使完全没有 Python 也能用。
- [x] **Windows 缺 MSVCP140.dll**（2026-11-03）：核查发现 `ctranslate2.dll` 依赖 `MSVCP140.dll`（便携 Python 只带 vcruntime140，不带 msvcp140），干净 Windows 会 `DLL load failed`。启动器在装依赖后 `import av, ctranslate2` 自检，失败则自动下载并静默安装微软官方 VC++ 运行库，需用户点一次 UAC「是」；装不上时给出官方链接让用户手动装。
- [x] **下载没有考虑国内网络环境**（2026-11-03，用户指出）：原来只给 GitHub 一个源，国内常无法访问；从第三方镜像下可执行文件又不校验，有被篡改的风险。已改为：官方 GitHub → `gh-proxy.com` → `ghproxy.net` 三源依次尝试，每次下载后用官方 `SHA256SUMS` 里的 hash 校验，不符即删掉换源；`curl` 加 `--connect-timeout 10 --speed-limit 1024 --speed-time 20` 让死链快速失败，没有 curl 的 Windows 回退 PowerShell。pip 改为清华镜像优先、官方源兜底；HuggingFace 探测超时缩到 5s/20s，端点不通时关掉 xet 改走镜像（切源方式见下方「hf-mirror 自动降级原先实际失效」）。
- [x] **依赖版本浮动导致转写全挂**（2026-11-03，真机报错暴露）：`requirements.txt` 只锁了 faster-whisper，pip 自动装到 av 19，`av 19` 移除了 `open(metadata_errors=...)` 参数，faster-whisper 1.2.1 直接报错、所有转写失败。已锁 `ctranslate2==4.8.1`、`av==17.1.0`、`tokenizers==0.22.1`、`huggingface-hub>=0.21,<2`；在 Linux 完整链路重装后实测转写成功。
- [x] **自动检查更新**（2026-11-05）：页面构建时把 `APP_VERSION` 写进 `BUNDLE_VERSION`，连上后端后比对 `/api/version`；落后就在顶部显示横幅，一键把有差异的文件写回用户文件夹（目录句柄存 IndexedDB，只写固定清单、不碰 `data/` 和 `.runtime/`），再调 `POST /api/restart`；启动器约定退出码 86 时回到开头重装依赖并重启。旧版后端没有该接口，第一次更新会提示用户手动重开一次。
- [x] **Windows 批处理中文导致 cmd 错位执行**（2026-11-03，用户真机实测暴露）：`.bat` 里写了中文注释，cmd 按字节读文件，UTF-8 中文被按 GBK 拆成不同字符数，文件偏移错位 → 从行中间开始执行（报 `untime` / `ownloads` / `026"`，还误触发 `time` 命令）。已改：`.bat` 纯 ASCII，`embed-backend.mjs` 自动转 CRLF 且检测到非 ASCII 直接让 build 失败；shell 脚本强制 LF。
- [x] **模型缓存放回项目文件夹**（2026-11-05，用户选择「要重新下」）：用户真机日志显示模型默认下到 `C:\Users\Rosa\.cache\huggingface`（系统盘），换电脑带不走。已把 `HF_HOME` 默认指向 `data/models/hf-cache/`，换机拷走整个文件夹即可；`needs_download` 改为检查缓存里是否已有 `model.bin`，避免每次启动都打印「开始下载」（用户会以为每次重下 500MB）。代价是用户已下的旧缓存作废，需重下一次（约 500MB）。
- [x] **hf-mirror 自动降级原先实际失效**（2026-11-05，实测暴露）：`huggingface_hub` 1.x 在进程运行中改 `constants.ENDPOINT` 不生效，原来的「官方失败后切镜像重试」永远走旧地址。改为在导入前 HEAD 官方模型接口（3 秒超时），不通就直接设 `HF_ENDPOINT=hf-mirror.com`（端点必须在 import 前定下）。sandbox 实测：官方不可达时自动切镜像，tiny 模型 75MB 下载成功，缓存落在项目文件夹。

- [x] **中文文件名上传直接崩溃**（2026-11-05，用户真机报错）：`fetch` 把 `X-Filename: 访谈1.mp3` 写进 HTTP 头时抛 `TypeError: String contains non ISO-8859-1 code point`——头字段只能是 ISO-8859-1。已改为文件名/格式放 query（`URLSearchParams` 自动 UTF-8 编码），后端 `parse_qs` 解码，仍兼容旧头。实测：同一 Node fetch 脚本，旧写法抛 `Cannot convert argument to a ByteString`，新写法 `201` 且回读 `name` 保留「访谈1.mp3」。
- [x] **主页不展示版本号，界面居中卡片化**（2026-11-05，用户指出）：版本号是开发信息，不该出现在用户主页；顶部品牌区居中，只留「本地后端已连接 · 录音不出本机」，四段版本号只在内部用于升级判断，横幅文案也不再带 `fr x` 这类数字。内容区改为居中容器（max-width 1120）+ 左右两张白卡片。
- [x] **写操作改乐观更新 + 回滚，去掉加载态**（2026-11-05，对照工程纪律三.3 自查）：新建项目、上传录音改为先插入临时项（`tmp-` 前缀）立即显示，成功后替换为服务端返回的真实对象、失败则移除并报错；去掉了「上传中…」文字与禁用态。临时 id 不设为当前选中项，避免触发对不存在对象的 GET。
- [x] **引导页滚动条隐形**（2026-11-05）：引导页容器改为 `100vh + overflowY:auto + scroll-hidden`，窗口矮时页面可滚但不露出滚动条。

- [x] **更新流程改成阻塞式更新页**（2026-11-05，用户指出「没有行业实践、闭门造车」）：检测到新版本不再只在顶部挂一条提示，而是进入全屏更新页（遮罩 + 卡片），按阶段展示：发现新版本 → 写入 x/n 个文件 → 重启后端（不确定进度条）→ 自动解除。更新进行中不允许操作，避免新旧代码混用；「发现新版本」阶段可以点「稍后」，收起成顶部一条提示继续用旧版。
- [x] **主界面加「启动设置」入口**（2026-11-05，用户指出）：右上角常驻按钮回到引导页，用户不需要手动输入网址；引导页在应用在线时带「← 返回应用」。
- [ ] **启动器脚本仍未全自动更新**：Windows cmd 边读边执行，覆盖正在运行的 .bat 会让命令错位。计划把逻辑外置到 `launcher.py`，`.bat` 只保留「准备运行时 → 调用 launcher.py」的薄壳，之后逻辑文件和启动器都能安全自动更新。

## 待办 / 坑

- [ ] **自动更新未在真机走完整条链路**：版本落后 → 横幅出现 → 点「更新本地文件」→ 浏览器写权限弹窗 → 写回 → 后端收到 86 自动重启，这条链在 sandbox 里无法执行 File System Access / IndexedDB（浏览器环境拿不到本地文件夹）。已实测的是：后端 `POST /api/restart` 进程确实以 86 退出、`start.sh` 收到 86 后确实重装依赖并重启、构建产物含横幅与版本比对逻辑。Windows 的 `if errorlevel 86` 循环仍需真机验证。
- [ ] **启动器脚本不会自动覆盖**：更新只写后端代码 / requirements / README；`.bat` / `.sh` / `.command` 内容有差异时只提示「请回到引导页重新写入一次」。若要彻底自动，需把启动器改成「薄壳 + 可安全覆盖的 PowerShell/其它脚本」，属于后续重构。
- [ ] **macOS 启动器未真机执行**：Windows 已于 2026-11-05 真机跑通（用户日志：下载运行时 44.93MB → 清华镜像装依赖 → 下模型 → 起服务 → 页面连上 `/api/health`）。macOS 仍未在真机跑过，脚本与 Linux 同构但仍需验证。
- [ ] **Windows 需要 Win10 1803+ 才有内置 `tar.exe`**：更老的系统会在解压步骤给出明确报错。若将来要覆盖老系统，可改用 python.org 的 zip 版（PowerShell 可直接解压）。
- [ ] **macOS / Linux 启动仍需一条终端命令**（Windows 已真双击）：mac 上 File System Access API 写出的文件没有执行位，`.command` 双击会报权限错误，当前方案是「bash + 拖入」。后续可探索安装时自赋执行位或打包 .pkg / AppImage。
- [ ] **镜像站可用性会变**：`gh-proxy.com` / `ghproxy.net` 当前实测可用（`ghfast.top`、`mirror.ghproxy.com` 已不可用），但第三方代理随时可能失效。若用户反馈「所有源都不通」，优先检查这两个域名，并考虑增加更多候选源。
- [ ] **Windows 侧 SHA 校验 / PowerShell 下载分支未执行过**：Linux 侧 `fetch_runtime` 的三源 + 校验已实测；Windows 的 `:try_download` / `:verify_download` 只做了静态审查，需真机跑到一次校验失败换源的场景才算验证。
- [ ] **升级便携 Python 必须同步 5 个 SHA256**：`PYTAG`/`PYVER` 变更时，官方 `SHA256SUMS` 里 Windows x64、mac arm64、mac x64、linux x64、linux arm64 五条 hash 要一起更新，漏一条会导致该平台永远校验失败。
- [ ] **转写进度粒度**：faster-whisper 按句 yield 才更新进度，长句/无音段时进度会跳变。当前够用，若需更平滑可加 VAD 分块进度。
- [ ] 后续阶段仍未实现（结构化空壳，已声明）：阶段 1 文字润色、阶段 2 脱敏、协作（配对码组群 + git 式合并 + 四级权限）、审查模式。
