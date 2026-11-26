import { useState } from 'react'
import { BOOTSTRAP_FILES, type BootstrapFile } from './bootstrapFiles'
import { pickDirectory, saveDirHandle, writeAll } from './updater'

// 引导部署：后端离线时的首屏。用户全程只做三件事——
// ① 点按钮写入启动文件 ② 双击/拖入启动器 ③ 等页面自动连上（对应工程纪律「点按钮就能完事」）。

type PickState = 'idle' | 'writing' | 'done' | 'error' | 'unsupported'

function isWindows(): boolean {
  return /Windows/i.test(navigator.userAgent)
}
function isMac(): boolean {
  return /Macintosh|Mac OS X/i.test(navigator.userAgent)
}

async function writeBootstrapFiles(onProgress: (written: number) => void): Promise<void> {
  const dir = await pickDirectory()
  await writeAll(dir, onProgress)
  // 记住目录：以后页面检测到后端过期，可以一键写回，不用再次选文件夹
  await saveDirHandle(dir)
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

export default function BootstrapGuide({ onRetry, onClose }: { onRetry: () => void; onClose?: () => void }) {
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
    <div
      className="scroll-hidden"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '48px 24px 32px',
        minHeight: '100vh',
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      {onClose && (
        <button onClick={onClose} style={{ alignSelf: 'flex-start', fontSize: 13, padding: '4px 10px' }}>
          ← 返回应用
        </button>
      )}
      <header style={{ textAlign: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>listen_writing</h1>
        <p style={{ margin: '8px 0 0', fontSize: 14, color: '#555' }}>
          转写由你电脑上的本地后端完成，录音不出本机。第一次使用，按下面三步准备（首次需下载约 3–5GB：运行环境、转写模型、AI 模型，之后双击即用；下载走国内镜像站，不需要开代理）。
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
            打开刚选的文件夹，<strong>双击 start-windows.bat</strong>。首次会自动准备运行环境、下载语音与 AI 模型（共约 3–5GB），请保持黑窗口开启。如果弹出「是否允许此应用更改设备」的窗口（安装微软运行库），点「是」。下载优先走国内镜像，不需要你开代理。
          </p>
        ) : isMac() ? (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            打开「终端」，输入 <code>bash&nbsp;</code>（bash 加一个空格），把文件夹里的 <strong>start-mac.command</strong> 拖进终端窗口，按回车。首次会自动准备运行环境、下载语音与 AI 模型（共约 3–5GB），请保持窗口开启。
          </p>
        ) : (
          <p style={{ fontSize: 13, color: '#666', margin: 0 }}>
            在文件夹里打开终端，运行 <code>bash start.sh</code>。首次会自动准备运行环境、下载语音与 AI 模型（共约 3–5GB），请保持窗口开启。
          </p>
        )}
        <details style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
          <summary>其他系统怎么启动？</summary>
          <p style={{ margin: '6px 0 0' }}>Windows：双击 start-windows.bat</p>
          <p style={{ margin: '4px 0 0' }}>macOS：终端里 bash + 拖入 start-mac.command</p>
          <p style={{ margin: '4px 0 0' }}>Linux：bash start.sh</p>
        </details>

        <details style={{ marginTop: 10, fontSize: 12, color: '#666', background: '#fdf5f5', border: '1px solid #f0d6d6', borderRadius: 8, padding: '8px 10px' }}>
          <summary style={{ cursor: 'pointer', color: '#b00020' }}>Windows 提示「无法验证发布者 / 已阻止此应用」？</summary>
          <div style={{ marginTop: 8, lineHeight: 1.7 }}>
            <p style={{ margin: '0 0 6px' }}>这是因为下载的脚本没有代码签名，被 Windows 标记为「来自网络」；不是文件损坏，也不是配置错误。</p>
            <p style={{ margin: '0 0 6px' }}><strong>方法一（最快）：</strong>右键 <code>start-windows.bat</code> →「属性」→ 勾选「解除锁定」→ 确定，再双击。</p>
            <p style={{ margin: '0 0 6px' }}><strong>方法二：</strong>如果弹出 SmartScreen 窗口，点「更多信息」→「仍要运行」。</p>
            <p style={{ margin: '0 0 6px' }}><strong>方法三（整文件夹）：</strong>在启动器文件夹里打开 PowerShell，运行 <code>Get-ChildItem -Recurse | Unblock-File</code>，然后重新双击。</p>
            <p style={{ margin: 0 }}><strong>更省事的办法：</strong>不要从 GitHub 直接下载 BAT；用本页第 1 步「选择文件夹并写入启动文件」，浏览器在本地新建的文件不会被标记为网络来源，通常不会触发拦截。</p>
          </div>
        </details>

        <details style={{ marginTop: 10, fontSize: 12, color: '#666', background: '#f8fafc', border: '1px solid #e8ebf0', borderRadius: 8, padding: '8px 10px' }}>
          <summary style={{ cursor: 'pointer', color: '#245c9c' }}>不想每次都去文件夹里找启动器？让它更好打开</summary>
          <div style={{ marginTop: 8, lineHeight: 1.7 }}>
            {isWindows() && (
              <>
                <p style={{ margin: '0 0 6px' }}><strong>Windows · 放一个快捷方式到桌面：</strong></p>
                <p style={{ margin: '0 0 6px' }}>1. 打开启动器所在文件夹，找到 <code>start-windows.bat</code>。</p>
                <p style={{ margin: '0 0 6px' }}>2. 右键它 →「发送到」→「桌面快捷方式」。以后双击桌面图标就能启动。</p>
                <p style={{ margin: '0 0 6px' }}><strong>想开机自动启动：</strong>按 <code>Win + R</code> 输入 <code>shell:startup</code> 回车，把上面那个快捷方式复制进去即可（不想要时删掉这个副本）。</p>
                <p style={{ margin: 0 }}>注意：快捷方式只是「指针」，别把原文件夹删了或挪走。</p>
              </>
            )}
            {isMac() && (
              <>
                <p style={{ margin: '0 0 6px' }}><strong>macOS · 做个别名放桌面：</strong></p>
                <p style={{ margin: '0 0 6px' }}>1. 在 Finder 里找到 <code>start-mac.command</code>。</p>
                <p style={{ margin: '0 0 6px' }}>2. 右键 →「制作别名」，把别名拖到桌面，以后双击别名即可。</p>
                <p style={{ margin: 0 }}><strong>想开机自动启动：</strong>系统设置 →「通用」→「登录项与扩展」→ 把别名加进「登录时打开」。</p>
              </>
            )}
            {!isWindows() && !isMac() && (
              <>
                <p style={{ margin: '0 0 6px' }}><strong>Linux · 建一个桌面启动器：</strong></p>
                <p style={{ margin: '0 0 6px' }}>在桌面新建一个 <code>listen-writing.desktop</code> 文件，内容如下，然后右键设为「允许启动」：</p>
                <pre style={{ margin: '0 0 6px', padding: 8, background: '#fff', border: '1px solid #e8ebf0', borderRadius: 6, overflowX: 'auto', fontSize: 11 }}>
{`[Desktop Entry]
Type=Application
Name=Listen Writing
Exec=bash ${'启动器完整路径'}/start.sh
Terminal=true`}
                </pre>
              </>
            )}
          </div>
        </details>
        <p style={{ fontSize: 12, color: '#999', margin: '8px 0 0' }}>不需要自己安装 Python：启动器会自动准备好所需的全部运行组件（主指令：{primaryCmd}）。</p>
      </section>

      {/* 第 3 步 */}
      <section style={cardStyle}>
        <h2 style={{ fontSize: 15, margin: '0 0 8px' }}>第 3 步 · 等窗口显示监听地址，然后回到这里</h2>
        <p style={{ fontSize: 13, color: '#666', margin: '0 0 10px' }}>
          启动窗口出现 <code>http://127.0.0.1:7850</code> 后，本页会在几秒内自动连上；也可以立刻点下面按钮。
        </p>
        <button onClick={onRetry} style={{ fontSize: 14, padding: '8px 16px' }}>
          重新连接
        </button>
      </section>
    </div>
  )
}
