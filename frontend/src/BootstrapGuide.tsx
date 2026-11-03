import { useState } from 'react'
import { BOOTSTRAP_FILES, type BootstrapFile } from './bootstrapFiles'

// 引导部署：后端离线时的首屏。用户全程只做三件事——
// ① 点按钮写入启动文件 ② 双击/拖入启动器 ③ 等页面自动连上（对应工程纪律「点按钮就能完事」）。

type PickState = 'idle' | 'writing' | 'done' | 'error' | 'unsupported'

function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent)
}
function isMac(): boolean {
  return /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

async function writeBootstrapFiles(
  onProgress: (written: number) => void,
): Promise<void> {
  const picker = window.showDirectoryPicker
  if (!picker) throw new Error('unsupported')
  const dir = await picker({ mode: 'readwrite' })
  let written = 0
  for (const f of BOOTSTRAP_FILES) {
    const parts = f.path.split('/')
    let handle: FileSystemDirectoryHandle = dir
    for (let i = 0; i < parts.length - 1; i++) {
      handle = await handle.getDirectoryHandle(parts[i], { create: true })
    }
    const fh = await handle.getFileHandle(parts[parts.length - 1], { create: true })
    const w = await fh.createWritable()
    await w.write(f.content)
    await w.close()
    written += 1
    onProgress(written)
  }
}

function downloadFile(f: BootstrapFile): void {
  const blob = new Blob([f.content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = f.path.split('/').pop() || f.path
  a.click()
  URL.revokeObjectURL(url)
}

const cardStyle = {
  border: '1px solid #e0e0e0',
  borderRadius: 10,
  padding: '16px 20px',
  maxWidth: 560,
  textAlign: 'left' as const,
}

export default function BootstrapGuide({ onRetry }: { onRetry: () => void }) {
  const [pick, setPick] = useState<PickState>('idle')
  const [written, setWritten] = useState(0)
  const [pickError, setPickError] = useState('')

  const primaryCmd = isMac()
    ? 'bash + 拖入 start-mac.command'
    : isWindows()
      ? '双击 start-windows.bat'
      : 'bash start.sh'

  async function onPick() {
    setPick('writing')
    setPickError('')
    try {
      await writeBootstrapFiles(setWritten)
      setPick('done')
    } catch (e) {
      if (e instanceof Error && e.message === 'unsupported') {
        setPick('unsupported')
      } else if (e instanceof DOMException && e.name === 'AbortError') {
        setPick('idle') // 用户取消选择，不算错误
      } else {
        setPick('error')
        setPickError(String(e))
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 48, gap: 16, padding: 24 }}>
      <header style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>listen_writing</h1>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#555' }}>
          转写由你电脑上的本地后端完成，录音不出本机。第一次使用，按下面三步准备（约 5 分钟，之后双击即用）。
        </p>
      </header>

      {/* 第 1 步 */}
      <section style={cardStyle}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>第 1 步 · 把启动文件放进电脑（点按钮）</h2>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 10px' }}>
          点击后选一个<strong>新建的空文件夹</strong>（比如「listen_writing」），启动文件会自动写进去。
        </p>
        {pick !== 'unsupported' && (
          <button onClick={onPick} disabled={pick === 'writing'} style={{ fontSize: 14, padding: '8px 16px' }}>
            {pick === 'writing' ? '写入中…' : pick === 'done' ? `已写入 ${written}/${BOOTSTRAP_FILES.length} 个文件（可重新写入）` : '选择文件夹并写入启动文件'}
          </button>
        )}
        {pick === 'error' && <p style={{ fontSize: 13, color: '#b00020', margin: '8px 0 0' }}>写入失败：{pickError}</p>}
        {pick === 'unsupported' && (
          <div style={{ fontSize: 13, color: '#666' }}>
            <p style={{ margin: '0 0 8px' }}>当前浏览器不支持一键写入，请逐个下载下面 {BOOTSTRAP_FILES.length} 个文件，放进同一个空文件夹：</p>
            <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 200, overflowY: 'auto' }}>
              {BOOTSTRAP_FILES.map((f) => (
                <li key={f.path} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                  <span>{f.path}</span>
                  <button onClick={() => downloadFile(f)} style={{ fontSize: 12, padding: '2px 10px' }}>下载</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 第 2 步 */}
      <section style={cardStyle}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>第 2 步 · 运行启动器</h2>
        {isWindows() ? (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            打开刚选的文件夹，<strong>双击 start-windows.bat</strong>。首次会自动装依赖、下载语音模型（约 500MB），请保持黑窗口开启。
          </p>
        ) : isMac() ? (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            打开「终端」，输入 <code>bash&nbsp;</code>（bash 加一个空格），把文件夹里的 <strong>start-mac.command</strong> 拖进终端窗口，按回车。首次会自动装依赖、下载语音模型（约 500MB），请保持窗口开启。
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            在文件夹里打开终端，运行 <code>bash start.sh</code>。首次会自动装依赖、下载语音模型（约 500MB），请保持窗口开启。
          </p>
        )}
        <details style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
          <summary>其他系统怎么启动？</summary>
          <p style={{ margin: '6px 0 0' }}>Windows：双击 start-windows.bat</p>
          <p style={{ margin: '4px 0 0' }}>macOS：终端里 bash + 拖入 start-mac.command</p>
          <p style={{ margin: '4px 0 0' }}>Linux：bash start.sh</p>
        </details>
        <p style={{ fontSize: 12, color: '#999', margin: '8px 0 0' }}>没有装 Python？先到 python.org 装 3.10+，再运行启动器（主指令：{primaryCmd}）。</p>
      </section>

      {/* 第 3 步 */}
      <section style={cardStyle}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>第 3 步 · 等窗口显示 listening，然后回到这里</h2>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 10px' }}>
          启动窗口出现 <code>backend listening on http://127.0.0.1:7850</code> 后，本页会在几秒内自动连上；也可以立刻点下面按钮。
        </p>
        <button onClick={onRetry} style={{ fontSize: 14, padding: '8px 16px' }}>
          重新连接
        </button>
      </section>
    </div>
  )
}
