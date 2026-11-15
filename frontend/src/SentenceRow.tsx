import type { CSSProperties, ReactNode } from 'react'
import type { Sentence } from './types'

/** 转写与编码共用的句子行：只负责“播放键 / 时间 / 正文 / 侧栏”这一套排版。 */
export default function SentenceRow({
  sentence,
  active = false,
  playing = false,
  id,
  className = '',
  style,
  onClick,
  playButton,
  body,
  gutter,
  textId,
}: {
  sentence: Sentence
  active?: boolean
  playing?: boolean
  id?: string
  className?: string
  style?: CSSProperties
  onClick?: () => void
  playButton: ReactNode
  body: ReactNode
  gutter?: ReactNode
  textId?: string
}) {
  return (
    <li
      id={id}
      className={`sentence-row${active ? ' active' : ''}${playing ? ' playing' : ''}${
        className ? ` ${className}` : ''
      }`}
      style={style}
      onClick={onClick}
    >
      {playButton}
      <span className="sentence-time">{fmtMs(sentence.start_ms)}</span>
      <div className="sentence-body" id={textId}>
        {body}
      </div>
      {gutter}
    </li>
  )
}

function fmtMs(ms: number): string {
  const total = Math.floor((ms || 0) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
