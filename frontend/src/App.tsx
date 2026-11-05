import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import BootstrapGuide from './BootstrapGuide'
import type { Project, Recording, RecordingDetail, Version } from './types'
import {
  applyUpdate,
  ensureWritePermission,
  isOutdated,
  loadDirHandle,
  pickDirectory,
  saveDirHandle,
} from './updater'

type UpdateState = 'idle' | 'available' | 'updating' | 'restarting' | 'manual' | 'error'

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
  const [version, setVersion] = useState<Version | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RecordingDetail | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [upd, setUpd] = useState<UpdateState>('idle')
  const [updText, setUpdText] = useState('')
  const [restarting, setRestarting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 启动：检查后端 + 版本 + 项目列表；后端离线时进入引导部署
  const boot = useCallback(async () => {
    const ok = await api.fetchHealth()
    setHealth(ok ? 'ok' : 'down')
    if (!ok) return
    try {
      const v = await api.fetchVersion()
      setVersion(v)
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

  async function onCreateProject(name: string) {
    if (!name.trim()) return
    try {
      const p = await api.createProject(name.trim(), '')
      setProjects((prev) => [p, ...prev])
      setProjectId(p.id)
    } catch (e) {
      setError(String(e))
    }
  }

  async function onUpload(file: File) {
    if (!projectId) return
    setUploading(true)
    setError('')
    try {
      const rec = await api.uploadRecording(projectId, file)
      await refreshRecordings(projectId)
      setRecordingId(rec.id)
    } catch (e) {
      setError(String(e))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function onUpdate() {
    setUpd('updating')
    setUpdText('正在写入本地文件…')
    try {
      let dir = await loadDirHandle()
      if (!dir || !(await ensureWritePermission(dir))) {
        // 没有记住文件夹，或用户这次没给写入权限：让用户重新选一次（仍是点击触发）
        dir = await pickDirectory()
        await saveDirHandle(dir)
      }

      const res = await applyUpdate(dir)
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
  if (health === 'checking') {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14 }}>
        正在连接本地后端…
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {upd !== 'idle' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 24px',
            fontSize: 13,
            borderBottom: '1px solid #eee',
            background:
              upd === 'error' ? '#fdecea' : upd === 'available' ? '#fff8e1' : upd === 'manual' ? '#fff4e5' : '#e8f0fe',
          }}
        >
          <span style={{ flex: 1, lineHeight: 1.6 }}>
            {upd === 'available'
              ? `页面已经更新，但你电脑上的本地后端还是旧版本（fr ${version?.frontend ?? '?'}）。`
              : updText}
            {(upd === 'available' || upd === 'updating' || upd === 'restarting') &&
              ' 只更新程序文件，不会动你的录音数据。'}
          </span>
          {(upd === 'available' || upd === 'error') && (
            <button onClick={onUpdate} style={{ fontSize: 13, padding: '4px 12px', flexShrink: 0 }}>
              更新本地文件
            </button>
          )}
        </div>
      )}

      <main style={{ display: 'flex', flex: 1, minHeight: 0, gap: 24, padding: 24, boxSizing: 'border-box' }}>
      {/* 左栏：项目 + 录音 */}
      <aside style={{ width: 280, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header>
          <h1 style={{ margin: 0, fontSize: 20 }}>listen_writing</h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: '#888' }}>
            后端在线
            {version && ` · fr ${version.frontend} be ${version.backend} mo ${version.model} da ${version.data}`}
          </p>
        </header>

        <ProjectCreator onCreate={onCreateProject} />

        <ProjectList projects={projects} activeId={projectId} onSelect={setProjectId} />

        {projectId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,.mp3,.m4a,.wma,.flac,.ogg,.opus,.aac,.aiff,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac,audio/ogg,audio/aac"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onUpload(f)
              }}
              disabled={uploading}
              style={{ fontSize: 13 }}
            />
            {uploading && <span style={{ fontSize: 12, color: '#888' }}>上传中…</span>}
            <RecordingList recordings={recordings} activeId={recordingId} onSelect={setRecordingId} />
          </div>
        )}
      </aside>

      {/* 右栏：转写详情 */}
      <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
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