import { useCallback, useEffect, useState } from 'react'
import * as api from './api'
import type { ModelJob, ModelsPayload } from './types'

/**
 * 模型清单 + 下载任务轮询。
 * 设置页与首启引导共用：只要还有 running 的任务就每 1.5 秒刷新一次进度，
 * 任务全部结束就停轮询，避免空闲时白刷接口。
 */
export function useModels(pollMs = 1500) {
  const [models, setModels] = useState<ModelsPayload | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      const m = await api.fetchModels()
      setModels(m)
      setError('')
      return m
    } catch (e) {
      setError(String(e))
      return null
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const running = models?.jobs.some((j) => j.status === 'running') ?? false
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(timer)
  }, [running, pollMs, refresh])

  const download = useCallback(
    async (kind: 'asr' | 'llm', key: string) => {
      setError('')
      try {
        await api.downloadModel(kind, key)
        await refresh()
      } catch (e) {
        setError(String(e))
      }
    },
    [refresh],
  )

  return { models, error, refresh, download }
}

/** 找到某个模型最近的一次下载任务（后端按开始时间倒序返回）。 */
export function jobFor(
  models: ModelsPayload | null,
  kind: 'asr' | 'llm',
  key: string,
): ModelJob | undefined {
  return (models?.jobs ?? []).find((j) => j.kind === kind && j.key === key)
}
