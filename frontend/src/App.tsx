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
import { speakerColor, SPEAKER_PALETTE } from './speakerColors'
import { CheckIcon, CrossIcon, EditIcon } from './icons'
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
  borderRadius: 10,
  padding: 14,
  boxShadow: 'none',
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

  // 删除录音：音频、转写、版本、脱敏标记一起删，删前必须二次确认。
  const handleDeleteRecording = useCallback(
    async (id: string) => {
      if (!projectId) return
      const rec = recordings.find((r) => r.id === id)
      if (!window.confirm(`删除录音「${rec?.name || '未命名'}」？音频、转写和所有历史版本都会一起删除，无法恢复。`)) {
        return
      }
      try {
        await api.deleteRecording(projectId, id)
        setRecordings((prev) => prev.filter((r) => r.id !== id))
        if (recordingId === id) {
          setRecordingId(null)
          setDetail(null)
        }
        setError('')
      } catch (e) {
        setError(String(e))
      }
    },
    [projectId, recordings, recordingId],
  )

  // 删除项目：项目下所有录音、音频、转写与历史版本一起删除，删前必须二次确认。
  const handleDeleteProject = useCallback(
    async (id: string) => {
      const p = projects.find((x) => x.id === id)
      if (
        !window.confirm(
          `删除项目「${p?.name || '未命名'}」？项目下所有录音、音频、转写和所有历史版本都会一起删除，无法恢复。`,
        )
      ) {
        return
      }
      try {
        await api.deleteProject(id)
        setProjects((prev) => prev.filter((x) => x.id !== id))
        if (projectId === id) {
          setProjectId(null)
          setRecordings([])
          setRecordingId(null)
          setDetail(null)
        }
        setError('')
      } catch (e) {
        setError(String(e))
      }
    },
    [projects, projectId],
  )

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
          // 转写中每 0.5 秒取一次：后端每 3 句或 2 秒落盘，轮询跟上就能尽快看到新句子。
          timer = setTimeout(poll, 500)
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

      <header
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px 6px',
          flexWrap: 'wrap',
        }}
      >
        <nav
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 3,
            background: '#f2f4f7',
            borderRadius: 8,
            flexShrink: 0,
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
                padding: '5px 14px',
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
        <h1 style={{ margin: 0, fontSize: 18, letterSpacing: '0.02em' }}>访谈录音台</h1>
        <span style={{ fontSize: 12, color: '#8a8f98', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: '#34a853', flexShrink: 0 }} />
          本地后端已连接 · 录音不出本机
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setSettingsOpen(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#666' }}>
            设置
          </button>
          <button onClick={() => setGuideOpen(true)} style={{ fontSize: 12, padding: '4px 10px', color: '#666' }}>
            启动设置
          </button>
        </div>
      </header>

      {view === 'collab' ? (
        <main
          style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
            width: '100%',
            padding: '0 12px 12px',
            gap: 12,
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
          gap: 12,
          width: '100%',
          padding: '0 12px 12px',
          boxSizing: 'border-box',
        }}
      >
      {/* 左栏：项目 + 录音 */}
      <aside
        style={{
          ...cardStyle,
          width: 260,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minHeight: 0,
        }}
      >
        <ProjectCreator onCreate={onCreateProject} />

        <ProjectList
          projects={projects}
          activeId={projectId}
          onSelect={setProjectId}
          onDelete={handleDeleteProject}
        />

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
            <RecordingList recordings={recordings} activeId={recordingId} onSelect={setRecordingId} onDelete={handleDeleteRecording} />
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
  onDelete,
}: {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
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
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 10px',
            cursor: 'pointer',
            borderRadius: 6,
            fontSize: 14,
            background: p.id === activeId ? '#e8f0fe' : 'transparent',
            marginBottom: 4,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.name}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(p.id)
            }}
            title="删除项目（连同其下所有录音与版本）"
            style={{
              fontSize: 11,
              padding: '1px 6px',
              color: '#b00020',
              background: '#fff',
              border: '1px solid #f0c9cc',
              borderRadius: 4,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            删除
          </button>
        </li>
      ))}
    </ul>
  )
}

function RecordingList({
  recordings,
  activeId,
  onSelect,
  onDelete,
}: {
  recordings: Recording[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
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
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
          <span style={{ color: '#999', fontSize: 12, flexShrink: 0 }}>{statusLabel(r.transcribe.status)}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete(r.id)
            }}
            title="删除这条录音"
            style={{
              fontSize: 11,
              padding: '1px 6px',
              border: '1px solid #f0d0d0',
              borderRadius: 4,
              background: '#fff',
              color: '#b00020',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            删除
          </button>
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
  // 发言人花名册：单独登记名字，才能在“原本只有 1 个发言人”时先加人再拆分。
  const [roster, setRoster] = useState<string[]>(detail.speakers ?? [])
  const [newSpeakerOpen, setNewSpeakerOpen] = useState(false)
  const [newSpeakerName, setNewSpeakerName] = useState('')
  // 重新跑说话人聚类（历史录音没有自动分人时也能补上，不需要重新转写）。
  const [detectingSpeakers, setDetectingSpeakers] = useState(false)
  // 多句合并：点句子自行涂色分组（涂色且连续为一组），最后一次性合并所有组（ASR 常按逗号切碎）。
  const [mergeMode, setMergeMode] = useState(false)
  // 间隔上色合并：顶部选择画笔颜色（蓝 / 白 / 橙），点句子涂色；蓝、橙各代表一组，白色不参与合并，同色且连续才成组。
  const [paintColors, setPaintColors] = useState<Record<string, 1 | 2>>({})
  const [paintBrush, setPaintBrush] = useState<0 | 1 | 2>(1)
  const [merging, setMerging] = useState(false)
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
  const [polishStage, setPolishStage] = useState('')
  const [suggestions, setSuggestions] = useState<PolishSuggestion[]>([])
  const [polishModel, setPolishModel] = useState('')
  const [llmReady, setLlmReady] = useState<boolean | null>(null)
  // 模型下载状态：选了档位但还没下载时，点 AI 按钮先起后台下载，而不是让请求挂几分钟。
  const { models: modelState, download: downloadModel } = useModels(1500)
  const [aiNotice, setAiNotice] = useState('')
  // AI 整理断句：先出预览（合并前后句数 + 正文），用户确认后才落盘。
  const [resegmenting, setResegmenting] = useState(false)
  const [resegStage, setResegStage] = useState('')
  const [resegPreview, setResegPreview] = useState<ResegmentResult | null>(null)
  // 预览弹窗是否展开：关掉不等于停止任务，后台继续跑，用户可以去实时录音。
  const [resegOpen, setResegOpen] = useState(false)
  const [resegDone, setResegDone] = useState(false)
  const [editOrigin, setEditOrigin] = useState<'ai_polish' | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  // 本轮已被用户接受/忽略的建议：轮询回来时过滤掉，避免「点了接受又弹回来」。
  const decidedRef = useRef<Set<string>>(new Set())
  // 点句播放的“只播这一句”上限；长按或点整行时清空，改为连播
  const sentenceStopRef = useRef<number | null>(null)
  const playPressTimer = useRef<number | null>(null)
  const playLongPressed = useRef(false)

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
  useEffect(() => {
    setRoster(detail.speakers ?? [])
  }, [detail.speakers])

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
    const stopAt = sentenceStopRef.current
    if (stopAt != null && ms >= stopAt) {
      sentenceStopRef.current = null
      audio.pause()
    }
    const current = localSentences.find((s) => ms >= s.start_ms && ms < s.end_ms)
    if (current && current.id !== activeId) {
      setActiveId(current.id)
      const el = document.getElementById(`sentence-${current.id}`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }

  function seek(s: Sentence, onlyThis = false) {
    setActiveId(s.id)
    const audio = audioRef.current
    if (!audio) return
    sentenceStopRef.current = onlyThis ? s.end_ms : null
    audio.currentTime = s.start_ms / 1000
    void audio.play().catch(() => {
      // 浏览器可能因权限/格式拒绝自动播放，用户可手点播放按钮
    })
  }

  // 句子前的 ▶：点一下只播这一句；长按从这一句开始连播
  function playPressStart(s: Sentence) {
    playLongPressed.current = false
    if (playPressTimer.current != null) window.clearTimeout(playPressTimer.current)
    playPressTimer.current = window.setTimeout(() => {
      playLongPressed.current = true
      seek(s)
    }, 450)
  }

  function playPressEnd(s: Sentence) {
    if (playPressTimer.current != null) {
      window.clearTimeout(playPressTimer.current)
      playPressTimer.current = null
    }
    if (!playLongPressed.current) seek(s, true)
    playLongPressed.current = false
  }

  function playPressCancel() {
    if (playPressTimer.current != null) {
      window.clearTimeout(playPressTimer.current)
      playPressTimer.current = null
    }
    playLongPressed.current = false
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
      if (speaker) setRoster((list) => (list.includes(speaker) ? list : [...list, speaker]))
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
    } else if (llmDownloading) {
      setAiNotice(`AI 模型下载中 ${Math.max(0, llmJob?.progress ?? 0)}%：${llmJob?.message || '准备下载…'}`)
    }
  }, [aiNotice, llmDownloaded, llmDownloading, llmJob?.status, llmJob?.error, llmJob?.message, llmJob?.progress])

  /** 过滤本轮已被接受/忽略的建议：边跑边改时轮询不能把它们塞回来。 */
  function visibleSuggestions(list: PolishSuggestion[]): PolishSuggestion[] {
    return list.filter((s) => !decidedRef.current.has(s.sentence_id))
  }

  async function runPolish() {
    if (polishing) return
    if (!(await ensureLlmReady())) return
    setPolishOpen(true)
    setPolishing(true)
    setSuggestions([])
    decidedRef.current = new Set()
    setPolishStage('正在启动…')
    try {
      let job = await api.polishRecording(projectId, recordingId)
      setPolishModel(job.model)
      // 长录音一批要几十秒：每批回来就刷新列表，用户能看到建议一条条长出来，
      // 而不是整篇跑完才一次性出现（1 小时录音要等 20 分钟以上）。
      while (job.status === 'running') {
        setSuggestions(visibleSuggestions(job.suggestions ?? []))
        setPolishStage(job.message || `已检查 ${job.processed}/${job.total} 句`)
        await new Promise((r) => setTimeout(r, 700))
        job = await api.fetchPolishJob(projectId, recordingId)
      }
      setSuggestions(visibleSuggestions(job.suggestions ?? []))
      if (job.status === 'error') throw new Error(job.error || 'AI 纠错失败')
      if (job.status === 'cancelled') {
        setPolishStage('')
        setAiNotice(`已停止 AI 纠错，保留已完成的 ${job.suggestions?.length ?? 0} 条建议`)
        onError('')
        return
      }
      setPolishStage('')
      setAiNotice('')
      onError('')
    } catch (e) {
      setPolishStage('')
      onError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setPolishing(false)
    }
  }

  async function stopPolish() {
    try {
      await api.cancelPolishJob(projectId!, recordingId!)
    } catch (e) {
      onError(`停止失败：${String(e)}`)
    }
  }

  async function runResegment() {
    if (resegmenting) return
    if (!(await ensureLlmReady())) return
    setResegmenting(true)
    setResegOpen(true)
    setResegDone(false)
    setResegStage('正在启动…')
    setResegPreview({ sentences: [], before: localSentences.length, after: 0 })
    try {
      let job = await api.startResegmentPreview(projectId, recordingId)
      while (job.status === 'running') {
        setResegPreview({
          sentences: job.sentences ?? [],
          before: job.before,
          after: job.after,
          model: job.model,
        })
        setResegStage(job.message || `已整理 ${job.processed}/${job.total} 个片段`)
        await new Promise((r) => setTimeout(r, 700))
        job = await api.fetchResegmentJob(projectId, recordingId)
      }
      if (job.status === 'error') throw new Error(job.error || 'AI 整理断句失败')
      setResegPreview({
        sentences: job.sentences ?? [],
        before: job.before,
        after: job.after,
        model: job.model,
      })
      setResegDone(job.status === 'done')
      setResegStage('')
      if (job.status === 'cancelled') {
        setAiNotice('已停止整理断句，下面是已完成的部分（不能应用，避免丢掉未处理的句子）')
      } else {
        setAiNotice('')
      }
      onError('')
    } catch (e) {
      setResegStage('')
      onError(String(e).replace(/^Error:\s*/, ''))
    } finally {
      setResegmenting(false)
    }
  }

  async function stopResegment() {
    try {
      await api.cancelResegmentJob(projectId!, recordingId!)
    } catch (e) {
      onError(`停止失败：${String(e)}`)
    }
  }

  async function applyResegment() {
    if (!resegPreview || resegmenting || !resegDone) return
    setResegmenting(true)
    try {
      const res = await api.resegmentRecording(projectId, recordingId, true, resegPreview.model)
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
    decidedRef.current.add(item.sentence_id)
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
    setLocalSentences((list) =>
      list.map((x) => (x.id === item.sentence_id ? { ...x, text: item.after } : x)),
    )
    // 先告诉后端这条已处理，避免轮询把它当成新建议重新塞回列表。
    void api
      .dismissPolishSuggestion(projectId, recordingId, item.sentence_id)
      .catch(() => undefined)
    try {
      const res = await api.updateSentence(projectId, recordingId, item.sentence_id, item.after, undefined, {
        advance_to: 1,
        source: 'ai_polish',
      })
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      decidedRef.current.delete(item.sentence_id)
      setLocalSentences(snapshot)
      setSuggestions((list) => [...list, item].sort((a, b) => a.index - b.index))
      onError(`采纳失败：${String(e)}`)
    }
  }

  function dismissSuggestion(item: PolishSuggestion) {
    decidedRef.current.add(item.sentence_id)
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
    void api
      .dismissPolishSuggestion(projectId, recordingId, item.sentence_id)
      .catch(() => undefined)
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
      if (res.speakers) setRoster(res.speakers)
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
      if (res.speakers) setRoster(res.speakers)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      onError(`合并失败：${String(e)}`)
    }
  }

  async function addSpeaker() {
    const name = newSpeakerName.trim()
    if (!name) return
    try {
      const res = await api.updateSpeakers(projectId, recordingId, { action: 'create', name })
      if (res.speakers) setRoster(res.speakers)
      setNewSpeakerOpen(false)
      setNewSpeakerName('')
      onError('')
    } catch (e) {
      onError(`新增发言人失败：${String(e)}`)
    }
  }

  async function detectSpeakersNow() {
    if (detectingSpeakers) return
    const hasLabels = speakers.some((sp) => localSentences.some((s) => s.speaker === sp))
    if (hasLabels && !window.confirm('重新识别会覆盖当前发言人标注，并生成一个新版本。继续？')) return
    setDetectingSpeakers(true)
    try {
      const res = await api.detectSpeakers(projectId, recordingId)
      setLocalSentences(res.sentences)
      setRoster(res.speakers)
      if (res.current) setVersion(res.current)
      if (res.detected <= 1) {
        onError('这次只识别出 1 位发言人：如果是单一说话人，这是正确结果；男女对话请确认音频里两人可听见。')
      } else {
        onError('')
      }
    } catch (e) {
      onError(`识别发言人失败：${String(e).replace(/^Error:\s*/, '')}`)
    } finally {
      setDetectingSpeakers(false)
    }
  }

  function paintWithBrush(id: string) {
    setPaintColors((marks) => {
      const next = { ...marks }
      if (paintBrush === 0) delete next[id]
      else next[id] = paintBrush
      return next
    })
  }

  const paintCount = Object.keys(paintColors).length

  // 只有「同色且连续」的句子才构成一组；白色的句子原地保留，不参与合并。
  const mergeGroups: string[][] = []
  localSentences.forEach((s, i) => {
    const color = paintColors[s.id]
    if (!color) return
    const prev = localSentences[i - 1]
    if (prev && paintColors[prev.id] === color) mergeGroups[mergeGroups.length - 1].push(s.id)
    else mergeGroups.push([s.id])
  })
  const mergeableGroups = mergeGroups.filter((g) => g.length > 1)
  const mergeReducible = mergeableGroups.reduce((n, g) => n + g.length - 1, 0)

  // 右侧改为对照/合并栏：同一时间只显示一种评审模式，避免三个面板抢位置。
  const reviewMode: 'polish' | 'merge' | 'resegment' | null =
    resegOpen && (resegmenting || resegPreview)
      ? 'resegment'
      : polishOpen && (polishing || suggestions.length > 0)
        ? 'polish'
        : mergeMode
          ? 'merge'
          : null

  // 纠错右侧按句 id 对齐：AI 建议必须落在它对应的那一句右边。
  const suggestionBySentence = new Map(suggestions.map((s) => [s.sentence_id, s]))

  async function mergeAllGroups() {
    if (paintCount === 0) return
    const groups = mergeableGroups
    if (groups.length === 0 || merging) return
    setMerging(true)
    try {
      const res = await api.mergeSentences(projectId, recordingId, groups)
      setLocalSentences(res.sentences)
      setMarks(res.redactions ?? [])
      if (res.current) setVersion(res.current)
      setPaintColors({})
      setMergeMode(false)
      onError('')
    } catch (e) {
      onError(`合并失败：${String(e)}`)
    } finally {
      setMerging(false)
    }
  }

  const speakers = [
    ...new Set([...roster, ...localSentences.map((s) => s.speaker).filter(Boolean)]),
  ] as string[]
  // 配色按句子里的出场顺序：与正文里看到的顺序一致，改名单也不会换色。
  const speakerOrder = [
    ...new Set([...localSentences.map((s) => s.speaker).filter(Boolean), ...roster]),
  ] as string[]

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
            onClick={() => {
              if (polishing || suggestions.length > 0) setPolishOpen(true)
              else void runPolish()
            }}
            disabled={llmReady === false || llmDownloading || transcribe.status !== 'done'}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              marginLeft: 'auto',
              background: polishOpen ? '#eef5ff' : '#fff',
              border: `1px solid ${polishOpen ? '#8ab4f8' : '#ddd'}`,
              color: llmReady === false ? '#999' : '#245c9c',
              borderRadius: 4,
              cursor: llmReady === false || llmDownloading ? 'not-allowed' : 'pointer',
            }}
            title={
              llmReady === false
                ? '本机未安装 AI 运行时（llama-cpp-python），请重新运行启动器安装'
                : llmDownloaded === false
                  ? '模型还没下载：点击会先在后台下载，完成后就能用'
                  : '用本地大模型纠错：只给建议，逐句采纳后才改正文；首次使用需下载模型'
            }
          >
            {polishing ? `AI 分析中 ${suggestions.length} 条…` : llmDownloading ? '模型下载中…' : 'AI 纠错'}
          </button>
          <button
            onClick={() => (resegmenting || resegDone ? setResegOpen(true) : void runResegment())}
            disabled={llmReady === false || llmDownloading || transcribe.status !== 'done'}
            style={{
              fontSize: 12,
              padding: '4px 10px',
              background: '#fff',
              border: '1px solid #ddd',
              color: llmReady === false ? '#999' : '#245c9c',
              borderRadius: 4,
              cursor:
                llmReady === false || llmDownloading || transcribe.status !== 'done'
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

        {((polishing && !polishOpen) ||
          (resegPreview && !resegOpen && (resegmenting || resegDone))) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 8,
              padding: '6px 10px',
              border: '1px solid #d6e4f7',
              background: '#f2f7ff',
              borderRadius: 6,
              fontSize: 12,
              color: '#245c9c',
            }}
          >
            <span style={{ flex: 1 }}>
              {polishing
                ? `AI 纠错在后台运行：${polishStage || '处理中…'}`
                : resegmenting
                  ? `AI 整理断句在后台运行：${resegStage || '处理中…'}`
                  : `AI 整理断句已完成：${resegPreview?.before ?? 0} 句 → ${resegPreview?.after ?? 0} 句`}
            </span>
            <button
              onClick={() => (polishing ? setPolishOpen(true) : setResegOpen(true))}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              {polishing ? '查看建议' : resegDone ? '查看结果' : '查看进度'}
            </button>
            {polishing ? (
              <button
                onClick={() => void stopPolish()}
                style={{ fontSize: 11, padding: '2px 8px', color: '#b00020' }}
              >
                停止
              </button>
            ) : resegmenting ? (
              <button
                onClick={() => void stopResegment()}
                style={{ fontSize: 11, padding: '2px 8px', color: '#b00020' }}
              >
                停止
              </button>
            ) : null}
          </div>
        )}

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
            正在转写 {transcribe.progress}% · 已出 {localSentences.length} 句
            {transcribe.message ? ` · ${transcribe.message}` : ''}。现在就能先改，后面的句子会继续追加，不会覆盖你的修改。
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

        {localSentences.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: '#888' }}>发言人：</span>
            {speakers.length === 0 && <span style={{ color: '#aaa' }}>尚未设置</span>}
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
                  style={{
                    fontSize: 12,
                    padding: '2px 10px',
                    borderRadius: 12,
                    background: speakerColor(sp, speakerOrder).bg,
                    color: speakerColor(sp, speakerOrder).fg,
                    border: `1px solid ${speakerColor(sp, speakerOrder).border}`,
                  }}
                  title="点击改名；改名后可选择并入其他发言人"
                >
                  {sp}
                </button>
              ),
            )}
            {newSpeakerOpen ? (
              <span style={{ display: 'flex', gap: 4, alignItems: 'center', background: '#f5f8ff', padding: '2px 6px', borderRadius: 4 }}>
                <input
                  autoFocus
                  value={newSpeakerName}
                  onChange={(e) => setNewSpeakerName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setNewSpeakerOpen(false)
                      setNewSpeakerName('')
                    }
                    if (e.key === 'Enter') void addSpeaker()
                  }}
                  placeholder="如：受访者"
                  style={{ fontSize: 12, width: 100, padding: '1px 4px' }}
                />
                <button onClick={() => void addSpeaker()} style={{ fontSize: 11, padding: '1px 6px' }}>
                  添加
                </button>
                <button
                  onClick={() => {
                    setNewSpeakerOpen(false)
                    setNewSpeakerName('')
                  }}
                  style={{ fontSize: 11, padding: '1px 6px' }}
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                onClick={() => setNewSpeakerOpen(true)}
                disabled={transcribe.status !== 'done'}
                style={{ fontSize: 12, padding: '2px 10px', borderRadius: 12, background: '#fff', color: '#1a73e8', border: '1px dashed #9dbcf5', cursor: 'pointer' }}
              >
                + 新增发言人
              </button>
            )}
            <button
              onClick={() => void detectSpeakersNow()}
              disabled={transcribe.status !== 'done' || detectingSpeakers || localSentences.length < 3}
              title="按音色重新分一次说话人（历史录音也能补上，不需要重新转写）；会覆盖当前标注并生成新版本"
              style={{
                fontSize: 12,
                padding: '2px 10px',
                borderRadius: 12,
                background: '#fff',
                color: '#0f766e',
                border: '1px dashed #9bd8cf',
                cursor: transcribe.status !== 'done' || detectingSpeakers ? 'not-allowed' : 'pointer',
              }}
            >
              {detectingSpeakers ? '识别中…' : speakers.length > 0 ? '重新识别发言人' : '自动识别发言人'}
            </button>
            <span style={{ color: '#aaa' }}>（点名字改名；先加人，再逐句指派）</span>
            <button
              onClick={() => {
                setMergeMode((v) => !v)
                setPaintColors({})
                setEditingId(null)
              }}
              disabled={transcribe.status !== 'done' || localSentences.length < 2}
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                padding: '3px 12px',
                borderRadius: 6,
                border: '1px solid ' + (mergeMode ? '#1a73e8' : '#d6e4ff'),
                background: mergeMode ? '#1a73e8' : '#fff',
                color: mergeMode ? '#fff' : '#1a73e8',
                cursor: 'pointer',
              }}
            >
              {mergeMode ? '退出合并' : '多句合并'}
            </button>
          </div>
        )}

        {mergeMode && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: '6px 10px', background: '#f5f8ff', border: '1px solid #d6e4ff', borderRadius: 6, fontSize: 12, flexWrap: 'wrap' }}>
            <span style={{ color: '#666', fontSize: 11 }}>画笔</span>
            {([
              { value: 1, label: '蓝', bg: '#1a73e8', fg: '#fff' },
              { value: 0, label: '白', bg: '#fff', fg: '#666' },
              { value: 2, label: '橙', bg: '#f59e0b', fg: '#fff' },
            ] as const).map((o) => (
              <button
                key={o.label}
                onClick={() => setPaintBrush(o.value)}
                title={o.value === 0 ? '白色：不参与合并' : `${o.label}色：合并为一组`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 12,
                  border: '1px solid #ddd',
                  background: '#fff',
                  color: '#333',
                  cursor: 'pointer',
                  boxShadow: paintBrush === o.value ? '0 0 0 2px #1a73e8' : 'none',
                  fontWeight: paintBrush === o.value ? 600 : 400,
                }}
              >
                <span style={{ width: 12, height: 12, borderRadius: 3, background: o.bg, border: o.value === 0 ? '1px solid #ccc' : 'none', color: o.fg }} />
                {o.label}
              </button>
            ))}
            <span style={{ color: '#1a73e8', fontWeight: 600, marginLeft: 6 }}>
              {paintCount === 0 ? '尚未分组' : `${paintCount} 句已涂 · ${mergeableGroups.length} 组 · 可减少 ${mergeReducible} 句`}
            </span>
            <span style={{ color: '#888', fontSize: 11 }}>点句子涂当前画笔颜色；蓝、橙各成一组，白色不合并</span>
            <button
              onClick={() => setPaintColors({})}
              disabled={paintCount === 0}
              style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 10px' }}
            >
              清除涂色
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        {reviewMode === 'polish' ? (
          <div className="scroll-hidden" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', border: '1px solid #eef1f5', borderRadius: 8 }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', background: '#f8fbff', borderBottom: '1px solid #e6ecf5', padding: '6px 10px', fontSize: 11, color: '#6b7280' }}>
              <div>原文（{localSentences.length} 句）</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, color: '#245c9c' }}>
                  AI 修改{polishing ? ` · ${polishStage || '处理中…'}` : ` · ${suggestions.length} 条`}
                </span>
                {polishing && (
                  <button onClick={() => void stopPolish()} title="停止纠错" style={{ fontSize: 11, padding: '1px 8px', color: '#b00020' }}>停止</button>
                )}
                <button onClick={() => setPolishOpen(false)} title="关闭纠错对照" style={{ fontSize: 11, padding: '1px 8px' }}>关闭</button>
              </div>
            </div>
            {localSentences.map((s) => {
              const sug = suggestionBySentence.get(s.id)
              const tone = s.speaker ? speakerColor(s.speaker, speakerOrder) : null
              return (
                <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #f2f4f7', background: sug ? '#f7fdf9' : '#fff' }}>
                  <div onClick={() => seek(s)} style={{ padding: '7px 10px', borderRight: '1px solid #f2f4f7', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                      <span style={{ fontSize: 11, color: '#9aa0a6' }}>{s.index + 1}</span>
                      {tone && (
                        <span style={{ fontSize: 11, color: tone.fg, background: tone.bg, borderRadius: 4, padding: '0 5px' }}>{s.speaker}</span>
                      )}
                      <span style={{ fontSize: 10, color: '#b0b6c0' }}>▶</span>
                    </div>
                    <div style={{ fontSize: 14, lineHeight: 1.7 }}>{renderText(s)}</div>
                  </div>
                  <div style={{ padding: '7px 10px' }}>
                    {sug ? (
                      <>
                        <div style={{ fontSize: 14, color: '#1e7e34', lineHeight: 1.7 }}>{sug.after}</div>
                        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                          <button
                            onClick={() => void acceptSuggestion(sug)}
                            title="正确（采纳建议）"
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, border: '1px solid #b7dfc2', color: '#1e7e34', background: '#fff', borderRadius: 4, cursor: 'pointer' }}
                          >
                            <CheckIcon />
                          </button>
                          <button
                            onClick={() => dismissSuggestion(sug)}
                            title="错误（保留原文）"
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, border: '1px solid #f0c9cc', color: '#b00020', background: '#fff', borderRadius: 4, cursor: 'pointer' }}
                          >
                            <CrossIcon />
                          </button>
                          <button
                            onClick={() => startEdit(s, sug.after, 'ai_polish')}
                            title="自己改"
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, color: '#5b6472', background: '#fff', border: '1px solid #dde3ea', borderRadius: 4, cursor: 'pointer' }}
                          >
                            <EditIcon />
                          </button>
                        </div>
                      </>
                    ) : (
                      <span style={{ fontSize: 11, color: '#c6ccd5' }}>{polishing ? '' : '—'}</span>
                    )}
                  </div>
                </div>
              )
            })}
            {suggestions.length === 0 && !polishing && (
              <div style={{ padding: 20, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>未发现需要修改的句子。</div>
            )}
          </div>
        ) : (
          <>
        <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minWidth: 0, minHeight: 0 }}>
          {localSentences.map((s) => {
            const active = s.id === activeId
            const color = mergeMode ? paintColors[s.id] : undefined
            return (
              <li
                key={s.id}
                id={`sentence-${s.id}`}
                onClick={() => {
                  if (mergeMode) {
                    paintWithBrush(s.id)
                    return
                  }
                  seek(s)
                }}
                style={{
                  padding: '8px 10px',
                  borderBottom: '1px solid #f0f0f0',
                  display: 'flex',
                  gap: 10,
                  cursor: 'pointer',
                  background: mergeMode
                    ? color === 1 ? '#eef4ff' : color === 2 ? '#fff4e6' : '#fff'
                    : active ? '#eef4ff' : 'transparent',
                  borderLeft: mergeMode
                    ? `3px solid ${color === 1 ? '#1a73e8' : color === 2 ? '#f59e0b' : 'transparent'}`
                    : active ? '3px solid #4285f4' : '3px solid transparent',
                }}
              >
                <button
                  type="button"
                  title="点一下只播这一句；长按从这一句开始连播"
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    playPressStart(s)
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation()
                    playPressEnd(s)
                  }}
                  onPointerLeave={playPressCancel}
                  onPointerCancel={playPressCancel}
                  onContextMenu={(e) => e.preventDefault()}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    flexShrink: 0,
                    fontSize: 12,
                    lineHeight: 1.2,
                    padding: '3px 8px',
                    alignSelf: 'flex-start',
                    color: '#1d4ed8',
                    background: '#eef4ff',
                    border: 'none',
                    borderRadius: 8,
                    cursor: 'pointer',
                    touchAction: 'manipulation',
                    userSelect: 'none',
                  }}
                >
                  ▶
                </button>
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
                      <select
                        value={draftSpeaker}
                        onChange={(e) => setDraftSpeaker(e.target.value)}
                        style={{ fontSize: 12, padding: '2px 6px', width: 190 }}
                      >
                        <option value="">未标注</option>
                        {speakers.map((sp) => (
                          <option key={sp} value={sp}>
                            {sp}
                          </option>
                        ))}
                        {draftSpeaker && !speakers.includes(draftSpeaker) && (
                          <option value={draftSpeaker}>{draftSpeaker}</option>
                        )}
                      </select>
                      <span style={{ fontSize: 11, color: '#aaa' }}>没有想要的？先在顶部「+ 新增发言人」</span>
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
                      <span
                        style={{
                          fontSize: 11,
                          color: speakerColor(s.speaker, speakerOrder).fg,
                          background: speakerColor(s.speaker, speakerOrder).bg,
                          border: `1px solid ${speakerColor(s.speaker, speakerOrder).border}`,
                          borderRadius: 4,
                          padding: '1px 6px',
                          alignSelf: 'flex-start',
                          flexShrink: 0,
                        }}
                      >
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
                    {!mergeMode && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(s)
                        }}
                        title="修改这一句"
                        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 22, alignSelf: 'flex-start', color: '#666', flexShrink: 0, padding: 0 }}
                      >
                        <EditIcon />
                      </button>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>

        {reviewMode === 'merge' && (
          <aside style={{ flex: '1 1 0', minWidth: 240, borderLeft: '1px solid #eee', paddingLeft: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>合并预览（{mergeableGroups.length} 组）</h3>
            <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>
              左边涂色 → 这里显示每组框住的句子和合并后的内容；点「合并全部」才写入新版本。
            </div>
            <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {mergeableGroups.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 20 }}>
                  还没有分组：在左边用蓝 / 橙画笔点选连续句子（白色表示不合并）。
                </div>
              ) : (
                mergeableGroups.map((ids, gi) => {
                  const items = ids
                    .map((id) => localSentences.find((x) => x.id === id))
                    .filter((x): x is Sentence => Boolean(x))
                  const chars = items.reduce((n, x) => n + x.text.length, 0)
                  const tone = SPEAKER_PALETTE[gi % SPEAKER_PALETTE.length]
                  return (
                    <div key={gi} style={{ border: `1px solid ${tone.border}`, background: tone.bg, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                      <div style={{ fontSize: 11, color: tone.fg, marginBottom: 6 }}>
                        第 {(items[0]?.index ?? 0) + 1}–{(items[items.length - 1]?.index ?? 0) + 1} 句 · {items.length} 句合一
                      </div>
                      <div style={{ fontSize: 13, color: '#1e7e34', lineHeight: 1.75 }}>
                        {items
                          .map((x) => x.text.trim().replace(/[，。；：、,.!?;:…]+$/, ''))
                          .join('，')}
                        。
                      </div>
                      <div style={{ marginTop: 6, fontSize: 11, color: '#8a8f98' }}>约 {chars} 字</div>
                    </div>
                  )
                })
              )}
            </div>
            <button
              onClick={() => void mergeAllGroups()}
              disabled={mergeReducible === 0 || merging}
              style={{ marginTop: 8, fontSize: 12, padding: '6px 12px' }}
            >
              {merging ? '合并中…' : `合并全部（可减少 ${mergeReducible} 句）`}
            </button>
          </aside>
        )}

        {reviewMode === 'resegment' && resegPreview && (
          <aside style={{ flex: '1 1 0', minWidth: 240, borderLeft: '1px solid #eee', paddingLeft: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 6px', flex: 1 }}>AI 整理断句预览</h3>
              <span style={{ fontSize: 11, color: resegPreview.after < resegPreview.before ? '#1e7e34' : '#7a869a' }}>
                {resegPreview.before} 句 → {resegPreview.after} 句
              </span>
            </div>
            <div style={{ fontSize: 11, color: '#8a8f98', lineHeight: 1.7, marginBottom: 8 }}>
              左边几个停顿碎片合并成一句；只动断句与标点，不增删内容。
              {resegStage ? ` ${resegStage}` : ''}
            </div>
            {!resegmenting && !resegDone && (
              <div style={{ fontSize: 11, color: '#b26b00', marginBottom: 8 }}>
                任务已停止，下面是已完成的部分；未处理的句子没有出现，不能直接应用。
              </div>
            )}
            <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {resegPreview.sentences.map((s, idx) => {
                const srcIds = s.source_ids ?? [s.id]
                const sources = srcIds
                  .map((id) => localSentences.find((x) => x.id === id))
                  .filter((x): x is Sentence => Boolean(x))
                const merged = srcIds.length > 1
                const tone = SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length]
                return (
                  <div key={s.id} style={{ border: `1px solid ${merged ? tone.border : '#e6ecf5'}`, borderRadius: 8, padding: 8, marginBottom: 8, background: merged ? tone.bg : '#fff' }}>
                    {merged && (
                      <div style={{ fontSize: 11, color: '#8a94a6', marginBottom: 4 }}>
                        由左边 {sources.length} 个碎片合并
                      </div>
                    )}
                    <div style={{ fontSize: merged ? 13 : 12, color: merged ? '#1e7e34' : '#5b6472', lineHeight: 1.75 }}>
                      {s.text}
                    </div>
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {resegmenting ? (
                <>
                  <button onClick={() => setResegOpen(false)} style={{ fontSize: 12, padding: '6px 12px' }}>转到后台</button>
                  <button onClick={() => void stopResegment()} style={{ fontSize: 12, padding: '6px 12px', color: '#b00020' }}>停止</button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setResegOpen(false)
                      setResegPreview(null)
                      setResegDone(false)
                    }}
                    style={{ fontSize: 12, padding: '6px 12px' }}
                  >
                    关闭
                  </button>
                  <button
                    onClick={() => void applyResegment()}
                    disabled={!resegDone}
                    style={{ fontSize: 12, padding: '6px 12px', background: resegDone ? '#245c9c' : '#e3e8ef', color: resegDone ? '#fff' : '#9aa0a6', border: 'none', borderRadius: 4, flex: 1 }}
                  >
                    应用并生成新版本
                  </button>
                </>
              )}
            </div>
          </aside>
        )}
          </>
        )}
        </div>
      </div>

      {showHistory && !reviewMode && (
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