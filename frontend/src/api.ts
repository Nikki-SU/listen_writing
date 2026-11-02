// 后端 fetch 封装。地址硬编码为本地回环（引导部署后由启动器负责本项配置，见 TODO.md）。

import type { Project, Recording, RecordingDetail, Version } from './types'

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

function formatOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  return ['wav', 'mp3', 'm4a', 'wma'].includes(ext) ? ext : ''
}

export async function uploadRecording(projectId: string, file: File): Promise<Recording> {
  const fmt = formatOf(file.name)
  if (!fmt) throw new Error('不支持的音频格式（仅 wav / mp3 / m4a / wma）')
  const data = await json<{ recording: Recording }>(
    await fetch(`${BACKEND}/api/projects/${projectId}/recordings`, {
      method: 'POST',
      headers: { 'X-Filename': file.name, 'X-Format': fmt },
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