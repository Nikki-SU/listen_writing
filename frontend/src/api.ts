// 后端 fetch 封装。地址固定本地回环：Pages 首屏检测到后端离线会进入引导部署（BootstrapGuide），
// 用户在本机跑起启动器后自动连上；录音数据全程不出本机。

import type {
  AppSettings,
  AttributeSet,
  CodingCase,
  CodingCode,
  CodingEntry,
  CodingStore,
  CollabAccess,
  CollabApproval,
  CollabChatMessage,
  CollabGroupSummary,
  CollabGrant,
  CollabMaterial,
  CollabMaterialDetail,
  CollabMember,
  CollabProposal,
  CollabRole,
  ModelJob,
  ModelsPayload,
  PeerSnapshot,
  SettingsPayload,
  Project,
  Recording,
  RecordingDetail,
  PolishSuggestion,
  RedactionCategory,
  RedactionMark,
  RedactionSuggestion,
  ResegmentResult,
  Sentence,
  Version,
  VersionDetail,
  VersionSummary,
} from './types'

// 默认连本机后端；构建时可用 VITE_BACKEND 指向同源/反向代理（留空表示同源），
// 方便在远程预览环境里验证界面，不改变桌面端的默认行为。
const BACKEND = import.meta.env.VITE_BACKEND ?? 'http://127.0.0.1:7850'

async function json<T>(res: Response | Promise<Response>): Promise<T> {
  res = await res
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      msg = (await res.json()).error || msg
    } catch {
      // 响应体非 JSON 时保留状态码
    }
    throw new Error(msg)
  }
  return res.json() as Promise<T>
}

export async function fetchHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND}/api/health`)
    return res.ok
  } catch {
    return false
  }
}

export async function fetchVersion(): Promise<Version> {
  const data = await json<{ version: Version; root?: string }>(await fetch(`${BACKEND}/api/version`))
  return { ...data.version, root: data.root }
}

/**
 * 让本地后端进程退出并重启（启动器约定退出码 86）。
 * 旧版后端没有这个接口，会返回 404 —— 此时前端提示用户手动重启一次。
 */
export async function restartBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${BACKEND}/api/restart`, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

/** 手机/平板叶子节点配对信息（仅本机可见）：局域网地址 + 6 位配对码。 */
export async function fetchLeafInfo(): Promise<{ code: string; urls: string[]; port: number }> {
  return json(await fetch(`${BACKEND}/api/leaf/info`))
}

export async function listProjects(): Promise<Project[]> {
  const data = await json<{ projects: Project[] }>(await fetch(`${BACKEND}/api/projects`))
  return data.projects
}

export async function createProject(name: string, description: string): Promise<Project> {
  const data = await json<{ project: Project }>(
    await fetch(`${BACKEND}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    }),
  )
  return data.project
}

// 上传格式白名单，与后端 main.AUDIO_FORMATS 同步（解码由后端 PyAV 内置完成）
const AUDIO_FORMATS = ['wav', 'mp3', 'm4a', 'wma', 'flac', 'ogg', 'opus', 'aac', 'aiff']

function formatOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return AUDIO_FORMATS.includes(ext) ? ext : ''
}

export async function uploadRecording(projectId: string, file: File): Promise<Recording> {
  const fmt = formatOf(file.name)
  if (!fmt) throw new Error(`不支持的音频格式（支持：${AUDIO_FORMATS.join(' / ')}）`)
  // 文件名不能放 HTTP 头：头字段只能是 ISO-8859-1，中文名（如「访谈1.mp3」）会让
  // fetch 直接抛 TypeError（Failed to read the 'headers' property ...）。改放 query，
  // URLSearchParams 会按 UTF-8 百分号编码，后端解码后拿回原名。
  const qs = new URLSearchParams({ name: file.name, format: fmt })
  const data = await json<{ recording: Recording }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings?${qs}`, {
      method: 'POST',
      body: file,
    }),
  )
  return data.recording
}

export async function listRecordings(projectId: string): Promise<Recording[]> {
  const data = await json<{ recordings: Recording[] }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings`),
  )
  return data.recordings
}

export async function fetchRecordingDetail(
  projectId: string,
  recordingId: string,
): Promise<RecordingDetail> {
  return json<RecordingDetail>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}`),
  )
}

/** 音频流地址（支持 Range）：<audio> 用它播放并精确跳转到句子开始时间。 */
export function audioUrl(projectId: string, recordingId: string): string {
  return `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/audio`
}

/** 导入逐字稿 Markdown（姓名(时:分:秒): 正文），建一个无音轨但可编码分析的条目。 */
export async function importTranscript(
  projectId: string, name: string, text: string,
): Promise<{ recording: Recording; sentences: number }> {
  return json(await fetch(`${BACKEND}/api/projects/${projectId}/recordings/import-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text }),
  }))
}

/** 删除一句（无意义句子）：重排 index、提交版本。 */
export async function deleteSentence(
  projectId: string, recordingId: string, sentenceId: string,
): Promise<{ sentences: Sentence[]; current: string }> {
  return json(await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/sentences/${sentenceId}`, {
    method: 'DELETE',
  }))
}

export async function updateSentence(
  projectId: string,
  recordingId: string,
  sentenceId: string,
  text: string,
  speaker?: string,
  options?: { advance_to?: number; source?: 'ai_polish' },
): Promise<{ sentence: Sentence; current: string }> {
  const body: { text: string; speaker?: string; advance_to?: number; source?: 'ai_polish' } = { text }
  if (speaker !== undefined) body.speaker = speaker
  if (options?.advance_to !== undefined) body.advance_to = options.advance_to
  if (options?.source) body.source = options.source
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/sentences/${sentenceId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  )
}

/** AI 长任务的统一进度：纠错用 suggestions，整理断句用 sentences。 */
export type AiJob = {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  processed: number
  total: number
  message: string
  model: string
  error: string
  suggestions: PolishSuggestion[]
  sentences: ResegmentResult['sentences']
  before: number
  after: number
}

/** 启动 AI 语义纠错：立即返回任务快照，之后用 fetchPolishJob 轮询增量结果。 */
export async function polishRecording(
  projectId: string,
  recordingId: string,
  model?: string,
): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  )
}

export async function fetchPolishJob(projectId: string, recordingId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/polish`),
  )
}

/** 停止长时间的 AI 纠错：后台线程在下一个 token 处退出，已完成建议保留。 */
export async function cancelPolishJob(projectId: string, recordingId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/polish/cancel`, {
      method: 'POST',
    }),
  )
}

/** 协作材料的 AI 纠错：与个人录音共用同一套 job/建议机制，采纳写入本地草稿、提交走 PR。 */
export async function polishMaterial(
  groupId: string, materialId: string, deviceCode: string,
): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  )
}

export async function fetchMaterialPolishJob(groupId: string, materialId: string): Promise<AiJob> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/polish`))
}

export async function cancelMaterialPolishJob(groupId: string, materialId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/polish/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: '' }),
    }),
  )
}

/** 协作材料 AI 整理断句：只出预览；采纳在本地整段替换句子，提交走 PR。 */
export async function startMaterialResegment(groupId: string, materialId: string, deviceCode: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/resegment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  )
}

export async function fetchMaterialResegmentJob(groupId: string, materialId: string): Promise<AiJob> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/resegment`))
}

export async function cancelMaterialResegmentJob(groupId: string, materialId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/resegment/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: '' }),
    }),
  )
}

/** 协作材料按音色重新识别发言人：只返回新句子序列，采纳写入本地分支、提交走 PR。 */
export async function detectMaterialSpeakers(
  groupId: string, materialId: string, deviceCode: string,
): Promise<{ sentences: Sentence[]; speakers: string[] }> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/speakers/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    }),
  )
}

// ---- 协作材料脱敏（群组级类别模板，标记写进材料快照，提交公认版本走 PR）----
export async function fetchGroupRedactionCategories(groupId: string): Promise<RedactionCategory[]> {
  const data = await json<{ categories: RedactionCategory[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/redaction`),
  )
  return data.categories
}

export async function updateGroupRedactionCategories(
  groupId: string, categories: RedactionCategory[], deviceCode: string,
): Promise<RedactionCategory[]> {
  const data = await json<{ categories: RedactionCategory[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/redaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories, device_code: deviceCode }),
    }),
  )
  return data.categories
}

export async function addMaterialRedactions(
  groupId: string, materialId: string, deviceCode: string,
  marks: { sentence_id: string; start: number; end: number; category_id: string }[],
): Promise<{ marks: RedactionMark[] }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/redactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks, device_code: deviceCode }),
  }))
}

/** 撤回自己灌入的材料（群主可撤任意材料）。 */
export async function deleteMaterial(
  groupId: string, materialId: string, deviceCode: string,
): Promise<{ status: string }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  }))
}

export async function deleteMaterialRedaction(
  groupId: string, materialId: string, markId: string, deviceCode: string,
): Promise<{ marks: RedactionMark[] }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/redactions/${markId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  }))
}

export async function suggestMaterialRedactions(
  groupId: string, materialId: string, deviceCode: string,
): Promise<{ suggestions: RedactionSuggestion[] }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/redactions/suggest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  }))
}

/** 告诉后端「这条建议已处理」：轮询时不再把它塞回来，任务跑完也不会重现。 */
export async function dismissPolishSuggestion(
  projectId: string,
  recordingId: string,
  sentenceId: string,
): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/polish/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentence_id: sentenceId }),
    }),
  )
}

/** 启动断句整理预览（apply=false）：立即返回任务快照，之后轮询增量预览。 */
export async function startResegmentPreview(
  projectId: string,
  recordingId: string,
  model?: string,
): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/resegment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply: false, model }),
    }),
  )
}

export async function fetchResegmentJob(projectId: string, recordingId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/resegment`),
  )
}

/** 停止正在跑的断句整理：已完成的部分保留在任务快照里。 */
export async function cancelResegmentJob(projectId: string, recordingId: string): Promise<AiJob> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/resegment/cancel`, {
      method: 'POST',
    }),
  )
}

/** 应用已完成的预览结果：后端按正文签名核对，对不上会重算，不会套用旧结果。 */
export async function resegmentRecording(
  projectId: string,
  recordingId: string,
  apply: boolean,
  model?: string,
): Promise<ResegmentResult> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/resegment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apply, model }),
    }),
  )
}

export type SpeakerAction =
  | { action: 'create'; name: string }
  | { action: 'rename'; from: string; to: string }
  | { action: 'merge'; from: string; into: string }
  | { action: 'assign'; sentence_ids: string[]; speaker: string }

export async function updateSpeakers(
  projectId: string,
  recordingId: string,
  payload: SpeakerAction,
): Promise<{ sentences: Sentence[]; speakers: string[]; current: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/speakers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

/** 手动合并相邻句子：按组提交，一次可合并多组（同色为一组）。 */
export async function mergeSentences(
  projectId: string,
  recordingId: string,
  groups: string[][],
): Promise<{ sentences: Sentence[]; redactions: RedactionMark[]; current: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/sentences/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups }),
    }),
  )
}

/** 只改任务/录音显示名；音频、句子与版本不动。 */
export async function renameRecording(
  projectId: string,
  recordingId: string,
  name: string,
): Promise<Recording> {
  const data = await json<{ recording: Recording }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
  return data.recording
}

/** 删除一条录音（音频、句子、版本、脱敏标记一并删除）。 */
export async function deleteRecording(projectId: string, recordingId: string): Promise<void> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}`, {
      method: 'DELETE',
    }),
  )
}

/** 删除整个项目（所有录音与版本一起删除）。 */
export async function deleteProject(projectId: string): Promise<void> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}`, {
      method: 'DELETE',
    }),
  )
}

/** 对已有录音重新识别发言人（只跑聚类，不重新转写）。 */
export async function detectSpeakers(
  projectId: string,
  recordingId: string,
): Promise<{ sentences: Sentence[]; speakers: string[]; current: string; detected: number }> {
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/speakers/detect`,
      { method: 'POST' },
    ),
  )
}

export async function listVersions(
  projectId: string,
  recordingId: string,
): Promise<VersionSummary[]> {
  const data = await json<{ versions: VersionSummary[] }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/versions`),
  )
  return data.versions
}

export async function fetchVersionDetail(
  projectId: string,
  recordingId: string,
  version: string,
): Promise<VersionDetail> {
  const data = await json<{ version: VersionDetail }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/versions/${version}`),
  )
  return data.version
}

export async function downloadExport(
  projectId: string,
  recordingId: string,
  format: 'md' | 'json',
  version?: string,
): Promise<Blob> {
  const query = new URLSearchParams({ format })
  if (version) query.set('version', version)
  const res = await fetch(
    `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/export?${query.toString()}`,
  )
  if (!res.ok) throw new Error((await res.text()) || `导出失败（${res.status}）`)
  return res.blob()
}

/** 协作材料导出：前端本地拼 md/json 下载，不改材料、走不到后端（审查模式由调用方禁用）。 */
export function downloadMaterialExport(
  name: string, sentences: Sentence[], format: 'md' | 'json',
): void {
  let content: string
  let mime: string
  if (format === 'md') {
    content = ['# ' + name, ''].concat(sentences.map((s) => {
      const t = Math.floor(s.start_ms / 1000)
      const ts = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
      return `[${ts}] **${s.speaker || ''}** ${s.text}`
    })).join('\n')
    mime = 'text/markdown'
  } else {
    content = JSON.stringify({ name, sentences }, null, 2)
    mime = 'application/json'
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.${format}`
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function fetchSettings(): Promise<SettingsPayload> {
  return json<SettingsPayload>(await fetch(`${BACKEND}/api/settings`))
}

export async function updateSettings(fields: Partial<AppSettings>): Promise<AppSettings> {
  const data = await json<{ settings: AppSettings }>(
    await fetch(`${BACKEND}/api/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  )
  return data.settings
}

// ---------- 脱敏 ----------

export async function fetchRedactionCategories(projectId: string): Promise<RedactionCategory[]> {
  const data = await json<{ categories: RedactionCategory[] }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/redaction`),
  )
  return data.categories
}

export async function updateRedactionCategories(
  projectId: string,
  categories: RedactionCategory[],
): Promise<RedactionCategory[]> {
  const data = await json<{ categories: RedactionCategory[] }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/redaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories }),
    }),
  )
  return data.categories
}

export type RedactionInput = {
  sentence_id: string
  start: number
  end: number
  category_id: string
}

export async function addRedactions(
  projectId: string,
  recordingId: string,
  marks: RedactionInput[],
): Promise<{ marks: RedactionMark[]; current: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/redactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marks }),
    }),
  )
}

export async function deleteRedaction(
  projectId: string,
  recordingId: string,
  markId: string,
): Promise<{ marks: RedactionMark[]; current: string }> {
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/redactions/${markId}`,
      { method: 'DELETE' },
    ),
  )
}
// ---- 局域网协作 ----

export async function listGroups(): Promise<{
  groups: CollabGroupSummary[]
  identity: { nick: string; device_code: string }
}> {
  return json(await fetch(`${BACKEND}/api/groups`))
}

export async function listGroupMessages(groupId: string): Promise<{
  messages: CollabChatMessage[]
  my_device: string
}> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/messages`))
}

export async function sendGroupMessage(
  groupId: string,
  msg: {
    kind: 'text' | 'file' | 'material'
    text?: string
    material_id?: string
    file_name?: string
    file_path?: string
    file_size?: number
  },
): Promise<CollabChatMessage> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }),
  )
}

/** 上传聊天附件（文件是文件，不进材料体系）。 */
export async function uploadChatFile(groupId: string, file: File): Promise<{
  file_name: string; file_path: string; file_size: number
}> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/chat/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: await file.arrayBuffer(),
    }),
  )
}

/** 聊天附件下载 URL（浏览器直接打开即下载，Content-Disposition 由后端给）。 */
export function chatFileUrl(groupId: string, stored: string, name: string): string {
  return `${BACKEND}/api/groups/${groupId}/chat/${encodeURIComponent(stored)}?name=${encodeURIComponent(name)}`
}

export async function createGroup(
  name: string,
  mode: 'authoritative' | 'replica',
): Promise<CollabGroupSummary> {
  return json(
    await fetch(`${BACKEND}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode }),
    }),
  )
}

export async function joinGroup(
  code: string,
  role: 'reader' | 'reviewer',
): Promise<CollabGroupSummary> {
  return json(
    await fetch(`${BACKEND}/api/groups/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, role }),
    }),
  )
}

export async function groupDetail(groupId: string): Promise<CollabGroupSummary> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}`))
}

export async function groupMembers(groupId: string): Promise<{
  members: CollabMember[]
  roles: Record<string, CollabRole>
  member_requests: {
    id: string
    device_code: string
    nick: string
    role: string
    by_nick: string
    at: string
    status: string
  }[]
  owner_device: string
}> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/members`))
}

export async function updateMember(
  groupId: string,
  deviceCode: string,
  role: string,
): Promise<{ member?: CollabMember; members?: CollabMember[]; pending?: unknown }> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/members/${deviceCode}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role }),
    }),
  )
}

export async function removeMember(groupId: string, deviceCode: string): Promise<{ members: CollabMember[] }> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/members/${deviceCode}`, { method: 'DELETE' }),
  )
}

// ---- 单次 / 单材料授权 ----

export async function listGrants(groupId: string): Promise<{ grants: CollabGrant[] }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/grants`))
}

export async function createGrant(
  groupId: string,
  payload: {
    target: string
    caps: string[]
    scope: 'group' | 'material'
    material_ids?: string[]
    uses?: number | null
    days?: number | null
    note?: string
  },
): Promise<CollabGrant> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/grants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  )
}

export async function revokeGrant(groupId: string, grantId: string): Promise<CollabGrant> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/grants/${grantId}`, { method: 'DELETE' }),
  )
}

// ---- 局域网节点 ----

export async function listPeers(): Promise<PeerSnapshot> {
  return json(await fetch(`${BACKEND}/api/peers`))
}

export async function addPeer(url: string): Promise<{ peers: PeerSnapshot['peers'] }> {
  return json(
    await fetch(`${BACKEND}/api/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),
  )
}

export async function removePeer(key: string): Promise<{ peers: PeerSnapshot['peers'] }> {
  return json(await fetch(`${BACKEND}/api/peers/${encodeURIComponent(key)}`, { method: 'DELETE' }))
}

export async function decideMemberRequest(
  groupId: string,
  requestId: string,
  approve: boolean,
): Promise<unknown> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/member_requests/${requestId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    }),
  )
}

export async function updateRole(
  groupId: string,
  role: string,
  caps: string[],
  name: string,
): Promise<{ roles: Record<string, CollabRole> }> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, caps, name }),
    }),
  )
}

export async function addGroupMaterial(
  groupId: string,
  projectId: string,
  recordingId: string,
): Promise<CollabMaterial> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, recording_id: recordingId }),
    }),
  )
}

export async function listGroupMaterials(groupId: string): Promise<CollabMaterial[]> {
  const data = await json<{ materials: CollabMaterial[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials`),
  )
  return data.materials
}

export async function groupMaterial(groupId: string, materialId: string): Promise<CollabMaterialDetail> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}`))
}

/** 共享材料的编码库：个人码本按设备码分开，共享码本由审批产生。 */
export type GroupCodebook = {
  id: string
  name: string
  codes: CodingCode[]
  version?: number
  approved_by?: { device_code: string; nick: string }[]
  owner_device?: string
  nick?: string
  updated_at?: string
  coder_id?: string
  is_me?: boolean
  coding_count?: number
}

/** 本机编码库（码本 + 编码 + 案例属性）落盘在项目目录，换浏览器不丢。 */
export async function getLocalCoding(projectId: string): Promise<{ store: CodingStore | null }> {
  return json(await fetch(`${BACKEND}/api/projects/${projectId}/coding`))
}

export async function saveLocalCoding(projectId: string, store: CodingStore): Promise<{ store: CodingStore }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/coding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store }),
    }),
  )
}

export type CodebookProposal = {
  id: string
  kind: 'create' | 'update'
  name: string
  codes: CodingCode[]
  base_version: number
  by_device: string
  by: string
  created_at: string
  expires_at: string
  required: string[]
  decisions: Record<string, { decision: 'approve' | 'reject'; nick?: string; at?: string }>
  approvals: { device_code: string; nick: string }[]
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  decided_at?: string
  applied_version?: number
}

export type GroupCoding = {
  material_id: string
  me: string
  nick: string
  my_codebook: GroupCodebook
  codebooks: GroupCodebook[]
  shared_codebook: GroupCodebook | null
  legacy_codes: CodingCode[]
  legacy_codebook: { id: string; name: string; updated_at?: string } | null
  /** 全量码表（个人 + 共享 + 旧版），供对比页按 id 找码。 */
  codes: CodingCode[]
  codings: CodingEntry[]
  /** 我的案例属性（个人维度，各设备独立）；属性集群组共用。 */
  cases: CodingCase[]
  attribute_sets: AttributeSet[]
  resolutions: unknown[]
  proposals: CodebookProposal[]
  can_approve: boolean
  approvers: { device_code: string; nick: string; role: string }[]
}

export async function getGroupCoding(groupId: string, materialId: string): Promise<GroupCoding> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding`))
}

export async function saveGroupCoding(
  groupId: string,
  materialId: string,
  codes: CodingCode[],
  codings: CodingEntry[],
  codebookName?: string,
): Promise<GroupCoding> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes, codings, codebook_name: codebookName || undefined }),
    }),
  )
}

/** 把我的个人码本提名为共享码本；已有共享码本时等价于提出修改。 */
export async function proposeGroupCodebook(
  groupId: string,
  materialId: string,
  name?: string,
): Promise<GroupCoding> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || undefined }),
    }),
  )
}

/** 审批共享码本提案：可单选，也可一键批量同意 / 拒绝。 */
export async function decideGroupCodebookProposals(
  groupId: string,
  materialId: string,
  ids: string[],
  decision: 'approve' | 'reject',
): Promise<GroupCoding> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding/proposals/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, decision }),
    }),
  )
}

export async function listGroupCodingCoders(
  groupId: string,
  materialId: string,
): Promise<{ coders: { coder_id: string; nick: string; count: number }[]; me: string }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding/coders`))
}

export type CodingCompareItem = { sentence_id: string; code_id: string; code_name?: string; quote: string }
export type CodingResolutionRecord = { chosen: string; at: string }
export type CodingCompare = {
  material_id: string
  a: { coder_id: string; nick: string }
  b: { coder_id: string; nick: string }
  stats: { both: number; only_a: number; only_b: number; total: number; agreement: number; jaccard: number }
  both: CodingCompareItem[]
  only_a: CodingCompareItem[]
  only_b: CodingCompareItem[]
  /** 逐条裁决留痕：按句子记「以谁为准」，只含双方各自的记录。 */
  resolutions?: {
    mine: Record<string, CodingResolutionRecord>
    peer: Record<string, CodingResolutionRecord>
  }
}

export async function compareGroupCoding(
  groupId: string,
  materialId: string,
  other: string,
): Promise<CodingCompare> {
  return json(
    await fetch(
      `${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding/compare?other=${encodeURIComponent(other)}`,
    ),
  )
}

export async function saveGroupCodingResolution(
  groupId: string,
  materialId: string,
  sentenceId: string,
  chosen: string,
): Promise<{ sentence_id: string; resolution: CodingResolutionRecord; mine: Record<string, CodingResolutionRecord> }> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/coding/resolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentence_id: sentenceId, chosen }),
    }),
  )
}

/** 材料改名（灌入者或群主）。 */
export async function renameGroupMaterial(
  groupId: string, materialId: string, deviceCode: string, name: string,
): Promise<{ status: string }> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, device_code: deviceCode }),
  }))
}

/** 保存协作材料的案例属性（我的）与属性集（群组共用）。 */
export async function saveGroupCases(
  groupId: string, materialId: string, deviceCode: string,
  cases: CodingCase[], attributeSets: AttributeSet[],
): Promise<GroupCoding> {
  return json(await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/cases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cases, attribute_sets: attributeSets, device_code: deviceCode }),
  }))
}

/** 按最新解析规则重新解析已导入的逐字稿（不必重新导文件）。 */
export async function reparseTranscript(
  projectId: string, recordingId: string,
): Promise<{ mode: string; sentences: number; speakers?: string[]; fixed?: number; note?: string }> {
  return json(await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/reparse`, { method: 'POST' }))
}

/** 提交「删除这一句」提案，等有审批权者合并后生效。 */
export async function createDeleteProposal(
  groupId: string, materialId: string, sentenceId: string,
): Promise<CollabProposal> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/sentences/${sentenceId}/delete-proposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
  )
}

export async function createProposal(
  groupId: string,
  materialId: string,
  sentenceId: string,
  after: string,
): Promise<CollabProposal> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/proposals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentence_id: sentenceId, after }),
    }),
  )
}

export async function listProposals(groupId: string): Promise<CollabProposal[]> {
  const data = await json<{ proposals: CollabProposal[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/proposals`),
  )
  return data.proposals
}

export async function decideProposal(
  groupId: string,
  proposalId: string,
  accept: boolean,
): Promise<unknown> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/proposals/${proposalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept }),
    }),
  )
}

export async function mergeProposals(
  groupId: string,
  options: { proposalIds?: string[]; mineOnly?: boolean; force?: boolean } = {},
): Promise<{
  merged: { id: string; material_id: string; index: number }[]
  conflicts: { id: string; material_id: string; index: number; current: string; incoming: string }[]
  skipped: { id: string; reason: string }[]
  versions: Record<string, string>
}> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/proposals/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_ids: options.proposalIds ?? null,
        mine_only: options.mineOnly ?? false,
        force: options.force ?? false,
      }),
    }),
  )
}

export async function requestPlayback(
  groupId: string,
  materialId: string,
  mode: 'burn' | 'permanent' | 'timed',
  days = 7,
): Promise<CollabApproval> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/playback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, days }),
    }),
  )
}

export async function listApprovals(groupId: string): Promise<CollabApproval[]> {
  const data = await json<{ approvals: CollabApproval[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/approvals`),
  )
  return data.approvals
}

export async function decidePlayback(
  groupId: string,
  approvalId: string,
  approve: boolean,
): Promise<CollabApproval> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/approvals/${approvalId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    }),
  )
}

export async function mergeSnapshot(
  groupId: string,
  materialId: string,
  parent: string,
  sentences: Sentence[],
  force = false,
  replace = false,
): Promise<{
  status: 'merged' | 'conflict'
  conflicts?: { sentence_id: string; index: number; base: string; current: string; incoming: string }[]
  version?: string
}> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, sentences, force, replace }),
    }),
  )
}

export async function groupAccess(groupId: string): Promise<CollabAccess[]> {
  const data = await json<{ access: CollabAccess[] }>(
    await fetch(`${BACKEND}/api/groups/${groupId}/access`),
  )
  return data.access
}

/** 审批门禁的播放地址：只有持有有效审批的 <audio> 才拿得到，页面不提供直链下载。 */
export function groupAudioUrl(groupId: string, materialId: string, approvalId: string): string {
  return `${BACKEND}/api/groups/${groupId}/materials/${materialId}/audio?approval_id=${encodeURIComponent(approvalId)}`
}

/** 页面关闭时用 sendBeacon 上报消费，避免绕过“听完即毁”的 onEnded。 */
export function playbackConsumeUrl(groupId: string, approvalId: string): string {
  return `${BACKEND}/api/groups/${groupId}/approvals/${approvalId}/consume`
}

/** 烧毁模式播放结束上报；服务端据此把这条审批标记为已用。 */
export async function consumePlayback(
  groupId: string,
  approvalId: string,
): Promise<CollabApproval> {
  return json(
    await fetch(`${BACKEND}/api/groups/${groupId}/approvals/${approvalId}/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  )
}

// ---- 模型管理 / 首启下载 ----

export async function fetchModels(): Promise<ModelsPayload> {
  return json(await fetch(`${BACKEND}/api/models`))
}

export async function downloadModel(kind: 'asr' | 'llm' | 'embed', key: string): Promise<ModelJob> {
  const data = await json<{ job: ModelJob }>(
    await fetch(`${BACKEND}/api/models/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, key }),
    }),
  )
  return data.job
}

/** 停止大模型下载（已下载部分保留，下次续传）。 */
export async function cancelModelJob(jobId: string): Promise<ModelJob> {
  const data = await json<{ job: ModelJob }>(
    await fetch(`${BACKEND}/api/models/jobs/${jobId}/cancel`, { method: 'POST' }),
  )
  return data.job
}

/** 转写失败后的重试；后端会复位状态并重新排队。 */
export async function retryTranscribe(
  projectId: string,
  recordingId: string,
): Promise<{ ok: boolean }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/transcribe`, {
      method: 'POST',
    }),
  )
}

/** AI 智能脱敏建议（不直接改正文）。 */
export async function suggestRedactions(
  projectId: string,
  recordingId: string,
  model?: string,
): Promise<{ suggestions: RedactionSuggestion[]; model: string }> {
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/redactions/suggest`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      },
    ),
  )
}

// ---- 实时录音 ----

export async function startLive(
  projectId: string,
  name: string,
): Promise<{ recording: Recording; asr_model: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  )
}

/** 发送一段 16kHz mono s16le PCM；返回这一批新识别出的句子。 */
export async function sendLiveChunk(
  projectId: string,
  recordingId: string,
  chunk: ArrayBuffer,
): Promise<{ sentences: Sentence[]; duration_sec: number; error?: string }> {
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/live/chunk`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: chunk,
      },
    ),
  )
}

export async function stopLive(
  projectId: string,
  recordingId: string,
): Promise<{ recording: Recording; sentences: Sentence[] }> {
  return json(
    await fetch(
      `${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/live/stop`,
      { method: 'POST' },
    ),
  )
}

// ==================== 知识库 + 证据优先对话 ====================

export type KbLibrary = {
  id: string
  name: string
  embedding_model: string
  created_at: string
  updated_at: string
  doc_count?: number
  chunk_count?: number
  ref_count?: number
}

export type KbDocument = {
  id: string
  name: string
  kb_id: string
  conversion: string
  chunk_count: number
  char_count: number
  status: string
  created_at: string
}

export type MineruInstallState = {
  status: 'not_installed' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  stage: string
  progress: number
  message: string
  error: string
  log_tail: string[]
  started_at: string
  finished_at: string
  running: boolean
  /** 断点续传：已完成的步骤与模型已下的字节数。 */
  done_stages: string[]
  resumable: boolean
  models_bytes: number
  models_required_bytes: number
}

export type MineruStatus = {
  available: boolean
  installed: boolean
  version: string
  ram_gb: number
  disk_free_gb: number
  disk_required_gb: number
  cuda: boolean
  device: string
  profile_suggestion: string
  timing_note: string
  pinned_version: string
  install: MineruInstallState
}

export type KbHit = {
  kind: 'kb'
  chunk_id: string
  doc_id: string
  doc_name: string
  kb_id: string
  kb_name: string
  text: string
  score: number
}

export type ChatRef = {
  tag: string
  kind: 'material' | 'kb'
  text: string
  doc_name?: string
  title?: string
  [key: string]: unknown
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  at?: string
  refs?: ChatRef[]
  context_chars?: number
}

export type Chat = {
  id: string
  title: string
  created_at: string
  updated_at: string
  messages: ChatMessage[]
}

export type AskResult = {
  answer: string
  citations: ChatRef[]
  invalid_citations: string[]
  fabricated_quotes: string[]
  had_evidence: boolean
  context_chars: number
  context: string
  channels?: string[]
  note?: string
}

export type MaterialChatContext = {
  group_id: string
  material_id: string
  material_name: string
  material_version: string
  review_mode: boolean
  sentences: { sentence_id: string; text: string; speaker: string }[]
  my_codings: unknown[]
  my_codebook: unknown[]
  note: string
}

export const kbApi = {
  listLibraries: () => json<{ libraries: KbLibrary[] }>(fetch(`${BACKEND}/api/kb/libraries`)),
  createLibrary: (name: string, embedding_model = '') => json<KbLibrary>(fetch(`${BACKEND}/api/kb/libraries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, embedding_model }),
  })),
  updateLibrary: (id: string, patch: Partial<Pick<KbLibrary, 'name' | 'embedding_model'>>) => json<KbLibrary>(fetch(`${BACKEND}/api/kb/libraries/${id}/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })),
  deleteLibrary: (id: string, force = false) => json<{ status: string }>(fetch(`${BACKEND}/api/kb/libraries/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' })),
  listDocs: (id: string) => json<{ docs: KbDocument[] }>(fetch(`${BACKEND}/api/kb/libraries/${id}/docs`)),
  addDocument: (id: string, name: string, text?: string, contentBase64?: string) => json<KbDocument>(fetch(`${BACKEND}/api/kb/libraries/${id}/docs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text, content_base64: contentBase64 }),
  })),
  deleteDocument: (id: string, docId: string) => json<{ status: string }>(fetch(`${BACKEND}/api/kb/libraries/${id}/docs/${docId}`, { method: 'DELETE' })),
  markdownUrl: (id: string, docId: string) => `${BACKEND}/api/kb/libraries/${id}/docs/${docId}/markdown`,
  listRefs: (projectId: string) => json<{ kb_refs: string[] }>(fetch(`${BACKEND}/api/projects/${projectId}/kb-refs`)),
  addRef: (projectId: string, kbId: string) => json<{ kb_refs: string[] }>(fetch(`${BACKEND}/api/projects/${projectId}/kb-refs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kb_id: kbId }),
  })),
  removeRef: (projectId: string, kbId: string) => json<{ kb_refs: string[] }>(fetch(`${BACKEND}/api/projects/${projectId}/kb-refs/${kbId}`, { method: 'DELETE' })),
  search: (query: string, libraryIds: string[], topK = 8) => json<{ hits: KbHit[] }>(fetch(`${BACKEND}/api/kb/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, library_ids: libraryIds, top_k: topK }),
  })),
  mineruStatus: () => json<MineruStatus>(fetch(`${BACKEND}/api/kb/mineru/status`)),
  mineruInstall: (force = false) => json<MineruStatus['install']>(fetch(`${BACKEND}/api/kb/mineru/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  })),
  mineruCancel: () => json<MineruStatus['install']>(fetch(`${BACKEND}/api/kb/mineru/install/cancel`, { method: 'POST' })),
  embedStatus: () => json<{ models: { key: string; label: string; ready: boolean }[]; max_loaded: number; loaded: string[] }>(fetch(`${BACKEND}/api/kb/embed/status`)),
  ensureEmbed: (modelKey: string) => json<{ status: string; path?: string }>(fetch(`${BACKEND}/api/kb/embed/ensure`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_key: modelKey }),
  })),
  buildIndex: (kbId: string, modelKey: string) => json<{ built: number; model: string }>(fetch(`${BACKEND}/api/kb/libraries/${kbId}/index`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_key: modelKey }),
  })),
  groupMaterialContext: (groupId: string, materialId: string, deviceCode: string) =>
    json<MaterialChatContext>(fetch(`${BACKEND}/api/groups/${groupId}/materials/${materialId}/chat-context?device_code=${encodeURIComponent(deviceCode)}`)),
}

export const chatApi = {
  listChats: (projectId: string) => json<{ chats: Chat[] }>(fetch(`${BACKEND}/api/projects/${projectId}/chats`)),
  createChat: (projectId: string, title = '') => json<Chat>(fetch(`${BACKEND}/api/projects/${projectId}/chats`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  })),
  getChat: (projectId: string, chatId: string) => json<Chat>(fetch(`${BACKEND}/api/projects/${projectId}/chats/${chatId}`)),
  deleteChat: (projectId: string, chatId: string) => json<{ status: string }>(fetch(`${BACKEND}/api/projects/${projectId}/chats/${chatId}`, { method: 'DELETE' })),
  appendMessages: (projectId: string, chatId: string, messages: ChatMessage[]) => json<Chat>(fetch(`${BACKEND}/api/projects/${projectId}/chats/${chatId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }),
  })),
  ask: (projectId: string, chatId: string, payload: ChatAskPayload) => json<AskResult>(fetch(`${BACKEND}/api/projects/${projectId}/chats/${chatId}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })),
  /** SSE 流式问答：onEvent 逐事件回调；返回 abort 函数用于取消。 */
  askStream: async (
    projectId: string, chatId: string, payload: ChatAskPayload,
    onEvent: (ev: StreamEvent) => void,
  ): Promise<{ abort: () => void }> => {
    const ctrl = new AbortController()
    const res = await fetch(`${BACKEND}/api/projects/${projectId}/chats/${chatId}/ask/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: ctrl.signal,
    })
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`
      try { msg = (await res.json()).error || msg } catch { /* ignore */ }
      throw new Error(msg)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx: number
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const line = raw.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue
            try { onEvent(JSON.parse(line.slice(6)) as StreamEvent) } catch { /* 忽略坏事件 */ }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') onEvent({ type: 'error', error: String(e) })
      }
    })()
    return { abort: () => ctrl.abort() }
  },
}

export type ChatAskPayload = {
  question: string
  history: ChatMessage[]
  material_snippets: { text: string; doc_name?: string; sentence_id?: string; material_version?: string }[]
  library_ids?: string[]
  all_libraries?: boolean
  only_evidence?: boolean
  top_k?: number
  model_key?: string
}

export type StreamEvent =
  | { type: 'sources'; citations: ChatRef[]; note: string; context_chars: number }
  | { type: 'delta'; text: string }
  | { type: 'done'; answer: string; citations: ChatRef[]; invalid_citations: string[]; fabricated_quotes: string[] }
  | { type: 'cancelled' }
  | { type: 'error'; error: string }
