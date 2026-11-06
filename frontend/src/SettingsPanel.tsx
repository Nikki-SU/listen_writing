import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from './api'
import type { AppSettings, ModelOption, SettingsPayload } from './types'

// 设置弹层：身份 + 两档模型。模型选项由后端 S-1 返回（唯一权威），
// 前端只渲染，不重复维护标签与最低配置。切换模型对“之后的转写/AI 任务”生效，
// 已完成的录音不会被追溯改动——这是用户的预期，也避免悄悄重跑长任务。
export default function SettingsPanel({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved?: (s: AppSettings) => void
}) {
  const [payload, setPayload] = useState<SettingsPayload | null>(null)
  const [nick, setNick] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .fetchSettings()
      .then((p) => {
        if (cancelled) return
        setPayload(p)
        setNick(p.settings.identity.nick)
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  // 写设置一律乐观更新 + 回滚（工程纪律三.3）。
  async function patch(fields: Partial<AppSettings>, optimistic: Partial<AppSettings>) {
    if (!payload) return
    const before = payload.settings
    setPayload({ ...payload, settings: { ...before, ...optimistic } })
    setSaving(true)
    setError('')
    try {
      const s = await api.updateSettings(fields)
      setPayload((p) => (p ? { ...p, settings: s } : p))
      onSaved?.(s)
    } catch (e) {
      setPayload((p) => (p ? { ...p, settings: before } : p))
      setError(`保存失败：${String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  function saveNick() {
    if (!payload) return
    const trimmed = nick.trim()
    if (!trimmed || trimmed === payload.settings.identity.nick) {
      setNick(payload.settings.identity.nick)
      return
    }
    void patch({ identity: { ...payload.settings.identity, nick: trimmed } }, {
      identity: { ...payload.settings.identity, nick: trimmed },
    })
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(16, 24, 40, 0.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="scroll-hidden"
        style={{
          width: 620,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 14,
          padding: 24,
          boxShadow: '0 12px 40px rgba(16, 24, 40, 0.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>设置</h2>
          <span style={{ fontSize: 12, color: '#9aa0a6' }}>{saving ? '保存中…' : '改动自动保存'}</span>
          <button onClick={onClose} style={{ fontSize: 12, padding: '3px 10px', color: '#666' }}>
            关闭
          </button>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8a8f98', lineHeight: 1.7 }}>
          模型负责“转得快不快、改得准不准”，这里改的是后续任务要用的引擎；已有录音不会被重跑。
        </p>

        {error && <div style={{ color: '#b00020', fontSize: 13, marginTop: 12 }}>{error}</div>}
        {!payload && !error && (
          <div style={{ color: '#8a8f98', fontSize: 13, marginTop: 24 }}>正在读取设置…</div>
        )}

        {payload && (
          <>
            <Section title="你是谁">
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 13, color: '#6b7280', width: 70 }}>昵称</label>
                <input
                  value={nick}
                  onChange={(e) => setNick(e.target.value)}
                  onBlur={saveNick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur()
                    }
                  }}
                  placeholder="用于版本记录里的作者"
                  style={{ flex: 1, fontSize: 13 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 13, color: '#6b7280', width: 70 }}>设备码</label>
                <div
                  style={{
                    flex: 1,
                    fontSize: 12,
                    color: '#4b5563',
                    background: '#f6f7f9',
                    borderRadius: 6,
                    padding: '6px 10px',
                    letterSpacing: '0.08em',
                  }}
                >
                  {payload.settings.identity.device_code}
                </div>
              </div>
              <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6' }}>
                设备码在本机首次启动时生成，用来在协作时区分“谁改的”；不需要时可以不看它。
              </p>
            </Section>

            <Section title="转写模型（语音 → 文字）">
              {payload.options.asr.map((m) => (
                <ModelRow
                  key={m.id}
                  option={m}
                  checked={payload.settings.asr_model === m.id}
                  onSelect={() => void patch({ asr_model: m.id }, { asr_model: m.id })}
                />
              ))}
              <Hint>换档后，下一段录音会用新模型；当前录音的转写结果不受影响。未就绪的档位置灰，避免选了之后才发现跑不起来。</Hint>
            </Section>

            <Section title="AI 模型（语义纠错 / 脱敏标记）">
              {payload.options.llm.map((m) => (
                <ModelRow
                  key={m.id}
                  option={m}
                  checked={payload.settings.llm_model === m.id}
                  onSelect={() => void patch({ llm_model: m.id }, { llm_model: m.id })}
                />
              ))}
              <Hint>首次使用会自动下载模型（约 1–5GB），之后全程离线运行。</Hint>
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{title}</div>
      {children}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 }}>{children}</p>
}

function ModelRow({
  option,
  checked,
  onSelect,
}: {
  option: ModelOption
  checked: boolean
  onSelect: () => void
}) {
  return (
    <div
      onClick={() => {
        if (option.available) onSelect()
      }}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${checked ? '#1f6feb' : '#eceef1'}`,
        background: checked ? '#f3f7ff' : '#fff',
        cursor: option.available ? 'pointer' : 'not-allowed',
        opacity: option.available ? 1 : 0.62,
      }}
    >
      <input type="radio" checked={checked} readOnly style={{ marginTop: 3 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</span>
          {checked && <span style={{ fontSize: 11, color: '#1f6feb' }}>使用中</span>}
          {!option.available && (
            <span style={{ fontSize: 11, color: '#b36b00', background: '#fff4e0', borderRadius: 4, padding: '1px 6px' }}>
              本机未内置
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {option.note} · 最低 {option.min_ram} · {option.speed}
        </div>
      </div>
    </div>
  )
}
