import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { jobFor, useModels } from './useModels'
import type { ModelsPayload } from './types'

// 首启引导：本机还没有转写 / AI 模型时，打开就自动开始下载，
// 而不是等用户第一次点“转写”才发现没模型、对着 0% 干等。
// 关掉这个窗口不会中断下载：任务跑在本地后端线程里，下次打开设置页能看到进度。
const RECOMMENDED: { kind: 'asr' | 'llm'; key: string }[] = [
  { kind: 'asr', key: 'whisper-small' },
  { kind: 'asr', key: 'sensevoice-small' },
  { kind: 'asr', key: 'qwen3-asr-0.6b' },
  { kind: 'llm', key: 'qwen3-4b' },
]

function downloaded(models: ModelsPayload, kind: 'asr' | 'llm', key: string): boolean {
  const list = kind === 'asr' ? models.asr : models.llm
  return list.some((m) => m.id === key && m.downloaded)
}

function labelOf(models: ModelsPayload, kind: 'asr' | 'llm', key: string): string {
  const list = kind === 'asr' ? models.asr : models.llm
  return list.find((m) => m.id === key)?.label || key
}

export default function ModelSetup({ onClose }: { onClose: () => void }) {
  const { models, error, download } = useModels(1500)
  const started = useRef(false)
  const hadMissing = useRef(false)

  const missing = models
    ? RECOMMENDED.filter((m) => !downloaded(models, m.kind, m.key))
    : []

  // 清单一到手就自动下载缺失项；每个模型独立任务，可并行。
  useEffect(() => {
    if (!models || started.current) return
    const todo = RECOMMENDED.filter((m) => !downloaded(models, m.kind, m.key))
    if (todo.length === 0) return
    hadMissing.current = true
    started.current = true
    for (const item of todo) void download(item.kind, item.key)
  }, [models, download])

  // 本机本来就齐全：不打扰用户。
  if (models && missing.length === 0 && !hadMissing.current) return null

  if (models && missing.length === 0) {
    return (
      <Overlay>
        <h2 style={{ margin: 0, fontSize: 18 }}>模型已就绪</h2>
        <p style={{ margin: '10px 0 18px', fontSize: 13, color: '#6b7280', lineHeight: 1.7 }}>
          转写与 AI 能力都已在本地可用，录音数据全程不出本机。
        </p>
        <button onClick={onClose} style={primaryBtn}>
          开始使用
        </button>
      </Overlay>
    )
  }

  return (
    <Overlay>
      <h2 style={{ margin: 0, fontSize: 18 }}>正在准备本地模型</h2>
      <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8a8f98', lineHeight: 1.7 }}>
        首次使用需要下载转写与 AI 模型（合计约 4GB）。已经在自动下载，你可以先去建项目、传录音；
        关掉这个窗口也不会中断，进度可在「设置」里查看。
      </p>

      {error && <div style={{ color: '#b00020', fontSize: 12, marginTop: 10 }}>{error}</div>}
      {!models && !error && (
        <div style={{ color: '#8a8f98', fontSize: 13, marginTop: 18 }}>正在读取本机模型状态…</div>
      )}

      {models && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {RECOMMENDED.map((item) => {
            const ready = downloaded(models, item.kind, item.key)
            const job = jobFor(models, item.kind, item.key)
            return (
              <div
                key={`${item.kind}:${item.key}`}
                style={{
                  border: '1px solid #eceef1',
                  borderRadius: 8,
                  padding: '10px 12px',
                  background: ready ? '#f6fbf7' : '#fff',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{labelOf(models, item.kind, item.key)}</span>
                  <span style={{ fontSize: 11, color: '#8a8f98' }}>
                    {item.kind === 'asr' ? '转写' : 'AI'}
                  </span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontSize: 11,
                      color: ready ? '#1e7e34' : job?.status === 'error' ? '#b00020' : '#8a5a00',
                    }}
                  >
                    {ready
                      ? '已就绪'
                      : job?.status === 'running'
                        ? `下载中 ${job.progress}%`
                        : job?.status === 'error'
                          ? '下载失败'
                          : '排队中'}
                  </span>
                  {!ready && (!job || job.status === 'error') && (
                    <button
                      onClick={() => void download(item.kind, item.key)}
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      重试
                    </button>
                  )}
                </div>
                {job?.status === 'running' && (
                  <>
                    <div style={{ marginTop: 6, height: 5, background: '#eef0f3', borderRadius: 3 }}>
                      <div
                        style={{
                          width: `${Math.max(4, job.progress)}%`,
                          height: 5,
                          background: '#4285f4',
                          borderRadius: 3,
                          transition: 'width .3s',
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: '#8a8f98' }}>{job.message}</div>
                  </>
                )}
                {job?.status === 'error' && (
                  <div style={{ marginTop: 4, fontSize: 11, color: '#b00020' }}>{job.error || job.message}</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {models && !models.runtime.llm && (
        <p style={{ margin: '10px 0 0', fontSize: 11, color: '#b36b00', lineHeight: 1.7 }}>
          AI 纠错运行时（llama-cpp-python）尚未安装：模型可以先下载，但要用 AI 功能需要重新运行一次启动器安装组件。
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
        <button onClick={onClose} style={{ ...primaryBtn, flex: 1 }}>
          后台下载，先去做别的
        </button>
      </div>
    </Overlay>
  )
}

const primaryBtn = {
  fontSize: 13,
  padding: '7px 16px',
  background: '#1f6feb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(16, 24, 40, 0.36)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: 560,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 14,
          padding: 24,
          boxShadow: '0 12px 40px rgba(16, 24, 40, 0.18)',
        }}
      >
        {children}
      </div>
    </div>
  )
}
