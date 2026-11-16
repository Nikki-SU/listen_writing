import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PolishSuggestion, Sentence } from './types'
import { CheckIcon, CrossIcon, EditIcon, PlayIcon, StopIcon } from './icons'
import SpeakerTag from './SpeakerTag'

/**
 * AI 纠错左右对照面板：个人录音与协作材料共用同一份实现。
 * 同一份建议、同一套交互（采纳/忽略/就地编辑/点句播放），杜绝两边 AI 长得不一样。
 * 差异只通过回调注入：采纳写到哪（个人存储 / 协作本地草稿）、怎么播放、发言人怎么改。
 */
export default function PolishCompare({
  sentences,
  suggestions,
  order,
  polishing,
  stage,
  onSeek,
  onSpeakerClick,
  onAccept,
  onDismiss,
  renderText,
  onClose,
  onStop,
}: {
  sentences: Sentence[]
  suggestions: PolishSuggestion[]
  order: string[]
  polishing: boolean
  stage: string
  onSeek: (s: Sentence, onlyThis: boolean) => void
  onSpeakerClick?: (s: Sentence, batch: boolean) => void
  onAccept: (sug: PolishSuggestion, override?: string) => void
  onDismiss: (sug: PolishSuggestion) => void
  renderText: (s: Sentence) => ReactNode
  onClose: () => void
  onStop?: () => void
}) {
  const [editId, setEditId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [edited, setEdited] = useState<Record<string, string>>({})
  const bySentence = new Map(suggestions.map((s) => [s.sentence_id, s]))

  function toggleEdit(sid: string, current: string) {
    if (editId === sid) {
      const text = draft.trim()
      if (text) setEdited((prev) => ({ ...prev, [sid]: text }))
      setEditId(null)
      setDraft('')
      return
    }
    setEditId(sid)
    setDraft(edited[sid] ?? current)
  }

  function fmtMs(ms: number) {
    const sec = Math.floor(ms / 1000)
    return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
  }

  return (
    <div className="scroll-hidden" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', border: '1px solid #eef1f5', borderRadius: 8 }}>
      <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', background: '#f8fbff', borderBottom: '1px solid #e6ecf5', padding: '6px 10px', fontSize: 11, color: '#6b7280' }}>
        <div>原文（{sentences.length} 句）</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ flex: 1, color: '#245c9c' }}>
            AI 修改{polishing ? ` · ${stage || '处理中…'}` : ` · ${suggestions.length} 条`}
          </span>
          {polishing && onStop && (
            <button onClick={onStop} title="停止纠错" aria-label="停止纠错" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 20, border: '1px solid #f0c9cc', color: '#b00020', background: '#fff', borderRadius: 4, cursor: 'pointer' }}><StopIcon size={11} /></button>
          )}
          <button onClick={onClose} title="关闭纠错对照" aria-label="关闭纠错对照" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 20, border: '1px solid #dde3ea', color: '#5b6472', background: '#fff', borderRadius: 4, cursor: 'pointer' }}><CrossIcon /></button>
        </div>
      </div>
      {sentences.map((s) => {
        const sug = bySentence.get(s.id)
        return (
          <div key={s.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: '1px solid #f2f4f7', background: sug ? '#f7fdf9' : '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderRight: '1px solid #f2f4f7' }}>
              <button type="button" onClick={(e) => { e.stopPropagation(); onSeek(s, true) }} title="只播这一句" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, flexShrink: 0, color: '#1d4ed8', background: '#eef4ff', border: '1px solid #dbe6ff', borderRadius: 4, cursor: 'pointer', marginTop: 1 }}>
                <PlayIcon size={11} />
              </button>
              <span style={{ fontSize: 12, color: '#999', flexShrink: 0, paddingTop: 2, fontVariantNumeric: 'tabular-nums' }}>{fmtMs(s.start_ms)}</span>
              {onSpeakerClick ? (
                <SpeakerTag speaker={s.speaker} order={order} onClick={(e) => { e.stopPropagation(); onSpeakerClick(s, e.shiftKey) }} title="点一下换下一位发言人；Shift + 点击把这一整段同标签的句子一起换" />
              ) : (
                <SpeakerTag speaker={s.speaker} order={order} />
              )}
              <div onClick={() => onSeek(s, false)} style={{ flex: 1, minWidth: 0, cursor: 'pointer', fontSize: 15, lineHeight: 1.7 }}>{renderText(s)}</div>
            </div>
            <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              {sug ? (
                <>
                  {editId === s.id ? (
                    <textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { setEditId(null); setDraft('') }
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) toggleEdit(s.id, sug.after)
                      }}
                      title="直接修改 AI 修正后的这一句；改完再点一次铅笔退出"
                      style={{ flex: 1, minWidth: 0, minHeight: 48, fontSize: 15, lineHeight: 1.7, padding: '4px 8px', boxSizing: 'border-box', resize: 'vertical', color: '#f8fafc', background: '#1f2937', border: '1px solid #111827', borderRadius: 6, caretColor: '#fff' }} />
                  ) : (
                    <div style={{ flex: 1, minWidth: 0, fontSize: 15, color: '#1e7e34', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
                      {edited[s.id] ?? sug.after}
                      {edited[s.id] != null && <span style={{ fontSize: 10, color: '#8a8f98', marginLeft: 6 }}>已手改</span>}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button onClick={() => onAccept(sug, editId === s.id ? draft : edited[s.id])} title="正确（采纳建议）" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, border: '1px solid #b7dfc2', color: '#1e7e34', background: '#fff', borderRadius: 4, cursor: 'pointer' }}><CheckIcon /></button>
                    <button onClick={() => onDismiss(sug)} title="错误（保留原文）" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, border: '1px solid #f0c9cc', color: '#b00020', background: '#fff', borderRadius: 4, cursor: 'pointer' }}><CrossIcon /></button>
                    <button onClick={() => toggleEdit(s.id, sug.after)} title={editId === s.id ? '退出编辑（保留修改）' : '自己改'} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, borderRadius: 4, cursor: 'pointer', color: editId === s.id ? '#fff' : '#5b6472', background: editId === s.id ? '#1f2937' : '#fff', border: '1px solid ' + (editId === s.id ? '#111827' : '#dde3ea') }}><EditIcon size={13} /></button>
                  </div>
                </>
              ) : (
                <span style={{ fontSize: 11, color: '#c6ccd5' }}>{polishing ? '' : '—'}</span>
              )}
            </div>
          </div>
        )
      })}
      {suggestions.length === 0 && !polishing && (
        <div style={{ padding: 20, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>未发现需要修改的句子。</div>
      )}
    </div>
  )
}
