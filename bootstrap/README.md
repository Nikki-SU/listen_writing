# listen_writing 本地启动包

这个文件夹里的文件由网页一键写入，是运行本地后端所需的全部内容。

## Windows

双击 `start-windows.bat`。

## macOS

打开「终端」（Terminal），输入 `bash `（bash 后面加一个空格），然后把 `start-mac.command` 从文件夹拖进终端窗口，按回车。

## Linux

在文件夹里打开终端，运行 `bash start.sh`。

## 启动后会发生什么

1. 首次运行自动创建 Python 虚拟环境、安装依赖（需要联网）。
2. 自动下载语音模型（约 500MB，下载源自动选择官方 / 国内镜像）。
3. 窗口显示 `backend listening on http://127.0.0.1:7850` 即启动成功。
4. 回到浏览器页面，它会在几秒内自动连上后端；没连上就点页面里的「重新连接」。

## 说明

- 请保持启动窗口开启；关闭窗口 = 停止后端。
- 录音与转写稿保存在本文件夹的 `data/` 目录，全部是人可读文本（CSV / JSON / Markdown），可直接查看和备份。
- 需要本机装有 Python 3.10+（没有就先装：https://www.python.org/downloads/）。
