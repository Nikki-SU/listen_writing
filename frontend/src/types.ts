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
  /** 最后内容修改时间（查看不更新），列表据此排序。老数据可能没有。 */
  updated_at?: string
  transcribe: TranscribeStatus
  version?: RecordingVersion
  speakers?: string[]
  /** audio=录音；transcript=导入的逐字稿（无音轨，播放器降级，其余功能照常）。 */
  source?: 'audio' | 'transcript'
  /** 逐字稿是否带真实时间戳；false=按行序占位，不参与播放。 */
  timestamps_real?: boolean
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
  /** 可否撤回（本人灌入或群主） */
  can_remove?: boolean
}

export type CollabMaterialDetail = {
  material: CollabMaterial & {
    sentences: Sentence[]
    history: { version: string; stage: number; at: string; by: string; message: string }[]
    redactions: RedactionMark[]
    stale_redactions?: boolean
  }
  can_play: boolean
  approval: CollabApproval | null
  review_mode: boolean
}

export type CollabChatMessage = {
  id: string
  kind: 'text' | 'file' | 'material'
  by: string
  nick: string
  at: string
  text: string
  material_id: string
  file_name: string
  file_path: string
  file_size: number
  /** 是不是我自己发的（前端按 device 比对） */
  mine?: boolean
}

export type CollabProposal = {
  id: string
  material_id: string
  sentence_id: string
  index: number
  before: string
  after: string
  /** text=改文字；delete=删除整句；coding=编码改动。 */
  kind?: 'text' | 'delete' | 'coding'
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
  status: 'running' | 'done' | 'error' | 'cancelled'
  message: string
  progress: number
  error: string
  started_at: string
  /** 已下载 / 总字节：下载页显示实际进度，而不是一直停在 25%。 */
  received?: number
  total?: number
}

export type ModelsPayload = {
  asr: ModelStatus[]
  llm: ModelStatus[]
  jobs: ModelJob[]
  runtime: { llm: boolean }
}

// ---- 质性编码 ----
//
// 层级固定为：Project → Recording（音频） → Document（转写稿） → Sentence。
// 一条 Recording 对应一份 Document；Document 不再复制句子正文，正文永远来自
// RecordingDetail.sentences（录音的转写结果），避免两份文字不同步。
// 编码挂在 Document 的句子字符区间上：Coding.spans 记录每个句子内的起止偏移。

/** 逻辑文档：一条录音的转写稿。只存身份与版本，正文从录音详情读取。 */
export type CodingDocument = {
  id: string
  project_id: string
  recording_id: string
  title: string
  /** 建立编码时的转写版本（如 "2.1"）；正文改版后据此提示重锚定。 */
  transcript_version: string
  created_at: string
}

/** 码：码本里的一个节点，可挂父子层级；color 为十六进制。 */
export type CodingCode = {
  id: string
  codebook_id: string
  parent_id: string | null
  name: string
  definition: string
  color: string
  status: 'active' | 'disabled'
  created_at: string
}

/** 编码片段：一条编码可跨多句，每个 span 是句内字符区间。 */
export type CodingSpan = {
  sentence_id: string
  start: number
  end: number
}

/** 一条编码记录：片段 × 码 × 编码者。 */
export type CodingEntry = {
  id: string
  document_id: string
  code_id: string
  spans: CodingSpan[]
  /** 冗余保存的选中原文，用于列表/导出；锚点仍是 spans。 */
  quote: string
  coder_id: string
  source: 'human' | 'ai'
  created_at: string
}

/** 对比裁决：每个句子记录一次“以谁为准”。 */
export type CodingResolution = {
  document_id: string
  sentence_id: string
  side: 'me' | 'peer'
  at: string
}

/** 案例属性：NVivo 式的 case attribute（职级 / 学科 / 单位…）。 */
export type CaseAttribute = {
  id: string
  label: string
  value: string
}

/** 属性集：一类条目的字段模板（如 访谈类：访员/被访/性别/时间）。 */
export type AttributeSet = {
  id: string
  name: string
  fields: string[]
}

/** 案例：一份文档对应的访谈对象；分析按这些属性做交叉对比。 */
export type CodingCase = {
  id: string
  document_id: string
  recording_id: string
  case_name: string
  attributes: CaseAttribute[]
}

/** 前端本地编码库（后端 API 落地前先存浏览器；结构即未来接口的响应）。 */
export type CodingStore = {
  schema: 1
  project_id: string
  codebook: { id: string; name: string; updated_at: string }
  documents: CodingDocument[]
  /** 项目级属性集模板，条目可套用后再加自定义字段。 */
  attribute_sets?: AttributeSet[]
  cases: CodingCase[]
  codes: CodingCode[]
  codings: CodingEntry[]
  resolutions: CodingResolution[]
  /** 最后一次写入时间：本机与后端的 coding.json 之间用它判断谁更新。 */
  saved_at?: string
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