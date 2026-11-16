import type { Sentence } from './types'
import { SPEAKER_PALETTE } from './speakerColors'

export type ResegmentPreview = {
  sentences: (Sentence & { source_ids?: string[] })[]
  before: number
  after: number
  model?: string
}

/**
 * AI 整理断句预览：个人录音与协作材料共用同一份界面。
 * 差异只在「应用」的含义：个人生成新版本 / 协作整段替换本地分支（提交仍走 PR）。
 */
export default function ResegmentPanel({
  preview,
  sourceSentences,
  stage,
  running,
  done,
  applyLabel,
  onApply,
  onClose,
  onStop,
}: {
  preview: ResegmentPreview
  sourceSentences: Sentence[]
  stage: string
  running: boolean
  done: boolean
  applyLabel: string
  onApply: () => void
  onClose: () => void
  onStop: () => void
}) {
  return (
    <aside style={{ flex: '1 1 0', minWidth: 240, borderLeft: '1px solid #eee', paddingLeft: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h3 style={{ fontSize: 13, margin: '0 0 6px', flex: 1 }}>AI 整理断句预览</h3>
        <span style={{ fontSize: 11, color: preview.after < preview.before ? '#1e7e34' : '#7a869a' }}>
          {preview.before} 句 → {preview.after} 句
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#8a8f98', lineHeight: 1.7, marginBottom: 8 }}>
        左边几个停顿碎片合并成一句；只动断句与标点，不增删内容。
        {stage ? ` ${stage}` : ''}
      </div>
      {!running && !done && (
        <div style={{ fontSize: 11, color: '#b26b00', marginBottom: 8 }}>
          任务已停止，下面是已完成的部分；再点「AI 整理断句」会从断点继续。未处理的句子还没整理，所以暂时不能应用。
        </div>
      )}
      <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {preview.sentences.map((s, idx) => {
          const srcIds = s.source_ids ?? [s.id]
          const sources = srcIds.map((id) => sourceSentences.find((x) => x.id === id)).filter((x): x is Sentence => Boolean(x))
          const merged = srcIds.length > 1
          const tone = SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length]
          return (
            <div key={s.id} style={{ border: `1px solid ${merged ? tone.border : '#e6ecf5'}`, borderRadius: 8, padding: 8, marginBottom: 8, background: merged ? tone.bg : '#fff' }}>
              {merged && <div style={{ fontSize: 11, color: '#8a94a6', marginBottom: 4 }}>由左边 {sources.length} 个碎片合并</div>}
              <div style={{ fontSize: merged ? 13 : 12, color: merged ? '#1e7e34' : '#5b6472', lineHeight: 1.75 }}>{s.text}</div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        {running ? (
          <>
            <button onClick={onClose} style={{ fontSize: 12, padding: '6px 12px' }}>转到后台</button>
            <button onClick={onStop} title="停止整理" aria-label="停止整理" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, color: '#b00020', background: '#fff', border: '1px solid #f0c9cc', borderRadius: 4, cursor: 'pointer' }}>■</button>
          </>
        ) : (
          <>
            <button onClick={onClose} title="关闭预览" aria-label="关闭预览" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, background: '#fff', border: '1px solid #dde3ea', borderRadius: 4, cursor: 'pointer' }}>✕</button>
            <button onClick={onApply} disabled={!done} style={{ fontSize: 12, padding: '6px 12px', background: done ? '#245c9c' : '#e3e8ef', color: done ? '#fff' : '#9aa0a6', border: 'none', borderRadius: 4, flex: 1, cursor: done ? 'pointer' : 'not-allowed' }}>
              {applyLabel}
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
