import { BOOTSTRAP_FILES } from './bootstrapFiles'

export type UpdatePhase = 'available' | 'updating' | 'restarting' | 'manual' | 'error'

// 阻塞式更新界面：行业做法是「检测到新版本 → 进入更新模式 → 完成后再放行」。
// 更新进行中不允许继续操作（避免新旧代码混用），但「发现新版本」阶段用户可以选「稍后」，
// 稍后会自动收起成顶部一条提示，继续用旧版本。
const COPY: Record<UpdatePhase, { title: string; body: string }> = {
  available: {
    title: '有新版本可用',
    body: '页面已经是新版，但电脑上正在运行的本地程序还是旧版。更新后再使用，避免新旧不一致。只更新程序文件，不会动你的录音。',
  },
  updating: {
    title: '正在更新本地文件',
    body: '只更新程序文件，不会动你的录音数据。请保持这个页面打开。',
  },
  restarting: {
    title: '正在重启本地程序',
    body: '本地程序需要重新启动才能用上新代码。如果这是第一次下载语音模型（约 500MB），可能需要几分钟，请保持黑色启动窗口开启。',
  },
  manual: {
    title: '需要手动完成一步',
    body: '文件已经写入，但本地程序没有自动重启（旧版本没有这个能力）。请关闭黑色启动窗口，再双击启动器。之后就能全自动更新。',
  },
  error: {
    title: '更新没有完成',
    body: '本地文件没能写成功。可以重试；如果反复失败，点「打开引导页」重新写入一次。',
  },
}

export default function UpdateScreen({
  phase,
  text,
  progress,
  onUpdate,
  onLater,
  onOpenGuide,
}: {
  phase: UpdatePhase
  text: string
  progress?: { done: number; total: number }
  onUpdate: () => void
  onLater: () => void
  onOpenGuide: () => void
}) {
  const copy = COPY[phase]
  const busy = phase === 'updating' || phase === 'restarting'
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-busy={busy}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(246, 247, 249, 0.94)',
        backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: '100%',
          background: '#fff',
          border: '1px solid #eceef1',
          borderRadius: 14,
          boxShadow: '0 10px 30px rgba(16, 24, 40, 0.12)',
          padding: '26px 26px 22px',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>{copy.title}</h2>
        <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.7, color: '#555' }}>{copy.body}</p>

        {busy && (
          <div style={{ marginTop: 18 }}>
            {phase === 'updating' && progress ? (
              <>
                <div style={{ height: 6, background: '#eef0f3', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${pct}%`, height: 6, background: '#4285f4', transition: 'width 0.2s' }} />
                </div>
                <p style={{ fontSize: 12, color: '#8a8f98', margin: '8px 0 0' }}>
                  已更新 {progress.done} / {progress.total} 个文件
                </p>
              </>
            ) : (
              <div style={{ height: 6, background: '#eef0f3', borderRadius: 3, overflow: 'hidden' }}>
                <div className="update-indeterminate" style={{ width: '35%', height: 6, background: '#4285f4' }} />
              </div>
            )}
          </div>
        )}

        {text && (
          <p style={{ margin: '12px 0 0', fontSize: 12, lineHeight: 1.7, color: phase === 'error' ? '#b00020' : '#666' }}>
            {text}
          </p>
        )}

        {!busy && (
          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            {phase !== 'manual' && (
              <button onClick={onLater} style={{ fontSize: 13, padding: '7px 14px' }}>
                稍后
              </button>
            )}
            {phase === 'available' && (
              <button onClick={onUpdate} style={{ fontSize: 13, padding: '7px 16px' }}>
                立即更新（{BOOTSTRAP_FILES.length} 个文件）
              </button>
            )}
            {phase === 'error' && (
              <button onClick={onUpdate} style={{ fontSize: 13, padding: '7px 16px' }}>
                重试
              </button>
            )}
            <button onClick={onOpenGuide} style={{ fontSize: 13, padding: '7px 14px' }}>
              打开引导页
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
