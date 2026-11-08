// 与后端 JSON 字段严格对齐（snake_case），见 API_CONTRACT.md。

export type Version = {
  frontend: number
  backend: number
  model: number
  data: number
}

export type Project = {
  id: string
  name: string
  description: string
  created_at: string
}

export type TranscribeStatus = {
  status: 'pending' | 'transcribing' | 'done' | 'error'
  progress: number
  error: string
  /** 阶段说明：加载模型 / 解码 / 正在转写，避免 0% 时看起来像卡死。 */
  message?: string
}

export type RecordingVersion = {
  stage: number
  seq: number
  current: string
}

export type Recording = {
  id: string
  project_id: string
  name: string
  audio_path: string
  format: string
  duration_sec: number
  created_at: string
  transcribe: TranscribeStatus
  version?: RecordingVersion
  speakers?: string[]
}

export type Sentence = {
  id: string
  recording_id: string
  index: number
  text: string
  start_ms: number
  end_ms: number
  speaker: string
}

export type RecordingDetail = {
  recording: Recording
  transcribe: TranscribeStatus
  sentences: Sentence[]
  redactions?: RedactionMark[]
  speakers?: string[]
}

export type DiffEntry = {
  sentence_id: string
  index: number
  op?: 'replace'
  kind?: 'text' | 'redaction'
  category?: string
  before: { id: string; index: number; text: string; speaker?: string } | string | null
  after: { id: string; index: number; text: string; speaker?: string } | string | null
}

export type RedactionCategory = {
  id: string
  name: string
  placeholder: string
  color: string
  enabled: boolean
}

export type RedactionMark = {
  id: string
  sentence_id: string
  start: number
  end: number
  original: string
  category_id: string
  category_name: string
  placeholder: string
  color: string
  timestamp?: string
}

export type VersionSummary = {
  version: string
  stage: number
  seq: number
  parent: string
  author_nick: string
  timestamp: string
  message: string
  changes: number
}

/** AI 整理断句结果：合并前后的句子数与预览正文。 */
export type ResegmentResult = {
  /** source_ids：这句由哪些原句合并而来，供预览左右对照；落盘时会被剔除。 */
  sentences: (Sentence & { source_ids?: string[] })[]
  before: number
  after: number
  current?: string
  model?: string
}

/** AI 语义纠错建议：只描述建议，正文由用户逐条采纳后才改。 */
export type PolishSuggestion = {
  sentence_id: string
  index: number
  before: string
  after: string
}

// ---- 局域网协作 ----

export type CollabRole = { name: string; caps: string[] }

export type CollabMember = {
  device_code: string
  nick: string
  role: string
  joined_at: string
}

export type CollabGroupSummary = {
  id: string
  name: string
  code: string
  mode: 'authoritative' | 'replica'
  created_at: string
  owner_device: string
  member_count: number
  material_count: number
  pending_proposals: number
  pending_playbacks: number
  pending_requests: number
  my_role?: string
  my_role_name?: string
  roles?: Record<string, CollabRole>
  code_expires_at?: string
}

export type CollabMaterial = {
  id: string
  name: string
  stage: number
  version: string
  sentence_count: number
  added_at: string
  added_by: string
  /** 已有获批的播放授权（≠ 有音频） */
  can_play: boolean
  /** 材料是否真有可播放音频；「申请播放」按钮据此启用 */
  has_audio?: boolean
}

export type CollabMaterialDetail = {
  material: CollabMaterial & {
    sentences: Sentence[]
    history: { version: string; stage: number; at: string; by: string; message: string }[]
    redactions: unknown[]
    stale_redactions?: boolean
  }
  can_play: boolean
  approval: CollabApproval | null
  review_mode: boolean
}

export type CollabProposal = {
  id: string
  material_id: string
  sentence_id: string
  index: number
  before: string
  after: string
  by_device: string
  by: string
  created_at: string
  status: 'pending' | 'accepted' | 'rejected' | 'conflict'
  conflict_text?: string
  decided_by?: string
  decided_at?: string
}

export type CollabApproval = {
  id: string
  material_id: string
  device_code: string
  nick: string
  mode: 'burn' | 'permanent' | 'timed'
  days: number
  status: 'pending' | 'approved' | 'denied' | 'used'
  requested_at: string
  granted_by?: string
  granted_at?: string
  expires_at?: string
  used_at?: string
}

export type CollabGrant = {
  id: string
  device_code: string
  nick: string
  caps: string[]
  scope: 'group' | 'material'
  material_ids: string[]
  uses: number | null
  used: number
  expires_at: string | null
  note: string
  created_by: string
  created_at: string
  revoked: boolean
  revoked_by?: string
  revoked_at?: string
}

export type PeerNode = {
  key: string
  device_code: string
  nick: string
  host: string
  port: number
  instance: string
  groups: string[]
  via: 'broadcast' | 'manual'
  last_seen: number
  online: boolean
  base_url: string
  same_identity: boolean
}

export type PeerSnapshot = {
  instance: string
  http_port: number
  discovery_port: number
  identity: { nick: string; device_code: string }
  peers: PeerNode[]
}

export type CollabAccess = {
  id: string
  at: string
  device_code: string
  nick: string
  action: string
  material_id: string
  detail: string
}

export type VersionDetail = VersionSummary & {
  recording_id: string
  diff: DiffEntry[]
  sentences: Sentence[]
}

export type AppSettings = {
  identity: { nick: string; device_code: string }
  asr_model: string
  llm_model: string
}

export type ModelOption = {
  id: string
  label: string
  min_ram: string
  speed: string
  note: string
  available: boolean
}

export type SettingsPayload = {
  settings: AppSettings
  options: { asr: ModelOption[]; llm: ModelOption[] }
}

/** 模型下载状态：下载与运行时安装分开显示，避免“模型在但跑不起来”的误解。 */
export type ModelStatus = ModelOption & {
  kind: 'asr' | 'llm'
  engine?: string
  size?: string
  downloaded: boolean
}

export type ModelJob = {
  id: string
  kind: 'asr' | 'llm'
  key: string
  label: string
  status: 'running' | 'done' | 'error'
  message: string
  progress: number
  error: string
  started_at: string
}

export type ModelsPayload = {
  asr: ModelStatus[]
  llm: ModelStatus[]
  jobs: ModelJob[]
  runtime: { llm: boolean }
}

/** AI 智能脱敏建议：只给位置与类别，采纳后仍走人工确认的 addRedactions。 */
export type RedactionSuggestion = {
  sentence_id: string
  index: number
  start: number
  end: number
  quote: string
  category_id: string
  placeholder: string
}