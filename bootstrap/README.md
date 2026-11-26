# listen_writing 本地启动包

这个文件夹里的文件由网页一键写入，是运行本地后端所需的全部内容。

**不需要预先安装 Python**：首次运行会自动下载一份便携 Python（约 25–70MB）放进 `.runtime/`，
依赖也装在这份运行时里，不会影响电脑上其他软件。

## Windows

双击 `start-windows.bat`。

首次成功启动后会：
- 在桌面创建「Listen Writing」图标（直接打开工作台页面）；
- 在开机启动项里创建「Listen Writing Backend」快捷方式（静默启动后端，不弹浏览器）。

以后点桌面图标、或直接点 GitHub Pages 页面 / 书签，都会直接连上已经在后台运行的本地后端。
如果关掉了后端窗口，再点桌面图标会停在引导页——此时重新双击 `start-windows.bat` 即可。

不想要开机启动：运行 `start-windows.bat --remove-shortcuts`（会删除桌面与启动项快捷方式）。

## macOS

打开「终端」（Terminal），输入 `bash `（bash 后面加一个空格），然后把 `start-mac.command` 从文件夹拖进终端窗口，按回车。

## Linux

在文件夹里打开终端，运行 `bash start.sh`。

## 不想每次去文件夹里找启动器？

**Windows**：首次运行会自动创建桌面快捷方式，无需再手动「发送到桌面」。想开机自动启动也已自动完成；不想要时运行 `start-windows.bat --remove-shortcuts`。

**macOS**：在 Finder 里右键 `start-mac.command` →「制作别名」，拖到桌面。
想开机自动启动：系统设置 →「通用」→「登录项与扩展」→ 加入登录项。

**Linux**：在桌面建 `listen-writing.desktop`，写入下面内容并右键设为允许启动：

```
[Desktop Entry]
Type=Application
Name=Listen Writing
Exec=bash /你的完整路径/start.sh
Terminal=true
```

## 首次启动会做什么

1. 下载便携 Python 运行时（约 50MB）。优先从国内镜像站（南京大学 / 华为云）下载，**不需要你开代理**。
2. 安装转写组件（约 600MB），以及可选的本地 AI 运行时（约 30MB；装不上不影响转写，只是「AI 纠错」不可用）。
3. 下载本机配置允许的全部模型：转写（含实时录音与更低档）、AI（选中档及以下）、向量模型，以及 MinerU 组件与模型。
4. 窗口出现 `http://127.0.0.1:7850` 即启动成功。

总计首次约 12–20GB 下载、约 20GB 磁盘空间（按本机配置自动选择档位；32G 机器会多下 7B 与更低档）。
之后再次启动不再下载。
第一次会把**本机配置允许的全部档位**一次装齐：转写（Whisper 各档 + SenseVoice + Qwen3-ASR，取决于内存与运行时）、
AI（选中档位及以下全部）、知识库向量模型、以及 PDF 转换组件（MinerU + torch + 模型）。
所有组件都由启动器自动安装，不需要你之后再去点“安装组件”；某个组件装失败时，知识库页会给出重试入口。
全程不需要你配置代理；下载源优先国内镜像，官方 GitHub 与第三方代理只作为兜底。

## Windows 提示「无法验证发布者 / 已阻止此应用」

这是因为下载的 BAT 没有代码签名，且被 Windows 标记为「来自网络」。处理：

1. 右键 `start-windows.bat` →「属性」→ 勾选「解除锁定」→ 确定。
2. 若弹出 SmartScreen，点「更多信息」→「仍要运行」。
3. 或在启动器文件夹里打开 PowerShell，运行 `Get-ChildItem -Recurse | Unblock-File`。
4. 更省事：优先用网页第 1 步「选择文件夹并写入启动文件」，本地新建的文件一般不会被拦。


## 数据在哪

录音与转写稿保存在本文件夹的 `data/` 目录，全部是人可读文本（CSV / JSON / Markdown），
可直接查看、备份、迁移。

## 断网 / 离线使用

把语音模型文件夹放到 `data/models/whisper-small/`，后端会优先使用它，不再联网下载。
