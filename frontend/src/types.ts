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
}

export type DiffEntry = {
  sentence_id: string
  index: number
  op: 'replace'
  before: { id: string; index: number; text: string; speaker?: string } | null
  after: { id: string; index: number; text: string; speaker?: string } | null
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