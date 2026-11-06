// 后端 fetch 封装。地址固定本地回环：Pages 首屏检测到后端离线会进入引导部署（BootstrapGuide），
// 用户在本机跑起启动器后自动连上；录音数据全程不出本机。

import type {
  AppSettings,
  SettingsPayload,
  Project,
  Recording,
  RecordingDetail,
  PolishSuggestion,
  RedactionCategory,
  RedactionMark,
  Sentence,
  Version,
  VersionDetail,
  VersionSummary,
} from './types'

const BACKEND = 'http://127.0.0.1:7850'

async function json<T>(res: Response): Promise<T> {
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
  const data = await json<{ version: Version }>(await fetch(`${BACKEND}/api/version`))
  return data.version
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

/** AI 语义纠错：只取建议，不改正文（POST 会阻塞到模型跑完，首次可能还要下载模型）。 */
export async function polishRecording(
  projectId: string,
  recordingId: string,
  model?: string,
): Promise<{ suggestions: PolishSuggestion[]; model: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/polish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  )
}

export type SpeakerAction =
  | { action: 'rename'; from: string; to: string }
  | { action: 'merge'; from: string; into: string }
  | { action: 'assign'; sentence_ids: string[]; speaker: string }

export async function updateSpeakers(
  projectId: string,
  recordingId: string,
  payload: SpeakerAction,
): Promise<{ sentences: Sentence[]; current: string }> {
  return json(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings/${recordingId}/speakers`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
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