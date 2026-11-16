import type { Sentence } from './types'
import { SPEAKER_PALETTE } from './speakerColors'

/**
 * 多句合并预览：个人录音与协作材料共用同一份界面。
 * 差异只在「合并」落点：个人写本地录音新版本 / 协作整段替换本地分支（提交走 PR）。
 */
export default function MergePanel({
  sentences,
  groups,
  reducible,
  busy,
  applyLabel,
  hint,
  onApply,
}: {
  sentences: Sentence[]
  groups: string[][]
  reducible: number
  busy: boolean
  applyLabel: string
  hint: string
  onApply: () => void
}) {
  return (
    <aside style={{ flex: '1 1 0', minWidth: 240, borderLeft: '1px solid #eee', paddingLeft: 14, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>合并预览（{groups.length} 组）</h3>
      <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>{hint}</div>
      <div className="scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {groups.length === 0 ? (
          <div style={{ fontSize: 12, color: '#9aa0a6', marginTop: 20 }}>
            还没有分组：在左边用蓝 / 橙画笔点选连续句子（白色表示不合并）。
          </div>
        ) : (
          groups.map((ids, gi) => {
            const items = ids.map((id) => sentences.find((x) => x.id === id)).filter((x): x is Sentence => Boolean(x))
            const chars = items.reduce((n, x) => n + x.text.length, 0)
            const tone = SPEAKER_PALETTE[gi % SPEAKER_PALETTE.length]
            return (
              <div key={gi} style={{ border: `1px solid ${tone.border}`, background: tone.bg, borderRadius: 8, padding: 10, marginBottom: 8 }}>
                <div style={{ fontSize: 11, color: tone.fg, marginBottom: 6 }}>
                  第 {(items[0]?.index ?? 0) + 1}–{(items[items.length - 1]?.index ?? 0) + 1} 句 · {items.length} 句合一
                </div>
                <div style={{ fontSize: 13, color: '#1e7e34', lineHeight: 1.75 }}>
                  {items.map((x) => x.text.trim().replace(/[，。；：、,.!?;:…]+$/, '')).join('，')}。
                </div>
                <div style={{ marginTop: 6, fontSize: 11, color: '#8a8f98' }}>约 {chars} 字</div>
              </div>
            )
          })
        )}
      </div>
      <button onClick={onApply} disabled={reducible === 0 || busy}
        style={{ marginTop: 8, fontSize: 12, padding: '6px 12px' }}>
        {busy ? '合并中…' : applyLabel}
      </button>
    </aside>
  )
}
