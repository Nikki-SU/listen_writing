// File System Access API（Chromium 系）：引导部署用它一键写入启动文件。
// 其余浏览器不支持时走「逐个下载」兜底（见 BootstrapGuide.tsx）。
interface Window {
  showDirectoryPicker?: (options?: {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?: string
  }) => Promise<FileSystemDirectoryHandle>
}
