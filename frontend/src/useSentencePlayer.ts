import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { Sentence } from './types'

/**
 * 句子播放器：播放器行为只有这一份实现。
 * 本地录音与协作材料共用同一个 hook，杜绝“看着一套、实则两套”。
 *
 * 职责：audio 元素引用、当前句高亮、点句只播一句、长按连播、rAF 精确卡停、
 * 播放中按时间滚动跟随。组件只管渲染句子行，不管播放逻辑。
 */
export function useSentencePlayer(
  sentences: Sentence[],
  audioRef: RefObject<HTMLAudioElement>,
) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const stopMsRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const pressTimer = useRef<number | null>(null)
  const longPressed = useRef(false)

  const stopRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  useEffect(() => () => stopRaf(), [stopRaf])

  // 播放时按时间定位当前句并滚动跟随；到句尾卡停（timeupdate 粗粒度兜底）。
  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    const ms = audio.currentTime * 1000
    const stopAt = stopMsRef.current
    if (stopAt != null && ms >= stopAt) {
      stopMsRef.current = null
      audio.pause()
    }
    const current = sentences.find((s) => ms >= s.start_ms && ms < s.end_ms)
    if (current && current.id !== activeId) {
      setActiveId(current.id)
      document.getElementById(`sentence-${current.id}`)?.scrollIntoView({ block: 'nearest' })
    }
  }, [audioRef, sentences, activeId])

  // seek 到某句；onlyThis=true 时播完这句就停，否则从这里连播。
  const seek = useCallback((s: Sentence, onlyThis = false) => {
    setActiveId(s.id)
    const audio = audioRef.current
    if (!audio) return
    stopRaf()
    const stopMs = onlyThis ? s.end_ms : null
    stopMsRef.current = stopMs
    audio.currentTime = (s.start_ms || 0) / 1000
    void audio.play().then(() => {
      if (stopMs == null || stopMsRef.current !== stopMs) return
      const tick = () => {
        const el = audioRef.current
        if (!el || el.paused || stopMsRef.current !== stopMs) {
          rafRef.current = null
          return
        }
        if (el.currentTime * 1000 >= stopMs) {
          el.pause()
          stopMsRef.current = null
          rafRef.current = null
          return
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    }).catch(() => {
      // 浏览器可能因权限/格式拒绝自动播放，用户可手点播放按钮
    })
  }, [audioRef, stopRaf])

  // 句子前 ▶：点一下只播这句；长按从这句连播。
  const playPressStart = useCallback((s: Sentence) => {
    longPressed.current = false
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      seek(s)
    }, 450)
  }, [seek])

  const playPressEnd = useCallback((s: Sentence) => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    if (!longPressed.current) seek(s, true)
    longPressed.current = false
  }, [seek])

  const playPressCancel = useCallback(() => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    longPressed.current = false
  }, [])

  // 供外部（如编码右栏“播放这一句”）注册 seek
  const registerExternalSeek = useCallback((fn: (seekFn: typeof seek) => void) => {
    fn(seek)
  }, [seek])

  return {
    activeId,
    setActiveId,
    onTimeUpdate,
    seek,
    playPressStart,
    playPressEnd,
    playPressCancel,
    registerExternalSeek,
  }
}
