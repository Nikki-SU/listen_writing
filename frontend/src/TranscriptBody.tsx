import type { CSSProperties, ReactNode, RefObject } from 'react'
import type { Sentence } from './types'
import SentenceRow from './SentenceRow'

/**
 * 转写正文的共享骨架——播放器与句子列表只有这一份实现。
 * 本地录音与协作材料都用它，行内容（发言人/编辑/脱敏/提案按钮）由调用方注入。
 * 拆成两个组件，是为了让“播放器常驻、句子列表按模式切换”的页面也能各取所需。
 */

export function TranscriptAudio({
  audioUrl,
  audioRef,
  onTimeUpdate,
  onPlay,
  onEnded,
}: {
  audioUrl: string
  audioRef: RefObject<HTMLAudioElement>
  onTimeUpdate: () => void
  onPlay?: () => void
  onEnded?: () => void
}) {
  return (
    <audio
      ref={audioRef}
      src={audioUrl}
      controls
      preload="metadata"
      onTimeUpdate={onTimeUpdate}
      onPlay={onPlay}
      onEnded={onEnded}
      style={{ width: '100%', height: 36, marginBottom: 10 }}
    />
  )
}

export function TranscriptList({
  sentences,
  activeId,
  onPlayPressStart,
  onPlayPressEnd,
  onPlayPressCancel,
  onRowClick,
  renderBody,
  renderGutter,
  rowStyle,
  emptyText,
}: {
  sentences: Sentence[]
  activeId: string | null
  onPlayPressStart: (s: Sentence) => void
  onPlayPressEnd: (s: Sentence) => void
  onPlayPressCancel: () => void
  onRowClick?: (s: Sentence) => void
  renderBody: (s: Sentence) => ReactNode
  renderGutter?: (s: Sentence) => ReactNode
  rowStyle?: (s: Sentence, active: boolean) => CSSProperties | undefined
  emptyText?: string
}) {
  if (sentences.length === 0) {
    return <div style={{ fontSize: 13, color: '#aaa', padding: 16, textAlign: 'center' }}>{emptyText ?? '还没有句子。'}</div>
  }
  return (
    <ul className="scroll-hidden" style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minWidth: 0, minHeight: 0 }}>
      {sentences.map((s) => {
        const active = s.id === activeId
        return (
          <SentenceRow
            key={s.id}
            sentence={s}
            id={`sentence-${s.id}`}
            active={active}
            onClick={() => onRowClick?.(s)}
            style={rowStyle?.(s, active)}
            playButton={
              <button
                type="button"
                title="点一下只播这一句；长按从这一句开始连播"
                onPointerDown={(e) => { e.stopPropagation(); onPlayPressStart(s) }}
                onPointerUp={(e) => { e.stopPropagation(); onPlayPressEnd(s) }}
                onPointerLeave={onPlayPressCancel}
                onPointerCancel={onPlayPressCancel}
                onContextMenu={(e) => e.preventDefault()}
                onClick={(e) => e.stopPropagation()}
                style={{
                  flexShrink: 0, fontSize: 12, lineHeight: 1.2, padding: '3px 8px',
                  alignSelf: 'flex-start', color: '#1d4ed8', background: '#eef4ff',
                  border: 'none', borderRadius: 8, cursor: 'pointer',
                  touchAction: 'manipulation', userSelect: 'none',
                }}
              >
                ▶
              </button>
            }
            body={renderBody(s)}
            gutter={renderGutter?.(s)}
          />
        )
      })}
    </ul>
  )
}
