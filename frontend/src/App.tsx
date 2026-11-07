import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import * as api from './api'
import BootstrapGuide from './BootstrapGuide'
import CollabPanel from './CollabPanel'
import LiveRecorder from './LiveRecorder'
import ModelSetup from './ModelSetup'
import SettingsPanel from './SettingsPanel'
import UpdateScreen, { type UpdatePhase } from './UpdateScreen'
import { jobFor, useModels } from './useModels'
import { BOOTSTRAP_FILES } from './bootstrapFiles'
import type {
  Project,
  Recording,
  RecordingDetail,
  PolishSuggestion,
  RedactionCategory,
  RedactionMark,
  RedactionSuggestion,
  ResegmentResult,
  Sentence,
  VersionDetail,
  VersionSummary,
} from './types'
import {
  applyUpdate,
  ensureWritePermission,
  isOutdated,
  loadDirHandle,
  pickDirectory,
  saveDirHandle,
} from './updater'

type UpdateState = 'idle' | UpdatePhase

// 卡片化容器：用户看到的应该是界面，不是开发信息。
const cardStyle = {
  background: '#fff',
  border: '1px solid #eceef1',
  borderRadius: 12,
  padding: 20,
  boxShadow: '0 1px 3px rgba(16, 24, 40, 0.04)',
}

async function waitForBackend(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await api.fetchHealth()) return true
  }
  return false
}

function fmtMs(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return '待转写'
    case 'transcribing':
      return '转写中'
    case 'done':
      return '已完成'
    case 'error':
      return '转写失败'
    default:
      return status
  }
}

export default function App() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [error, setError] = useState('')
  const [upd, setUpd] = useState<UpdateState>('idle')
  const [updText, setUpdText] = useState('')
  const [updProgress, setUpdProgress] = useState<{ done: number; total: number }>()
  const [updDismissed, setUpdDismissed] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  // 共享任务不是弹层里的“小入口”：它和「我的录音」并列，是同一层级的常驻工作区。
  const [view, setView] = useState<'workspace' | 'collab'>('workspace')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [liveOpen, setLiveOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [detailNonce, setDetailNonce] = useState(0)
  const [modelSetupDone, setModelSetupDone] = useState(() => {
    try {
      return localStorage.getItem('lw_model_setup_done_v1') === '1'
    } catch {
      return false
    }
  })
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 启动：检查后端 + 版本 + 项目列表；后端离线时进入引导部署
  const boot = useCallback(async () => {
    const ok = await api.fetchHealth()
    setHealth(ok ? 'ok' : 'down')
    if (!ok) return
    try {
      const v = await api.fetchVersion()
      setProjects(await api.listProjects())
      setError('')
      // 页面内置版本比本地后端新 → 提示可更新。自动检查只做提示，
      // 真正写文件要用户点按钮（浏览器要求写权限必须由点击触发）。
      setUpd((prev) => (isOutdated(v) ? (prev === 'idle' ? 'available' : prev) : 'idle'))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // 后端离线期间每 2 秒探测一次：用户跑完启动器后页面自动连上，无需手动刷新
  useEffect(() => {
    if (health !== 'down') return
    const timer = setInterval(async () => {
      if (await api.fetchHealth()) void boot()
    }, 2000)
    return () => clearInterval(timer)
  }, [health, boot])

  const refreshRecordings = useCallback(async (pid: string) => {
    try {
      setRecordings(await api.listRecordings(pid))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    if (projectId) {
      refreshRecordings(projectId)
      setRecordingId(null)
      setDetail(null)
    }
  }, [projectId, refreshRecordings])

  // 轮询转写进度（长任务，例外允许进度反馈）
  useEffect(() => {
    if (!projectId || !recordingId) {
      setDetail(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const d = await api.fetchRecordingDetail(projectId!, recordingId!)
        if (cancelled) return
        setDetail(d)
        if (d.transcribe.status === 'pending' || d.transcribe.status === 'transcribing') {
          timer = setTimeout(poll, 1000)
        }
      } catch {
        // 轮询失败静默停止，避免抖动；用户可重新点选录音重新触发
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [projectId, recordingId, detailNonce])

  // 写操作一律乐观更新 + 回滚（工程纪律三.3）：先立刻显示结果，失败再撤掉。
  // 不切到临时 id，否则会触发对不存在对象的 GET（404）而闪错误。
  async function onCreateProject(name: string) {
    const trimmed = name.trim()
    if (!trimmed) return
    const tempId = `tmp-${Date.now()}`
    const optimistic: Project = { id: tempId, name: trimmed, description: '', created_at: new Date().toISOString() }
    setProjects((prev) => [optimistic, ...prev])
    try {
      const p = await api.createProject(trimmed, '')
      setProjects((prev) => prev.map((x) => (x.id === tempId ? p : x)))
      setProjectId(p.id)
    } catch (e) {
      setProjects((prev) => prev.filter((x) => x.id !== tempId))
      setError(`新建项目失败：${String(e)}`)
    }
  }

  async function onUpload(file: File) {
    if (!projectId) return
    const tempId = `tmp-${Date.now()}`
    const optimistic: Recording = {
      id: tempId,
      project_id: projectId,
      name: file.name,
      audio_path: '',
      format: file.name.split('.').pop()?.toLowerCase() ?? '',
      duration_sec: 0,
      created_at: new Date().toISOString(),
      transcribe: { status: 'pending', progress: 0, error: '' },
    }
    setRecordings((prev) => [optimistic, ...prev])
    setError('')
    try {
      const rec = await api.uploadRecording(projectId, file)
      setRecordings((prev) => prev.map((x) => (x.id === tempId ? rec : x)))
      setRecordingId(rec.id)
      await refreshRecordings(projectId)
    } catch (e) {
      setRecordings((prev) => prev.filter((x) => x.id !== tempId))
      setError(`上传失败：${String(e)}`)
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function onLiveFinished(recordingId: string) {
    setLiveOpen(false)
    if (projectId) void refreshRecordings(projectId)
    setRecordingId(recordingId)
  }

  async function onUpdate() {
    setUpd('updating')
    setUpdText('正在写入本地文件…')
    setUpdProgress({ done: 0, total: BOOTSTRAP_FILES.filter((f) => !f.launcher).length })
    try {
      let dir = await loadDirHandle()
      if (!dir || !(await ensureWritePermission(dir))) {
        // 没有记住文件夹，或用户这次没给写入权限：让用户重新选一次（仍是点击触发）
        dir = await pickDirectory()
        await saveDirHandle(dir)
      }

      const res = await applyUpdate(dir, (done) =>
        setUpdProgress({ done, total: BOOTSTRAP_FILES.filter((f) => !f.launcher).length }),
      )
      const launcherNote = res.launcherStale.length
        ? `启动器脚本有更新（${res.launcherStale.join('、')}），请回到引导页重新点一次「写入启动文件」覆盖它们。`
        : ''

      if (res.changed === 0 && !res.launcherStale.length) {
        setUpd('manual')
        setUpdText('本地文件已是最新，但正在运行的后端仍是旧代码：请关闭黑色启动窗口，再双击启动器。')
        return
      }

      const restarted = await api.restartBackend()
      if (!restarted) {
        // 旧版后端还没有 /api/restart：这次只能手动重启，之后就能自动重启
        setUpd('manual')
        setUpdText(`已更新 ${res.changed} 个文件。${launcherNote} 请关闭黑色启动窗口，再双击启动器（本次需手动重启，之后会自动重启）。`)
        return
      }

      setUpd('restarting')
      setUpdText(`已更新 ${res.changed} 个文件，正在重启后端…${launcherNote}`)
      setRestarting(true)
      // 首次更新可能触发模型下载（约 500MB），启动会明显变慢；
      // 一分钟还没起来就先解释原因，避免用户以为卡死而关掉窗口。
      const slowTimer = setTimeout(() => {
        setUpdText(`正在重启本地后端…如果这是首次下载语音模型（约 500MB），需要几分钟，请保持启动窗口开启。${launcherNote}`)
      }, 60000)
      const ok = await waitForBackend(8 * 60 * 1000)
      clearTimeout(slowTimer)
      setRestarting(false)
      if (ok) {
        setUpd('idle')
        setUpdText('')
        void boot()
      } else {
        setUpd('manual')
        setUpdText('后端没有自动起来。请看启动窗口里的提示：如果它正在下载模型，请等下载完成后再刷新本页面；如果是报错，把窗口内容发给我们。')
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setUpd('available') // 用户取消选文件夹
        setUpdText('')
        return
      }
      if (e instanceof Error && e.message === 'unsupported') {
        setUpd('manual')
        setUpdText('当前浏览器不支持一键写入。请在引导页逐个下载文件覆盖，或换用 Chrome / Edge。')
        return
      }
      setUpd('error')
      setUpdText(String(e))
    }
  }

  if (health === 'down' && !restarting) {
    return <BootstrapGuide onRetry={() => void boot()} />
  }
  if (guideOpen) {
    return (
      <BootstrapGuide
        onRetry={() => {
          setGuideOpen(false)
          void boot()
        }}
        onClose={() => setGuideOpen(false)}
      />
    )
  }
  if (health === 'checking') {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: '#8a8f98', fontSize: 14, background: '#f6f7f9' }}>
        正在连接本地后端…
      </div>
    )
  }

  const blockingUpdate =
    upd === 'updating' ||
    upd === 'restarting' ||
    ((upd === 'available' || upd === 'manual' || upd === 'error') && !updDismissed)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#f6f7f9' }}>
      {blockingUpdate && (
        <UpdateScreen
          phase={upd as UpdatePhase}
          text={updText}
          progress={updProgress}
          onUpdate={onUpdate}
          onLater={() => setUpdDismissed(true)}
          onOpenGuide={() => {
            setUpdDismissed(true)
            setGuideOpen(true)
          }}
        />
      )}

      {/* 用户选择「稍后」后，收起成一行的提示，不挡操作 */}
      {upd !== 'idle' && updDismissed && (upd === 'available' || upd === 'manual' || upd === 'error') && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 24px',
            fontSize: 13,
            borderBottom: '1px solid #eee',
            background: upd === 'error' ? '#fdecea' : '#fff8e1',
          }}
        >
          <span style={{ flex: 1, lineHeight: 1.6 }}>
            有新版本可用：页面已更新，本地程序还是旧版。只更新程序文件，不会动你的录音。
          </span>
          <button onClick={onUpdate} style={{ fontSize: 13, padding: '4px 12px', flexShrink: 0 }}>
            更新本地文件
          </button>
        </div>
      )}

      <header style={{ flexShrink: 0, textAlign: 'center', padding: '24px 24px 18px', position: 'relative' }}>
        <div style={{ position: 'absolute', right: 24, top: 20, display: 'flex', gap: 8 }}>
          <button onClick={() => setSettingsOpen(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#666' }}>
            设置
          </button>
          <button onClick={() => setGuideOpen(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#666' }}>
            启动设置
          </button>
        </div>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: '0.02em' }}>访谈录音台</h1>
        <nav
          style={{
            display: 'inline-flex',
            gap: 4,
            marginTop: 14,
            padding: 3,
            background: '#f2f4f7',
            borderRadius: 8,
          }}
        >
          {(
            [
              ['workspace', '我的录音'],
              ['collab', '共享任务'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setView(key)}
              style={{
                fontSize: 13,
                padding: '6px 18px',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
                background: view === key ? '#fff' : 'transparent',
                color: view === key ? '#1f2937' : '#6b7280',
                boxShadow: view === key ? '0 1px 3px rgba(16,24,40,.12)' : 'none',
                fontWeight: view === key ? 600 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <p
          style={{
            margin: '8px 0 0',
            fontSize: 12,
            color: '#8a8f98',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 3, background: '#34a853', flexShrink: 0 }} />
          本地后端已连接 · 录音不出本机
        </p>
      </header>

      {view === 'collab' ? (
        <main
          style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            width: '100%',
            maxWidth: 1120,
            margin: '0 auto',
            padding: '0 24px 24px',
            boxSizing: 'border-box',
          }}
        >
          <CollabPanel projects={projects} embedded onClose={() => setView('workspace')} />
        </main>
      ) : (
      <main
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          gap: 20,
          width: '100%',
          maxWidth: 1120,
          margin: '0 auto',
          padding: '0 24px 24px',
          boxSizing: 'border-box',
        }}
      >
      {/* 左栏：项目 + 录音 */}
      <aside
        style={{
          ...cardStyle,
          width: 300,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minHeight: 0,
        }}
      >
        <ProjectCreator onCreate={onCreateProject} />

        <ProjectList projects={projects} activeId={projectId} onSelect={setProjectId} />

        {projectId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>录音</span>
              <input
                ref={fileInputRef}
                type="file"
                hidden
                accept=".wav,.mp3,.m4a,.wma,.flac,.ogg,.opus,.aac,.aiff,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac,audio/ogg,audio/aac"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onUpload(f)
                }}
              />
              <button
                onClick={() => setLiveOpen(true)}
                style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}
              >
                实时录音
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                上传录音
              </button>
            </div>
            <RecordingList recordings={recordings} activeId={recordingId} onSelect={setRecordingId} />
          </div>
        )}
      </aside>

      {/* 右栏：转写详情 */}
      <section
        style={{
          ...cardStyle,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {error && (
          <div style={{ color: '#b00020', fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}
        {detail ? (
          <TranscriptPanel
            key={`${projectId}/${recordingId}`}
            projectId={projectId!}
            recordingId={recordingId!}
            detail={detail}
            onError={setError}
            onRetry={() => setDetailNonce((n) => n + 1)}
          />
        ) : (
          <div style={{ color: '#aaa', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
            选择一条录音查看转写结果
          </div>
        )}
      </section>
      </main>
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      {liveOpen && projectId && (
        <LiveRecorder
          projectId={projectId}
          onClose={() => setLiveOpen(false)}
          onFinished={onLiveFinished}
        />
      )}
      {!modelSetupDone && (
        <ModelSetup
          onClose={() => {
            try {
              localStorage.setItem('lw_model_setup_done_v1', '1')
            } catch {
              // 隐私模式下 localStorage 不可写，忽略即可，下次仍会提示
            }
            setModelSetupDone(true)
          }}
        />
      )}
    </div>
  )
}

function ProjectCreator({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ fontSize: 13, padding: '6px 10px' }}>
        + 新建项目
      </button>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <input
        autoFocus
        value={name}
        placeholder="项目名"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) {
            onCreate(name)
            setName('')
            setOpen(false)
          }
        }}
        style={{ flex: 1, fontSize: 13, minWidth: 0 }}
      />
      <button
        onClick={() => {
          onCreate(name)
          setName('')
          setOpen(false)
        }}
        style={{ fontSize: 13 }}
      >
        确定
      </button>
    </div>
  )
}

function ProjectList({
  projects,
  activeId,
  onSelect,
}: {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (projects.length === 0) {
    return <div style={{ color: '#aaa', fontSize: 13 }}>还没有项目</div>
  }
  return (
    <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {projects.map((p) => (
        <li
          key={p.id}
          onClick={() => onSelect(p.id)}
          style={{
            padding: '8px 10px',
            cursor: 'pointer',
            borderRadius: 6,
            fontSize: 14,
            background: p.id === activeId ? '#e8f0fe' : 'transparent',
            marginBottom: 4,
          }}
        >
          {p.name}
        </li>
      ))}
    </ul>
  )
}

function RecordingList({
  recordings,
  activeId,
  onSelect,
}: {
  recordings: Recording[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  if (recordings.length === 0) {
    return <div style={{ color: '#aaa', fontSize: 13 }}>暂无录音，上传以开始</div>
  }
  return (
    <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', maxHeight: 220 }}>
      {recordings.map((r) => (
        <li
          key={r.id}
          onClick={() => onSelect(r.id)}
          style={{
            padding: '6px 10px',
            cursor: 'pointer',
            borderRadius: 6,
            fontSize: 13,
            background: r.id === activeId ? '#e8f0fe' : 'transparent',
            marginBottom: 2,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ color: '#999', fontSize: 12, flexShrink: 0 }}>{statusLabel(r.transcribe.status)}</span>
        </li>
      ))}
    </ul>
  )
}

function TranscriptPanel({
  projectId,
  recordingId,
  detail,
  onError,
  onRetry,
}: {
  projectId: string
  recordingId: string
  detail: RecordingDetail
  onError: (msg: string) => void
  onRetry: () => void
}) {
  const { transcribe, sentences, recording } = detail
  const [localSentences, setLocalSentences] = useState<Sentence[]>(sentences)
  const [version, setVersion] = useState(recording.version?.current ?? '')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftSpeaker, setDraftSpeaker] = useState('')
  const [speakerEdit, setSpeakerEdit] = useState<string | null>(null)
  const [speakerDraft, setSpeakerDraft] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [marks, setMarks] = useState<RedactionMark[]>(detail.redactions ?? [])
  const [redactMode, setRedactMode] = useState(false)
  const [categories, setCategories] = useState<RedactionCategory[]>([])
  const [activeCat, setActiveCat] = useState('')
  const [catPanel, setCatPanel] = useState(false)
  const [catDraft, setCatDraft] = useState<RedactionCategory[]>([])
  // AI 智能脱敏：只给带偏移的建议，采纳仍走人工确认的 addRedactions。
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState<RedactionSuggestion[]>([])
  const [aiError, setAiError] = useState('')
  // AI 语义纠错：建议列表、运行时的可用性、模型名；运行不可用时按钮置灰。
  const [polishOpen, setPolishOpen] = useState(false)
  const [polishing, setPolishing] = useState(false)
  const [suggestions, setSuggestions] = useState<PolishSuggestion[]>([])
  const [polishModel, setPolishModel] = useState('')
  const [llmReady, setLlmReady] = useState<boolean | null>(null)
  // 模型下载状态：选了档位但还没下载时，点 AI 按钮先起后台下载，而不是让请求挂几分钟。
  const { models: modelState, download: downloadModel } = useModels(1500)
  const [aiNotice, setAiNotice] = useState('')
  // AI 整理断句：先出预览（合并前后句数 + 正文），用户确认后才落盘。
  const [resegmenting, setResegmenting] = useState(false)
  const [resegPreview, setResegPreview] = useState<ResegmentResult | null>(null)
  const [editOrigin, setEditOrigin] = useState<'ai_polish' | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const llmKey = polishModel || 'qwen3-4b'
  const llmModelInfo = modelState?.llm.find((m) => m.id === llmKey)
  const llmDownloaded = llmModelInfo?.downloaded ?? null
  const llmJob = jobFor(modelState, 'llm', llmKey)
  const llmDownloading = llmJob?.status === 'running'

  // 服务端轮询到的句子是权威值；转写结束后不再轮询，本地编辑结果不会被覆盖
  useEffect(() => {
    setLocalSentences(sentences)
  }, [sentences])
  useEffect(() => {
    setVersion(recording.version?.current ?? '')
  }, [recording.version?.current])
  useEffect(() => {
    setMarks(detail.redactions ?? [])
  }, [detail.redactions])

  // 进入脱敏态才取类别模板：平时不打扰；模板是项目级，切换录音仍一致。
  useEffect(() => {
    if (!redactMode) return
    let cancelled = false
    api
      .fetchRedactionCategories(projectId)
      .then((cs) => {
        if (cancelled) return
        setCategories(cs)
        setActiveCat((prev) => prev || cs.find((c) => c.enabled)?.id || cs[0]?.id || '')
      })
      .catch((e) => onError(`读取脱敏类别失败：${String(e)}`))
    return () => {
      cancelled = true
    }
  }, [redactMode, projectId, onError])

  // 读取 LLM 运行时是否就绪：未安装时按钮直接置灰并说明原因，而不是点了才报错。
  useEffect(() => {
    let cancelled = false
    api
      .fetchSettings()
      .then((p) => {
        if (cancelled) return
        setLlmReady(p.options.llm.some((o) => o.available))
        setPolishModel(p.settings.llm_model)
      })
      .catch(() => {
        // 设置读取失败不影响其它功能；按钮保持可用，由接口返回明确错误。
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 播放时按时间定位当前句，滚动跟随（流式浏览用滚动）
  function onTimeUpdate() {
    const audio = audioRef.current
    if (!audio) return
    const ms = audio.currentTime * 1000
    const current = localSentences.find((s) => ms >= s.start_ms && ms < s.end_ms)
    if (current && current.id !== activeId) {
      setActiveId(current.id)
      const el = document.getElementById(`sentence-${current.id}`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }

  function seek(s: Sentence) {
    setActiveId(s.id)
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = s.start_ms / 1000
    void audio.play().catch(() => {
      // 浏览器可能因权限/格式拒绝自动播放，用户可手点播放按钮
    })
  }

  function startEdit(s: Sentence, prefill?: string, origin: 'ai_polish' | null = null) {
    setEditingId(s.id)
    setDraft(prefill ?? s.text)
    setDraftSpeaker(s.speaker ?? '')
    setEditOrigin(origin)
  }

  async function saveEdit(s: Sentence) {
    const text = draft.trim()
    const speaker = draftSpeaker.trim()
    const origin = editOrigin
    setEditingId(null)
    setEditOrigin(null)
    if (!text || (text === s.text && speaker === (s.speaker ?? ''))) return
    const snapshot = localSentences
    // 乐观更新：先让用户看到新文字，失败再回滚
    setLocalSentences((list) => list.map((x) => (x.id === s.id ? { ...x, text, speaker } : x)))
    try {
      const res = await api.updateSentence(
        projectId,
        recordingId,
        s.id,
        text,
        speaker,
        origin ? { advance_to: 1, source: origin } : undefined,
      )
      setVersion(res.current || version)
      if (origin === 'ai_polish') {
        setSuggestions((list) => list.filter((x) => x.sentence_id !== s.id))
      }
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      onError(`保存失败：${String(e)}`)
    }
  }

  // AI 调用前的就绪检查：运行时缺失直接说明；模型没下载就先起后台下载任务，
  // 绝不让一个 HTTP 请求在服务端同步拉几 GB（界面看起来就是卡死）。
  async function ensureLlmReady(): Promise<boolean> {
    if (llmReady === false) {
      onError('本机未安装 AI 运行时（llama-cpp-python）：请重新运行启动器安装后重启，再用 AI 功能')
      return false
    }
    if (llmReady === null || llmDownloaded === null) return true // 状态未知，交给后端给明确错误
    if (llmDownloaded) return true
    setAiNotice(
      `AI 模型「${llmModelInfo?.label || llmKey}」还没下载，已开始后台下载（约 1–5GB）；完成后直接再点一次即可。`,
    )
    if (!llmDownloading) await downloadModel('llm', llmKey)
    return false
  }

  useEffect(() => {
    if (!aiNotice) return
    if (llmDownloaded) {
      setAiNotice('AI 模型已就绪，再点一次「AI 纠错 / AI 整理断句」即可使用。')
    } else if (llmJob?.status === 'error') {
      setAiNotice(`AI 模型下载失败：${llmJob.error || llmJob.message || '请到设置里重试'}`)
    }
  }, [aiNotice, llmDownloaded, llmJob?.status, llmJob?.error, llmJob?.message])

  async function runPolish() {
    if (polishing) return
    if (!(await ensureLlmReady())) return
    setPolishOpen(true)
    setPolishing(true)
    setSuggestions([])
    try {
      const res = await api.polishRecording(projectId, recordingId)
      setSuggestions(res.suggestions)
      setPolishModel(res.model)
      setAiNotice('')
      onError('')
    } catch (e) {
      onError(`AI 纠错失败：${String(e)}`)
    } finally {
      setPolishing(false)
    }
  }

  async function runResegment() {
    if (resegmenting) return
    if (!(await ensureLlmReady())) return
    setResegmenting(true)
    setResegPreview(null)
    try {
      const res = await api.resegmentRecording(projectId, recordingId, false)
      setResegPreview(res)
      setAiNotice('')
      onError('')
    } catch (e) {
      onError(`AI 整理断句失败：${String(e)}`)
    } finally {
      setResegmenting(false)
    }
  }

  async function applyResegment() {
    if (!resegPreview || resegmenting) return
    setResegmenting(true)
    try {
      const res = await api.resegmentRecording(projectId, recordingId, true)
      setLocalSentences(res.sentences)
      if (res.current) setVersion(res.current)
      setResegPreview(null)
      onError('')
    } catch (e) {
      onError(`应用整理结果失败：${String(e)}`)
    } finally {
      setResegmenting(false)
    }
  }

  async function acceptSuggestion(item: PolishSuggestion) {
    if (!localSentences.some((s) => s.id === item.sentence_id)) return
    const snapshot = localSentences
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
    setLocalSentences((list) =>
      list.map((x) => (x.id === item.sentence_id ? { ...x, text: item.after } : x)),
    )
    try {
      const res = await api.updateSentence(projectId, recordingId, item.sentence_id, item.after, undefined, {
        advance_to: 1,
        source: 'ai_polish',
      })
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      setSuggestions((list) => [...list, item].sort((a, b) => a.index - b.index))
      onError(`采纳失败：${String(e)}`)
    }
  }

  function dismissSuggestion(item: PolishSuggestion) {
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
  }

  async function renameSpeaker(from: string, to: string) {
    const name = to.trim()
    setSpeakerEdit(null)
    if (!name || name === from) return
    const snapshot = localSentences
    setLocalSentences((list) => list.map((x) => (x.speaker === from ? { ...x, speaker: name } : x)))
    try {
      const res = await api.updateSpeakers(projectId, recordingId, { action: 'rename', from, to: name })
      setLocalSentences(res.sentences)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      onError(`改名失败：${String(e)}`)
    }
  }

  async function mergeSpeaker(from: string, into: string) {
    if (!into) return
    const snapshot = localSentences
    setLocalSentences((list) => list.map((x) => (x.speaker === from ? { ...x, speaker: into } : x)))
    try {
      const res = await api.updateSpeakers(projectId, recordingId, { action: 'merge', from, into })
      setLocalSentences(res.sentences)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      onError(`合并失败：${String(e)}`)
    }
  }

  const speakers = [...new Set(localSentences.map((s) => s.speaker).filter(Boolean))] as string[]

  /** 从当前选区取出句子内的字符区间（只统计文字，不含任何按钮）。 */
  function selectionRange(s: Sentence): { start: number; end: number } | null {
    const container = document.getElementById(`stext-${s.id}`)
    const sel = window.getSelection()
    if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null
    const pre = document.createRange()
    pre.selectNodeContents(container)
    pre.setEnd(range.startContainer, range.startOffset)
    const start = pre.toString().length
    const end = start + range.toString().length
    if (start >= end) return null
    return { start, end }
  }

  async function markSelection(s: Sentence) {
    if (!redactMode) return
    const cat = categories.find((c) => c.id === activeCat && c.enabled)
    if (!cat) {
      onError('请先选择一个脱敏类别')
      return
    }
    const range = selectionRange(s)
    if (!range) return
    const original = s.text.slice(range.start, range.end)
    window.getSelection()?.removeAllRanges()

    // 乐观更新：先画上颜色，失败回滚（工程纪律三.3）。
    const snapshot = marks
    const temp: RedactionMark = {
      id: `tmp-${Date.now()}`,
      sentence_id: s.id,
      start: range.start,
      end: range.end,
      original,
      category_id: cat.id,
      category_name: cat.name,
      placeholder: cat.placeholder,
      color: cat.color,
    }
    setMarks((list) => [...list, temp])
    try {
      const res = await api.addRedactions(projectId, recordingId, [
        { sentence_id: s.id, start: range.start, end: range.end, category_id: cat.id },
      ])
      setMarks(res.marks)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setMarks(snapshot)
      onError(`标记失败：${String(e)}`)
    }
  }

  async function removeMark(mark: RedactionMark) {
    if (!redactMode) return
    const snapshot = marks
    setMarks((list) => list.filter((m) => m.id !== mark.id))
    try {
      const res = await api.deleteRedaction(projectId, recordingId, mark.id)
      setMarks(res.marks)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setMarks(snapshot)
      onError(`移除标记失败：${String(e)}`)
    }
  }

  async function suggestAiRedactions() {
    setAiSuggesting(true)
    setAiError('')
    try {
      const res = await api.suggestRedactions(projectId, recordingId)
      setAiSuggestions(res.suggestions)
      if (res.suggestions.length === 0) setAiError('没有发现匹配已启用类别的敏感片段。')
    } catch (e) {
      setAiError(String(e))
    } finally {
      setAiSuggesting(false)
    }
  }

  async function acceptAiRedactions(items: RedactionSuggestion[]) {
    if (items.length === 0) return
    try {
      const res = await api.addRedactions(
        projectId,
        recordingId,
        items.map((x) => ({
          sentence_id: x.sentence_id,
          start: x.start,
          end: x.end,
          category_id: x.category_id,
        })),
      )
      setMarks(res.marks)
      setVersion(res.current || version)
      const done = new Set(items.map((x) => `${x.sentence_id}:${x.start}:${x.end}`))
      setAiSuggestions((list) => list.filter((x) => !done.has(`${x.sentence_id}:${x.start}:${x.end}`)))
      onError('')
    } catch (e) {
      onError(`采纳 AI 建议失败：${String(e)}`)
    }
  }

  function openCategoryPanel() {
    setCatDraft(categories.map((c) => ({ ...c })))
    setCatPanel((v) => !v)
  }

  async function saveCategories() {
    const snapshot = categories
    const cleaned = catDraft.map((c) => ({ ...c, name: c.name.trim() }))
    setCategories(cleaned)
    try {
      const cs = await api.updateRedactionCategories(projectId, cleaned)
      setCategories(cs)
      setActiveCat((prev) => (cs.some((c) => c.id === prev && c.enabled) ? prev : cs.find((c) => c.enabled)?.id || ''))
      setCatPanel(false)
      onError('')
    } catch (e) {
      setCategories(snapshot)
      onError(`保存类别失败：${String(e)}`)
    }
  }

  function renderText(s: Sentence) {
    const text = s.text
    const list = marks
      .filter((m) => m.sentence_id === s.id && m.start < m.end && m.end <= text.length)
      .sort((a, b) => a.start - b.start)
    if (list.length === 0) return text
    const nodes: ReactNode[] = []
    let cursor = 0
    list.forEach((m, i) => {
      if (m.start < cursor) return
      if (m.start > cursor) nodes.push(text.slice(cursor, m.start))
      nodes.push(
        <span
          key={`${m.id}-${i}`}
          title={`${m.category_name}：导出时替换为 ${m.placeholder}${redactMode ? '（点击移除）' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            if (redactMode) void removeMark(m)
          }}
          style={{
            background: `${m.color}22`,
            borderBottom: `2px solid ${m.color}`,
            borderRadius: 3,
            cursor: redactMode ? 'pointer' : 'text',
          }}
        >
          {text.slice(m.start, m.end)}
        </span>,
      )
      cursor = m.end
    })
    if (cursor < text.length) nodes.push(text.slice(cursor))
    return nodes
  }

  // 排队阶段还没内容可看，只给进度；一旦开始出句就进入正文，允许边出边改。
  if (transcribe.status === 'pending') {
    return (
      <div style={{ marginTop: 40, textAlign: 'center' }}>
        <div style={{ fontSize: 14, color: '#555', marginBottom: 12 }}>
          转写中 {transcribe.progress}%
        </div>
        <div style={{ width: '60%', margin: '0 auto', height: 8, background: '#eee', borderRadius: 4 }}>
          <div
            style={{ width: `${transcribe.progress}%`, height: 8, background: '#4285f4', borderRadius: 4 }}
          />
        </div>
        {transcribe.progress < 5 && (
          <p style={{ fontSize: 12, color: '#999', marginTop: 12 }}>
            进度长时间停在 0% 通常是在下载语音模型（首次约 500MB），请保持启动窗口开启。
          </p>
        )}
      </div>
    )
  }

  if (transcribe.status === 'error') {
    return (
      <div style={{ marginTop: 40, textAlign: 'center', color: '#b00020', fontSize: 14 }}>
        <div style={{ marginBottom: 12 }}>转写失败：{transcribe.error}</div>
        <button
          onClick={async () => {
            try {
              await api.retryTranscribe(projectId, recordingId)
              onRetry()
            } catch (e) {
              onError(`重新转写失败：${String(e)}`)
            }
          }}
          style={{ fontSize: 13, padding: '6px 14px' }}
        >
          重新转写
        </button>
        <p style={{ fontSize: 12, color: '#8a8f98', marginTop: 10 }}>
          如果是模型缺失或下载失败，可先在「设置」里下载对应模型再重试。
        </p>
      </div>
    )
  }

  if (transcribe.status === 'done' && localSentences.length === 0) {
    return <div style={{ marginTop: 40, textAlign: 'center', color: '#aaa' }}>未识别到任何句子</div>
  }

  return (
    <div style={{ display: 'flex', gap: 20, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>转写稿（{localSentences.length} 句）</h2>
          {version && (
            <span style={{ fontSize: 11, color: '#6b7280', background: '#f1f3f5', borderRadius: 10, padding: '2px 8px' }}>
              v{version}
            </span>
          )}
          <button
            onClick={() => void saveExport(projectId, recordingId, 'md', version || undefined, onError)}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            导出 MD
          </button>
          <button
            onClick={() => void saveExport(projectId, recordingId, 'json', version || undefined, onError)}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            导出 JSON
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            style={{ fontSize: 12, padding: '4px 10px' }}
          >
            {showHistory ? '收起版本' : '版本历史'}
          </button>
          <button
            onClick={() => void runPolish()}
            disabled={polishing || llmReady === false || llmDownloading || transcribe.status !== 'done'}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              marginLeft: 'auto',
              background: polishOpen ? '#eef5ff' : '#fff',
              border: `1px solid ${polishOpen ? '#8ab4f8' : '#ddd'}`,
              color: llmReady === false ? '#999' : '#245c9c',
              borderRadius: 4,
              cursor: polishing || llmReady === false || llmDownloading ? 'not-allowed' : 'pointer',
            }}
            title={
              llmReady === false
                ? '本机未安装 AI 运行时（llama-cpp-python），请重新运行启动器安装'
                : llmDownloaded === false
                  ? '模型还没下载：点击会先在后台下载，完成后就能用'
                  : '用本地大模型纠错：只给建议，逐句采纳后才改正文；首次使用需下载模型'
            }
          >
            {polishing ? 'AI 分析中…' : llmDownloading ? '模型下载中…' : 'AI 纠错'}
          </button>
          <button
            onClick={() => void runResegment()}
            disabled={resegmenting || llmReady === false || llmDownloading || transcribe.status !== 'done'}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: '#fff',
              border: '1px solid #ddd',
              color: llmReady === false ? '#999' : '#245c9c',
              borderRadius: 4,
              cursor:
                resegmenting || llmReady === false || llmDownloading || transcribe.status !== 'done'
                  ? 'not-allowed'
                  : 'pointer',
            }}
            title={
              llmReady === false
                ? '本机未安装 AI 运行时（llama-cpp-python），请重新运行启动器安装'
                : llmDownloaded === false
                  ? '模型还没下载：点击会先在后台下载，完成后就能用'
                  : '把按停顿切碎的片段交给本地 AI，合并成人类能读懂的句子；只给预览，确认后才写入'
            }
          >
            {resegmenting ? 'AI 整理中…' : llmDownloading ? '模型下载中…' : 'AI 整理断句'}
          </button>
          <button
            onClick={() => setRedactMode((v) => !v)}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: redactMode ? '#fff4e0' : '#fff',
              border: `1px solid ${redactMode ? '#f0b429' : '#ddd'}`,
              color: redactMode ? '#8a5a00' : '#555',
              borderRadius: 4,
            }}
            title="进入脱敏态：选中文字后点类别即可标记；导出时替换为占位符"
          >
            {redactMode ? '退出脱敏' : '脱敏'}
          </button>
        </div>

        {llmReady === false && (
          <div
            style={{
              fontSize: 12,
              color: '#8a5a00',
              background: '#fff8e6',
              border: '1px solid #f0d9a8',
              borderRadius: 6,
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            AI 纠错 / AI 整理断句需要本地运行时（llama-cpp-python）：请重新运行一次启动器安装组件后重启。
          </div>
        )}

        {aiNotice && (
          <div
            style={{
              fontSize: 12,
              color: '#245c9c',
              background: '#eef5ff',
              border: '1px solid #d5e5fb',
              borderRadius: 6,
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            {aiNotice}
            {llmDownloading && ` 下载中 ${Math.max(1, llmJob?.progress ?? 0)}%`}
          </div>
        )}

        {transcribe.status === 'transcribing' && (
          <div
            style={{
              fontSize: 12,
              color: '#245c9c',
              background: '#eef5ff',
              border: '1px solid #d5e5fb',
              borderRadius: 6,
              padding: '6px 10px',
              marginBottom: 8,
            }}
          >
            正在转写 {transcribe.progress}% · 已出 {localSentences.length} 句。现在就能先改，后面的句子会继续追加，不会覆盖你的修改。
          </div>
        )}

        <audio
          ref={audioRef}
          src={api.audioUrl(projectId, recordingId)}
          controls
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          style={{ width: '100%', height: 36, marginBottom: 10 }}
        />

        {resegPreview && (
          <div
            onClick={() => !resegmenting && setResegPreview(null)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 60,
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
                width: 640,
                maxWidth: '100%',
                maxHeight: '82vh',
                overflowY: 'auto',
                background: '#fff',
                borderRadius: 12,
                padding: 20,
                boxShadow: '0 12px 40px rgba(16, 24, 40, 0.18)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h3 style={{ margin: 0, fontSize: 16, flex: 1 }}>AI 整理断句预览</h3>
                <span style={{ fontSize: 12, color: '#7a869a' }}>
                  {resegPreview.before} 句 → {resegPreview.after} 句
                </span>
              </div>
              <p style={{ fontSize: 12, color: '#8a8f98', lineHeight: 1.7, margin: '8px 0 12px' }}>
                只合并停顿碎片、补标点，不增删内容。应用后写入新版本，可在版本历史里回退。
              </p>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: '#333' }}>
                {resegPreview.sentences.slice(0, 8).map((s) => (
                  <li key={s.id} style={{ marginBottom: 4 }}>{s.text}</li>
                ))}
              </ol>
              {resegPreview.sentences.length > 8 && (
                <p style={{ fontSize: 12, color: '#9aa0a6', margin: '8px 0 0' }}>
                  仅预览前 8 句，共 {resegPreview.after} 句。
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                <button
                  onClick={() => setResegPreview(null)}
                  disabled={resegmenting}
                  style={{ fontSize: 13, padding: '6px 14px' }}
                >
                  取消
                </button>
                <button
                  onClick={() => void applyResegment()}
                  disabled={resegmenting}
                  style={{ fontSize: 13, padding: '6px 14px', background: '#245c9c', color: '#fff', border: 'none', borderRadius: 4 }}
                >
                  {resegmenting ? '应用中…' : '应用并生成新版本'}
                </button>
              </div>
            </div>
          </div>
        )}

        {polishOpen && (
          <div
            style={{
              marginBottom: 10,
              border: '1px solid #dce6f2',
              background: '#f8fbff',
              borderRadius: 8,
              padding: 10,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: '#245c9c', fontWeight: 600 }}>
                AI 纠错建议
              </span>
              <span style={{ fontSize: 11, color: '#7a869a' }}>
                {polishModel ? `模型 ${polishModel}` : ''}
              </span>
              <span style={{ fontSize: 11, color: '#7a869a' }}>
                {polishing ? '' : `共 ${suggestions.length} 条`}
              </span>
              <button
                onClick={() => setPolishOpen(false)}
                style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
              >
                关闭
              </button>
            </div>
            {polishing ? (
              <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.7 }}>
                正在本地分析，请保持窗口开启。首次使用需要下载模型（约 1–3 GB），可能耗时较久。
              </div>
            ) : suggestions.length === 0 ? (
              <div style={{ fontSize: 12, color: '#6b7280' }}>
                未发现需要修改的句子。你也可以再点一次「AI 纠错」重新分析。
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {suggestions.map((item) => {
                  const target = localSentences.find((s) => s.id === item.sentence_id)
                  return (
                    <div
                      key={item.sentence_id}
                      style={{ border: '1px solid #e6ecf5', background: '#fff', borderRadius: 6, padding: 8 }}
                    >
                      <div style={{ fontSize: 11, color: '#8a94a6', marginBottom: 2 }}>
                        第 {item.index + 1} 句
                      </div>
                      <div style={{ fontSize: 12, color: '#b00020', textDecoration: 'line-through', lineHeight: 1.6 }}>
                        {item.before}
                      </div>
                      <div style={{ fontSize: 13, color: '#1e7e34', lineHeight: 1.6 }}>{item.after}</div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button
                          onClick={() => void acceptSuggestion(item)}
                          style={{ fontSize: 11, padding: '2px 10px', border: '1px solid #b7dfc2', color: '#1e7e34', borderRadius: 4 }}
                        >
                          接受
                        </button>
                        <button
                          onClick={() => target && startEdit(target, item.after, 'ai_polish')}
                          disabled={!target}
                          style={{ fontSize: 11, padding: '2px 10px', borderRadius: 4 }}
                        >
                          自己改
                        </button>
                        <button
                          onClick={() => dismissSuggestion(item)}
                          style={{ fontSize: 11, padding: '2px 10px', borderRadius: 4 }}
                        >
                          忽略
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {redactMode && (
          <div style={{ marginBottom: 10, fontSize: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#8a5a00' }}>脱敏类别：</span>
              {categories
                .filter((c) => c.enabled)
                .map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setActiveCat(c.id)}
                    style={{
                      fontSize: 12,
                      padding: '2px 10px',
                      borderRadius: 12,
                      background: activeCat === c.id ? `${c.color}22` : '#fff',
                      color: activeCat === c.id ? c.color : '#555',
                      border: `1px solid ${activeCat === c.id ? c.color : '#ddd'}`,
                    }}
                    title={c.placeholder}
                  >
                    {c.name}
                  </button>
                ))}
              <button onClick={openCategoryPanel} style={{ fontSize: 12, padding: '2px 10px', color: '#666' }}>
                {catPanel ? '收起类别管理' : '管理类别'}
              </button>
              <button
                onClick={() => void suggestAiRedactions()}
                disabled={aiSuggesting || llmReady === false}
                title={
                  llmReady === false
                    ? 'AI 运行时未安装，请先运行启动器安装组件'
                    : '用本地 AI 找出敏感片段，确认后才写入'
                }
                style={{ fontSize: 12, padding: '2px 10px', color: llmReady === false ? '#aaa' : '#1f6feb' }}
              >
                {aiSuggesting ? 'AI 识别中…' : 'AI 识别敏感信息'}
              </button>
              <span style={{ color: '#9aa0a6' }}>选中文字即标记；点彩色文字移除</span>
            </div>

            {llmReady === false && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#b36b00' }}>
                AI 智能脱敏需要本地 AI 运行时（llama-cpp-python）：请重新运行一次启动器安装组件。
              </div>
            )}

            {aiError && (
              <div style={{ marginTop: 6, fontSize: 11, color: aiSuggestions.length ? '#8a8f98' : '#b00020' }}>
                {aiError}
              </div>
            )}

            {aiSuggestions.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  border: '1px solid #f0d9a8',
                  background: '#fffdf6',
                  borderRadius: 8,
                  padding: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: '#8a5a00', fontWeight: 600 }}>
                    AI 找到 {aiSuggestions.length} 处敏感信息
                  </span>
                  <span style={{ fontSize: 11, color: '#a08a5a' }}>逐条确认后才会写入</span>
                  <button
                    onClick={() => void acceptAiRedactions(aiSuggestions)}
                    style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}
                  >
                    全部采纳
                  </button>
                  <button
                    onClick={() => setAiSuggestions([])}
                    style={{ fontSize: 11, padding: '2px 8px' }}
                  >
                    清空
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {aiSuggestions.map((item) => (
                    <div
                      key={`${item.sentence_id}:${item.start}:${item.end}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}
                    >
                      <span style={{ color: '#8a94a6', fontSize: 11, flexShrink: 0 }}>
                        第 {item.index + 1} 句
                      </span>
                      <span style={{ color: '#b00020', background: '#fdecea', borderRadius: 3, padding: '0 4px' }}>
                        {item.quote}
                      </span>
                      <span style={{ color: '#8a8f98', fontSize: 11 }}>→ {item.placeholder}</span>
                      <button
                        onClick={() => void acceptAiRedactions([item])}
                        style={{ marginLeft: 'auto', fontSize: 11, padding: '1px 8px' }}
                      >
                        采纳
                      </button>
                      <button
                        onClick={() =>
                          setAiSuggestions((list) =>
                            list.filter(
                              (x) =>
                                !(
                                  x.sentence_id === item.sentence_id &&
                                  x.start === item.start &&
                                  x.end === item.end
                                ),
                            ),
                          )
                        }
                        style={{ fontSize: 11, padding: '1px 8px' }}
                      >
                        忽略
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {catPanel && (
              <div style={{ marginTop: 8, padding: 10, border: '1px solid #eceef1', borderRadius: 8, background: '#fafbfc' }}>
                {catDraft.map((c, i) => (
                  <div key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      value={c.name}
                      onChange={(e) => setCatDraft((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      placeholder="类别名"
                      style={{ width: 110, fontSize: 12, padding: '2px 6px' }}
                    />
                    <input
                      value={c.placeholder}
                      onChange={(e) => setCatDraft((list) => list.map((x, j) => (j === i ? { ...x, placeholder: e.target.value } : x)))}
                      placeholder="占位符，如 [人名]"
                      style={{ width: 130, fontSize: 12, padding: '2px 6px' }}
                    />
                    <input
                      type="color"
                      value={c.color}
                      onChange={(e) => setCatDraft((list) => list.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))}
                      style={{ width: 30, height: 24, padding: 0, border: 'none', background: 'none' }}
                    />
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#666', fontSize: 11 }}>
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) => setCatDraft((list) => list.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))}
                      />
                      启用
                    </label>
                    <button
                      onClick={() => setCatDraft((list) => list.filter((_, j) => j !== i))}
                      disabled={catDraft.length <= 1}
                      style={{ fontSize: 11, padding: '1px 8px', color: '#b00020' }}
                    >
                      删除
                    </button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() =>
                      setCatDraft((list) => [
                        ...list,
                        { id: `c${Date.now()}`, name: '', placeholder: '', color: '#0f766e', enabled: true },
                      ])
                    }
                    style={{ fontSize: 12, padding: '3px 10px' }}
                  >
                    新增类别
                  </button>
                  <button onClick={() => void saveCategories()} style={{ fontSize: 12, padding: '3px 12px', background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 4 }}>
                    保存类别
                  </button>
                  <span style={{ color: '#9aa0a6', fontSize: 11 }}>占位符留空时自动为 [类别名]；已有标记不受改名影响</span>
                </div>
              </div>
            )}
          </div>
        )}

        {speakers.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: '#888' }}>发言人：</span>
            {speakers.map((sp) =>
              speakerEdit === sp ? (
                <span key={sp} style={{ display: 'flex', gap: 4, alignItems: 'center', background: '#f5f8ff', padding: '2px 6px', borderRadius: 4 }}>
                  <input
                    autoFocus
                    value={speakerDraft}
                    onChange={(e) => setSpeakerDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setSpeakerEdit(null)
                      if (e.key === 'Enter') void renameSpeaker(sp, speakerDraft)
                    }}
                    style={{ fontSize: 12, width: 100, padding: '1px 4px' }}
                  />
                  <button onClick={() => void renameSpeaker(sp, speakerDraft)} style={{ fontSize: 11, padding: '1px 6px' }}>
                    保存
                  </button>
                  <button onClick={() => setSpeakerEdit(null)} style={{ fontSize: 11, padding: '1px 6px' }}>
                    取消
                  </button>
                  {speakers.length > 1 && (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        const into = e.target.value
                        e.target.value = ''
                        if (into) void mergeSpeaker(sp, into)
                      }}
                      style={{ fontSize: 11 }}
                    >
                      <option value="">并入…</option>
                      {speakers.filter((x) => x !== sp).map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
              ) : (
                <button
                  key={sp}
                  onClick={() => {
                    setSpeakerEdit(sp)
                    setSpeakerDraft(sp)
                  }}
                  style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: '#eef4ff', color: '#1a73e8', border: '1px solid #d6e4ff' }}
                  title="点击改名；改名后可选择并入其他发言人"
                >
                  {sp}
                </button>
              ),
            )}
            <span style={{ color: '#aaa' }}>（点名字改名，改单句可拆分/合并）</span>
          </div>
        )}

        <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {localSentences.map((s) => {
            const active = s.id === activeId
            return (
              <li
                key={s.id}
                id={`sentence-${s.id}`}
                onClick={() => seek(s)}
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid #f0f0f0',
                  display: 'flex',
                  gap: 10,
                  cursor: 'pointer',
                  background: active ? '#eef4ff' : 'transparent',
                  borderLeft: active ? '3px solid #4285f4' : '3px solid transparent',
                }}
              >
                <span style={{ color: '#999', fontSize: 12, flexShrink: 0, fontVariantNumeric: 'tabular-nums', paddingTop: 2 }}>
                  {fmtMs(s.start_ms)}
                </span>
                {editingId === s.id ? (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingId(null)
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit(s)
                      }}
                      style={{ width: '100%', fontSize: 14, lineHeight: 1.6, minHeight: 58, boxSizing: 'border-box' }}
                    />
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        value={draftSpeaker}
                        onChange={(e) => setDraftSpeaker(e.target.value)}
                        placeholder="发言人（留空=未标注，填新名字即拆分）"
                        list="speaker-options"
                        style={{ fontSize: 12, padding: '2px 6px', width: 190 }}
                      />
                      <datalist id="speaker-options">
                        {speakers.map((sp) => (
                          <option key={sp} value={sp} />
                        ))}
                      </datalist>
                      <button onClick={() => void saveEdit(s)} style={{ fontSize: 12, padding: '3px 12px' }}>
                        保存
                      </button>
                      <button onClick={() => setEditingId(null)} style={{ fontSize: 12, padding: '3px 12px' }}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {s.speaker && (
                      <span style={{ fontSize: 11, color: '#4285f4', background: '#eef4ff', borderRadius: 4, padding: '1px 6px', alignSelf: 'flex-start', flexShrink: 0 }}>
                        {s.speaker}
                      </span>
                    )}
                    <span
                      id={`stext-${s.id}`}
                      onMouseUp={() => void markSelection(s)}
                      style={{ fontSize: 15, lineHeight: 1.6, flex: 1, whiteSpace: 'pre-wrap' }}
                    >
                      {renderText(s)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        startEdit(s)
                      }}
                      style={{ fontSize: 11, padding: '1px 8px', alignSelf: 'flex-start', color: '#666', flexShrink: 0 }}
                    >
                      修改
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      {showHistory && (
        <VersionPanel
          projectId={projectId}
          recordingId={recordingId}
          version={version}
          onError={onError}
        />
      )}
    </div>
  )
}

const STAGE_LABEL: Record<number, string> = { 0: '初始转写', 1: '文字润色', 2: '脱敏' }

function VersionPanel({
  projectId,
  recordingId,
  version,
  onError,
}: {
  projectId: string
  recordingId: string
  version: string
  onError: (msg: string) => void
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([])
  const [selected, setSelected] = useState<VersionDetail | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .listVersions(projectId, recordingId)
      .then((list) => {
        if (!cancelled) setVersions([...list].reverse())
      })
      .catch((e) => onError(`读取版本历史失败：${String(e)}`))
    return () => {
      cancelled = true
    }
  }, [projectId, recordingId, version, onError])

  async function open(v: VersionSummary) {
    if (v.version === selected?.version) {
      setSelected(null)
      return
    }
    try {
      setSelected(await api.fetchVersionDetail(projectId, recordingId, v.version))
    } catch (e) {
      onError(`读取版本失败：${String(e)}`)
    }
  }

  return (
    <aside style={{ width: 280, flexShrink: 0, borderLeft: '1px solid #eee', paddingLeft: 16, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 10px', color: '#333' }}>版本历史</h3>
      <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {versions.map((v) => (
          <li
            key={v.version}
            onClick={() => void open(v)}
            style={{
              padding: '8px 8px',
              borderBottom: '1px solid #f0f0f0',
              cursor: 'pointer',
              background: selected?.version === v.version ? '#f5f8ff' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>v{v.version}</span>
              <span style={{ fontSize: 11, color: '#888' }}>{STAGE_LABEL[v.stage] ?? `阶段 ${v.stage}`}</span>
              {v.version === version && (
                <span style={{ fontSize: 10, color: '#1a73e8', marginLeft: 'auto' }}>当前</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>{v.message || '改动'}</div>
            <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
              {v.author_nick || '本机'} · {fmtTime(v.timestamp)}
            </div>
          </li>
        ))}
      </ul>
      {selected && (
        <div className="scroll-hidden" style={{ borderTop: '1px solid #eee', marginTop: 8, paddingTop: 8, maxHeight: '45%', overflowY: 'auto', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => void saveExport(projectId, recordingId, 'md', selected.version, onError)}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              导出此版 MD
            </button>
            <button
              onClick={() => void saveExport(projectId, recordingId, 'json', selected.version, onError)}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              导出此版 JSON
            </button>
          </div>
          {selected.diff.length === 0 ? (
            <div style={{ fontSize: 12, color: '#999' }}>本版本为初始稿，无文字改动。</div>
          ) : (
            selected.diff.map((d, i) => {
              const before = typeof d.before === 'object' ? d.before : null
              const after = typeof d.after === 'object' ? d.after : null
              return (
                <div key={i} style={{ fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
                  <div style={{ color: '#999', marginBottom: 2 }}>第 {d.index + 1} 句</div>
                  {d.kind === 'redaction' ? (
                    <div style={{ color: '#8a5a00' }}>
                      脱敏（{d.category}）：{String(d.before ?? '')} → {String(d.after ?? '')}
                    </div>
                  ) : (
                    <>
                      {before?.speaker !== after?.speaker && (
                        <div style={{ color: '#8a6d00' }}>
                          发言人：{before?.speaker || '未标注'} → {after?.speaker || '未标注'}
                        </div>
                      )}
                      {before && <div style={{ color: '#b00020', textDecoration: 'line-through' }}>{before.text}</div>}
                      {after && <div style={{ color: '#1e7e34' }}>{after.text}</div>}
                    </>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </aside>
  )
}

async function saveExport(
  projectId: string,
  recordingId: string,
  format: 'md' | 'json',
  version: string | undefined,
  onError: (msg: string) => void,
) {
  try {
    const blob = await api.downloadExport(projectId, recordingId, format, version)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `转写稿-${version || '当前版本'}.${format}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (e) {
    onError(`导出失败：${String(e)}`)
  }
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}