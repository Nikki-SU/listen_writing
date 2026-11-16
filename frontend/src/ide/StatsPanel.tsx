import { useEffect, useMemo, useState } from 'react'
import type { CodingCode, Sentence } from '../types'
import * as api from '../api'

/** 协作统计：编码条数 / 涉及句子 / 覆盖率 / 码频次 / 共现 / 成员口径。 */
export default function StatsPanel({
  groupId, materialId, sentences, mode,
}: {
  groupId: string
  materialId: string
  sentences: Sentence[]
  mode: 'personal' | 'shared'
}) {
  const [data, setData] = useState<api.GroupCoding | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.getGroupCoding(groupId, materialId).then((d) => { if (!cancelled) setData(d) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [groupId, materialId])

  const view = useMemo(() => {
    if (!data) return null
    const active = (list: CodingCode[]) => list.filter((c) => c.status === 'active')
    const subtree = (all: CodingCode[], id: string): Set<string> => {
      const out = new Set<string>()
      const walk = (x: string) => { out.add(x); all.filter((c) => c.parent_id === x).forEach((c) => walk(c.id)) }
      walk(id)
      return out
    }
    const countWith = (all: CodingCode[], codings: { code_id: string }[], id: string) => {
      const sub = subtree(all, id)
      return codings.filter((c) => sub.has(c.code_id)).length
    }
    const coverage = (codings: { spans: { sentence_id: string }[] }[]) => {
      const ids = new Set(codings.flatMap((c) => c.spans.map((s) => s.sentence_id)))
      return sentences.length ? Math.round((ids.size / sentences.length) * 100) : 0
    }

    const sharedCodes = active(data.shared_codebook?.codes || [])
    const pool: CodingCode[] = []
    const seen = new Set<string>()
    for (const c of [...active(data.my_codebook.codes || []), ...sharedCodes, ...(data.legacy_codes || [])]) {
      if (c.id && !seen.has(c.id)) { seen.add(c.id); pool.push(c) }
    }
    const allCodes = mode === 'shared' ? sharedCodes : pool
    const ids = new Set(allCodes.map((c) => c.id))
    const codings = (data.codings || []).filter((c) => (mode === 'shared' ? ids.has(c.code_id) : c.coder_id === data.me))
    const roots = allCodes.filter((c) => !c.parent_id)
    const rows = roots.map((code) => ({ code, count: countWith(allCodes, codings, code.id) }))
      .filter((r) => r.count > 0).sort((a, b) => b.count - a.count)
    const maxCount = rows[0]?.count || 1

    const pairs = new Map<string, number>()
    for (const sentence of sentences) {
      const present = roots.filter((root) => codings.some((c) => subtree(allCodes, root.id).has(c.code_id) && (c.spans || []).some((sp) => sp.sentence_id === sentence.id))).map((c) => c.id)
      for (let i = 0; i < present.length; i += 1) {
        for (let j = i + 1; j < present.length; j += 1) {
          const key = [present[i], present[j]].sort().join('|')
          pairs.set(key, (pairs.get(key) || 0) + 1)
        }
      }
    }
    const cooc = Array.from(pairs.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([key, count]) => ({ count, names: key.split('|').map((id) => roots.find((c) => c.id === id)?.name || '未命名').join(' × ') }))

    const sentenceIds = new Set(codings.flatMap((c) => (c.spans || []).map((sp) => sp.sentence_id)))
    const sharedIds = new Set(active(data.shared_codebook?.codes || []).map((c) => c.id))
    const mine = (data.codings || []).filter((c) => c.coder_id === data.me)
    const mineAligned = mine.filter((c) => sharedIds.has(c.code_id)).length

    const nickOf = new Map<string, string>()
    nickOf.set(data.me, data.nick || '我')
    for (const b of data.codebooks || []) nickOf.set(b.coder_id || '', b.coder_id === data.me ? '我' : b.nick || b.coder_id || '')
    const coderIds = Array.from(new Set((data.codings || []).map((c) => c.coder_id)))
    const members = coderIds.map((coder) => {
      const own = (data.codings || []).filter((c) => c.coder_id === coder)
      const aligned = own.filter((c) => sharedIds.has(c.code_id))
      const top = roots.map((code) => ({ name: code.name, count: own.filter((c) => subtree(active(data.shared_codebook?.codes || []), code.id).has(c.code_id)).length }))
        .sort((a, b) => b.count - a.count)[0]
      return { coder, nick: nickOf.get(coder) || (coder === data.me ? '我' : coder), total: own.length, aligned: aligned.length, coverage: coverage(own), top: top?.count ? top.name : '—', isMe: coder === data.me }
    }).sort((a, b) => b.aligned - a.aligned || b.total - a.total)

    const unaligned = active(data.my_codebook.codes || []).filter((c) => !sharedIds.has(c.id))
      .map((code) => ({ code, count: countWith(active(data.my_codebook.codes || []), mine, code.id) }))
      .filter((r) => r.count > 0).sort((a, b) => b.count - a.count)

    return { rows, maxCount, cooc, sentenceCount: sentenceIds.size, coverageRate: coverage(codings), members, mineAligned, unaligned, mode }
  }, [data, mode, sentences])

  if (!view) return <div style={{ fontSize: 12, color: '#9aa0a6', paddingTop: 16, textAlign: 'center' }}>读取编码统计中…</div>

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 14 }}>
        {[
          ['编码条数', view.rows.reduce((n, r) => n + r.count, 0)],
          ['涉及句子', view.sentenceCount],
          ['文本覆盖率', `${view.coverageRate}%`],
          ['顶层码', view.rows.length],
        ].map(([label, val]) => (
          <div key={String(label)} style={{ background: '#f7f9fc', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, color: '#8a8f98' }}>{label}</div>
            <div style={{ fontSize: 20, fontWeight: 500, marginTop: 4 }}>{val}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>码频次（父码含子码）</div>
      {view.rows.map((r) => (
        <div key={r.code.id} style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 90, flexShrink: 0, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.code.name}</span>
          <span style={{ flex: 1, height: 10, background: '#eef1f5', borderRadius: 5, overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${Math.round((r.count / view.maxCount) * 100)}%`, background: r.code.color || '#7aa5d8' }} />
          </span>
          <span style={{ fontSize: 11, color: '#8a8f98', width: 20, textAlign: 'right' }}>{r.count}</span>
        </div>
      ))}

      <div style={{ fontSize: 12, fontWeight: 600, margin: 14, marginBottom: 8 }}>常见共现（同一句）</div>
      {view.cooc.length === 0 && <div style={{ fontSize: 11, color: '#9aa0a6' }}>暂无共现</div>}
      {view.cooc.map((p) => <span key={p.names} style={{ display: 'inline-block', fontSize: 11, background: '#eef4ff', color: '#245c9c', borderRadius: 12, padding: '3px 9px', margin: '0 6px 6px 0' }}>{p.names} · {p.count}</span>)}

      {view.mode === 'shared' ? (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: '14px 0 8px' }}>成员口径</div>
          <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>我的共享码覆盖：{view.mineAligned} 条</div>
          {view.members.map((m) => (
            <div key={m.coder} style={{ fontSize: 11, borderBottom: '1px solid #f0f2f5', padding: '6px 0', display: 'flex', gap: 8 }}>
              <span style={{ width: 70, flexShrink: 0 }}>{m.nick}{m.isMe ? '（我）' : ''}</span>
              <span style={{ flex: 1, color: '#8a8f98' }}>共享 {m.aligned}/{m.total} · 覆盖 {m.coverage}% · 常用 {m.top}</span>
            </div>
          ))}
        </>
      ) : (
        <>
          <div style={{ fontSize: 12, fontWeight: 600, margin: '14px 0 8px' }}>我的编码</div>
          <div style={{ fontSize: 11, color: '#8a8f98' }}>对齐到共享码的：{view.mineAligned} 条</div>
          {view.unaligned.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: '#b00020', margin: '10px 0 6px' }}>以下个人码未对齐到共享码，不计入共享分析</div>
              {view.unaligned.map((u) => <div key={u.code.id} style={{ fontSize: 11, padding: '3px 0' }}>{u.code.name} · {u.count} 条</div>)}
            </>
          )}
        </>
      )}
    </div>
  )
}
