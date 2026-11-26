import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from './api'
import { jobFor, useModels } from './useModels'
import type { AppSettings, ModelJob, ModelOption, ModelStatus, SettingsPayload } from './types'
import { ICON_BTN, DownloadIcon, RefreshIcon, StopIcon } from './icons'

// 设置弹层：身份 + 模型。模型选项由后端 S-1 返回（唯一权威），
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
  const [deviceCode, setDeviceCode] = useState('')
  const [leafInfo, setLeafInfo] = useState<{ code: string; urls: string[] } | null>(null)
  const [leafError, setLeafError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const { models, error: modelError, download, cancel } = useModels(1500)
  // 补充组件（MinerU / 向量模型）统一在这里安装，知识库页只显示状态。
  const [mineru, setMineru] = useState<api.MineruStatus | null>(null)
  const [embed, setEmbed] = useState<{ models: { key: string; label: string; ready: boolean }[]; max_loaded: number } | null>(null)
  const [componentError, setComponentError] = useState('')
  const [embeddingBusy, setEmbeddingBusy] = useState('')

  const refreshComponents = () => Promise.all([
    api.kbApi.mineruStatus().then(setMineru).catch(() => undefined),
    api.kbApi.embedStatus().then(setEmbed).catch(() => undefined),
  ])

  useEffect(() => {
    void refreshComponents()
  }, [])

  // MinerU 安装是长任务：运行中每 1.5 秒刷新进度。
  useEffect(() => {
    if (!mineru?.install.running) return
    const timer = window.setInterval(() => { void refreshComponents() }, 1500)
    return () => window.clearInterval(timer)
  }, [mineru?.install.running])

  useEffect(() => {
    let cancelled = false
    api
      .fetchSettings()
      .then((p) => {
        if (cancelled) return
        setPayload(p)
        setNick(p.settings.identity.nick)
        setDeviceCode(p.settings.identity.device_code)
      })
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .fetchLeafInfo()
      .then((info) => !cancelled && setLeafInfo({ code: info.code, urls: info.urls }))
      .catch((e) => !cancelled && setLeafError(String(e)))
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

  function saveDeviceCode() {
    if (!payload) return
    const current = payload.settings.identity.device_code
    const code = deviceCode.trim()
    if (code === current) return
    if (code.length < 4 || code.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(code)) {
      setDeviceCode(current)
      setError('设备码需为 4–64 位，只能包含字母、数字和 . _ : -')
      return
    }
    void patch({ identity: { ...payload.settings.identity, device_code: code } }, {
      identity: { ...payload.settings.identity, device_code: code },
    })
  }

  function installMineru(resume: boolean) {
    const size = mineru?.disk_required_gb ? `约 ${mineru.disk_required_gb}GB` : '数 GB'
    const tip = resume
      ? '继续安装会跳过已完成步骤，并从上次中断处续传已下载的包。继续？'
      : `安装 PDF 转换组件需要下载${size}（依赖 + 模型），且转换在 CPU 上较慢。继续安装？`
    if (!window.confirm(tip)) return
    setComponentError('')
    void api.kbApi.mineruInstall().then(() => refreshComponents())
      .catch((e) => setComponentError(`安装启动失败：${String(e).replace(/^Error:\s*/, '')}`))
  }

  function cancelMineru(clearProgress: boolean) {
    if (clearProgress && !window.confirm('清除已完成的安装进度？已下载的包会保留，但步骤会从头开始。')) return
    void api.kbApi.mineruCancel().then(() => refreshComponents())
      .catch((e) => setComponentError(String(e)))
  }

  async function downloadEmbedding(key: string) {
    setComponentError('')
    setEmbeddingBusy(key)
    try {
      await api.kbApi.ensureEmbed(key)
      await refreshComponents()
    } catch (e) {
      setComponentError(`向量模型下载失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setEmbeddingBusy('')
    }
  }

  function statusOf(kind: 'asr' | 'llm', id: string): ModelStatus | undefined {
    const list = kind === 'asr' ? models?.asr : models?.llm
    return list?.find((m) => m.id === id)
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

        {(error || modelError) && (
          <div style={{ color: '#b00020', fontSize: 13, marginTop: 12 }}>{error || modelError}</div>
        )}
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
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  placeholder="用于版本记录里的作者"
                  style={{ flex: 1, fontSize: 13 }}
                />
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <label style={{ fontSize: 13, color: '#6b7280', width: 70 }}>设备码</label>
                <input
                  value={deviceCode}
                  onChange={(e) => setDeviceCode(e.target.value)}
                  onBlur={saveDeviceCode}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setDeviceCode(payload.settings.identity.device_code)
                  }}
                  spellCheck={false}
                  style={{ flex: 1, fontSize: 12, letterSpacing: '0.06em' }}
                />
              </div>
              <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6' }}>
                设备码用于协作时区分“谁改的”。可以改成你易记的标识（4–64 位字母数字），改完后本机旧授权仍按原码记录。
              </p>
            </Section>

            <Section title="手机 / 平板（同一 Wi-Fi）">
              {leafError && <div style={{ fontSize: 12, color: '#b00020' }}>{leafError}</div>}
              {leafInfo ? (
                <>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 13, color: '#6b7280', width: 70 }}>配对码</label>
                    <span style={{ fontSize: 22, letterSpacing: '0.22em', fontFamily: 'ui-monospace, monospace' }}>
                      {leafInfo.code}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 13, color: '#6b7280', width: 70 }}>访问地址</label>
                    {leafInfo.urls.map((u) => (
                      <code key={u} style={{ fontSize: 12.5, color: '#1f6feb' }}>{u}</code>
                    ))}
                    <button
                      style={{ fontSize: 12, padding: '3px 10px' }}
                      onClick={() => void navigator.clipboard?.writeText(leafInfo.urls[0] || '')}
                    >
                      复制链接
                    </button>
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: '#9aa0a6', lineHeight: 1.7 }}>
                    手机与电脑连同一个 Wi-Fi，用浏览器打开上面的地址，输入配对码。手机不跑模型、不存整库，
                    改完直接写回这台电脑；电脑上按 F5 即可看到。首次配对后手机会记住授权。
                  </p>
                </>
              ) : (
                !leafError && <div style={{ fontSize: 12, color: '#8a8f98' }}>正在读取配对信息…</div>
              )}
            </Section>

            <Section title="转写模型（语音 → 文字）">
              {payload.options.asr.map((m) => (
                <ModelRow
                  key={m.id}
                  option={m}
                  checked={payload.settings.asr_model === m.id}
                  onSelect={() => void patch({ asr_model: m.id }, { asr_model: m.id })}
                  status={statusOf('asr', m.id)}
                  job={jobFor(models, 'asr', m.id)}
                  onDownload={() => void download('asr', m.id)}
                />
              ))}
              <Hint>换档后，下一段录音会用新模型；当前录音的转写结果不受影响。未下载的档位可以先下载，下完再选。</Hint>
            </Section>

            <Section title="AI 模型（语义纠错 / 智能脱敏）">
              {payload.options.llm.map((m) => (
                <ModelRow
                  key={m.id}
                  option={m}
                  checked={payload.settings.llm_model === m.id}
                  onSelect={() => void patch({ llm_model: m.id }, { llm_model: m.id })}
                  status={statusOf('llm', m.id)}
                  job={jobFor(models, 'llm', m.id)}
                  onDownload={() => void download('llm', m.id)}
                  onCancel={(id) => void cancel(id)}
                />
              ))}
              <Hint>
                先在这里下载选定模型（约 1–5GB），之后全程离线运行；未下载时点击「AI 纠错 / AI 整理断句」也会自动开始后台下载。
                {models && !models.runtime.llm && ' 当前 AI 运行时未安装，下载完成后仍需运行启动器安装组件。'}
              </Hint>
            </Section>

            <Section title="组件安装（补充下载）">
              {componentError && <div style={{ fontSize: 12, color: '#b00020' }}>{componentError}</div>}

              <div style={{ border: '1px solid #eceef1', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>PDF 转换组件（MinerU）</span>
                  {mineru?.available && (
                    <span style={{ fontSize: 11, color: '#1e7e34', background: '#e9f7ee', borderRadius: 4, padding: '1px 6px' }}>
                      已就绪{mineru.version ? ` v${mineru.version}` : ''}
                    </span>
                  )}
                  {mineru?.install.running && (
                    <span style={{ fontSize: 11, color: '#8a5a00', background: '#fff4e0', borderRadius: 4, padding: '1px 6px' }}>
                      安装中 {mineru.install.progress}%
                    </span>
                  )}
                  {mineru && !mineru.available && !mineru.install.running && (
                    <span style={{
                      fontSize: 11, borderRadius: 4, padding: '1px 6px',
                      color: mineru.install.status === 'failed' ? '#b00020' : mineru.install.status === 'interrupted' ? '#8a5a00' : '#8a8f98',
                      background: mineru.install.status === 'failed' ? '#fdecea' : mineru.install.status === 'interrupted' ? '#fff4e0' : '#f3f4f6',
                    }}>
                      {mineru.install.status === 'failed' ? '安装失败'
                        : mineru.install.status === 'interrupted' ? '已中断 · 可续传'
                          : mineru.install.status === 'cancelled' ? '已停止 · 可续传'
                            : '未安装'}
                    </span>
                  )}
                </div>
                {mineru && (
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    设备 {mineru.device} · 内存 {mineru.ram_gb}GB · 磁盘剩余 {mineru.disk_free_gb}GB · 建议档位 {mineru.profile_suggestion}
                  </div>
                )}
                {mineru?.install.running && (
                  <>
                    <div style={{ height: 4, background: '#eef0f3', borderRadius: 2 }}>
                      <div style={{ width: `${Math.max(4, mineru.install.progress)}%`, height: 4, background: '#4285f4', borderRadius: 2, transition: 'width .3s' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ flex: 1, fontSize: 11, color: '#8a8f98' }}>{mineru.install.message || '准备中…'}</span>
                      <button onClick={() => cancelMineru(false)} style={{ fontSize: 11, padding: '2px 8px', color: '#b00020' }}>停止（保留进度）</button>
                    </div>
                  </>
                )}
                {mineru && !mineru.available && !mineru.install.running && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <button onClick={() => installMineru(mineru.install.resumable)} style={{ fontSize: 12, padding: '4px 10px', background: '#245c9c', color: '#fff', border: 'none', borderRadius: 6 }}>
                        {mineru.install.resumable
                          ? '继续安装（断点续传）'
                          : mineru.install.status === 'failed'
                            ? '重试安装'
                            : `安装（约 ${mineru.disk_required_gb}GB）`}
                      </button>
                      {mineru.install.resumable && (
                        <button onClick={() => cancelMineru(true)} style={{ fontSize: 11, padding: '3px 8px' }}>
                          取消并清除进度
                        </button>
                      )}
                      <span style={{ fontSize: 11, color: '#8a8f98' }}>PDF 入库必需；docx / md / txt 不需要它。</span>
                    </div>
                    {mineru.install.done_stages.length > 0 && (
                      <div style={{ fontSize: 11, color: '#5b6472' }}>
                        已完成：{mineru.install.done_stages.join('、')}
                        {mineru.install.models_bytes > 0 && ` · 模型已下 ${(mineru.install.models_bytes / 1024 ** 2).toFixed(0)}MB`}
                      </div>
                    )}
                    {(mineru.install.status === 'failed' || mineru.install.status === 'interrupted') && (
                      <div style={{ fontSize: 11, color: mineru.install.status === 'failed' ? '#b00020' : '#8a5a00', lineHeight: 1.6 }}>
                        {mineru.install.error || mineru.install.message}
                      </div>
                    )}
                  </>
                )}
                {mineru?.available && (
                  <div style={{ fontSize: 11, color: '#9aa0a6' }}>{mineru.timing_note}</div>
                )}
              </div>

              <div style={{ border: '1px solid #eceef1', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>向量模型（知识库检索）</span>
                  {embed && <span style={{ fontSize: 11, color: '#8a8f98' }}>同时最多装 {embed.max_loaded} 个</span>}
                </div>
                {!embed && <div style={{ fontSize: 12, color: '#8a8f98' }}>正在读取状态…</div>}
                {embed?.models.map((m) => (
                  <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 12 }}>{m.label}</span>
                    <span style={{ fontSize: 11, color: m.ready ? '#1e7e34' : '#8a8f98', background: m.ready ? '#e9f7ee' : '#f3f4f6', borderRadius: 4, padding: '1px 6px' }}>
                      {m.ready ? '已下载' : embeddingBusy === m.key ? '下载中…' : '未下载'}
                    </span>
                    {!m.ready && (
                      <button onClick={() => void downloadEmbedding(m.key)} disabled={embeddingBusy === m.key}
                        style={{ fontSize: 11, padding: '2px 8px' }}>
                        {embeddingBusy === m.key ? '下载中…' : '下载'}
                      </button>
                    )}
                  </div>
                ))}
                <Hint>向量模型没下载时知识库仍可用 BM25 词法检索，只是召回弱一些；下载后再「建向量索引」。</Hint>
              </div>

              <Hint>所有补充组件都集中在这里安装；知识库页只显示状态，不再单独提供安装按钮。</Hint>
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
  status,
  job,
  onDownload,
  onCancel,
}: {
  option: ModelOption
  checked: boolean
  onSelect: () => void
  status?: ModelStatus
  job?: ModelJob
  onDownload: () => void
  onCancel?: (jobId: string) => void
}) {
  const running = job?.status === 'running'
  const failed = job?.status === 'error'
  const stopped = job?.status === 'cancelled'
  const ready = status?.downloaded || job?.status === 'done'
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 12px',
        borderRadius: 8,
        border: `1px solid ${checked ? '#1f6feb' : '#eceef1'}`,
        background: checked ? '#f3f7ff' : '#fff',
      }}
    >
      <input
        type="radio"
        checked={checked}
        readOnly
        onClick={() => {
          if (option.available) onSelect()
        }}
        style={{ marginTop: 3, cursor: option.available ? 'pointer' : 'not-allowed' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{option.label}</span>
          {checked && <span style={{ fontSize: 11, color: '#1f6feb' }}>使用中</span>}
          <span
            style={{
              fontSize: 11,
              color: ready ? '#1e7e34' : running ? '#8a5a00' : failed ? '#b00020' : '#8a8f98',
              background: ready ? '#e9f7ee' : running ? '#fff4e0' : failed ? '#fdecea' : '#f3f4f6',
              borderRadius: 4,
              padding: '1px 6px',
            }}
          >
          {ready ? '已下载' : running ? `下载中 ${job?.progress ?? 0}%` : failed ? '下载失败' : stopped ? '已停止' : '未下载'}
          </span>
          {!option.available && (
            <span style={{ fontSize: 11, color: '#b36b00', background: '#fff4e0', borderRadius: 4, padding: '1px 6px' }}>
              运行时未安装
            </span>
          )}
          {running && onCancel && job && (
            <button
              onClick={() => onCancel(job.id)}
              title="停止下载"
              aria-label="停止下载"
              style={{ ...ICON_BTN, marginLeft: 'auto', width: 24, height: 22, color: '#b00020' }}
            >
              <StopIcon size={11} />
            </button>
          )}
          {!ready && !running && (
            <button
              onClick={onDownload}
              title={failed ? '重试下载' : stopped ? '继续下载（断点续传）' : '下载模型'}
              aria-label="下载模型"
              style={{ ...ICON_BTN, marginLeft: 'auto', width: 24, height: 22 }}
            >
              {failed ? <RefreshIcon size={12} /> : <DownloadIcon size={12} />}
            </button>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
          {option.note} · 最低 {option.min_ram} · {option.speed}
        </div>
        {running && (
          <>
            <div style={{ marginTop: 6, height: 4, background: '#eef0f3', borderRadius: 2 }}>
              <div
                style={{
                  width: `${Math.max(4, job?.progress ?? 4)}%`,
                  height: 4,
                  background: '#4285f4',
                  borderRadius: 2,
                  transition: 'width .3s',
                }}
              />
            </div>
            <div style={{ marginTop: 3, fontSize: 11, color: '#8a8f98' }}>{job?.message}</div>
          </>
        )}
        {failed && (
          <div style={{ marginTop: 3, fontSize: 11, color: '#b00020' }}>{job?.error || job?.message}</div>
        )}
        {stopped && (
          <div style={{ marginTop: 3, fontSize: 11, color: '#8a5a00' }}>{job?.message}</div>
        )}
      </div>
    </div>
  )
}
