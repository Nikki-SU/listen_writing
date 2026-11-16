import type { ReactNode } from 'react'
import type { RedactionMark } from './types'

/**
 * 脱敏的两个纯逻辑：选区坐标计算 + 正文高亮渲染。
 * 个人录音与协作材料共用同一份——同一段文字、同一批标记，两处显示与交互完全一致。
 * 注意：正文只加彩色底纹、不替换文字（保证选区坐标不漂移）；占位符替换只发生在导出/审查视图。
 */

/** 从页面选区算出相对某句子容器的纯文本字符偏移；选区不在容器内返回 null。 */
export function selectionRangeById(containerId: string): { start: number; end: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const container = document.getElementById(containerId)
  if (!container) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  const pre = document.createRange()
  pre.selectNodeContents(container)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  const end = start + sel.toString().length
  sel.removeAllRanges()
  return end > start ? { start, end } : null
}

/** 把句子正文按脱敏标记渲染成带底纹的片段；redactMode 下点标记可移除。 */
export function renderRedactedText(
  text: string,
  marks: RedactionMark[],
  redactMode: boolean,
  onRemove?: (mark: RedactionMark) => void,
): ReactNode {
  const list = marks
    .filter((m) => m.sentence_id && m.start < m.end && m.end <= text.length)
    // 同一个句子由调用方按 sentence_id 过滤后再传入；这里只按坐标排序。
    .sort((a, b) => a.start - b.start)
  if (!list.length) return text
  const nodes: ReactNode[] = []
  let cursor = 0
  list.forEach((m, i) => {
    if (m.start < cursor) return
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start))
    nodes.push(
      <span
        key={m.id || i}
        title={`${m.category_name}：导出时替换为 ${m.placeholder}${redactMode ? '（点击移除）' : ''}`}
        onClick={(e) => { e.stopPropagation(); if (redactMode) onRemove?.(m) }}
        style={{
          background: `${m.color}22`,
          borderBottom: `2px solid ${m.color}`,
          borderRadius: 3,
          cursor: redactMode ? 'pointer' : 'text',
        }}
      >
        {text.slice(m.start, m.end)}
      </span>,
    )
    cursor = m.end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}
