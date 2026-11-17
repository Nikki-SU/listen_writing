import type { IdeData } from './IdePanels'

/** 个人版编码统计：编码条数 / 涉及句子 / 覆盖率 / 码频次 / 共现（本机 store 数据）。 */
export default function CodingStatsPanel({ data }: { data: IdeData }) {
  const codings = data.myCodings
  const sentenceIds = new Set(codings.flatMap((c) => c.spans.map((s) => s.sentence_id)))
  const byCode = data.topCodes
    .map((code) => ({ code, count: codings.filter((c) => data.codeById(code.id) && (c.code_id === code.id || isChild(data, code.id, c.code_id))).length }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
  const max = byCode[0]?.count || 1

  // 共现：同一句里出现的顶层码对
  const pairs = new Map<string, number>()
  const sentenceIdsList = Array.from(sentenceIds)
  for (const sid of sentenceIdsList) {
    const present = data.topCodes.filter((root) =>
      codings.some((c) => (c.code_id === root.id || isChild(data, root.id, c.code_id)) && c.spans.some((sp) => sp.sentence_id === sid)),
    ).map((c) => c.id)
    for (let i = 0; i < present.length; i += 1) {
      for (let j = i + 1; j < present.length; j += 1) {
        const key = [present[i], present[j]].sort().join('|')
        pairs.set(key, (pairs.get(key) || 0) + 1)
      }
    }
  }
  const cooc = Array.from(pairs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)

  const coverage = data.sentences.length ? Math.round((sentenceIds.size / data.sentences.length) * 100) : 0

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 14 }}>
        {([['编码条数', codings.length], ['涉及句子', sentenceIds.size], ['本条覆盖率', `${coverage}%`], ['顶层码', byCode.length]] as const).map(([label, val]) => (
          <div key={label} style={{ background: '#f7f9fc', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, color: '#8a8f98' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 4 }}>{val}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>码频次（父码含子码）</div>
      {byCode.length === 0 && <div style={{ fontSize: 11, color: '#9aa0a6' }}>还没有编码</div>}
      {byCode.map(({ code, count }) => (
        <div key={code.id} style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 90, flexShrink: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{code.name}</span>
          <span style={{ flex: 1, height: 10, background: '#eef1f5', borderRadius: 5, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round((count / max) * 100)}%`, background: code.color || '#7aa5d8' }} />
          </span>
          <span style={{ fontSize: 11, color: '#8a8f98', width: 20, textAlign: 'right' }}>{count}</span>
        </div>
      ))}
      <div style={{ fontSize: 12, fontWeight: 600, margin: '14px 0 8px' }}>常见共现（同一句）</div>
      {cooc.length === 0 ? <div style={{ fontSize: 11, color: '#9aa0a6' }}>暂无共现</div> : cooc.map(([key, count]) => (
        <span key={key} style={{ display: 'inline-block', fontSize: 11, background: '#eef4ff', color: '#245c9c', borderRadius: 12, padding: '3px 9px', margin: '0 6px 6px 0' }}>
          {key.split('|').map((id) => data.codeById(id)?.name || '未命名').join(' × ')} · {count}
        </span>
      ))}
    </div>
  )
}

function isChild(data: IdeData, rootId: string, codeId: string): boolean {
  let cur = data.codeById(codeId)
  while (cur?.parent_id) {
    if (cur.parent_id === rootId) return true
    cur = data.codeById(cur.parent_id)
  }
  return false
}
