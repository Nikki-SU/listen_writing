import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import BootstrapGuide from './BootstrapGuide'
import UpdateScreen, { type UpdatePhase } from './UpdateScreen'
import { BOOTSTRAP_FILES } from './bootstrapFiles'
import type { Project, Recording, RecordingDetail } from './types'
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
  const [restarting, setRestarting] = useState(false)
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
  }, [projectId, recordingId])

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
        <button
          onClick={() => setGuideOpen(true)}
          style={{ position: 'absolute', right: 24, top: 20, fontSize: 12, padding: '4px 10px', color: '#666' }}
        >
          启动设置
        </button>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: '0.02em' }}>listen_writing</h1>
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
                onClick={() => fileInputRef.current?.click()}
                style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}
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
          <TranscriptPanel detail={detail} />
        ) : (
          <div style={{ color: '#aaa', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
            选择一条录音查看转写结果
          </div>
        )}
      </section>
      </main>
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

function TranscriptPanel({ detail }: { detail: RecordingDetail }) {
  const { transcribe, sentences } = detail

  if (transcribe.status === 'transcribing' || transcribe.status === 'pending') {
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
        转写失败：{transcribe.error}
      </div>
    )
  }

  if (transcribe.status === 'done' && sentences.length === 0) {
    return <div style={{ marginTop: 40, textAlign: 'center', color: '#aaa' }}>未识别到任何句子</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 12px' }}>转写稿（{sentences.length} 句）</h2>
      <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {sentences.map((s) => (
          <li key={s.id} style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', display: 'flex', gap: 12 }}>
            <span style={{ color: '#999', fontSize: 13, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {fmtMs(s.start_ms)}
            </span>
            <span style={{ fontSize: 15, lineHeight: 1.6 }}>{s.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}