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
import { BOOTSTRAP_FILES, BUNDLE_VERSION } from './bootstrapFiles'
import { speakerColor, SPEAKER_PALETTE } from './speakerColors'
import CodingPanel from './coding/CodingPanel'
import AnalysisPanel from './coding/AnalysisPanel'
import { CodingContext, useCodingSession, useOptionalCoding } from './coding/CodingContext'
import { TranscriptAudio, TranscriptList } from './TranscriptBody'
import { useSentencePlayer } from './useSentencePlayer'
import SentenceLine from './SentenceLine'
import './coding/coding.css'
import {
  ICON_BTN,
  CheckIcon,
  CloseIcon,
  CrossIcon,
  EditIcon,
  GearIcon,
  HistoryIcon,
  MicIcon,
  PlayIcon,
  PlusIcon,
  ShareIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
} from './icons'
import type {
  CollabGroupSummary,
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
  backendOutdated,
  ensureWritePermission,
  loadDirHandle,
  markBundleApplied,
  pickDirectory,
  saveDirHandle,
} from './updater'

type UpdateState = 'idle' | UpdatePhase

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

/** 状态只用颜色说话：黄=待转写 / 蓝=转写中 / 红=失败 / 绿=完成。文字只在 hover 的 title 里。 */
function statusColor(status: string): string {
  switch (status) {
    case 'pending': return '#e8a317'
    case 'transcribing': return '#245c9c'
    case 'done': return '#34a853'
    case 'error': return '#d93025'
    default: return '#c4c7c9'
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
  const [notice, setNotice] = useState('')
  const [upd, setUpd] = useState<UpdateState>('idle')
  const [updText, setUpdText] = useState('')
  const [updProgress, setUpdProgress] = useState<{ done: number; total: number }>()
  const [updDismissed, setUpdDismissed] = useState(false)
  // 仅前端更新：只提示刷新页面，不写本地文件、不重启后端（用户明确要求）。
  const [needRefresh, setNeedRefresh] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  // 共享任务不是弹层里的“小入口”：它和「我的录音」并列，是同一层级的常驻工作区。
  const [view, setView] = useState<'workspace' | 'collab'>('workspace')
  // 共享任务顶栏的协作/审批切换（与工作空间、模式同在顶栏）
  const [collabView, setCollabView] = useState<'collab' | 'approve'>('collab')
  // 选中录音后的四个工作状态：转写 / 编码 / 分析 / 对比。
  // 编码、分析、对比读取同一条录音的音频与转写稿，不复制正文。
  const [workspaceMode, setWorkspaceMode] = useState<'transcript' | 'coding' | 'analysis' | 'compare'>('transcript')
  // 项目区：true=列出所有项目（选项目用）；false=折叠到当前项目，直接显示其材料。
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  // 左栏“条目”区：展开列全部条目，折叠只留当前条目。与项目区各自独立。
  const [entriesExpanded, setEntriesExpanded] = useState(true)
  // 左栏材料的“分享”：把一条录音加入某个协作组（复用已有的 addGroupMaterial）。
  const [shareTarget, setShareTarget] = useState<Recording | null>(null)
  const [shareGroups, setShareGroups] = useState<CollabGroupSummary[]>([])
  const [shareBusy, setShareBusy] = useState(false)
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
      // 后端代码落后才需要写本地文件 + 可能重启（需用户点击授权写）。
      // 纯前端更新走下面的 version.json 探测，只提示刷新，不碰后端。
      const backendBehind = backendOutdated(v)
      setUpd((prev) => (backendBehind ? (prev === 'idle' ? 'available' : prev) : 'idle'))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  // 前端更新探测：no-store 拉取随每次部署生成的 version.json，和本页面编译时的版本比。
  // 线上前端版本更高 = 已部署新版但用户还开着旧页面 → 提示刷新（与后端版本无关）。
  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const v = (await res.json()) as { frontend?: number }
        if (alive && typeof v.frontend === 'number' && v.frontend > BUNDLE_VERSION.frontend) {
          setNeedRefresh(true)
        }
      } catch {
        // 探测失败就安静跳过，不打扰用户
      }
    }
    void check()
    const timer = setInterval(() => void check(), 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

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

  // 任务/录音改名：只改显示名，不动音频、转写和版本。
  const handleRenameRecording = useCallback(
    async (id: string, name: string) => {
      if (!projectId) return
      const trimmed = name.trim()
      if (!trimmed) return
      const snapshot = recordings
      setRecordings((prev) => prev.map((r) => (r.id === id ? { ...r, name: trimmed } : r)))
      setDetail((prev) =>
        prev && prev.recording.id === id
          ? { ...prev, recording: { ...prev.recording, name: trimmed } }
          : prev,
      )
      try {
        const updated = await api.renameRecording(projectId, id, trimmed)
        setRecordings((prev) => prev.map((r) => (r.id === id ? updated : r)))
        setDetail((prev) =>
          prev && prev.recording.id === id ? { ...prev, recording: updated } : prev,
        )
        setError('')
      } catch (e) {
        setRecordings(snapshot)
        setError(`改名失败：${String(e)}`)
      }
    },
    [projectId, recordings],
  )

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
          setEntriesExpanded(true)
        }
        setError('')
      } catch (e) {
        setError(String(e))
      }
    },
    [projectId, recordings, recordingId],
  )

  // 分享条目：点材料行的分享图标 → 拉取我所在的协作组 → 选一个把这条录音加入。
  async function openShare(r: Recording) {
    setShareTarget(r)
    setShareGroups([])
    setError('')
    try {
      const data = await api.listGroups()
      setShareGroups(data.groups)
    } catch (e) {
      setError(`读取协作组失败：${String(e)}`)
    }
  }

  async function doShare(groupId: string) {
    if (!shareTarget || !projectId || shareBusy) return
    setShareBusy(true)
    setError('')
    try {
      await api.addGroupMaterial(groupId, projectId, shareTarget.id)
      const g = shareGroups.find((x) => x.id === groupId)
      setNotice(`已把「${shareTarget.name}」分享到协作组「${g?.name || groupId}」。`)
      setShareTarget(null)
    } catch (e) {
      setError(`分享失败：${String(e)}`)
    } finally {
      setShareBusy(false)
    }
  }

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
          setProjectsExpanded(true)
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
      setEntriesExpanded(true)
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
      setProjectsExpanded(false)
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

      // 只有后端代码真的落后才重启本地进程：纯页面更新、只改了启动脚本/说明时
      // 不重启，避免每次发版都打断正在录音/转写的用户。
      let needRestart = true
      try {
        needRestart = backendOutdated(await api.fetchVersion())
      } catch {
        // 版本接口都取不到，说明本地后端很旧：按需要重启处理。
        needRestart = true
      }

      if (!needRestart) {
        // 只写了页面/说明/版本常量，本进程不用重启；记下已应用版本，
        // 避免前端段暂时还是旧值时每次启动都重复弹提示。
        markBundleApplied()
        if (res.launcherStale.length) {
          setUpd('manual')
          setUpdText(`已更新 ${res.changed} 个文件，后端无需重启。${launcherNote}`)
        } else {
          // 本次只是页面/说明文件更新：不弹阻塞提示，直接回到界面。
          setUpd('idle')
          setUpdText('')
        }
        return
      }

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
        markBundleApplied()
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

      {/* 仅前端更新：不写本地文件、不重启后端，只提示刷新页面 */}
      {needRefresh && upd === 'idle' && (
        <div className="refresh-hint" role="status">
          <span>界面已更新，刷新后生效。本地程序无需重启。</span>
          <button type="button" onClick={() => window.location.reload()}>刷新</button>
          <button type="button" className="refresh-hint-close" onClick={() => setNeedRefresh(false)} title="稍后再说" aria-label="关闭">×</button>
        </div>
      )}

      {/* 分享条目到协作组：点材料行的分享图标调出 */}
      {shareTarget && (
        <div className="share-overlay" onClick={() => setShareTarget(null)}>
          <div className="share-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="分享到协作组">
            <div className="share-title">
              <span>分享「{shareTarget.name}」</span>
              <button onClick={() => setShareTarget(null)} title="关闭" aria-label="关闭">×</button>
            </div>
            <p className="share-sub">选择要加入的协作组；分享后对方可在该组材料里看到这条录音。</p>
            <div className="share-list">
              {shareGroups.length === 0 && <div className="share-empty">你还没有加入任何协作组，请先到「共享任务」创建或加入一个组。</div>}
              {shareGroups.map((g) => (
                <button key={g.id} className="share-group" disabled={shareBusy} onClick={() => void doShare(g.id)}>
                  <span>{g.name}</span>
                  <span className="share-go">加入 →</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <header className="app-header">
        {/* 左：软件标志 + 标题（身份区，固定） */}
        <div className="app-brand">
          <span className="app-mark" aria-hidden="true"><MicIcon size={16} /></span>
          <span className="app-title">访谈工作台</span>
        </div>

        {/* 连接状态：绿=已连接，红=未连接；细节只在 hover 的 title 里 */}
        <span
          className={`app-health ${health === 'ok' ? 'up' : 'down'}`}
          title={health === 'ok' ? '本地后端已连接 · 录音不出本机' : '本地后端未连接'}
          aria-label={health === 'ok' ? '已连接' : '未连接'}
        />

        {/* 中：工作空间（我的录音 / 共享任务） */}
        <nav className="seg-nav" aria-label="工作空间">
          {(
            [
              ['workspace', '我的录音'],
              ['collab', '共享任务'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={view === key ? 'on' : ''}
              disabled={health !== 'ok'}
              onClick={() => {
                setView(key)
                // 对比只在协作视图存在；切回个人视图时退回转写，避免模式条没有任何高亮项。
                if (key === 'workspace' && workspaceMode === 'compare') setWorkspaceMode('transcript')
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* 共享任务视图：协作 / 审批切换（顶栏，与个人页同构） */}
        {view === 'collab' && (
          <nav className="seg-nav" aria-label="协作审批">
            {([['collab', '协作'], ['approve', '审批']] as const).map(([key, label]) => (
              <button
                key={key}
                className={collabView === key ? 'on' : ''}
                disabled={health !== 'ok'}
                onClick={() => setCollabView(key)}
              >
                {label}
              </button>
            ))}
          </nav>
        )}

        {/* 右：当前模式（转写/编码/分析[/对比]），常驻，不随是否选中录音而出现/消失。
            个人视图 3 档无对比；协作视图 4 档含对比。两套共用同一个 workspaceMode。 */}
        <nav className="seg-nav mode-nav" aria-label="工作模式">
          {(
            (
              view === 'collab'
                ? [['transcript', '转写'], ['coding', '编码'], ['analysis', '分析'], ['compare', '对比']]
                : [['transcript', '转写'], ['coding', '编码'], ['analysis', '分析']]
            ) as [typeof workspaceMode, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={workspaceMode === key ? 'on' : ''}
              disabled={health !== 'ok'}
              onClick={() => setWorkspaceMode(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="app-tools">
          <button onClick={() => setSettingsOpen(true)} title="设置" aria-label="设置" style={{ ...ICON_BTN, height: 28 }}>
            <GearIcon />
          </button>
          <button onClick={() => setGuideOpen(true)} title="启动设置" style={{ ...ICON_BTN, height: 28, width: 'auto', padding: '0 8px' }}>
            启动
          </button>
        </div>
      </header>

      {health === 'down' && !restarting ? (
        <BootstrapGuide onRetry={() => void boot()} />
      ) : view === 'collab' ? (
        <div style={{ flex: 1, minHeight: 0, padding: '0 12px 12px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }}>
          <main className="workspace-grid">
            <CollabPanel projects={projects} embedded gridMode mainView={collabView} workspaceMode={workspaceMode} onClose={() => setView('workspace')} />
          </main>
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            padding: '0 12px 12px',
            boxSizing: 'border-box',
          }}
        >
          {error && <div className="workspace-error">{error}</div>}
          {notice && <div className="workspace-notice" onClick={() => setNotice('')}>{notice}</div>}
          <main className="workspace-grid">
            {/* 第 1 列：项目区两态——展开列全部项目选项目；折叠只显当前项目+其材料 */}
            <aside className="workspace-card task-rail scroll-hidden">
              <ProjectCreator onCreate={onCreateProject} />
              <ProjectList
                projects={projects}
                activeId={projectId}
                onSelect={setProjectId}
                onDelete={handleDeleteProject}
                expanded={projectsExpanded}
                onToggleExpand={() => setProjectsExpanded((v) => !v)}
                entriesExpanded={entriesExpanded}
                onToggleEntriesExpand={() => setEntriesExpanded((v) => !v)}
                recordings={recordings}
                activeRecordingId={recordingId}
                onSelectRecording={setRecordingId}
                onDeleteRecording={handleDeleteRecording}
                onRenameRecording={(id, name) => void handleRenameRecording(id, name)}
                onShareRecording={(r) => void openShare(r)}
                onUpload={onUpload}
                onLive={() => setLiveOpen(true)}
                fileInputRef={fileInputRef}
              />
            </aside>

            {detail ? (
              workspaceMode === 'coding' ? (
                <CodingWorkspace
                  key={`coding/${projectId}/${recordingId}`}
                  projectId={projectId!}
                  recordingId={recordingId!}
                  detail={detail}
                  onError={setError}
                  onRetry={() => setDetailNonce((n) => n + 1)}
                />
              ) : workspaceMode === 'analysis' ? (
                <AnalysisPanel
                  key={`analysis/${projectId}/${recordingId}`}
                  projectId={projectId!}
                  recordings={recordings}
                  detail={detail}
                  onJump={(recId, sentenceId) => {
                    setWorkspaceMode('transcript')
                    if (recId !== recordingId) setRecordingId(recId)
                    window.setTimeout(() => {
                      document.getElementById(`sentence-${sentenceId}`)?.scrollIntoView({ block: 'center' })
                    }, 300)
                  }}
                />
              ) : (
                <section className="workspace-card transcript-workspace" style={{ gridColumn: 'span 4' }}>
                  <TranscriptPanel
                    key={`${projectId}/${recordingId}`}
                    projectId={projectId!}
                    recordingId={recordingId!}
                    detail={detail}
                    onError={setError}
                    onRetry={() => setDetailNonce((n) => n + 1)}
                  />
                </section>
              )
            ) : (
              <section className="workspace-card" style={{ gridColumn: 'span 4', display: 'grid', placeItems: 'center' }}>
                <div style={{ color: '#aaa', fontSize: 14 }}>选择一条录音查看转写结果</div>
              </section>
            )}
          </main>
        </div>
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
      <button onClick={() => setOpen(true)} title="新建项目" aria-label="新建项目" style={{ ...ICON_BTN, width: '100%', height: 30 }}>
        <PlusIcon />
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

/**
 * 左栏两级：项目 → 项目下面的条目（一条录音 = 一个条目）。
 * 每级一个文字标签 + 折叠图标：项目标签常驻顶部；条目标签在项目展开后才出现。
 * 录音/上传 = 新建条目，放在“条目”标签右侧，只有图标、文字退到 title。
 */
function ProjectList({
  projects,
  activeId,
  onSelect,
  onDelete,
  expanded,
  onToggleExpand,
  entriesExpanded,
  onToggleEntriesExpand,
  recordings,
  activeRecordingId,
  onSelectRecording,
  onDeleteRecording,
  onRenameRecording,
  onShareRecording,
  onUpload,
  onLive,
  fileInputRef,
}: {
  projects: Project[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  expanded: boolean
  onToggleExpand: () => void
  entriesExpanded: boolean
  onToggleEntriesExpand: () => void
  recordings: Recording[]
  activeRecordingId: string | null
  onSelectRecording: (id: string) => void
  onDeleteRecording: (id: string) => void
  onRenameRecording: (id: string, name: string) => void
  onShareRecording: (r: Recording) => void
  onUpload: (f: File) => void
  onLive: () => void
  fileInputRef: React.RefObject<HTMLInputElement>
}) {
  if (projects.length === 0) {
    return <div style={{ color: '#aaa', fontSize: 13 }}>还没有项目</div>
  }

  const deleteBtn = (p: Project) => (
    <button
      onClick={(e) => { e.stopPropagation(); onDelete(p.id) }}
      title="删除项目（连同其下所有条目与版本）"
      aria-label="删除项目"
      style={{ ...ICON_BTN, width: 22, height: 20, color: '#b00020', border: '1px solid #f0c9cc' }}
    >
      <TrashIcon size={12} />
    </button>
  )

  // 项目标签行：文字“项目” + 折叠图标，常驻顶部。
  const projectHead = (
    <div className="rail-head">
      <span className="rail-head-label">项目</span>
      <button className="rail-fold" onClick={onToggleExpand} title={expanded ? '折叠项目' : '展开项目'} aria-label={expanded ? '折叠项目' : '展开项目'}>
        {expanded ? '▴' : '▾'}
      </button>
    </div>
  )

  const current = projects.find((p) => p.id === activeId) || projects[0]

  if (expanded) {
    return (
      <div className="scroll-hidden" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
        {projectHead}
        <ul className="project-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {projects.map((p) => (
            <li key={p.id} className="project-node">
              <div
                className={`project-row${p.id === activeId ? ' current' : ''}`}
                onClick={() => { onSelect(p.id); onToggleExpand() }}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { onSelect(p.id); onToggleExpand() } }}
              >
                <span className="project-caret">▸</span>
                <span className="project-name" title={p.name}>{p.name}</span>
                {deleteBtn(p)}
              </div>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // 折叠态：当前项目 + “条目”标签行（右侧录音/上传图标）+ 条目列表。
  const list = entriesExpanded ? recordings : recordings.filter((r) => r.id === activeRecordingId)
  return (
    <div className="scroll-hidden" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {projectHead}
      <div className="project-row expanded" onClick={onToggleExpand} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand() }}
        title="点开切换项目"
      >
        <span className="project-caret">▾</span>
        <span className="project-name" title={current.name}>{current.name}</span>
        {deleteBtn(current)}
      </div>

      <div className="rail-head entry-head">
        <span className="rail-head-label">条目</span>
        <button className="rail-fold" onClick={onToggleEntriesExpand} title={entriesExpanded ? '折叠条目' : '展开条目'} aria-label={entriesExpanded ? '折叠条目' : '展开条目'}>
          {entriesExpanded ? '▴' : '▾'}
        </button>
        <span className="head-spacer" />
        <input
          ref={fileInputRef}
          type="file"
          hidden
          accept=".wav,.mp3,.m4a,.wma,.flac,.ogg,.opus,.aac,.aiff,audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/flac,audio/ogg,audio/aac"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f) }}
        />
        <button onClick={onLive} title="现场录音（新建条目）" aria-label="现场录音" className="rail-fold"><MicIcon /></button>
        <button onClick={() => fileInputRef.current?.click()} title="上传录音（新建条目）" aria-label="上传录音" className="rail-fold"><UploadIcon /></button>
      </div>
      <div className="project-materials">
        <RecordingList
          recordings={list}
          activeId={activeRecordingId}
          onSelect={onSelectRecording}
          onDelete={onDeleteRecording}
          onRename={onRenameRecording}
          onShare={onShareRecording}
        />
      </div>
    </div>
  )
}

function RecordingList({
  recordings,
  activeId,
  onSelect,
  onDelete,
  onRename,
  onShare,
}: {
  recordings: Recording[]
  activeId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onShare: (r: Recording) => void
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  function startRename(r: Recording) {
    setRenamingId(r.id)
    setRenameDraft(r.name)
  }

  function commitRename(r: Recording) {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (name && name !== r.name) onRename(r.id, name)
  }

  if (recordings.length === 0) {
    return <div style={{ color: '#aaa', fontSize: 13 }}>还没有条目，点上方图标新建</div>
  }
  return (
    <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>
      {recordings.map((r) => {
        const renaming = renamingId === r.id
        return (
          <li
            key={r.id}
            onClick={() => {
              if (!renaming) onSelect(r.id)
            }}
            style={{
              padding: '6px 10px',
              cursor: renaming ? 'default' : 'pointer',
              borderRadius: 6,
              fontSize: 13,
              background: r.id === activeId ? '#e8f0fe' : 'transparent',
              marginBottom: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {/* 状态只用颜色：黄/蓝/红/绿；文字退到 hover 的 title */}
            <span
              className="mat-status"
              style={{ background: statusColor(r.transcribe.status) }}
              title={statusLabel(r.transcribe.status)}
              aria-label={statusLabel(r.transcribe.status)}
            />
            {renaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(r)}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') commitRename(r)
                  if (e.key === 'Escape') setRenamingId(null)
                }}
                style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '2px 5px' }}
              />
            ) : (
              <span
                style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={r.name}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  startRename(r)
                }}
              >
                {r.name}
              </span>
            )}
            {/* 顺序：分享（对外行为）→ 重命名、删除（对条目自身的 CRUD）。两类行为不混放。 */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onShare(r)
              }}
              title="分享到协作组"
              aria-label="分享到协作组"
              style={{ ...ICON_BTN, width: 22, height: 20, color: '#245c9c' }}
            >
              <ShareIcon size={13} />
            </button>
            {!renaming && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  startRename(r)
                }}
                title="重命名"
                aria-label="重命名"
                style={{ ...ICON_BTN, width: 22, height: 20, color: '#5b6472' }}
              >
                <EditIcon size={12} />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(r.id)
              }}
              title="删除这条材料"
              aria-label="删除这条材料"
              style={{ ...ICON_BTN, width: 22, height: 20, color: '#b00020', border: '1px solid #f0d0d0' }}
            >
              <TrashIcon size={12} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 编码工作区：录音区与「转写」用的是同一个 TranscriptPanel，一行样式都没改；
 * 只在右侧附加编码右栏。编码状态通过 Context 下发给录音区（荧光/密度条/选区）。
 */
function CodingWorkspace({
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
  const session = useCodingSession(projectId, recordingId, detail)
  return (
    <CodingContext.Provider value={session}>
      <section className="workspace-card transcript-workspace" style={{ gridColumn: 'span 3' }}>
        <TranscriptPanel
          projectId={projectId}
          recordingId={recordingId}
          detail={detail}
          onError={onError}
          onRetry={onRetry}
        />
      </section>
      <CodingPanel />
    </CodingContext.Provider>
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
  // 编码模式：录音区本身不改造，只从 Context 拿增强（荧光正文 / 页边密度 / 选区）。
  // 普通转写模式这里恒为 null，行为与改动前逐字一致。
  const coding = useOptionalCoding()
  const [localSentences, setLocalSentences] = useState<Sentence[]>(sentences)
  const [version, setVersion] = useState(recording.version?.current ?? '')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftSpeaker, setDraftSpeaker] = useState('')
  const [speakerEdit, setSpeakerEdit] = useState<string | null>(null)
  const [speakerDraft, setSpeakerDraft] = useState('')
  // 发言人花名册：单独登记名字，才能在“原本只有 1 个发言人”时先加人再拆分。
  const [roster, setRoster] = useState<string[]>(detail.speakers ?? [])
  const [newSpeakerOpen, setNewSpeakerOpen] = useState(false)
  // 发言人管理浮层：全局的改名/并入/新增/识别都收在这里，由标题栏图标调出。
  const [speakerPanelOpen, setSpeakerPanelOpen] = useState(false)
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
  // 纠错对照里的就地编辑：点铅笔进入反色编辑态，改完再点一次退出，勾勾采纳改后的文字。
  const [polishEditId, setPolishEditId] = useState<string | null>(null)
  const [polishDraft, setPolishDraft] = useState('')
  const [polishEdited, setPolishEdited] = useState<Record<string, string>>({})
  const audioRef = useRef<HTMLAudioElement>(null)
  // 本轮已被用户接受/忽略的建议：轮询回来时过滤掉，避免「点了接受又弹回来」。
  const decidedRef = useRef<Set<string>>(new Set())
  // 播放逻辑与协作材料共用同一个 hook（播放器行为只有一份，杜绝两套）。
  const player = useSentencePlayer(localSentences, audioRef)
  const { activeId, setActiveId, seek } = player

  const llmKey = polishModel || 'qwen3-4b'
  const llmModelInfo = modelState?.llm.find((m) => m.id === llmKey)
  const llmDownloaded = llmModelInfo?.downloaded ?? null
  const llmJob = jobFor(modelState, 'llm', llmKey)
  const llmDownloading = llmJob?.status === 'running'

  // 把本录音区的 seek 注册给编码会话：右栏“播放这一句/片段”复用同一播放器，不另起一套。
  useEffect(() => {
    coding?.registerSeek((s, onlyThis) => seek(s, onlyThis))
  }, [coding])

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
    setPolishEditId(null)
    setPolishDraft('')
    setPolishEdited({})
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
        setAiNotice(
          `已停止 AI 纠错，保留已完成的 ${job.suggestions?.length ?? 0} 条建议；` +
            `再点「AI 纠错」会从第 ${job.processed + 1} 句继续。`,
        )
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
        setAiNotice(
          `已停止整理断句，保留已整理的 ${job.after} 句；` +
            `再点「AI 整理断句」会从第 ${job.processed + 1} 个片段继续。`,
        )
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

  // override：用户点铅笔手改后的文字。采纳时用手改版，而不是模型原建议。
  async function acceptSuggestion(item: PolishSuggestion, override?: string) {
    if (!localSentences.some((s) => s.id === item.sentence_id)) return
    const after = (override ?? item.after).trim() || item.after
    const snapshot = localSentences
    decidedRef.current.add(item.sentence_id)
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
    clearPolishEdit(item.sentence_id)
    setLocalSentences((list) =>
      list.map((x) => (x.id === item.sentence_id ? { ...x, text: after } : x)),
    )
    // 先告诉后端这条已处理，避免轮询把它当成新建议重新塞回列表。
    void api
      .dismissPolishSuggestion(projectId, recordingId, item.sentence_id)
      .catch(() => undefined)
    try {
      const res = await api.updateSentence(projectId, recordingId, item.sentence_id, after, undefined, {
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

  function clearPolishEdit(sentenceId: string) {
    setPolishEditId((id) => (id === sentenceId ? null : id))
    setPolishEdited((prev) => {
      if (!(sentenceId in prev)) return prev
      const next = { ...prev }
      delete next[sentenceId]
      return next
    })
  }

  // 点铅笔：进入反色编辑态；再点一次退出并把改动留在 polishEdited 里，等勾勾采纳。
  function togglePolishEdit(sentenceId: string, current: string) {
    if (polishEditId === sentenceId) {
      const text = polishDraft.trim()
      setPolishEdited((prev) => {
        if (!text || text === current) {
          if (!(sentenceId in prev)) return prev
          const next = { ...prev }
          delete next[sentenceId]
          return next
        }
        return { ...prev, [sentenceId]: text }
      })
      setPolishEditId(null)
      return
    }
    setPolishDraft(polishEdited[sentenceId] ?? current)
    setPolishEditId(sentenceId)
  }

  function dismissSuggestion(item: PolishSuggestion) {
    decidedRef.current.add(item.sentence_id)
    setSuggestions((list) => list.filter((x) => x.sentence_id !== item.sentence_id))
    clearPolishEdit(item.sentence_id)
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

  // 点句子里的发言人标签：单击换下一位；Shift+点击把「同标签的连续一段」一起换。
  // 循环顺序 = 花名册 + 未标注，听录音时单手就能逐句纠错。
  async function cycleSentenceSpeaker(s: Sentence, batch: boolean) {
    const base = speakers.length ? speakers : ['Speaker 1']
    const cycle = [...base, '']
    const current = s.speaker ?? ''
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length]
    let ids = [s.id]
    if (batch) {
      const i = localSentences.findIndex((x) => x.id === s.id)
      if (i >= 0) {
        let l = i
        let r = i
        while (l > 0 && (localSentences[l - 1].speaker ?? '') === current) l -= 1
        while (r < localSentences.length - 1 && (localSentences[r + 1].speaker ?? '') === current) r += 1
        ids = localSentences.slice(l, r + 1).map((x) => x.id)
      }
    }
    const snapshot = localSentences
    const idSet = new Set(ids)
    setLocalSentences((list) => list.map((x) => (idSet.has(x.id) ? { ...x, speaker: next } : x)))
    try {
      const res = await api.updateSpeakers(projectId, recordingId, {
        action: 'assign',
        sentence_ids: ids,
        speaker: next,
      })
      setLocalSentences(res.sentences)
      if (res.speakers) setRoster(res.speakers)
      setVersion(res.current || version)
      onError('')
    } catch (e) {
      setLocalSentences(snapshot)
      onError(`改发言人失败：${String(e)}`)
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
    <div style={{ display: 'flex', gap: 20, height: '100%', minHeight: 0, position: 'relative' }}>
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>{recording.name}</h2>
          <span style={{ fontSize: 11, color: '#8a8f98' }}>{localSentences.length} 句</span>
          {version && (
            <span style={{ fontSize: 11, color: '#6b7280', background: '#f1f3f5', borderRadius: 10, padding: '2px 8px' }}>
              v{version}
            </span>
          )}
          {/* 编码模式不给编辑入口，正文自然只读，不需要写“正文只读”声明 */}
          <button
            onClick={() => void saveExport(projectId, recordingId, 'md', version || undefined, onError)}
            title="导出为 Markdown"
            aria-label="导出为 Markdown"
            className="export-tag"
          >
            MD
          </button>
          <button
            onClick={() => void saveExport(projectId, recordingId, 'json', version || undefined, onError)}
            title="导出为 JSON"
            aria-label="导出为 JSON"
            className="export-tag"
          >
            JSON
          </button>
          <button
            onClick={() => setShowHistory((v) => !v)}
            title={showHistory ? '收起版本历史' : '版本历史'}
            aria-label="版本历史"
            style={{ ...ICON_BTN, background: showHistory ? '#eef5ff' : '#fff' }}
          >
            <HistoryIcon />
          </button>
          <span style={{ marginLeft: 'auto' }} />
          {!coding && (
            <>
          <button
            onClick={() => {
              if (polishing || suggestions.length > 0) setPolishOpen(true)
              else void runPolish()
            }}
            disabled={llmReady === false || llmDownloading || transcribe.status !== 'done'}
            style={{
              fontSize: 12,
              padding: '4px 10px',
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
            </>
          )}
          {/* 编码模式下正文天然是脱敏后的稿子，不提供脱敏入口 */}
          {!coding && (
            <button
              onClick={() => setRedactMode((v) => !v)}
              className="text-tool"
              style={{
                background: redactMode ? '#fff4e0' : '#fff',
                borderColor: redactMode ? '#f0b429' : '#ddd',
                color: redactMode ? '#8a5a00' : '#555',
              }}
              title="进入脱敏态：选中文字后点类别即可标记；导出时替换为占位符"
            >
              {redactMode ? '退出脱敏' : '脱敏'}
            </button>
          )}

          {/* 全局工具：发言人管理、多句合并。都是图标，文字退到 hover。
              句内“点胶囊换下一位发言人”在正文行里，不在这里——那是句内交互。 */}
          {!coding && transcribe.status === 'done' && localSentences.length > 0 && (
            <>
              <span className="tool-sep" />
              <button
                className="text-tool"
                onClick={() => setSpeakerPanelOpen((v) => !v)}
                title="新增 / 改名 / 并入发言人，或按音色重新识别"
                style={speakerPanelOpen ? { background: '#eef5ff', borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
              >
                发言人
              </button>
              <button
                className="text-tool"
                onClick={() => {
                  setMergeMode((v) => !v)
                  setPaintColors({})
                  setEditingId(null)
                }}
                title={mergeMode ? '退出合并' : '把被 ASR 切碎的连续句子合并成一句'}
                style={mergeMode ? { background: '#eef5ff', borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
              >
                {mergeMode ? '退出合并' : '合并句子'}
              </button>
            </>
          )}
        </div>

        {/* 发言人管理浮层：从工具栏图标调出，不在正文流里，AI 提示条出现也不会推着它跑 */}
        {speakerPanelOpen && !coding && (
          <div className="speaker-panel">
            <div className="speaker-panel-title">
              发言人管理
              <button className="icon-tool" onClick={() => setSpeakerPanelOpen(false)} title="关闭" aria-label="关闭">
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="speaker-panel-body">
              {speakers.length === 0 && <div className="speaker-panel-empty">还没有发言人，可以新增或按音色自动识别。</div>}
              {speakers.map((sp) =>
                speakerEdit === sp ? (
                  <div key={sp} className="speaker-edit-row">
                    <input
                      autoFocus
                      value={speakerDraft}
                      onChange={(e) => setSpeakerDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setSpeakerEdit(null)
                        if (e.key === 'Enter') void renameSpeaker(sp, speakerDraft)
                      }}
                      style={{ fontSize: 12, width: 110, padding: '2px 5px' }}
                    />
                    <button className="text-tool" onClick={() => void renameSpeaker(sp, speakerDraft)}>保存</button>
                    <button className="text-tool" onClick={() => setSpeakerEdit(null)}>取消</button>
                    {speakers.length > 1 && (
                      <select
                        defaultValue=""
                        onChange={(e) => {
                          const into = e.target.value
                          e.target.value = ''
                          if (into) void mergeSpeaker(sp, into)
                        }}
                        style={{ fontSize: 11 }}
                        title="把这个发言人的全部句子并入另一个"
                      >
                        <option value="">并入…</option>
                        {speakers.filter((x) => x !== sp).map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : (
                  <button
                    key={sp}
                    className="speaker-chip"
                    style={{
                      background: speakerColor(sp, speakerOrder).bg,
                      color: speakerColor(sp, speakerOrder).fg,
                      borderColor: speakerColor(sp, speakerOrder).border,
                    }}
                    onClick={() => { setSpeakerEdit(sp); setSpeakerDraft(sp) }}
                    title="点击改名 / 并入"
                  >
                    {sp}
                  </button>
                ),
              )}
              <div className="speaker-panel-actions">
                {newSpeakerOpen ? (
                  <span className="speaker-edit-row">
                    <input
                      autoFocus
                      value={newSpeakerName}
                      onChange={(e) => setNewSpeakerName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setNewSpeakerOpen(false); setNewSpeakerName('') }
                        if (e.key === 'Enter') void addSpeaker()
                      }}
                      placeholder="如：受访者"
                      style={{ fontSize: 12, width: 110, padding: '2px 5px' }}
                    />
                    <button className="text-tool" onClick={() => void addSpeaker()}>添加</button>
                    <button className="text-tool" onClick={() => { setNewSpeakerOpen(false); setNewSpeakerName('') }}>取消</button>
                  </span>
                ) : (
                  <button className="text-tool" onClick={() => setNewSpeakerOpen(true)}>+ 新增</button>
                )}
                <button
                  className="text-tool"
                  onClick={() => void detectSpeakersNow()}
                  disabled={detectingSpeakers || localSentences.length < 3}
                  title="按音色重新分说话人；会覆盖当前标注并生成新版本"
                >
                  {detectingSpeakers ? '识别中…' : speakers.length > 0 ? '重新识别' : '自动识别'}
                </button>
              </div>
              <div className="speaker-panel-hint">点正文里的发言人标签可换下一位（只改这一句）；Shift+点改整段。</div>
            </div>
          </div>
        )}

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

        <TranscriptAudio
          audioRef={audioRef}
          audioUrl={api.audioUrl(projectId, recordingId)}
          onTimeUpdate={player.onTimeUpdate}
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
                  <button onClick={() => void stopPolish()} title="停止纠错" aria-label="停止纠错" style={{ ...ICON_BTN, width: 22, height: 20, color: '#b00020' }}><StopIcon size={11} /></button>
                )}
                <button onClick={() => setPolishOpen(false)} title="关闭纠错对照" aria-label="关闭纠错对照" style={{ ...ICON_BTN, width: 22, height: 20 }}><CloseIcon size={11} /></button>
              </div>
            </div>
            {localSentences.map((s) => {
              const sug = suggestionBySentence.get(s.id)
              const tone = s.speaker ? speakerColor(s.speaker, speakerOrder) : null
              return (
                <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #f2f4f7', background: sug ? '#f7fdf9' : '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRight: '1px solid #f2f4f7' }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        seek(s, true)
                      }}
                      title="只播这一句"
                      aria-label="只播这一句"
                      style={{ ...ICON_BTN, width: 24, height: 24, color: '#1d4ed8', background: '#eef4ff', border: '1px solid #dbe6ff', marginTop: 1 }}
                    >
                      <PlayIcon size={11} />
                    </button>
                    <span style={{ fontSize: 12, color: '#999', flexShrink: 0, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMs(s.start_ms)}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        void cycleSentenceSpeaker(s, e.shiftKey)
                      }}
                      title="点一下换下一位发言人；Shift + 点击把这一整段同标签的句子一起换"
                      style={{
                        fontSize: 11,
                        color: s.speaker ? tone?.fg ?? '#8a8f98' : '#8a8f98',
                        background: s.speaker ? tone?.bg ?? '#f7f8fa' : '#f7f8fa',
                        border: s.speaker ? `1px solid ${tone?.border ?? '#d7dce3'}` : '1px dashed #d7dce3',
                        borderRadius: 4,
                        padding: '1px 6px',
                        flexShrink: 0,
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                        cursor: 'pointer',
                      }}
                    >
                      {s.speaker || '未标注'}
                    </button>
                    <div onClick={() => seek(s)} style={{ flex: 1, minWidth: 0, cursor: 'pointer', fontSize: 15, lineHeight: 1.7 }}>
                      {renderText(s)}
                    </div>
                  </div>
                  <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    {sug ? (
                      <>
                        {polishEditId === s.id ? (
                          <textarea
                            autoFocus
                            value={polishDraft}
                            onChange={(e) => setPolishDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') {
                                setPolishEditId(null)
                                setPolishDraft('')
                              }
                              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) togglePolishEdit(s.id, sug.after)
                            }}
                            title="直接修改 AI 修正后的这一句；改完再点一次铅笔退出"
                            style={{ flex: 1, minWidth: 0, minHeight: 48, fontSize: 15, lineHeight: 1.7, padding: '4px 8px', boxSizing: 'border-box', resize: 'vertical', color: '#f8fafc', background: '#1f2937', border: '1px solid #111827', borderRadius: 6, caretColor: '#fff' }}
                          />
                        ) : (
                          <div style={{ flex: 1, minWidth: 0, fontSize: 15, color: '#1e7e34', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                            {polishEdited[s.id] ?? sug.after}
                            {polishEdited[s.id] != null && (
                              <span style={{ fontSize: 10, color: '#8a8f98', marginLeft: 6 }}>已手改</span>
                            )}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          <button
                            onClick={() => void acceptSuggestion(sug, polishEditId === s.id ? polishDraft : polishEdited[s.id])}
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
                            onClick={() => togglePolishEdit(s.id, sug.after)}
                            title={polishEditId === s.id ? '退出编辑（保留修改）' : '自己改'}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: 26,
                              height: 24,
                              borderRadius: 4,
                              cursor: 'pointer',
                              color: polishEditId === s.id ? '#fff' : '#5b6472',
                              background: polishEditId === s.id ? '#1f2937' : '#fff',
                              border: '1px solid ' + (polishEditId === s.id ? '#111827' : '#dde3ea'),
                            }}
                          >
                            <EditIcon size={13} />
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
<TranscriptList
          sentences={localSentences}
          activeId={activeId}
          onPlayPressStart={player.playPressStart}
          onPlayPressEnd={player.playPressEnd}
          onPlayPressCancel={player.playPressCancel}
          onRowClick={(s) => {
            if (mergeMode) { paintWithBrush(s.id); return }
            setActiveId(s.id)
            coding?.selectSentence(s.id)
          }}
          rowStyle={(s, active) => {
            const color = mergeMode ? paintColors[s.id] : undefined
            return {
              background: mergeMode
                ? color === 1 ? '#eef4ff' : color === 2 ? '#fff4e6' : '#fff'
                : active ? '#eef4ff' : 'transparent',
              borderLeft: mergeMode
                ? `3px solid ${color === 1 ? '#1a73e8' : color === 2 ? '#f59e0b' : 'transparent'}`
                : active ? '3px solid #4285f4' : '3px solid transparent',
            }
          }}
          renderBody={(s) => (
                  editingId === s.id ? (
                    <div className="transcript-edit" onClick={(e) => e.stopPropagation()}>
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
<SentenceLine
                      sentence={s}
                      order={speakerOrder}
                      speakerTitle="点一下换下一位发言人；Shift + 点击把这一整段同标签的句子一起换"
                      speakerOnClick={(e) => { e.stopPropagation(); void cycleSentenceSpeaker(s, e.shiftKey) }}
                      textId={`stext-${s.id}`}
                      textAttrs={{ 'data-coding-sentence': coding ? s.id : undefined }}
                      onTextMouseUp={(e) => {
                        void markSelection(s)
                        if (coding && e.detail <= 1) coding.readSelection(e.currentTarget.closest('.transcript-line') || null)
                      }}
                      tail={
                        <>
                      {!mergeMode && !coding && (
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
                      {/* 句尾色点：这一句挂了哪几个码，一眼可见（NVivo 式） */}
                      {coding && (() => {
                        const codes = Array.from(
                          new Map(
                            coding.sentenceCodings(s.id)
                              .map((e) => coding.store.codes.find((c) => c.id === e.code_id))
                              .filter((c): c is NonNullable<typeof c> => Boolean(c))
                              .map((c) => [c.id, c]),
                          ).values(),
                        )
                        if (!codes.length) return null
                        return (
                          <span style={{ display: 'inline-flex', gap: 3, alignSelf: 'flex-start', flexShrink: 0, paddingTop: 4 }} title={codes.map((c) => c.name).join('、')}>
                            {codes.map((c) => (
                              <span key={c.id} style={{ width: 8, height: 8, borderRadius: 2, background: c.color }} />
                            ))}
                          </span>
                        )
                      })()}

                        </>
                      }
                    >
                        {coding
                          ? coding.decorateText(s, (entry) => coding.selectCoding(entry, (sid) => {
                              document.getElementById(`sentence-${sid}`)?.scrollIntoView({ block: 'nearest' })
                            }), (entry) => { coding.clearSelection(); coding.removeCoding(entry.id) })
                          : renderText(s)}

                    </SentenceLine>                  )
          )}
          renderGutter={(s) => (
                  coding ? (
                    <span
                      title={`本句编码密度 ${Math.round(coding.coverageOf(s) * 100)}%`}
                      style={{
                        width: 6,
                        alignSelf: 'stretch',
                        minHeight: 20,
                        borderRadius: 3,
                        flexShrink: 0,
                        // 密度条常驻：随密度从淡绿连续过渡到深红，相邻句形成渐变带，而非有色/无色直白跳变。
                        background: (() => {
                          const r = coding.coverageOf(s)
                          const from = r < 0.5 ? [46, 160, 67] : [234, 179, 8]
                          const to = r < 0.5 ? [234, 179, 8] : [220, 38, 38]
                          const k = r < 0.5 ? r * 2 : (r - 0.5) * 2
                          const c = from.map((v, i) => Math.round(v + (to[i] - v) * k))
                          return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${0.12 + r * 0.88})`
                        })(),
                      }}
                    />
                  ) : undefined

          )}
        />
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
                任务已停止，下面是已完成的部分；再点「AI 整理断句」会从断点继续。未处理的句子还没整理，所以暂时不能应用。
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
                  <button onClick={() => void stopResegment()} title="停止整理" aria-label="停止整理" style={{ ...ICON_BTN, width: 28, height: 28, color: '#b00020' }}><StopIcon size={12} /></button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      setResegOpen(false)
                      setResegPreview(null)
                      setResegDone(false)
                    }}
                    title="关闭预览"
                    aria-label="关闭预览"
                    style={{ ...ICON_BTN, width: 28, height: 28 }}
                  >
                    <CloseIcon size={12} />
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