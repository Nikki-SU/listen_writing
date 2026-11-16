import type { MouseEvent } from 'react'
import { speakerColor } from './speakerColors'

/**
 * 发言人标签：个人录音与协作材料共用同一份渲染。
 * 同一个人按出场顺序取色，同一颜色在所有视图一致，杜绝“个人页彩色、协作页灰色”的两套皮。
 */
export function speakerOrderFrom(sentences: { speaker?: string }[]): string[] {
  return [...new Set(sentences.map((s) => s.speaker).filter(Boolean))] as string[]
}

export default function SpeakerTag({
  speaker,
  order,
  onClick,
  title,
}: {
  speaker?: string
  order: string[]
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  title?: string
}) {
  const tone = speaker ? speakerColor(speaker, order) : null
  const style = {
    fontSize: 11,
    color: tone ? tone.fg : '#8a8f98',
    background: tone ? tone.bg : '#f7f8fa',
    border: tone ? `1px solid ${tone.border}` : '1px dashed #d7dce3',
    borderRadius: 4,
    padding: '1px 6px',
    alignSelf: 'flex-start' as const,
    flexShrink: 0,
    cursor: onClick ? 'pointer' : 'default',
  }
  if (onClick) {
    return <button type="button" onClick={onClick} title={title} style={style}>{speaker || '未标注'}</button>
  }
  return <span title={title} style={style}>{speaker || '未标注'}</span>
}
