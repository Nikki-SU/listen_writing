import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { Recording, Sentence } from './types'

const TARGET_RATE = 16000

/** 线性重采样到 16k（部分浏览器不保证 AudioContext 的采样率）。 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input
  const ratio = from / to
  const length = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** Float32 [-1,1] → 小端 s16le。 */
function toInt16(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < input.length; i += 1) {
    const v = Math.max(-1, Math.min(1, input[i]))
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return buffer
}

function fmt(sec: number): string {
  const total = Math.floor(sec)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * 实时录音：浏览器采 16k/mono PCM，每秒一批发给本地后端；
 * 后端按静音切段增量识别，句子边录边出现，停止时把整段 PCM 落成 wav。
 */
export default function LiveRecorder({
  projectId,
  onClose,
  onFinished,
}: {
  projectId: string
  onClose: () => void
  onFinished: (recordingId: string) => void
}) {
  const [status, setStatus] = useState<'init' | 'recording' | 'stopping' | 'error'>('init')
  const [error, setError] = useState('')
  const [sentences, setSentences] = useState<Sentence[]>([])
  const [seconds, setSeconds] = useState(0)
  const [asrModel, setAsrModel] = useState('')

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pendingRef = useRef<Float32Array[]>([])
  const sendingRef = useRef(false)
  const recRef = useRef<Recording | null>(null)
  const stoppedRef = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  function detach() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    processorRef.current?.disconnect()
    processorRef.current = null
    sourceRef.current?.disconnect()
    sourceRef.current = null
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => undefined)
      ctxRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  async function flush() {
    const rec = recRef.current
    const ctx = ctxRef.current
    if (!rec || !ctx || sendingRef.current) return
    const chunks = pendingRef.current
    if (chunks.length === 0) return
    pendingRef.current = []
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    const pcm = toInt16(resample(merged, ctx.sampleRate, TARGET_RATE))
    if (pcm.byteLength === 0) return
    sendingRef.current = true
    try {
      const res = await api.sendLiveChunk(rec.project_id, rec.id, pcm)
      if (res.error) setError(res.error)
      if (res.sentences?.length) setSentences((prev) => [...prev, ...res.sentences])
      if (res.duration_sec) setSeconds(res.duration_sec)
    } catch (e) {
      setError(`发送音频失败：${String(e)}`)
    } finally {
      sendingRef.current = false
    }
  }

  async function start() {
    setStatus('init')
    setError('')
    setSentences([])
    setSeconds(0)
    stoppedRef.current = false
    pendingRef.current = []
    try {
      const { recording, asr_model } = await api.startLive(projectId, '')
      recRef.current = recording
      setAsrModel(asr_model)

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      streamRef.current = stream

      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE })
      } catch {
        ctx = new AudioContext()
      }
      ctxRef.current = ctx
      if (ctx.state === 'suspended') await ctx.resume()

      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (e) => {
        if (stoppedRef.current) return
        pendingRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      // Chrome 需要接到 destination 才会持续触发 onaudioprocess；不把声音放出来。
      processor.connect(ctx.destination)
      sourceRef.current = source
      processorRef.current = processor

      timerRef.current = setInterval(() => void flush(), 1000)
      setStatus('recording')
    } catch (e) {
      detach()
      const rec = recRef.current
      if (rec) {
        recRef.current = null
        void api.stopLive(rec.project_id, rec.id).catch(() => undefined)
      }
      setStatus('error')
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? '麦克风权限被拒绝。请在浏览器地址栏允许麦克风后重试。'
          : String(e),
      )
    }
  }

  async function stop() {
    if (stoppedRef.current) return
    stoppedRef.current = true
    setStatus('stopping')
    detach()
    const rec = recRef.current
    if (!rec) {
      onClose()
      return
    }
    // 等上一批发送完成，再把最后不足 1 秒的音频发出去
    for (let i = 0; i < 30 && sendingRef.current; i += 1) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await flush()
    recRef.current = null
    try {
      const res = await api.stopLive(rec.project_id, rec.id)
      onFinished(res.recording.id)
    } catch (e) {
      setError(`保存录音失败：${String(e)}`)
      setStatus('error')
    }
  }

  useEffect(() => {
    void start()
    return () => {
      // 用户直接关窗口时也要停麦；有会话就尽力收尾，避免后端留下半截 PCM。
      detach()
      const rec = recRef.current
      recRef.current = null
      if (rec && !stoppedRef.current) {
        void api.stopLive(rec.project_id, rec.id).catch(() => undefined)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [sentences.length])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(12, 18, 28, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: 640,
          maxWidth: '100%',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#fff',
          borderRadius: 14,
          padding: 22,
          boxShadow: '0 12px 40px rgba(16, 24, 40, 0.24)',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 5,
              background: status === 'recording' ? '#e53935' : '#c9ced6',
            }}
          />
          <h2 style={{ margin: 0, fontSize: 17, flex: 1 }}>实时录音</h2>
          <span style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.04em' }}>
            {fmt(seconds)}
          </span>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8a8f98', lineHeight: 1.7 }}>
          {status === 'init' && '正在启动麦克风…'}
          {status === 'recording' &&
            `边说边转写${asrModel ? `（${asrModel}）` : ''}。停止后会按设置里的模型再精转一遍（稍慢）。`}
          {status === 'stopping' && '正在保存录音与最后一段转写…'}
          {status === 'error' && '录音未开始或已中断。'}
        </p>

        {error && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#b00020', background: '#fdecea', borderRadius: 6, padding: '8px 10px' }}>
            {error}
          </div>
        )}

        <div
          ref={listRef}
          className="scroll-hidden"
          style={{
            marginTop: 12,
            flex: 1,
            minHeight: 180,
            maxHeight: 380,
            overflowY: 'auto',
            border: '1px solid #eef0f3',
            borderRadius: 8,
            padding: 10,
            background: '#fbfcfe',
          }}
        >
          {sentences.length === 0 ? (
            <div style={{ color: '#b0b6c0', fontSize: 13, textAlign: 'center', marginTop: 60 }}>
              {status === 'recording' ? '开始说话吧，第一句识别出来后会显示在这里' : '等待录音…'}
            </div>
          ) : (
            sentences.map((s) => (
              <div key={s.id} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: '#b0b6c0', width: 44, flexShrink: 0, paddingTop: 2 }}>
                  {fmt(s.start_ms / 1000)}
                </span>
                <span style={{ fontSize: 13, lineHeight: 1.7 }}>{s.text}</span>
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {status === 'recording' && (
            <button
              onClick={() => void stop()}
              style={{
                flex: 1,
                fontSize: 13,
                padding: '8px 16px',
                background: '#e53935',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              停止并保存
            </button>
          )}
          {status === 'error' && (
            <button
              onClick={() => void start()}
              style={{
                flex: 1,
                fontSize: 13,
                padding: '8px 16px',
                background: '#1f6feb',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              重试
            </button>
          )}
          {(status === 'init' || status === 'stopping') && (
            <button disabled style={{ flex: 1, fontSize: 13, padding: '8px 16px', opacity: 0.6 }}>
              {status === 'init' ? '正在准备…' : '正在保存…'}
            </button>
          )}
          <button
            onClick={() => {
              if (status === 'recording') {
                void stop()
              } else {
                detach()
                onClose()
              }
            }}
            style={{ fontSize: 13, padding: '8px 16px' }}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
