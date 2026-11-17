import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import { TranscriptAudio, TranscriptList } from './TranscriptBody'
import { useSentencePlayer } from './useSentencePlayer'
import { speakerOrderFrom } from './SpeakerTag'
import SentenceLine from './SentenceLine'
import PolishCompare from './PolishCompare'
import ResegmentPanel from './ResegmentPanel'
import SpeakerPanel from './SpeakerPanel'
import MergePanel from './MergePanel'
import { selectionRangeById, renderRedactedText } from './redaction'
import {
  DownloadIcon,
  EditIcon,
  EnterIcon,
  GearIcon,
  PlusIcon,
  UploadIcon,
  CloseIcon,
} from './icons'
import GroupCodingPanel from './coding/GroupCodingPanel'
import GroupAnalysisPanel from './coding/GroupAnalysisPanel'
import ComparePanel from './coding/ComparePanel'
import type {
  CollabAccess,
  CollabApproval,
  CollabChatMessage,
  CollabGrant,
  CollabGroupSummary,
  CollabMaterial,
  CollabMaterialDetail,
  CollabMember,
  CollabProposal,
  CollabRole,
  PolishSuggestion,
  RedactionMark,
  RedactionCategory,
  RedactionSuggestion,
  PeerSnapshot,
  Project,
  Recording,
  Sentence,
} from './types'

const CAP_LABELS: Record<string, string> = {
  view: '查看',
  edit: '编辑正文',
  submit: '提交修改',
  merge: '合并提案',
  material: '灌入材料',
  approve: '批准播放',
  members: '管理成员',
  roles: '改权限',
  review: '审查模式',
  manage: '协作管理',
}

const ROLE_ORDER = ['owner', 'admin', 'editor', 'reader', 'reviewer']

const TABS = [
  ['material', '任务材料'],
  ['members', '成员与权限'],
  ['proposals', '修改提案'],
  ['approvals', '播放审批'],
  ['access', '访问留痕'],
  ['devices', '我的设备'],
] as const

type Tab = (typeof TABS)[number][0]

const ICON_BTN: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  border: '1px solid #e3e6ea', borderRadius: 6, background: '#fff',
  cursor: 'pointer', padding: 0,
}

function errText(e: unknown): string {
  return String(e)
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] || c))
}

export default function CollabPanel({
  projects,
  onClose,
  embedded = false,
  gridMode = false,
  mainView: mainViewProp,
  workspaceMode = 'transcript',
}: {
  projects: Project[]
  onClose: () => void
  embedded?: boolean
  /** true 时三栏直接作为父级 workspace-grid 的子元素（span1/span3/span1），与个人页视觉对齐 */
  gridMode?: boolean
  mainView?: 'collab' | 'approve'
  /** 工作模式由顶栏统一控制（转写/编码/分析/对比），本地不再单开一套 */
  workspaceMode?: 'transcript' | 'coding' | 'analysis' | 'compare'
}) {
  const [groups, setGroups] = useState<CollabGroupSummary[]>([])
  const [identity, setIdentity] = useState<{ nick: string; device_code: string }>({ nick: '', device_code: '' })
  const [selected, setSelected] = useState<CollabGroupSummary | null>(null)
  const [tab, setTab] = useState<Tab>('material')
  // 协作/审批由顶栏控制（App 持有）。
  const mainView = mainViewProp ?? 'collab'
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [newName, setNewName] = useState('')
  const [newMode, setNewMode] = useState<'authoritative' | 'replica'>('authoritative')
  const [joinCode, setJoinCode] = useState('')
  const [joinRole, setJoinRole] = useState<'reader' | 'reviewer'>('reader')
  const [createOpen, setCreateOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)

  const [members, setMembers] = useState<CollabMember[]>([])
  const [roles, setRoles] = useState<Record<string, CollabRole>>({})
  const [requests, setRequests] = useState<{
    id: string
    device_code: string
    nick: string
    role: string
    by_nick: string
    at: string
    status: string
  }[]>([])
  const [materials, setMaterials] = useState<CollabMaterial[]>([])
  const [proposals, setProposals] = useState<CollabProposal[]>([])
  const [proposalSel, setProposalSel] = useState<string[]>([])
  const [approvals, setApprovals] = useState<CollabApproval[]>([])
  const [access, setAccess] = useState<CollabAccess[]>([])

  // 单次 / 单材料授权（长期角色之外的临时放权）
  const [grants, setGrants] = useState<CollabGrant[]>([])
  const [grantTarget, setGrantTarget] = useState('')
  const [grantCaps, setGrantCaps] = useState<string[]>(['edit'])
  const [grantScope, setGrantScope] = useState<'group' | 'material'>('material')
  const [grantMaterials, setGrantMaterials] = useState<string[]>([])
  const [grantUses, setGrantUses] = useState('1')
  const [grantDays, setGrantDays] = useState('0')
  const [grantNote, setGrantNote] = useState('')

  // 局域网节点发现 / 手工登记
  const [peers, setPeers] = useState<PeerSnapshot['peers']>([])
  const [peerUrl, setPeerUrl] = useState('')

  const [addProject, setAddProject] = useState('')
  const [addRecording, setAddRecording] = useState('')
  const [recordings, setRecordings] = useState<Recording[]>([])

  // 右栏群聊：文件是文件（附件可下载），材料是材料（另行从工作区灌入）。
  const [chatOpen, setChatOpen] = useState(true)
  const [chatMsgs, setChatMsgs] = useState<CollabChatMessage[]>([])
  const [chatMyDevice, setChatMyDevice] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [chatSending, setChatSending] = useState(false)
  const chatFileRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const groupAudioRef = useRef<HTMLAudioElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [materialView, setMaterialView] = useState<CollabMaterialDetail | null>(null)
  const [editSentence, setEditSentence] = useState<Sentence | null>(null)
  const [editText, setEditText] = useState('')
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({})
  // 本地分支对发言人的改动（句内换人/批量/改名/并入）；提交走 PR。
  const [localSpeakerEdits, setLocalSpeakerEdits] = useState<Record<string, string>>({})
  const [speakerPanelOpen, setSpeakerPanelOpen] = useState(false)
  // 本地新增的发言人名字（花名册）；按 Git 模型提交走 PR。
  const [localRoster, setLocalRoster] = useState<string[]>([])
  const [detectSpeakersBusy, setDetectSpeakersBusy] = useState(false)
  // 多句合并：涂色分组 → 本地整段替换（提交走 PR）。与个人页同一套交互。
  const [mergeMode, setMergeMode] = useState(false)
  const [paintColors, setPaintColors] = useState<Record<string, 1 | 2>>({})
  const [paintBrush, setPaintBrush] = useState<0 | 1 | 2>(1)
  const [merging, setMerging] = useState(false)
  // 协作脱敏：标记来自材料快照，类别模板是群组级（全员共用）。
  const [redactMode, setRedactMode] = useState(false)
  const [redactMarks, setRedactMarks] = useState<RedactionMark[]>([])
  const [redactCats, setRedactCats] = useState<RedactionCategory[]>([])
  const [activeCat, setActiveCat] = useState('')
  const [catPanel, setCatPanel] = useState(false)
  const [catDraft, setCatDraft] = useState<RedactionCategory[]>([])
  const [aiSuggesting, setAiSuggesting] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState<RedactionSuggestion[]>([])
  const [redactError, setRedactError] = useState('')
  // 本地分支的整段句子替换（AI 整理断句等会改句子结构/id）；null=用主分支原句。
  // 本地可以做任何事；提交公认版本仍必须走 PR。
  const [sentencesOverride, setSentencesOverride] = useState<Sentence[] | null>(null)
  // 本地分支里勾选提交为 PR 的句子（Git: 从本地分支挑部分 commit 发 PR）。
  const [localSel, setLocalSel] = useState<string[]>([])
  // 协作材料的 AI 纠错：与个人录音共用同一套 job/建议机制。
  const [aiJob, setAiJob] = useState<api.AiJob | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiDecided, setAiDecided] = useState<string[]>([])
  // AI 整理断句：预览→本地整段替换；提交公认版本仍走 PR。
  const [resegJob, setResegJob] = useState<api.AiJob | null>(null)
  const [resegOpen, setResegOpen] = useState(false)
  const [resegDone, setResegDone] = useState(false)
  const [localEditing, setLocalEditing] = useState<Sentence | null>(null)
  const [localText, setLocalText] = useState('')
  // 播放逻辑与本地录音共用同一个 hook（播放器行为只有一份，杜绝两套）。
  const player = useSentencePlayer(materialView?.material.sentences ?? [], groupAudioRef)
  // 发言人配色顺序与个人页同源：按句子出场顺序取色，同一个人在两处颜色一致。
  const speakerOrder = useMemo(() => speakerOrderFrom(materialView?.material.sentences ?? []), [materialView?.material.sentences])

  // AI 纠错是后台长任务：运行中每 1.2s 轮询一次，逐批看到建议。
  useEffect(() => {
    if (!aiJob || !selected || !materialView) return
    if (aiJob.status !== 'running') return
    let cancelled = false
    const timer = window.setInterval(() => {
      void api.fetchMaterialPolishJob(selected.id, materialView.material.id)
        .then((job) => { if (!cancelled) setAiJob(job) })
        .catch(() => { /* 轮询失败保留上一次结果 */ })
    }, 1200)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [aiJob?.status, selected?.id, materialView?.material.id])

  // 材料切换/刷新后同步脱敏标记；进入脱敏态时拉群组级类别模板。
  useEffect(() => {
    if (materialView) setRedactMarks(materialView.material.redactions ?? [])
  }, [materialView?.material.id, materialView?.material.version, materialView])
  useEffect(() => {
    if (!redactMode || !selected) return
    let cancelled = false
    void api.fetchGroupRedactionCategories(selected.id).then((cats) => {
      if (cancelled) return
      setRedactCats(cats)
      setActiveCat((prev) => prev || cats.find((c) => c.enabled)?.id || cats[0]?.id || '')
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [redactMode, selected?.id])

  // AI 整理断句轮询。
  useEffect(() => {
    if (!resegJob || !selected || !materialView) return
    if (resegJob.status !== 'running') return
    let cancelled = false
    const timer = window.setInterval(() => {
      void api.fetchMaterialResegmentJob(selected.id, materialView.material.id)
        .then((job) => { if (!cancelled) { setResegJob(job); if (job.status === 'done') setResegDone(true) } })
        .catch(() => { /* 保留上次 */ })
    }, 900)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [resegJob?.status, selected?.id, materialView?.material.id])

  const [mergeConflicts, setMergeConflicts] = useState<{
    sentence_id: string
    index: number
    base: string
    current: string
    incoming: string
  }[] | null>(null)
  const [playMode, setPlayMode] = useState<'burn' | 'permanent' | 'timed'>('timed')

  const myRole = selected?.my_role || ''
  const myCaps = (roles[myRole]?.caps || []) as string[]
  const has = (cap: string) => myCaps.includes(cap)
  // 审批分两种：待我审批（别人提交的）/ 我提交的PR。Git 模型：审批别人 vs 被别人审批。
  const [prView, setPrView] = useState<'review' | 'mine'>('review')
  const isMyProposal = (p: CollabProposal) => p.by_device === identity.device_code
  const reviewProposals = proposals.filter((p) => !isMyProposal(p))
  const myProposals = proposals.filter((p) => isMyProposal(p))
  const visibleProposals = prView === 'mine' ? myProposals : reviewProposals
  // 待处理提案：pending 与 conflict 都能批量合并（conflict 由服务端严格判断）。
  const mergeableProposals = (prView === 'mine' ? myProposals : reviewProposals).filter(
    (p) => p.status === 'pending' || p.status === 'conflict',
  )
  const allProposalsSelected =
    mergeableProposals.length > 0 && mergeableProposals.every((p) => proposalSel.includes(p.id))
  // 提案只对能提交/合并的人生效；只读与审查者连 tab 都不显示，避免拿到他人原文。
  const visibleTabs: (typeof TABS)[number][] = mainView === 'collab'
    ? TABS.filter(([key]) => key === 'material')
    : TABS.filter(([key]) => (key === 'proposals' && (has('submit') || has('merge'))) || key === 'approvals')
  // 顶栏切换协作/审批时，把 tab 落到该视图的第一个可见项。
  // 用 ref 记住上一次的 mainView，避免首次挂载以及“从群设置进入 members/access/devices”时被重置。
  const lastMainView = useRef(mainView)
  useEffect(() => {
    if (lastMainView.current === mainView) return
    lastMainView.current = mainView
    setMaterialView(null)
    if (mainView === 'collab') setTab('material')
    else setTab((myCaps.includes('submit') || myCaps.includes('merge')) ? 'proposals' : 'approvals')
  }, [mainView])
  const burnApproval = useMemo(() => {
    const a = materialView?.approval
    if (!selected || !a || a.mode !== 'burn' || a.status !== 'approved') return null
    return { groupId: selected.id, approvalId: a.id }
  }, [selected, materialView])
  const burnStarted = useRef(false)

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadGroups() {
    const data = await api.listGroups()
    setGroups(data.groups)
    setIdentity(data.identity)
  }

  async function loadPeers() {
    try {
      setPeers((await api.listPeers()).peers)
    } catch {
      setPeers([])
    }
  }

  useEffect(() => {
    void run(loadGroups)
    void loadPeers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (tab === 'devices') void loadPeers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // 权限变化后把不可见的提案 tab 收回到“材料”。
  useEffect(() => {
    if (tab === 'proposals' && !has('submit') && !has('merge')) setTab('material')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, myCaps])

  useEffect(() => {
    burnStarted.current = false
  }, [burnApproval?.approvalId])

  // 烧毁模式：播到一半直接关页面也算消费，不能靠关标签页绕过“听完即毁”。
  useEffect(() => {
    if (!burnApproval) return
    const consume = () => {
      if (!burnStarted.current) return
      burnStarted.current = false
      const blob = new Blob(['{}'], { type: 'application/json' })
      navigator.sendBeacon?.(api.playbackConsumeUrl(burnApproval.groupId, burnApproval.approvalId), blob)
    }
    window.addEventListener('pagehide', consume)
    return () => window.removeEventListener('pagehide', consume)
  }, [burnApproval])

  async function loadGroup(id: string) {
    const [g, m, mat, p, a, gr] = await Promise.all([
      api.groupDetail(id),
      api.groupMembers(id),
      api.listGroupMaterials(id),
      // 无 submit/merge 权限的后端会 403；提案本来就不该给只读/审查者看。
      api.listProposals(id).catch(() => [] as CollabProposal[]),
      api.listApprovals(id),
      api.listGrants(id).catch(() => ({ grants: [] as CollabGrant[] })),
    ])
    setSelected(g)
    setRoles(m.roles)
    setMembers(m.members)
    setRequests(m.member_requests || [])
    setMaterials(mat)
    setProposals(p)
    setApprovals(a)
    setGrants(gr.grants)
    const caps = (m.roles[g.my_role || '']?.caps || []) as string[]
    if (caps.includes('members')) {
      try {
        setAccess(await api.groupAccess(id))
      } catch {
        setAccess([])
      }
    } else {
      setAccess([])
    }
    try {
      const chat = await api.listGroupMessages(id)
      setChatMsgs(chat.messages)
      setChatMyDevice(chat.my_device)
    } catch {
      setChatMsgs([])
    }
  }

  async function sendChat() {
    if (!selected || chatSending || !chatDraft.trim()) return
    setChatSending(true)
    const text = chatDraft.trim()
    setChatDraft('')
    try {
      const msg = await api.sendGroupMessage(selected.id, { kind: 'text', text })
      setChatMsgs((prev) => [...prev, msg])
    } catch (e) {
      setError(`发送失败：${errText(e)}`)
    } finally {
      setChatSending(false)
    }
  }

  async function sendChatFile(file: File) {
    if (!selected || chatSending) return
    setChatSending(true)
    try {
      const meta = await api.uploadChatFile(selected.id, file)
      const msg = await api.sendGroupMessage(selected.id, { kind: 'file', ...meta })
      setChatMsgs((prev) => [...prev, msg])
    } catch (e) {
      setError(`上传失败：${errText(e)}`)
    } finally {
      setChatSending(false)
    }
  }

  async function sendMaterialCard() {
    if (!selected || !materialView || chatSending) return
    setChatSending(true)
    try {
      const msg = await api.sendGroupMessage(selected.id, {
        kind: 'material',
        material_id: materialView.material.id,
        text: materialView.material.name,
      })
      setChatMsgs((prev) => [...prev, msg])
    } catch (e) {
      setError(`发送失败：${errText(e)}`)
    } finally {
      setChatSending(false)
    }
  }

  async function selectGroup(id: string) {
    setMaterialView(null)
    setLocalEdits({})
    setLocalEditing(null)
    setMergeConflicts(null)
    setProposalSel([])
    await run(async () => {
      await loadGroup(id)
    })
  }

  async function openMaterial(id: string) {
    if (!selected) return
    setLocalEdits({})
    setLocalEditing(null)
    setMergeConflicts(null)
    await run(async () => {
      setMaterialView(await api.groupMaterial(selected.id, id))
    })
  }

  function saveLocalEdit() {
    if (!localEditing) return
    setLocalEdits((prev) => ({ ...prev, [localEditing.id]: localText }))
    setLocalEditing(null)
    setLocalText('')
  }

  // 把本地分支里勾选的改动提交为 PR（逐句提案），提交后这些改动不再算本地未提交。
  async function submitSelectedAsPR() {
    if (!selected || !materialView || localSel.length === 0) return
    await run(async () => {
      for (const sid of localSel) {
        const after = localEdits[sid]
        if (after === undefined) continue
        await api.createProposal(selected.id, materialView.material.id, sid, after)
      }
      setLocalEdits((prev) => {
        const next = { ...prev }
        for (const sid of localSel) delete next[sid]
        return next
      })
      setLocalSel([])
      setNotice(`已提交 ${localSel.length} 条改动为 PR，等待审批`)
      await loadGroup(selected.id)
    })
  }

  // ---- 发言人（本地分支操作，提交走 PR，与个人页同一套交互）----
  const localSpeakers = useMemo(
    () => [...new Set([...localSentences().map((s) => s.speaker).filter(Boolean), ...localRoster])],
    // 依赖序列化后的本地句子，避免每次渲染新数组带来的失效
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(localEdits), JSON.stringify(localSpeakerEdits), JSON.stringify(localRoster), sentencesOverride, materialView?.material.id],
  )

  function paintWithBrush(id: string) {
    setPaintColors((prev) => {
      const next = { ...prev }
      if (paintBrush === 0) delete next[id]
      else next[id] = paintBrush
      return next
    })
  }

  const paintCount = Object.keys(paintColors).length
  // 只有同色且连续才成组；白色（未涂）不参与合并。与个人页同一算法。
  const mergeGroups: string[][] = []
  localSentences().forEach((s, i) => {
    const color = paintColors[s.id]
    if (!color) return
    const prev = localSentences()[i - 1]
    if (prev && paintColors[prev.id] === color) mergeGroups[mergeGroups.length - 1].push(s.id)
    else mergeGroups.push([s.id])
  })
  const mergeableGroups = mergeGroups.filter((g) => g.length > 1)
  const mergeReducible = mergeableGroups.reduce((n, g) => n + g.length - 1, 0)

  // 合并全部：把每组句子合成一句，整段替换本地分支（提交走 PR）。
  async function applyMergeGroups() {
    if (mergeableGroups.length === 0 || merging) return
    await run(async () => {
      setMerging(true)
      try {
        const list = localSentences()
        const mergedIds = new Set(mergeableGroups.flat())
        const result: Sentence[] = []
        for (const s of list) {
          if (!mergedIds.has(s.id)) { result.push(s); continue }
          const group = mergeableGroups.find((g) => g.includes(s.id))!
          if (group[0] !== s.id) continue // 每组只在第一句位置产出合并句
          const items = group.map((id) => list.find((x) => x.id === id)!).filter(Boolean)
          const text = items.map((x) => x.text.trim().replace(/[，。；：、,.!?;:…]+$/, '')).join('，') + '。'
          result.push({ ...s, text })
        }
        setSentencesOverride(result)
        setLocalEdits({})
        setLocalSpeakerEdits({})
        setPaintColors({})
        setMergeMode(false)
        setNotice('已合并到本地分支；提交公认版本请走 PR')
      } finally {
        setMerging(false)
      }
    })
  }

  function assignLocalSpeakers(ids: string[], speaker: string) {
    setLocalSpeakerEdits((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = speaker
      return next
    })
  }

  // 句内点胶囊：单击换下一位，Shift+点把同标签连续段一起换。
  function cycleLocalSpeaker(s: Sentence, batch: boolean) {
    const list = localSentences()
    const cycle = [...localSpeakers, '']
    const current = s.speaker ?? ''
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length]
    let ids = [s.id]
    if (batch) {
      const i = list.findIndex((x) => x.id === s.id)
      let l = i, r = i
      while (l > 0 && (list[l - 1].speaker ?? '') === current) l -= 1
      while (r < list.length - 1 && (list[r + 1].speaker ?? '') === current) r += 1
      ids = list.slice(l, r + 1).map((x) => x.id)
    }
    assignLocalSpeakers(ids, next)
    setNotice('已改发言人（本地草稿）；提交后走审批')
  }

  // 面板：改名 / 并入 / 新增，都是本地分支操作。
  function renameLocalSpeaker(from: string, to: string) {
    const ids = localSentences().filter((s) => s.speaker === from).map((s) => s.id)
    assignLocalSpeakers(ids, to)
    setNotice('已改名（本地草稿）；提交后走审批')
  }

  function mergeLocalSpeaker(from: string, into: string) {
    const ids = localSentences().filter((s) => s.speaker === from).map((s) => s.id)
    assignLocalSpeakers(ids, into)
    setNotice('已并入（本地草稿）；提交后走审批')
  }

  async function runMaterialDetectSpeakers() {
    if (!selected || !materialView || detectSpeakersBusy) return
    await run(async () => {
      setDetectSpeakersBusy(true)
      try {
        // 服务端按音色聚类，返回新的 speaker 序列（不写主分支）。
        const res = await api.detectMaterialSpeakers(selected.id, materialView.material.id, identity.device_code)
        setSentencesOverride(res.sentences)
        setLocalSpeakerEdits({})
        setLocalRoster(res.speakers ?? [])
        setNotice('已按音色重新识别（本地草稿）；提交后走审批')
      } finally {
        setDetectSpeakersBusy(false)
      }
    })
  }

  async function runMaterialPolish() {
    if (!selected || !materialView) return
    await run(async () => {
      setAiOpen(true)
      setAiDecided([])
      setAiJob(await api.polishMaterial(selected.id, materialView.material.id, identity.device_code))
    })
  }

  function acceptAiSuggestion(sug: PolishSuggestion, override?: string) {
    const after = (override ?? sug.after).trim() || sug.after
    setLocalEdits((prev) => ({ ...prev, [sug.sentence_id]: after }))
    setAiDecided((prev) => [...prev, sug.sentence_id])
    setNotice('已采纳 AI 建议，写入本地草稿；提交后走审批')
  }

  function dismissAiSuggestion(sug: PolishSuggestion) {
    setAiDecided((prev) => [...prev, sug.sentence_id])
  }

  async function runMaterialResegment() {
    if (!selected || !materialView) return
    await run(async () => {
      setResegOpen(true)
      setResegDone(false)
      setResegJob(await api.startMaterialResegment(selected.id, materialView.material.id, identity.device_code))
    })
  }

  async function applyMaterialResegment() {
    if (!resegJob || resegJob.status !== 'done' || !selected || !materialView) return
    await run(async () => {
      // 本地整段替换（本地分支可以做任何事）；提交公认版本仍必须走 PR。
      setSentencesOverride(resegJob.sentences as Sentence[])
      setLocalEdits({})
      setLocalSel([])
      setResegOpen(false)
      setResegJob(null)
      setNotice('已应用整理结果到本地分支；提交到主版本请走 PR 审批')
    })
  }

  function localSentences(): Sentence[] {
    if (!materialView) return []
    // 整段替换优先（整理断句改了句子结构/id），否则按 id 应用本地文字草稿。
    const applySpeaker = (s: Sentence): Sentence =>
      localSpeakerEdits[s.id] !== undefined ? { ...s, speaker: localSpeakerEdits[s.id] } : s
    if (sentencesOverride) return sentencesOverride.map(applySpeaker)
    return materialView.material.sentences.map((s) => {
      const withSpeaker = applySpeaker(s)
      return localEdits[s.id] !== undefined ? { ...withSpeaker, text: localEdits[s.id] } : withSpeaker
    })
  }

  // ---- 协作脱敏（标记写进材料快照；标记本身是客观事实，提交仍走 PR 留痕）----
  async function markSelection(s: Sentence) {
    if (!redactMode || !selected || !materialView) return
    const cat = redactCats.find((c) => c.id === activeCat && c.enabled)
    if (!cat) { setRedactError('请先选择一个脱敏类别'); return }
    const range = selectionRangeById(`stext-${s.id}`)
    if (!range) return
    const original = s.text.slice(range.start, range.end)
    const temp: RedactionMark = {
      id: 'tmp-' + Date.now(), sentence_id: s.id, start: range.start, end: range.end, original,
      category_id: cat.id, category_name: cat.name,
      placeholder: cat.placeholder || `[${cat.name}]`, color: cat.color,
      timestamp: new Date().toISOString(),
    }
    const snapshot = redactMarks
    setRedactMarks([...snapshot, temp])
    try {
      const res = await api.addMaterialRedactions(selected.id, materialView.material.id, identity.device_code, [
        { sentence_id: s.id, start: range.start, end: range.end, category_id: cat.id },
      ])
      setRedactMarks(res.marks)
      setRedactError('')
      setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
    } catch (e) {
      setRedactMarks(snapshot)
      setRedactError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  async function removeRedactMark(mark: RedactionMark) {
    if (!redactMode || !selected || !materialView) return
    const snapshot = redactMarks
    setRedactMarks(snapshot.filter((m) => m.id !== mark.id))
    try {
      const res = await api.deleteMaterialRedaction(selected.id, materialView.material.id, mark.id, identity.device_code)
      setRedactMarks(res.marks)
      setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
    } catch (e) {
      setRedactMarks(snapshot)
      setRedactError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  async function suggestRedactions() {
    if (!selected || !materialView) return
    await run(async () => {
      setAiSuggesting(true)
      setRedactError('')
      try {
        const res = await api.suggestMaterialRedactions(selected.id, materialView.material.id, identity.device_code)
        setAiSuggestions(res.suggestions)
        if (!res.suggestions.length) setRedactError('没有发现匹配已启用类别的敏感片段。')
      } catch (e) {
        setRedactError(String(e).replace(/^Error:\s*/, ''))
      } finally {
        setAiSuggesting(false)
      }
    })
  }

  async function acceptRedactSuggestions(items: RedactionSuggestion[]) {
    if (!selected || !materialView || !items.length) return
    await run(async () => {
      const res = await api.addMaterialRedactions(selected.id, materialView.material.id, identity.device_code, items.map((x) => ({
        sentence_id: x.sentence_id, start: x.start, end: x.end, category_id: x.category_id,
      })))
      setRedactMarks(res.marks)
      const done = new Set(items.map((x) => `${x.sentence_id}:${x.start}:${x.end}`))
      setAiSuggestions((list) => list.filter((x) => !done.has(`${x.sentence_id}:${x.start}:${x.end}`)))
      setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
    })
  }

  function openCatPanel() { setCatDraft(redactCats.map((c) => ({ ...c }))); setCatPanel((v) => !v) }

  async function saveCats() {
    if (!selected) return
    const cleaned = catDraft.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name)
    if (!cleaned.length) { setRedactError('至少保留一个类别'); return }
    setRedactCats(cleaned)
    try {
      const cs = await api.updateGroupRedactionCategories(selected.id, cleaned, identity.device_code)
      setRedactCats(cs)
      setActiveCat((prev) => (cs.some((c) => c.id === prev && c.enabled) ? prev : cs.find((c) => c.enabled)?.id || ''))
      setCatPanel(false)
    } catch (e) {
      setRedactError(String(e).replace(/^Error:\s*/, ''))
    }
  }

  async function onCreate() {
    if (!identity.nick.trim()) {
      setError('先在「设置」里设置你的代号（昵称），再创建共享任务')
      return
    }
    await run(async () => {
      await api.createGroup(newName.trim(), newMode)
      setNewName('')
      await loadGroups()
    })
  }

  async function onJoin() {
    if (!identity.nick.trim()) {
      setError('先在「设置」里设置你的代号（昵称），再加入共享任务')
      return
    }
    await run(async () => {
      const g = await api.joinGroup(joinCode.trim(), joinRole)
      setJoinCode('')
      await loadGroups()
      await loadGroup(g.id)
      setTab('material')
    })
  }

  async function onAddMaterial() {
    if (!selected || !addProject || !addRecording) return
    await run(async () => {
      await api.addGroupMaterial(selected.id, addProject, addRecording)
      setAddProject('')
      setAddRecording('')
      setRecordings([])
      await loadGroup(selected.id)
    })
  }

  async function onRemoveMaterial(materialId: string, name: string) {
    if (!selected) return
    if (!window.confirm(`撤回材料「${name}」？相关的提案也会一起清掉。`)) return
    await run(async () => {
      await api.deleteMaterial(selected.id, materialId, identity.device_code)
      if (materialView?.material.id === materialId) setMaterialView(null)
      await loadGroup(selected.id)
    })
  }

  async function onProjectChange(pid: string) {
    setAddProject(pid)
    setAddRecording('')
    setRecordings([])
    if (!pid) return
    try {
      setRecordings(await api.listRecordings(pid))
    } catch (e) {
      setError(String(e))
    }
  }

  // 有 merge 权限的人（群主 / 管理员）不必自己提提案再自己批：直接落库。
  async function onSubmitProposal(applyNow = false) {
    if (!selected || !materialView || !editSentence) return
    await run(async () => {
      const proposal = await api.createProposal(selected.id, materialView.material.id, editSentence.id, editText)
      if (applyNow) {
        await api.decideProposal(selected.id, proposal.id, true)
        setNotice('已直接合并，生成新版本')
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      } else {
        setNotice('提案已提交，等待合并')
      }
      setEditSentence(null)
      setEditText('')
      await loadGroup(selected.id)
    })
  }

  async function onSubmitDeleteSentence(s: Sentence) {
    if (!selected || !materialView) return
    if (!window.confirm(`提交删除第 ${s.index + 1} 句的提案？合并后生效，可在历史里找回。`)) return
    await run(async () => {
      await api.createDeleteProposal(selected.id, materialView.material.id, s.id)
      setNotice('删除提案已提交，等待合并')
      await loadGroup(selected.id)
    })
  }

  async function onBatchMerge(ids: string[] | null, mineOnly = false) {
    if (!selected) return
    await run(async () => {
      const res = await api.mergeProposals(selected.id, { proposalIds: ids ?? undefined, mineOnly })
      const parts = [`已合并 ${res.merged.length} 条`]
      if (res.conflicts.length) parts.push(`${res.conflicts.length} 条有冲突待人工判断`)
      if (res.skipped.length) parts.push(`跳过 ${res.skipped.length} 条`)
      setNotice(parts.join('，'))
      setProposalSel([])
      await loadGroup(selected.id)
      if (materialView) {
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      }
    })
  }

  async function onDecideProposal(id: string, accept: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decideProposal(selected.id, id, accept)
      await loadGroup(selected.id)
      if (materialView) {
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      }
    })
  }

  async function onPlayback(mode: 'burn' | 'permanent' | 'timed') {
    if (!selected || !materialView) return
    await run(async () => {
      const approval = await api.requestPlayback(selected.id, materialView.material.id, mode, 7)
      setNotice(
        approval.status === 'approved'
          ? '已直接放行，播放器已就绪'
          : '播放申请已提交，等待群主/管理员批准',
      )
      await loadGroup(selected.id)
      setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
    })
  }

  async function onDecideApproval(id: string, approve: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decidePlayback(selected.id, id, approve)
      await loadGroup(selected.id)
      if (materialView) {
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      }
    })
  }

  async function onConsume(approvalId: string) {
    if (!selected) return
    try {
      await api.consumePlayback(selected.id, approvalId)
    } catch {
      // 播放已经结束，上报失败不打扰用户
    }
  }

  async function onRoleChange(deviceCode: string, role: string) {
    if (!selected) return
    await run(async () => {
      const res = await api.updateMember(selected.id, deviceCode, role)
      if (res?.pending) setNotice('已提交群主审批：管理员互任需群主通过')
      await loadGroup(selected.id)
    })
  }

  async function onRemoveMember(deviceCode: string) {
    if (!selected) return
    await run(async () => {
      await api.removeMember(selected.id, deviceCode)
      await loadGroup(selected.id)
    })
  }

  async function onDecideRequest(id: string, approve: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decideMemberRequest(selected.id, id, approve)
      await loadGroup(selected.id)
    })
  }

  async function onSaveRole(role: string, name: string, caps: string[]) {
    if (!selected) return
    await run(async () => {
      await api.updateRole(selected.id, role, caps, name)
      setNotice('权限已保存')
      await loadGroup(selected.id)
    })
  }

  async function onCreateGrant() {
    if (!selected || !grantTarget) return
    await run(async () => {
      await api.createGrant(selected.id, {
        target: grantTarget,
        caps: grantCaps,
        scope: grantScope,
        material_ids: grantScope === 'material' ? grantMaterials : [],
        uses: grantUses.trim() ? Number(grantUses) : null,
        days: grantDays.trim() && Number(grantDays) > 0 ? Number(grantDays) : null,
        note: grantNote,
      })
      setGrantNote('')
      setGrants((await api.listGrants(selected.id)).grants)
      setNotice('授权已发放')
    })
  }

  async function onRevokeGrant(id: string) {
    if (!selected) return
    await run(async () => {
      await api.revokeGrant(selected.id, id)
      setGrants((await api.listGrants(selected.id)).grants)
      setNotice('授权已撤销')
    })
  }

  async function onAddPeer() {
    if (!peerUrl.trim()) return
    await run(async () => {
      await api.addPeer(peerUrl.trim())
      setPeerUrl('')
      await loadPeers()
      setNotice('节点已登记')
    })
  }

  async function onRemovePeer(key: string) {
    await run(async () => {
      await api.removePeer(key)
      await loadPeers()
    })
  }

  const watermark = useMemo(() => {
    const label = `${identity.nick || '本机'} · ${fmtTime(new Date().toISOString())} · 审查可见`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="190"><text x="18" y="110" font-size="13" font-family="sans-serif" fill="rgba(0,0,0,0.07)" transform="rotate(-24 150 95)">${escapeXml(label)}</text></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  }, [identity.nick])

  return (
    <div
      style={
        gridMode
          ? { display: 'contents' }
          : embedded
          ? { display: 'flex', gap: 20, width: '100%', height: '100%', minHeight: 0 }
          : {
              position: 'fixed',
              inset: 0,
              background: 'rgba(28, 32, 38, .38)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
              padding: 20,
              boxSizing: 'border-box',
            }
      }
      onClick={(e) => {
        if (embedded) return
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={
          gridMode
            ? { display: 'contents' }
            : embedded
            ? {
                flex: 1,
                width: '100%',
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }
            : {
                background: '#fff',
                borderRadius: 12,
                width: 'min(980px, 100%)',
                maxHeight: '88vh',
                overflow: 'auto',
                boxShadow: '0 18px 60px rgba(0,0,0,.22)',
                padding: 18,
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
              }
        }
      >
        {!embedded && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 17 }}>共享任务</h2>
            <span style={{ fontSize: 11, color: '#8a8f98' }}>
              一个配对码 = 一个共享任务（昵称 / 个人码在「设置」里修改）
            </span>
            <button onClick={onClose} style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}>
              关闭
            </button>
          </div>
        )}

        {(error || notice) && (
          <div style={gridMode
            ? { position: 'fixed', top: 60, left: '50%', transform: 'translateX(-50%)', zIndex: 90, background: '#fff', border: `1px solid ${error ? '#f0c9cc' : '#c9e6cf'}`, borderRadius: 8, padding: '6px 12px', fontSize: 12, color: error ? '#b00020' : '#1e7e34', boxShadow: '0 4px 16px rgba(0,0,0,.12)', maxWidth: '80%' }
            : { marginBottom: 8 }}>
            {error && <div style={{ color: '#b00020' }}>{error}</div>}
            {notice && <div style={{ color: '#1e7e34' }}>{notice}</div>}
          </div>
        )}

        <div style={gridMode ? { display: 'contents' } : { display: 'flex', gap: 20, width: '100%', flex: 1, minHeight: 0 }}>
          <aside
            className={gridMode ? 'workspace-card task-rail scroll-hidden' : undefined}
            style={{
              width: gridMode ? undefined : 260,
              gridColumn: gridMode ? 'span 1' : undefined,
              flexShrink: 0,
              background: '#fff',
              border: '1px solid #e8ebf0',
              borderRadius: 12,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>群组</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => { setJoinOpen(false); setCreateOpen((v) => !v) }}
                title="新建群组" aria-label="新建群组"
                style={{ ...ICON_BTN, width: 24, height: 24, color: createOpen ? '#245c9c' : '#5b6472' }}
              >
                <PlusIcon size={14} />
              </button>
              <button
                onClick={() => { setCreateOpen(false); setJoinOpen((v) => !v) }}
                title="加入群组" aria-label="加入群组"
                style={{ ...ICON_BTN, width: 24, height: 24, color: joinOpen ? '#245c9c' : '#5b6472' }}
              >
                <EnterIcon size={14} />
              </button>
            </div>

            {createOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="共享任务名称（如：XX 乡村访谈）"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                />
                <select
                  value={newMode}
                  onChange={(e) => setNewMode(e.target.value as 'authoritative' | 'replica')}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                >
                  <option value="authoritative">无副本（群主权威，只读播放）</option>
                  <option value="replica">有副本（节点提交与三方合并）</option>
                </select>
                <button
                  disabled={busy || !newName.trim()}
                  onClick={() => void onCreate()}
                  style={{ fontSize: 12, padding: '4px 12px' }}
                >
                  创建共享任务
                </button>
              </div>
            )}

            {joinOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                <input
                  autoFocus
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 位配对码（由群主发给你）"
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                />
                <select
                  value={joinRole}
                  onChange={(e) => setJoinRole(e.target.value as 'reader' | 'reviewer')}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                >
                  <option value="reader">只读</option>
                  <option value="reviewer">审查者（仅看版本 2 之后）</option>
                </select>
                <button
                  disabled={busy || joinCode.length !== 6}
                  onClick={() => void onJoin()}
                  style={{ fontSize: 12, padding: '4px 12px' }}
                >
                  加入共享任务
                </button>
              </div>
            )}

            <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups.length === 0 && (
                  <div style={{ fontSize: 12, color: '#999' }}>还没有共享任务，先建一个或输入配对码加入。</div>
                )}
                {groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => void selectGroup(g.id)}
                    style={{
                      textAlign: 'left',
                      border: `1px solid ${selected?.id === g.id ? '#c7d7f2' : '#e2e6ec'}`,
                      borderRadius: 8,
                      background: selected?.id === g.id ? '#e8f0fe' : '#fbfcfe',
                      padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</span>
                      <span style={{ fontSize: 11, color: '#8a8f98' }}>
                        {g.mode === 'replica' ? '有副本' : '无副本'} · {g.my_role_name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginTop: 3 }}>
                      配对码 {g.code} · {g.member_count} 人 · {g.material_count} 份材料
                      {g.pending_proposals > 0 ? ` · ${g.pending_proposals} 条待合并` : ''}
                      {g.pending_playbacks > 0 ? ` · ${g.pending_playbacks} 条播放待批` : ''}
                    </div>
                  </button>
                ))}
              </div>

              {selected && (
                <div style={{ marginTop: 14, borderTop: '1px solid #f0f2f5', paddingTop: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#8a8f98', marginBottom: 6 }}>材料</div>
                  {has('material') && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                      <select
                        value={addProject}
                        onChange={(e) => void onProjectChange(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, borderRadius: 6, padding: '3px 6px' }}
                      >
                        <option value="">选择项目</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <select
                        value={addRecording}
                        onChange={(e) => setAddRecording(e.target.value)}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, borderRadius: 6, padding: '3px 6px' }}
                      >
                        <option value="">选择录音</option>
                        {recordings.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                      <button
                        disabled={busy || !addRecording}
                        onClick={() => void onAddMaterial()}
                        style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6 }}
                      >
                        灌入当前版本
                      </button>
                      <span style={{ fontSize: 10, color: '#8a8f98' }}>
                        材料是快照；之后原录音再改不会自动同步。
                      </span>
                    </div>
                  )}
                  {materials.length === 0 ? (
                    <div style={{ fontSize: 12, color: '#999' }}>这个共享任务还没有材料。</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {materials.map((m) => (
                        <div key={m.id} style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          border: `1px solid ${materialView?.material.id === m.id ? '#c7d7f2' : '#e2e6ec'}`,
                          borderRadius: 8,
                          background: materialView?.material.id === m.id ? '#e8f0fe' : '#fbfcfe',
                          padding: '7px 9px',
                        }}>
                          <span onClick={() => void openMaterial(m.id)} style={{ flex: 1, fontSize: 12, fontWeight: 600, cursor: 'pointer', minWidth: 0 }}>{m.name}</span>
                          {m.can_remove && (
                            <button onClick={() => void onRemoveMaterial(m.id, m.name)} title="撤回这份材料（相关提案一并清掉）" style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, color: '#b00020', border: '1px solid #f0c9cc', background: '#fff', cursor: 'pointer' }}>×</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>

          <section
            className={gridMode ? 'workspace-card' : undefined}
            style={{
              flex: gridMode ? undefined : 1,
              gridColumn: gridMode ? (chatOpen ? 'span 3' : 'span 4') : undefined,
              minWidth: 0,
              background: '#fff',
              border: '1px solid #e8ebf0',
              borderRadius: 12,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden',
              boxSizing: 'border-box',
            }}
          >
            {!selected ? (
              <div style={{ margin: 'auto', fontSize: 13, color: '#8a8f98', textAlign: 'center' }}>
                从左边选择一个共享任务，或新建/加入一个。
              </div>
            ) : (
              <>
                {((mainView === 'collab' && !materialView) || !chatOpen || (requests.filter((r) => r.status === 'pending').length > 0 && has('roles'))) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                    {mainView === 'collab' && !materialView && <span style={{ fontSize: 14, fontWeight: 600 }}>{selected.name}</span>}
                    {!chatOpen && (
                      <button onClick={() => setChatOpen(true)} title="展开群聊" aria-label="展开群聊"
                        style={{ ...ICON_BTN, width: 24, height: 22, color: '#245c9c' }}>▸</button>
                    )}
                    {requests.filter((r) => r.status === 'pending').length > 0 && has('roles') && (
                      <span style={{ fontSize: 11, color: '#8a5a00' }}>
                        {requests.filter((r) => r.status === 'pending').length} 条管理员任免待你决定
                      </span>
                    )}
                  </div>
                )}

            <div style={{ display: mainView === 'collab' ? 'none' : 'flex', gap: 4, borderBottom: '1px solid #eee', marginBottom: 12 }}>
              {visibleTabs.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setTab(key); setMaterialView(null) }}
                  style={{
                    fontSize: 12,
                    padding: '5px 12px',
                    border: 'none',
                    borderBottom: tab === key ? '2px solid #245c9c' : '2px solid transparent',
                    background: 'transparent',
                    color: tab === key ? '#245c9c' : '#666',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                  {key === 'proposals' && proposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length > 0
                    ? ` (${proposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length})`
                    : ''}
                  {key === 'approvals' && approvals.filter((a) => a.status === 'pending').length > 0
                    ? ` (${approvals.filter((a) => a.status === 'pending').length})`
                    : ''}
                </button>
              ))}
            </div>

            <div className="scroll-hidden" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {/* ---- 材料 ---- */}
            {tab === 'material' && (
              materialView ? (
                <>

              <div
                onCopy={(e) => {
                  if (materialView.review_mode) e.preventDefault()
                }}
                style={{ position: 'relative', userSelect: materialView.review_mode ? 'none' : 'auto' }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{materialView.material.name}</span>
                  <span style={{ fontSize: 11, color: '#8a8f98' }}>
                    版本 {materialView.material.version} · 阶段 {materialView.material.stage} · {localSentences().length} 句
                  </span>
                  {!materialView.review_mode && workspaceMode === 'transcript' && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => void runMaterialPolish()}
                        disabled={aiJob?.status === 'running'}
                        title="用本地 AI 逐句检查错别字/语病；只给建议，采纳后写入本地草稿，提交走审批"
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #ddd', color: '#245c9c', background: '#fff' }}
                      >
                        {aiJob?.status === 'running' ? `AI 检查中 ${aiJob.processed}/${aiJob.total}…` : 'AI 纠错'}
                      </button>
                      <button
                        onClick={() => (resegJob?.status === 'running' || resegDone ? setResegOpen(true) : void runMaterialResegment())}
                        disabled={resegJob?.status === 'running' && !resegOpen}
                        title="把按停顿切碎的片段合并成完整句子；只给预览，应用后整段替换本地分支，提交走 PR"
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: '1px solid #ddd', color: '#245c9c', background: '#fff' }}
                      >
                        {resegJob?.status === 'running' ? `整理中 ${resegJob.processed}/${resegJob.total}…` : 'AI 整理断句'}
                      </button>
                      <button
                        onClick={() => setSpeakerPanelOpen((v) => !v)}
                        title="新增 / 改名 / 并入发言人，句内点标签可换人（本地草稿，提交走审批）"
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${speakerPanelOpen ? '#8ab4f8' : '#ddd'}`, color: '#245c9c', background: speakerPanelOpen ? '#eef5ff' : '#fff' }}
                      >
                        发言人
                      </button>
                      <button
                        onClick={() => { setMergeMode((v) => !v); setPaintColors({}) }}
                        title="把被 ASR 切碎的连续句子合并成一句（本地草稿，提交走审批）"
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${mergeMode ? '#8ab4f8' : '#ddd'}`, color: '#245c9c', background: mergeMode ? '#eef5ff' : '#fff' }}
                      >
                        {mergeMode ? '退出合并' : '合并句子'}
                      </button>
                      <button
                        onClick={() => setRedactMode((v) => !v)}
                        title="进入脱敏态：选中文字后点类别即可标记；导出时替换为占位符"
                        style={{ fontSize: 12, padding: '4px 10px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${redactMode ? '#f0b429' : '#ddd'}`, color: redactMode ? '#8a5a00' : '#555', background: redactMode ? '#fff4e0' : '#fff' }}
                      >
                        {redactMode ? '退出脱敏' : '脱敏'}
                      </button>
                    </div>
                  )}
                  {materialView.review_mode && (
                    <span style={{ fontSize: 11, color: '#8a5a00', background: '#fff4e0', padding: '2px 8px', borderRadius: 4 }}>
                      审查模式 · 禁复制 / 禁下载
                    </span>
                  )}
                </div>

                {speakerPanelOpen && !materialView.review_mode && workspaceMode === 'transcript' && (
                  <SpeakerPanel
                    speakers={localSpeakers}
                    order={speakerOrder}
                    onRename={renameLocalSpeaker}
                    onMerge={mergeLocalSpeaker}
                    onCreate={(name) => {
                      // 新增发言人：记一个空句子占位不可行；用本地花名册状态。
                      setLocalRoster((prev) => [...new Set([...prev, name])])
                      setNotice('已新增发言人（本地草稿）；提交后走审批')
                    }}
                    onDetect={() => { void runMaterialDetectSpeakers() }}
                    detecting={detectSpeakersBusy}
                    detectDisabled={localSentences().length < 3}
                    onClose={() => setSpeakerPanelOpen(false)}
                  />
                )}

                {redactMode && !materialView.review_mode && workspaceMode === 'transcript' && (
                  <div style={{ border: '1px solid #f0d9a8', background: '#fffcf5', borderRadius: 8, padding: 8, marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: '#8a5a00' }}>脱敏类别：</span>
                      {redactCats.filter((c) => c.enabled).map((c) => (
                        <button key={c.id} onClick={() => setActiveCat(c.id)} title={c.placeholder}
                          style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, cursor: 'pointer', border: `1px solid ${activeCat === c.id ? c.color : '#ddd'}`, background: activeCat === c.id ? `${c.color}22` : '#fff', color: c.color }}>
                          {c.name}
                        </button>
                      ))}
                      <button onClick={openCatPanel} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }} title="管理群组脱敏类别">管理类别</button>
                      <button onClick={() => void suggestRedactions()} disabled={aiSuggesting} style={{ fontSize: 11, padding: '2px 8px', cursor: 'pointer' }} title="用本地 AI 识别敏感信息（只给建议，采纳后写入标记）">
                        {aiSuggesting ? '识别中…' : 'AI 识别敏感信息'}
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 6 }}>选中正文里的文字即可标为当前类别；点已标记文字可移除。</div>
                    {redactError && <div style={{ fontSize: 11, color: '#b00020', marginBottom: 6 }}>{redactError}</div>}
                    {catPanel && (
                      <div style={{ border: '1px solid #eee', borderRadius: 6, padding: 8, marginBottom: 8, background: '#fff' }}>
                        <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>群组共用一套类别；改名不影响已有标记的语义。</div>
                        {catDraft.map((c, i) => (
                          <div key={i} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                            <input type="color" value={c.color} onChange={(e) => setCatDraft((prev) => prev.map((x, j) => j === i ? { ...x, color: e.target.value } : x))} style={{ width: 28, height: 22, padding: 0 }} />
                            <input value={c.name} onChange={(e) => setCatDraft((prev) => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} placeholder="类别名" style={{ fontSize: 11, width: 90, padding: '2px 5px' }} />
                            <input value={c.placeholder} onChange={(e) => setCatDraft((prev) => prev.map((x, j) => j === i ? { ...x, placeholder: e.target.value } : x))} placeholder="[占位符]" style={{ fontSize: 11, width: 90, padding: '2px 5px' }} />
                            <label style={{ fontSize: 10, color: '#666' }}><input type="checkbox" checked={c.enabled} onChange={(e) => setCatDraft((prev) => prev.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x))} />启用</label>
                            <button onClick={() => setCatDraft((prev) => prev.filter((_, j) => j !== i))} disabled={catDraft.length <= 1} style={{ fontSize: 11 }} title="删除类别">×</button>
                          </div>
                        ))}
                        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                          <button onClick={() => setCatDraft((prev) => [...prev, { id: 'c' + Date.now(), name: '', placeholder: '', color: '#0f766e', enabled: true }])} style={{ fontSize: 11, padding: '2px 8px' }}>+ 新增类别</button>
                          <button onClick={() => void saveCats()} style={{ fontSize: 11, padding: '2px 10px' }}>保存</button>
                          <button onClick={() => setCatPanel(false)} style={{ fontSize: 11, padding: '2px 10px' }}>取消</button>
                        </div>
                      </div>
                    )}
                    {aiSuggestions.length > 0 && (
                      <div style={{ border: '1px solid #dce6f2', borderRadius: 6, padding: 8, background: '#f8fbff' }}>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, color: '#245c9c', flex: 1 }}>AI 建议（{aiSuggestions.length}）</span>
                          <button onClick={() => void acceptRedactSuggestions(aiSuggestions)} style={{ fontSize: 11, padding: '2px 8px' }}>全部采纳</button>
                          <button onClick={() => setAiSuggestions([])} style={{ fontSize: 11, padding: '2px 8px' }}>清空</button>
                        </div>
                        {aiSuggestions.map((sug, i) => (
                          <div key={i} style={{ fontSize: 11, borderBottom: '1px solid #eef2f8', paddingBottom: 4, marginBottom: 4, lineHeight: 1.6 }}>
                            <div style={{ color: '#8a8f98' }}>第 {sug.index + 1} 句 · {sug.quote}</div>
                            <div style={{ color: '#1e7e34' }}>→ {sug.placeholder}</div>
                            <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                              <button onClick={() => void acceptRedactSuggestions([sug])} style={{ fontSize: 10, padding: '1px 8px' }}>采纳</button>
                              <button onClick={() => setAiSuggestions((list) => list.filter((_, j) => j !== i))} style={{ fontSize: 10, padding: '1px 8px' }}>忽略</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {materialView.review_mode && (
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: watermark, zIndex: 0 }} />
                )}

                <div style={{ position: 'relative', zIndex: 1 }}>
                  {materialView.review_mode && (
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>
                      仅显示阶段 2 之后的版本；历史共 {materialView.material.history.length} 条。
                    </div>
                  )}

                  {materialView.material.stale_redactions && (
                    <div style={{ fontSize: 11, color: '#b00020', background: '#fdecea', borderRadius: 6, padding: '6px 8px', marginBottom: 8 }}>
                      有句子被修改，原脱敏标记已失效。请在本机重新脱敏并刷新材料后再送审。
                    </div>
                  )}


                  {materialView.can_play && materialView.approval && workspaceMode === 'coding' ? null : materialView.can_play && materialView.approval ? (
                    <TranscriptAudio
                      audioRef={groupAudioRef}
                      onTimeUpdate={player.onTimeUpdate}
                      audioUrl={api.groupAudioUrl(selected.id, materialView.material.id, materialView.approval.id)}
                      onPlay={() => { burnStarted.current = true }}
                      onEnded={() => { burnStarted.current = false; void onConsume(materialView.approval!.id) }}
                    />
                  ) : has('view') && materialView.material.has_audio ? (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
                      <select value={playMode} onChange={(e) => setPlayMode(e.target.value as 'burn' | 'permanent' | 'timed')} style={{ fontSize: 11 }}>
                        <option value="burn">听完即毁（一次）</option>
                        <option value="permanent">长期有效</option>
                        <option value="timed">限时 7 天</option>
                      </select>
                      <button disabled={busy} onClick={() => void onPlayback(playMode)} style={{ fontSize: 11, padding: '2px 10px' }}>
                        {materialView.approval?.status === 'pending' ? '待批准' : has('approve') ? '直接播放' : '申请播放'}
                      </button>
                    </div>
                  ) : null}

                  {workspaceMode === 'coding' ? (
                    <div style={{ height: 'calc(100vh - 320px)', minHeight: 320, display: 'flex' }}>
                      <GroupCodingPanel
                        groupId={selected.id}
                        materialId={materialView.material.id}
                        sentences={materialView.material.sentences}
                        nick={identity.nick}
                        canPlay={Boolean(materialView.can_play && materialView.approval)}
                        audioSrc={
                          materialView.can_play && materialView.approval
                            ? api.groupAudioUrl(selected.id, materialView.material.id, materialView.approval.id)
                            : ''
                        }
                      />
                    </div>
                  ) : workspaceMode === 'analysis' ? (
                    <GroupAnalysisPanel
                      groupId={selected.id}
                      materialId={materialView.material.id}
                      sentences={materialView.material.sentences}
                      deviceCode={identity.device_code}
                      materialVersion={materialView.material.version}
                      pendingMerges={
                        proposals.filter(
                          (p) =>
                            p.material_id === materialView.material.id &&
                            (p.status === 'pending' || p.status === 'conflict'),
                        ).length
                      }
                    />
                  ) : workspaceMode === 'compare' ? (
                    <div className="workspace-grid" style={{ minHeight: 320 }}>
                      <ComparePanel
                        groupId={selected.id}
                        materialId={materialView.material.id}
                        sentences={materialView.material.sentences}
                      />
                    </div>
                  ) : resegOpen && resegJob ? (
<ResegmentPanel
                    preview={{ sentences: resegJob.sentences ?? [], before: resegJob.before, after: resegJob.after, model: resegJob.model }}
                    sourceSentences={localSentences()}
                    stage={resegJob.message}
                    running={resegJob.status === 'running'}
                    done={resegDone}
                    applyLabel="应用到本地分支（提交走 PR）"
                    onApply={() => { void applyMaterialResegment() }}
                    onClose={() => { setResegOpen(false) }}
                    onStop={() => { void run(async () => { setResegJob(await api.cancelMaterialResegmentJob(selected.id, materialView.material.id)) }) }}
                  />
                  ) : aiOpen && aiJob ? (
<PolishCompare
                    sentences={localSentences()}
                    suggestions={aiJob.suggestions.filter((s) => !aiDecided.includes(s.sentence_id))}
                    order={speakerOrder}
                    polishing={aiJob.status === 'running'}
                    stage={aiJob.message}
                    onSeek={(s, onlyThis) => player.seek(s, onlyThis)}
                    onAccept={(sug, override) => acceptAiSuggestion(sug, override)}
                    onDismiss={dismissAiSuggestion}
                    renderText={(s) => localEdits[s.id] ?? s.text}
                    onClose={() => setAiOpen(false)}
                    onStop={() => { void run(async () => { setAiJob(await api.cancelMaterialPolishJob(selected.id, materialView.material.id)) }) }}
                  />
                  ) : (
<TranscriptList
                    sentences={localSentences()}
                    activeId={player.activeId}
                    onPlayPressStart={player.playPressStart}
                    onPlayPressEnd={player.playPressEnd}
                    onPlayPressCancel={player.playPressCancel}
                    onRowClick={(s) => { if (mergeMode) { paintWithBrush(s.id); return } player.seek(s, true) }}
                    rowStyle={(s, active) => {
                      const color = mergeMode ? paintColors[s.id] : undefined
                      return {
                        background: mergeMode ? (color === 1 ? '#eef4ff' : color === 2 ? '#fff4e6' : '#fff') : active ? '#eef4ff' : 'transparent',
                        borderLeft: mergeMode ? `3px solid ${color === 1 ? '#1a73e8' : color === 2 ? '#f59e0b' : 'transparent'}` : active ? '3px solid #4285f4' : '3px solid transparent',
                      }
                    }}
renderBody={(s) => {
                      const draft = localEdits[s.id]
                      return <SentenceLine
                        sentence={s}
                        order={speakerOrder}
                        speakerOnClick={materialView.review_mode ? undefined : (e) => { e.stopPropagation(); cycleLocalSpeaker(s, e.shiftKey) }}
                        speakerTitle="单击换下一位发言人；Shift + 点击改整段（本地草稿，提交走审批）"
                        textId={redactMode ? `stext-${s.id}` : undefined}
                        onTextMouseUp={redactMode ? () => { void markSelection(s) } : undefined}
                        textColor={draft !== undefined ? '#8a5a00' : undefined}
                        tail={<>
                          {draft !== undefined && (
                            <span style={{ fontSize: 10, color: '#8a5a00', background: '#fff4e0', padding: '1px 5px', borderRadius: 4, alignSelf: 'flex-start' }}>本地草稿</span>
                          )}
                          {localSpeakerEdits[s.id] !== undefined && (
                            <span style={{ fontSize: 10, color: '#245c9c', background: '#eef4ff', padding: '1px 5px', borderRadius: 4, alignSelf: 'flex-start' }}>发言人已改</span>
                          )}
                          {!materialView.review_mode && has('view') && (
                            <button
                              onClick={() => { setLocalEditing(s); setLocalText(draft ?? s.text); setEditSentence(null); setError('') }}
                              title="本地改这一句（改完存入本地草稿，提交合并请到「审批」）"
                              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 22, alignSelf: 'flex-start', color: '#666', flexShrink: 0, padding: 0 }}
                            >
                              <EditIcon />
                            </button>
                          )}
                          {!materialView.review_mode && has('submit') && (
                            <button
                              onClick={(e) => { e.stopPropagation(); void onSubmitDeleteSentence(s) }}
                              title="提交删除这一句的提案（合并后生效）"
                              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 22, alignSelf: 'flex-start', color: '#b00020', border: '1px solid #f0c9cc', borderRadius: 4, background: '#fff', flexShrink: 0, padding: 0 }}
                            >
                              ×
                            </button>
                          )}
                        </>}
                        below={<>
                          {editSentence?.id === s.id && (
                            <div style={{ marginTop: 6 }}>
                              <textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={3}
                                style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                              />
                              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                <button disabled={busy || editText.trim() === s.text} onClick={() => void onSubmitProposal(has('merge'))} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  {has('merge') ? '提交并直接合并' : '提交提案'}
                                </button>
                                {has('merge') && (
                                  <button disabled={busy || editText.trim() === s.text} onClick={() => void onSubmitProposal(false)} style={{ fontSize: 11, padding: '2px 10px' }}>
                                    仅提交提案
                                  </button>
                                )}
                                <button onClick={() => { setEditSentence(null); setEditText('') }} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  取消
                                </button>
                              </div>
                            </div>
                          )}
                          {localEditing?.id === s.id && (
                            <div style={{ marginTop: 6 }}>
                              <textarea
                                value={localText}
                                onChange={(e) => setLocalText(e.target.value)}
                                rows={3}
                                style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                              />
                              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                <button disabled={localText.trim() === s.text} onClick={saveLocalEdit} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  存为本地草稿
                                </button>
                                {draft !== undefined && (
                                  <button
                                    onClick={() => {
                                      setLocalEdits((prev) => {
                                        const next = { ...prev }
                                        delete next[s.id]
                                        return next
                                      })
                                      setLocalEditing(null)
                                      setLocalText('')
                                    }}
                                    style={{ fontSize: 11, padding: '2px 10px' }}
                                  >
                                    恢复原文
                                  </button>
                                )}
                                <button onClick={() => { setLocalEditing(null); setLocalText('') }} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  取消
                                </button>
                              </div>
                            </div>
                          )}

                        </>}
                      >{renderRedactedText(
                        draft ?? s.text,
                        redactMarks.filter((m) => m.sentence_id === s.id),
                        redactMode,
                        (m) => { void removeRedactMark(m) },
                      )}</SentenceLine>
                    }}                  />                  )}
                  {mergeMode && !materialView.review_mode && (
                    <div style={{ marginTop: 8, border: '1px solid #dce6f2', borderRadius: 8, padding: 8 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, color: '#8a8f98' }}>画笔：</span>
                        {([{ value: 1, label: '蓝', bg: '#1a73e8' }, { value: 0, label: '白', bg: '#fff' }, { value: 2, label: '橙', bg: '#f59e0b' }] as const).map((o) => (
                          <button key={o.label} onClick={() => setPaintBrush(o.value)}
                            title={o.value === 0 ? '白色：取消分组' : `${o.label}色：连续的涂色句合并为一组`}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '2px 8px', borderRadius: 12, border: '1px solid #ddd', background: '#fff', cursor: 'pointer', boxShadow: paintBrush === o.value ? '0 0 0 2px #1a73e8' : 'none' }}>
                            <span style={{ width: 12, height: 12, borderRadius: 3, background: o.bg, border: '1px solid #ccc' }} />{o.label}
                          </button>
                        ))}
                        <span style={{ fontSize: 11, color: '#1a73e8', fontWeight: 600 }}>
                          {paintCount === 0 ? '尚未分组' : `${paintCount} 句已涂 · ${mergeableGroups.length} 组 · 可减少 ${mergeReducible} 句`}
                        </span>
                      </div>
                      <div style={{ height: 220, overflowY: 'auto', display: 'flex' }}>
                        <MergePanel
                          sentences={localSentences()}
                          groups={mergeableGroups}
                          reducible={mergeReducible}
                          busy={merging}
                          applyLabel={`合并全部（可减少 ${mergeReducible} 句）`}
                          hint="上方涂色 → 这里显示每组和合并结果；点「合并全部」写入本地分支，提交走 PR。"
                          onApply={() => { void applyMergeGroups() }}
                        />
                      </div>
                    </div>
                  )}
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>版本历史</div>
                    {materialView.material.history.map((h, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.7 }}>
                        {h.version} · {h.message} · {h.by} · {fmtTime(h.at)}
                      </div>
                    ))}
                  </div>

                  {!materialView.review_mode && has('submit') && Object.keys(localEdits).length > 0 && (
                    <div style={{ marginTop: 10, border: '1px solid #dce6f2', borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 6 }}>
                        本地分支（{Object.keys(localEdits).length} 处未提交改动）
                      </div>
                      <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 6 }}>
                        勾选要提交为 PR 的改动；也可以只提交一部分。
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                        {materialView.material.sentences.filter((s) => localEdits[s.id] !== undefined).map((s) => (
                          <label key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, cursor: 'pointer' }}>
                            <input type="checkbox" checked={localSel.includes(s.id)}
                              onChange={() => setLocalSel((prev) => prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id])}
                              style={{ margin: '2px 0 0' }} />
                            <span>
                              <span style={{ color: '#8a8f98' }}>第 {s.index + 1} 句：</span>
                              <span style={{ color: '#b00020', textDecoration: 'line-through' }}>{s.text}</span>
                              <span style={{ color: '#666' }}> → </span>
                              <span style={{ color: '#1e7e34' }}>{localEdits[s.id]}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button disabled={busy || localSel.length === 0} onClick={() => void submitSelectedAsPR()} style={{ fontSize: 11, padding: '2px 10px' }}>
                          提交所选为 PR（{localSel.length}）
                        </button>
                        <button disabled={busy} onClick={() => setLocalSel(materialView.material.sentences.filter((s) => localEdits[s.id] !== undefined).map((s) => s.id))} style={{ fontSize: 11, padding: '2px 10px' }}>
                          全选
                        </button>
                      </div>
                    </div>
                  )}

                  {selected.mode === 'replica' && has('merge') && !materialView.review_mode && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>
                        有副本模式：先在本地改，再提交节点合并（三方合并，冲突人工判断）。
                      </div>
                      <button
                        disabled={busy || (Object.keys(localEdits).length === 0 && !sentencesOverride)}
                        onClick={() =>
                          void run(async () => {
                            setMergeConflicts(null)
                            const res = await api.mergeSnapshot(
                              selected.id,
                              materialView.material.id,
                              materialView.material.version,
                              localSentences(),
                              false,
                              Boolean(sentencesOverride),
                            )
                            if (res.status === 'conflict') {
                              setMergeConflicts(res.conflicts || [])
                              setError(`存在 ${res.conflicts?.length || 0} 处冲突，需人工判断`)
                            } else {
                              setNotice(`节点合并完成，新版本 ${res.version}`)
                              setLocalEdits({})
                              setSentencesOverride(null)
                              setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
                              await loadGroup(selected.id)
                            }
                          })
                        }
                        style={{ fontSize: 11, padding: '2px 10px' }}
                      >
                        提交节点合并（{sentencesOverride ? `${sentencesOverride.length} 句整段替换` : `${Object.keys(localEdits).length} 句本地修改`}）
                      </button>
                      {(Object.keys(localEdits).length > 0 || sentencesOverride) && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              setLocalEdits({})
                              setSentencesOverride(null)
                              setLocalEditing(null)
                              setMergeConflicts(null)
                              setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
                              setNotice('已丢弃本地改动，对齐到主分支最新版本')
                            })
                          }
                          style={{ fontSize: 11, padding: '2px 10px', marginLeft: 6 }}
                          title="丢弃本地分支的修改，重新拉取主分支最新版本"
                        >
                          对齐主分支（丢弃本地）
                        </button>
                      )}
                      {mergeConflicts && (
                        <div style={{ marginTop: 8, border: '1px solid #f0d6a8', background: '#fffaf0', borderRadius: 8, padding: 8 }}>
                          <div style={{ fontSize: 11, color: '#8a5a00', marginBottom: 6 }}>冲突句（同一句在群组与本地都被改过）</div>
                          {mergeConflicts.map((c) => (
                            <div key={c.sentence_id} style={{ fontSize: 11, lineHeight: 1.7, marginBottom: 6 }}>
                              <div>第 {c.index + 1} 句</div>
                              <div style={{ color: '#8a8f98' }}>共同基数：{c.base}</div>
                              <div style={{ color: '#245c9c' }}>群组当前：{c.current}</div>
                              <div style={{ color: '#8a5a00' }}>本地版本：{c.incoming}</div>
                            </div>
                          ))}
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const res = await api.mergeSnapshot(
                                  selected.id,
                                  materialView.material.id,
                                  materialView.material.version,
                                  localSentences(),
                                  true,
                                  Boolean(sentencesOverride),
                                )
                                if (res.status === 'conflict') {
                                  setError('仍有冲突未解决')
                                } else {
                                  setNotice(`已采用本地版本强制合并，新版本 ${res.version}`)
                                  setMergeConflicts(null)
                                  setLocalEdits({})
                                  setSentencesOverride(null)
                                  setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
                                  await loadGroup(selected.id)
                                }
                              })
                            }
                            style={{ fontSize: 11, padding: '2px 10px' }}
                          >
                            采用本地版本强制合并
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: '#999' }}>从左边选择一条材料查看转写与播放。</div>
              )
            )}

            {/* ---- 成员与权限 ---- */}
            {tab === 'members' && (
              <div>
                <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 8 }}>
                  加入凭配对码，默认只读；审查者仅能看到阶段 2 之后的脱敏正文。管理员互任需群主通过。
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {members.map((m) => {
                    const editable =
                      has('members') &&
                      m.role !== 'owner' &&
                      (myRole === 'owner' || (m.role !== 'admin' && myRole === 'admin')) &&
                      m.device_code !== identity.device_code
                    return (
                      <div key={m.device_code} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #eee', borderRadius: 6, padding: '6px 8px' }}>
                        <span style={{ fontSize: 12, minWidth: 90 }}>{m.nick || '未命名'}</span>
                        <span style={{ fontSize: 11, color: '#8a8f98', flex: 1 }}>{m.device_code}</span>
                        {editable ? (
                          <select
                            value={m.role}
                            onChange={(e) => void onRoleChange(m.device_code, e.target.value)}
                            style={{ fontSize: 11 }}
                          >
                            {ROLE_ORDER.filter((r) => r !== 'owner').map((r) => (
                              <option key={r} value={r}>{roles[r]?.name || r}</option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ fontSize: 11, color: '#245c9c' }}>{roles[m.role]?.name || m.role}</span>
                        )}
                        {has('members') && m.role !== 'owner' && m.device_code !== identity.device_code && (
                          <button onClick={() => void onRemoveMember(m.device_code)} style={{ fontSize: 10, padding: '1px 6px', color: '#b00020' }}>
                            移除
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                {has('roles') && requests.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>管理员任免</div>
                    {requests.map((r) => (
                      <div key={r.id} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <span>{r.by_nick || '管理员'} 提议 {r.nick || r.device_code} 为管理员</span>
                        {r.status === 'pending' ? (
                          <>
                            <button onClick={() => void onDecideRequest(r.id, true)} style={{ fontSize: 10, padding: '1px 8px' }}>通过</button>
                            <button onClick={() => void onDecideRequest(r.id, false)} style={{ fontSize: 10, padding: '1px 8px' }}>拒绝</button>
                          </>
                        ) : (
                          <span>{r.status === 'approved' ? '已通过' : '已拒绝'}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {has('roles') && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>四级权限（可自定义）</div>
                    {ROLE_ORDER.map((role) => (
                      <RoleEditor
                        key={role}
                        roleKey={role}
                        role={roles[role]}
                        busy={busy}
                        onSave={(name, caps) => void onSaveRole(role, name, caps)}
                      />
                    ))}
                  </div>
                )}

                {has('approve') && (
                  <div style={{ marginTop: 18, borderTop: '1px solid #eee', paddingTop: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>单次 / 单材料授权</div>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>
                      在长期角色之外临时放权：可限定某几份材料，或用一次就失效。授权用完、过期或被撤销后立即失效。
                    </div>
                    {grants.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                        {grants.map((g) => (
                          <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, border: '1px solid #eee', borderRadius: 6, padding: '5px 8px' }}>
                            <span style={{ minWidth: 80 }}>{g.nick || g.device_code}</span>
                            <span style={{ color: '#245c9c' }}>{g.caps.map((c) => CAP_LABELS[c] || c).join('、')}</span>
                            <span style={{ color: '#6b7280', flex: 1 }}>
                              {g.scope === 'material' ? `仅 ${g.material_ids.length} 份材料` : '群内全部材料'}
                              {g.uses ? ` · ${g.used}/${g.uses} 次` : ' · 不限次数'}
                              {g.expires_at ? ` · ${fmtTime(g.expires_at)} 到期` : ''}
                            </span>
                            <span style={{ color: g.revoked ? '#b00020' : g.uses && g.used >= g.uses ? '#a16207' : '#2e7d32' }}>
                              {g.revoked ? '已撤销' : g.uses && g.used >= g.uses ? '已用完' : '生效中'}
                            </span>
                            {!g.revoked && (
                              <button onClick={() => void onRevokeGrant(g.id)} style={{ fontSize: 10, padding: '1px 6px', color: '#b00020' }}>
                                撤销
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 11 }}>
                      <select value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)}>
                        <option value="">选择成员</option>
                        {members.filter((m) => m.role !== 'owner' && m.device_code !== identity.device_code).map((m) => (
                          <option key={m.device_code} value={m.device_code}>{m.nick || m.device_code}</option>
                        ))}
                      </select>
                      <select value={grantScope} onChange={(e) => setGrantScope(e.target.value as 'group' | 'material')}>
                        <option value="material">单材料</option>
                        <option value="group">全部材料</option>
                      </select>
                      {(['view', 'edit', 'submit', 'material'] as const).map((cap) => (
                        <label key={cap} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <input
                            type="checkbox"
                            checked={grantCaps.includes(cap)}
                            onChange={(e) => setGrantCaps((prev) => e.target.checked ? [...prev, cap] : prev.filter((c) => c !== cap))}
                          />
                          {CAP_LABELS[cap] || cap}
                        </label>
                      ))}
                      <label>
                        次数
                        <input value={grantUses} onChange={(e) => setGrantUses(e.target.value)} style={{ width: 44 }} placeholder="不限" />
                      </label>
                      <label>
                        有效天数
                        <input value={grantDays} onChange={(e) => setGrantDays(e.target.value)} style={{ width: 44 }} />
                      </label>
                    </div>
                    {grantScope === 'material' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6, fontSize: 11 }}>
                        {materials.map((mat) => (
                          <label key={mat.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                            <input
                              type="checkbox"
                              checked={grantMaterials.includes(mat.id)}
                              onChange={(e) => setGrantMaterials((prev) => e.target.checked ? [...prev, mat.id] : prev.filter((x) => x !== mat.id))}
                            />
                            {mat.name || mat.id}
                          </label>
                        ))}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                      <input
                        value={grantNote}
                        onChange={(e) => setGrantNote(e.target.value)}
                        placeholder="备注（可选）"
                        style={{ flex: 1, fontSize: 11 }}
                      />
                      <button disabled={busy || !grantTarget} onClick={() => void onCreateGrant()} style={{ fontSize: 11 }}>
                        发放授权
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ---- 提案 ---- */}
            {tab === 'proposals' && (
              <div>
                <div className="seg-nav" style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                  <button className={prView === 'review' ? 'on' : ''} onClick={() => { setPrView('review'); setProposalSel([]) }}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', border: '1px solid ' + (prView === 'review' ? '#8ab4f8' : '#ddd'), background: prView === 'review' ? '#eef5ff' : '#fff', color: prView === 'review' ? '#245c9c' : '#666' }}>
                    待我审批{reviewProposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length > 0 ? ` (${reviewProposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length})` : ''}
                  </button>
                  <button className={prView === 'mine' ? 'on' : ''} onClick={() => { setPrView('mine'); setProposalSel([]) }}
                    style={{ fontSize: 12, padding: '4px 12px', borderRadius: 4, cursor: 'pointer', border: '1px solid ' + (prView === 'mine' ? '#8ab4f8' : '#ddd'), background: prView === 'mine' ? '#eef5ff' : '#fff', color: prView === 'mine' ? '#245c9c' : '#666' }}>
                    我提交的 PR{myProposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length > 0 ? ` (${myProposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length})` : ''}
                  </button>
                </div>
                {has('merge') && mergeableProposals.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                    <button
                      onClick={() =>
                        setProposalSel(allProposalsSelected ? [] : mergeableProposals.map((p) => p.id))
                      }
                      style={{ fontSize: 11, padding: '2px 10px' }}
                    >
                      {allProposalsSelected ? '取消全选' : '全选待合并'}
                    </button>
                    <button
                      disabled={busy || proposalSel.length === 0}
                      onClick={() => void onBatchMerge(proposalSel)}
                      style={{ fontSize: 11, padding: '2px 10px' }}
                    >
                      合并所选（{proposalSel.length}）
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void onBatchMerge(null, true)}
                      style={{ fontSize: 11, padding: '2px 10px' }}
                    >
                      合并我提交的
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void onBatchMerge(null)}
                      style={{ fontSize: 11, padding: '2px 10px' }}
                    >
                      合并全部待处理
                    </button>
                  </div>
                )}
                {visibleProposals.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>{prView === 'mine' ? '你还没有提交过 PR。' : '没有待你审批的提案。'}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {visibleProposals.map((p) => (
                      <div key={p.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                          {(p.status === 'pending' || p.status === 'conflict') && has('merge') && (
                            <input
                              type="checkbox"
                              checked={proposalSel.includes(p.id)}
                              onChange={() =>
                                setProposalSel((prev) =>
                                  prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                                )
                              }
                              style={{ margin: 0 }}
                            />
                          )}
                          <span>
                            第 {p.index + 1} 句 · {p.by || p.by_device} · {fmtTime(p.created_at)} ·{' '}
                            {p.kind === 'delete' && <span style={{ color: '#b00020', marginRight: 4 }}>[删除]</span>}
                            <span style={{ color: p.status === 'conflict' ? '#b00020' : p.status === 'accepted' ? '#1e7e34' : p.status === 'rejected' ? '#999' : '#8a5a00' }}>
                              {p.status === 'pending' ? '待合并' : p.status === 'accepted' ? '已合并' : p.status === 'rejected' ? '已拒绝' : '有冲突'}
                            </span>
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: '#b00020', textDecoration: 'line-through', lineHeight: 1.6 }}>{p.before}</div>
                        {p.kind !== 'delete' && <div style={{ fontSize: 12, color: '#1e7e34', lineHeight: 1.6 }}>{p.after}</div>}
                        {p.conflict_text && (
                          <div style={{ fontSize: 11, color: '#8a5a00', marginTop: 3 }}>当前正文已变为：{p.conflict_text}</div>
                        )}
                        {(p.status === 'pending' || p.status === 'conflict') && has('merge') && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button onClick={() => void onDecideProposal(p.id, true)} style={{ fontSize: 11, padding: '2px 10px' }}>
                              合并
                            </button>
                            <button onClick={() => void onDecideProposal(p.id, false)} style={{ fontSize: 11, padding: '2px 10px' }}>
                              拒绝
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 播放审批 ---- */}
            {tab === 'approvals' && (
              <div>
                <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 8 }}>
                  只读端不保存副本、看不到音频直链；申请获批后才能播放整段录音。
                </div>
                {approvals.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>还没有播放申请。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {approvals.map((a) => {
                      const material = materials.find((m) => m.id === a.material_id)
                      return (
                        <div key={a.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8, fontSize: 11 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12 }}>{a.nick || a.device_code}</span>
                            <span style={{ color: '#8a8f98' }}>{material?.name || a.material_id}</span>
                            <span style={{ color: '#8a8f98' }}>
                              {a.mode === 'burn' ? '听完即毁' : a.mode === 'permanent' ? '长期' : `限时 ${a.days} 天`}
                            </span>
                            <span style={{ color: a.status === 'approved' ? '#1e7e34' : a.status === 'pending' ? '#8a5a00' : '#999' }}>
                              {a.status === 'approved' ? '已批准' : a.status === 'pending' ? '待批' : a.status === 'used' ? '已用完' : '已拒绝'}
                            </span>
                            <span style={{ marginLeft: 'auto', color: '#8a8f98' }}>{fmtTime(a.requested_at)}</span>
                            {a.status === 'pending' && has('approve') && (
                              <>
                                <button onClick={() => void onDecideApproval(a.id, true)} style={{ fontSize: 10, padding: '1px 8px' }}>批准</button>
                                <button onClick={() => void onDecideApproval(a.id, false)} style={{ fontSize: 10, padding: '1px 8px' }}>拒绝</button>
                              </>
                            )}
                          </div>
                          {a.expires_at && <div style={{ color: '#8a8f98', marginTop: 3 }}>有效期至 {fmtTime(a.expires_at)}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ---- 访问留痕 ---- */}
            {tab === 'access' && (
              <div>
                {!has('members') ? (
                  <div style={{ fontSize: 12, color: '#999' }}>访问留痕仅群主/管理员可见。</div>
                ) : access.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>暂无记录。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {access
                      .slice()
                      .reverse()
                      .slice(0, 200)
                      .map((a) => (
                        <div key={a.id} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 8 }}>
                          <span style={{ width: 92, flexShrink: 0, color: '#9aa1ab' }}>{fmtTime(a.at)}</span>
                          <span style={{ width: 70, flexShrink: 0 }}>{a.nick || a.device_code}</span>
                          <span style={{ width: 110, flexShrink: 0, color: '#245c9c' }}>{a.action}</span>
                          <span style={{ flex: 1 }}>{a.detail}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 我的设备 ---- */}
            {tab === 'devices' && (
              <div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6, lineHeight: 1.7 }}>
                  同一局域网内的设备会自动互相发现（UDP 广播），不经过任何中心服务器。
                  <br />
                  把每台设备都设成同一个<strong>个人码 + 代号</strong>，系统就会把它们认成“同一个人”，项目与录音自动同步——
                  <strong>不需要知道 IP</strong>。
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: '#245c9c',
                    background: '#eef5ff',
                    border: '1px solid #d5e5fb',
                    borderRadius: 6,
                    padding: '7px 10px',
                    marginBottom: 12,
                  }}
                >
                  我的个人码：<strong>{identity.device_code || '未设置'}</strong> · 我的代号：<strong>{identity.nick || '未设置'}</strong>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                    还没设好？在「设置」里改昵称与个人码。
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                  <button disabled={busy} onClick={() => void run(loadPeers)} style={{ fontSize: 11 }}>
                    刷新发现的设备
                  </button>
                </div>
                {peers.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>暂未发现在线设备。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {peers.map((p) => (
                      <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '1px solid #eee', borderRadius: 6, padding: '7px 10px', fontSize: 12 }}>
                        <span style={{ minWidth: 90 }}>{p.nick || '未命名'}</span>
                        <span style={{ color: '#8a8f98', minWidth: 80 }}>{p.device_code}</span>
                        <span style={{ color: '#245c9c', flex: 1 }}>{p.base_url}</span>
                        <span style={{ fontSize: 11, color: p.same_identity ? '#2e7d32' : '#6b7280' }}>
                          {p.same_identity ? '同一人的另一台设备' : '协作节点'}
                        </span>
                        <span style={{ fontSize: 11, color: '#6b7280' }}>{p.groups.length} 个共享任务</span>
                        <span style={{ fontSize: 11, color: p.online ? '#2e7d32' : '#b00020' }}>{p.online ? '在线' : '离线'}</span>
                        <button onClick={() => void onRemovePeer(p.key)} style={{ fontSize: 10, padding: '1px 6px', color: '#b00020' }}>
                          移除
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 广播被交换机拦截时才需要手工登记；默认完全不需要用户懂 IP。 */}
                <details style={{ marginTop: 16 }}>
                  <summary style={{ fontSize: 11, color: '#8a8f98', cursor: 'pointer' }}>
                    高级：局域网广播被拦截时，手工登记一台设备
                  </summary>
                  <div style={{ fontSize: 11, color: '#8a8f98', margin: '6px 0' }}>
                    只有自动发现失败时才用；需要对方把自己的地址（形如 http://192.168.1.20:7850）发给你。
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={peerUrl}
                      onChange={(e) => setPeerUrl(e.target.value)}
                      placeholder="http://192.168.1.20:7850"
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button disabled={busy || !peerUrl.trim()} onClick={() => void onAddPeer()} style={{ fontSize: 11 }}>
                      手工登记
                    </button>
                  </div>
                </details>
              </div>
            )}
            </div>
              </>
            )}
          </section>

          {/* 右栏：群聊（辅助）。文件是文件：附件可下载、不在聊天打开；
              材料是材料：从工作区另行灌入，聊天里只给入口。 */}
          {chatOpen ? (
            <aside className={gridMode ? 'workspace-card' : undefined} style={{
              width: gridMode ? undefined : 220,
              gridColumn: gridMode ? 'span 1' : undefined,
              flexShrink: 0, background: '#fff', border: '1px solid #e8ebf0',
              borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column',
              minHeight: 0, boxSizing: 'border-box',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>群聊</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => setSettingsOpen(true)} title="群聊设置" aria-label="群聊设置" style={{ ...ICON_BTN, width: 24, height: 24 }}><GearIcon size={13} /></button>
                <button onClick={() => setChatOpen(false)} title="折叠" aria-label="折叠群聊" style={{ ...ICON_BTN, width: 24, height: 24 }}>▾</button>
              </div>
              <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {chatMsgs.length === 0 && <div style={{ fontSize: 12, color: '#999', lineHeight: 1.6 }}>还没有消息。说点什么，或发个文件。</div>}
                {chatMsgs.map((m) => {
                  const mine = m.by === chatMyDevice
                  return (
                    <div key={m.id} style={{ marginBottom: 10, display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                      <div style={{ maxWidth: '92%', background: mine ? '#e8f0fe' : '#f4f6f8', borderRadius: 8, padding: '6px 9px', fontSize: 12, color: '#2b3138' }}>
                        {!mine && <div style={{ fontSize: 10, color: '#8a8f98', marginBottom: 2 }}>{m.nick || m.by.slice(0, 6)}</div>}
                        {m.kind === 'text' && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</div>}
                        {m.kind === 'file' && (
                          <a href={api.chatFileUrl(selected?.id || '', m.file_path, m.file_name)} target="_blank" rel="noreferrer"
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#245c9c', textDecoration: 'none' }}>
                            <DownloadIcon size={13} />
                            <span>{m.file_name}</span>
                            <span style={{ fontSize: 10, color: '#8a8f98' }}>{Math.round(m.file_size / 1024)}KB</span>
                          </a>
                        )}
                        {m.kind === 'material' && (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#245c9c' }}>
                            <span style={{ fontSize: 10, border: '1px solid #8ab4f8', borderRadius: 4, padding: '0 4px' }}>材料</span>
                            <span>{m.text || '一份材料'}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                <div ref={chatEndRef} />
              </div>
              {/* 灌材料入口：材料从工作区有意识灌入，这里只告诉用户去哪灌 */}
              <div style={{ fontSize: 11, color: '#8a8f98', margin: '6px 0 4px', lineHeight: 1.5 }}>
                材料请在左侧「材料」区从工作区灌入；灌入后可在这里发一条提示。
              </div>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginTop: 4 }}>
                <input
                  ref={chatFileRef}
                  type="file"
                  hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendChatFile(f); e.target.value = '' }}
                />
                <button onClick={() => chatFileRef.current?.click()} disabled={chatSending} title="发文件" aria-label="发文件" style={{ ...ICON_BTN, width: 28, height: 28 }}><UploadIcon size={13} /></button>
                {materialView && (
                  <button onClick={() => void sendMaterialCard()} disabled={chatSending} title="把当前材料提示到群里" aria-label="分享材料提示" style={{ ...ICON_BTN, width: 28, height: 28, color: '#245c9c' }}>⊕</button>
                )}
                <input
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendChat() } }}
                  placeholder="说点什么…"
                  disabled={chatSending}
                  style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '5px 7px', border: '1px solid #e3e6ea', borderRadius: 6 }}
                />
              </div>
            </aside>
          ) : gridMode ? null : (
            <button
              onClick={() => setChatOpen(true)}
              title="展开群聊" aria-label="展开群聊"
              style={{ ...ICON_BTN, width: 30, flexShrink: 0, alignSelf: 'stretch', minHeight: 60, color: '#245c9c' }}
            >▸</button>
          )}
        </div>
      </div>

      {/* 群聊/群组设置（本群相关）：低频管理从此处进入，不默认铺在主界面 */}
      {settingsOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(16,24,40,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setSettingsOpen(false)}>
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e8ebf0', padding: '18px 20px', width: 360, maxWidth: '100%' }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>群聊设置</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setSettingsOpen(false)} title="关闭" aria-label="关闭" style={{ ...ICON_BTN, width: 26, height: 26 }}><CloseIcon size={14} /></button>
            </div>
            {selected && (
              <button
                onClick={() => void navigator.clipboard?.writeText(selected.code)}
                style={{ width: '100%', textAlign: 'left', fontSize: 13, padding: '10px 12px', border: '1px solid #c7d7f2', borderRadius: 8, background: '#f5f9ff', cursor: 'pointer', color: '#245c9c', marginBottom: 12 }}
              >
                <div style={{ fontWeight: 500 }}>配对码 {selected.code}</div>
                <div style={{ fontSize: 11, color: '#8a8f98', marginTop: 3 }}>
                  {selected.code_expires_at ? `${fmtTime(selected.code_expires_at)} 前有效 · ` : ''}点击复制，用于邀请新成员
                </div>
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {([['members', '成员与权限'], ['access', '访问留痕'], ['devices', '我的设备']] as const).map(([key, label]) => (
                <button key={key} onClick={() => { setTab(key); setSettingsOpen(false) }}
                  style={{ display: 'flex', alignItems: 'center', fontSize: 13, padding: '9px 12px', border: '1px solid #e3e6ea', borderRadius: 8, background: '#fff', cursor: 'pointer', color: '#3b4250' }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>{label}</span><span style={{ color: '#9aa0a6' }}>→</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RoleEditor({
  roleKey,
  role,
  busy,
  onSave,
}: {
  roleKey: string
  role?: CollabRole
  busy: boolean
  onSave: (name: string, caps: string[]) => void
}) {
  const [name, setName] = useState(role?.name || '')
  const [caps, setCaps] = useState<string[]>(role?.caps || [])

  useEffect(() => {
    setName(role?.name || '')
    setCaps(role?.caps || [])
  }, [role?.name, role?.caps])

  if (!role) return null
  const toggle = (cap: string) => {
    if (roleKey === 'owner' && (cap === 'roles' || cap === 'manage')) return
    setCaps((list) => (list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]))
  }

  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ fontSize: 12, width: 110 }}
          placeholder="角色名"
        />
        <span style={{ fontSize: 10, color: '#9aa1ab' }}>{roleKey}</span>
        <button disabled={busy} onClick={() => onSave(name, caps)} style={{ fontSize: 10, padding: '2px 8px', marginLeft: 'auto' }}>
          保存
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {Object.keys(CAP_LABELS).map((cap) => (
          <label key={cap} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 3, alignItems: 'center' }}>
            <input type="checkbox" checked={caps.includes(cap)} onChange={() => toggle(cap)} />
            {CAP_LABELS[cap]}
          </label>
        ))}
      </div>
    </div>
  )
}
