# listen_writing 本地启动包

这个文件夹里的文件由网页一键写入，是运行本地后端所需的全部内容。

**不需要预先安装 Python**：首次运行会自动下载一份便携 Python（约 25–70MB）放进 `.runtime/`，
依赖也装在这份运行时里，不会影响电脑上其他软件。

## Windows

双击 `start-windows.bat`。

## macOS

打开「终端」（Terminal），输入 `bash `（bash 后面加一个空格），然后把 `start-mac.command` 从文件夹拖进终端窗口，按回车。

## Linux

在文件夹里打开终端，运行 `bash start.sh`。

## 不想每次去文件夹里找启动器？

**Windows**：右键 `start-windows.bat` →「发送到」→「桌面快捷方式」，以后双击桌面图标即可。
想开机自动启动：按 `Win + R` 输入 `shell:startup` 回车，把该快捷方式复制进打开的文件夹。
（快捷方式只是指针，原文件夹不要删或挪走。）

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
3. 下载语音模型与 AI 模型（转写约 500MB + AI 约 2–4GB，按内存档位自动选）。
4. 窗口出现 `http://127.0.0.1:7850` 即启动成功。

总计首次约 3–5GB 下载、约 5–8GB 磁盘空间。之后再次启动不再下载。
PDF 知识库的转换组件（MinerU）在第一次导入 PDF 时由网页里的「知识库」页安装，另需约 6GB。
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
