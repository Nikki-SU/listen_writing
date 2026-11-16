import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import type { CodingCode, CodingEntry, Sentence } from '../types'

type Mode = 'personal' | 'shared'

function active(codes: CodingCode[]): CodingCode[] {
  return codes.filter((c) => c.status !== 'disabled')
}

/** 一个码连同它的全部子码：统计父码时要含下级。 */
function subtree(codes: CodingCode[], codeId: string): Set<string> {
  const ids = new Set<string>([codeId])
  let changed = true
  while (changed) {
    changed = false
    for (const c of codes) {
      if (c.parent_id && ids.has(c.parent_id) && !ids.has(c.id)) {
        ids.add(c.id)
        changed = true
      }
    }
  }
  return ids
}

function countWith(codes: CodingCode[], codings: CodingEntry[], codeId: string): number {
  const ids = subtree(codes, codeId)
  return codings.filter((c) => ids.has(c.code_id)).length
}

/** 文本覆盖率：所有编码区间在句子内取并集后 / 全文字数。 */
function coverage(sentences: Sentence[], codings: CodingEntry[]): number {
  const total = sentences.reduce((n, s) => n + s.text.length, 0)
  if (!total) return 0
  let covered = 0
  for (const sentence of sentences) {
    const len = sentence.text.length
    const spans = codings
      .flatMap((c) => c.spans || [])
      .filter((sp) => sp.sentence_id === sentence.id)
      .map((sp) => [Math.max(0, sp.start), Math.min(len, sp.end)] as const)
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0])
    let cursor = 0
    for (const [s, e] of spans) {
      const from = Math.max(s, cursor)
      if (e > from) {
        covered += e - from
        cursor = e
      }
    }
  }
  return covered / total
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

export default function GroupAnalysisPanel({
  groupId,
  materialId,
  sentences,
  materialVersion,
  pendingMerges,
}: {
  groupId: string
  materialId: string
  sentences: Sentence[]
  materialVersion: string
  /** 群组里还没合并的文本提案：合并版不是最终版时要说清楚。 */
  pendingMerges: number
}) {
  const [data, setData] = useState<api.GroupCoding | null>(null)
  const [mode, setMode] = useState<Mode>('personal')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .getGroupCoding(groupId, materialId)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError('')
      })
      .catch((e) => setError(`读取编码库失败：${String(e)}`))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [groupId, materialId])

  const view = useMemo(() => {
    if (!data) return null
    const shared = data.shared_codebook
    const sharedCodes = active(shared?.codes || [])
    // 个人模式看的是「我标了什么」，不限于我自己建的码：用共享码标的也算我的解释。
    const pool: CodingCode[] = []
    const seen = new Set<string>()
    for (const code of [...active(data.my_codebook.codes || []), ...sharedCodes, ...(data.legacy_codes || [])]) {
      if (code.id && !seen.has(code.id)) {
        seen.add(code.id)
        pool.push(code)
      }
    }
    const allCodes = mode === 'shared' ? sharedCodes : pool
    const ids = new Set(allCodes.map((c) => c.id))
    const codings = (data.codings || []).filter(
      (c) => (mode === 'shared' ? ids.has(c.code_id) : c.coder_id === data.me),
    )
    const roots = allCodes.filter((c) => !c.parent_id)
    const rows = roots
      .map((code) => ({ code, count: countWith(allCodes, codings, code.id) }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count)
    const maxCount = rows[0]?.count || 1

    // 共现：同一句里同时出现的顶层码（父码已含子码）。
    const pairs = new Map<string, number>()
    for (const sentence of sentences) {
      const present = roots
        .filter((root) =>
          codings.some(
            (c) =>
              subtree(allCodes, root.id).has(c.code_id) &&
              (c.spans || []).some((sp) => sp.sentence_id === sentence.id),
          ),
        )
        .map((c) => c.id)
      for (let i = 0; i < present.length; i += 1) {
        for (let j = i + 1; j < present.length; j += 1) {
          const key = [present[i], present[j]].sort().join('|')
          pairs.set(key, (pairs.get(key) || 0) + 1)
        }
      }
    }
    const cooc = Array.from(pairs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([key, count]) => ({
        count,
        names: key
          .split('|')
          .map((id) => roots.find((c) => c.id === id)?.name || '未命名')
          .join(' × '),
      }))

    const sentenceIds = new Set(
      codings.flatMap((c) => (c.spans || []).map((sp) => sp.sentence_id)),
    )

    const sharedIds = new Set(active(shared?.codes || []).map((c) => c.id))
    const mine = (data.codings || []).filter((c) => c.coder_id === data.me)
    const mineAligned = mine.filter((c) => sharedIds.has(c.code_id)).length

    const nickOf = new Map<string, string>()
    nickOf.set(data.me, data.nick || '我')
    for (const b of data.codebooks || []) {
      nickOf.set(b.coder_id || '', b.coder_id === data.me ? '我' : b.nick || b.coder_id || '')
    }
    const coderIds = Array.from(new Set((data.codings || []).map((c) => c.coder_id)))
    const members = coderIds
      .map((coder) => {
        const own = (data.codings || []).filter((c) => c.coder_id === coder)
        const aligned = own.filter((c) => sharedIds.has(c.code_id))
        const top = roots
          .map((code) => ({
            name: code.name,
            count: own.filter((c) => subtree(active(shared?.codes || []), code.id).has(c.code_id)).length,
          }))
          .sort((a, b) => b.count - a.count)[0]
        return {
          coder,
          nick: nickOf.get(coder) || (coder === data.me ? '我' : coder),
          total: own.length,
          aligned: aligned.length,
          coverage: coverage(sentences, own),
          top: top?.count ? top.name : '—',
          isMe: coder === data.me,
        }
      })
      .sort((a, b) => b.aligned - a.aligned || b.total - a.total)

    // 共享模式下：我的哪些个人码没对齐到共享码，仍带着编码。
    const unaligned = active(data.my_codebook.codes || [])
      .filter((c) => !sharedIds.has(c.id))
      .map((code) => ({ code, count: countWith(active(data.my_codebook.codes || []), mine, code.id) }))
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count)

    return {
      rows,
      maxCount,
      cooc,
      codings,
      poolSize: allCodes.length,
      sentenceCount: sentenceIds.size,
      coverageRate: coverage(sentences, codings),
      members,
      mine,
      mineAligned,
      unaligned,
    }
  }, [data, mode, sentences])

  const chip = (activeMode: boolean) =>
    ({
      fontSize: 12,
      padding: '3px 12px',
      borderRadius: 4,
      cursor: 'pointer',
      border: `1px solid ${activeMode ? '#8ab4f8' : '#ddd'}`,
      background: activeMode ? '#eef5ff' : '#fff',
      color: activeMode ? '#245c9c' : '#666',
    }) as const

  if (loading) return <div style={{ padding: 24, color: '#8a8f98', fontSize: 13 }}>读取编码库…</div>
  if (error) return <div style={{ padding: 24, color: '#b00020', fontSize: 13 }}>{error}</div>
  if (!data || !view) return null

  const hasShared = Boolean(data.shared_codebook)
  const shown = mode === 'shared' ? data.shared_codebook : data.my_codebook

  return (
    <div className="workspace-grid" style={{ minHeight: 320, padding: '0 4px' }}>
      <section className="workspace-card coding-analysis-left" style={{ gridColumn: 'span 3' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>群组分析</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={chip(mode === 'personal')} onClick={() => setMode('personal')}>
              个人码
            </button>
            <button type="button" style={chip(mode === 'shared')} onClick={() => setMode('shared')}>
              共享码
            </button>
          </div>
          <span style={{ fontSize: 11, color: '#8a8f98' }}>
            材料 v{materialVersion || '—'}
            {mode === 'shared' && data.shared_codebook ? ` · 共享码本 v${data.shared_codebook.version}` : ''}
            {pendingMerges > 0 ? ` · ${pendingMerges} 条文本待合并` : ''}
          </span>
        </div>

        <div style={{ fontSize: 12, color: '#5a6270', margin: '8px 0 12px', lineHeight: 1.7 }}>
          {mode === 'personal'
            ? '只统计我的编码和我的码本，属于个人解释；结果不进入群组。'
            : hasShared
              ? `只统计挂在共享码本 ${shown?.name || ''} 上的编码，属于共识口径；未对齐的个人码不计入，列在下方。`
              : '这个材料还没有共享码本。先到「编码 → 码本」用自己的码本提案，群主与管理员通过后就有共识口径。'}
        </div>

        {pendingMerges > 0 && (
          <div
            style={{
              fontSize: 11,
              color: '#8a5a00',
              background: '#fff8e8',
              border: '1px solid #f0dfb8',
              borderRadius: 6,
              padding: '6px 10px',
              marginBottom: 12,
            }}
          >
            共享分析基于当前合并版；还有 {pendingMerges} 条文本提案没合并，结论可能随后变化。
          </div>
        )}

        {mode === 'shared' && !hasShared ? (
          <div style={{ padding: '28px 0', color: '#8a8f98', fontSize: 13 }}>暂无共享码本，无法按共识口径分析。</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
              {[
                ['编码条数', String(view.codings.length)],
                ['涉及句子', `${view.sentenceCount} / ${sentences.length}`],
                ['文本覆盖率', pct(view.coverageRate)],
                ['码总数', String(view.poolSize)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{ flex: '1 1 100px', border: '1px solid #eceff3', borderRadius: 8, padding: '10px 12px' }}
                >
                  <div style={{ fontSize: 11, color: '#8a8f98' }}>{label}</div>
                  <div style={{ fontSize: 20, fontWeight: 600, color: '#233' }}>{value}</div>
                </div>
              ))}
            </div>

            <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 6 }}>
              码频次（父码含子码）
            </div>
            {view.rows.length === 0 ? (
              <div style={{ fontSize: 12, color: '#b0b6c0', padding: '10px 0 18px' }}>还没有可用编码。</div>
            ) : (
              <div style={{ display: 'grid', gap: 6, marginBottom: 18 }}>
                {view.rows.map(({ code, count }) => (
                  <div key={code.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: code.color || '#5b4bcc',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ width: 120, fontSize: 12, color: '#333', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {code.name || '未命名'}
                    </span>
                    <div style={{ flex: 1, height: 8, background: '#f1f3f6', borderRadius: 4, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.max(4, (count / view.maxCount) * 100)}%`,
                          height: '100%',
                          background: code.color || '#5b4bcc',
                          opacity: 0.75,
                        }}
                      />
                    </div>
                    <span style={{ width: 28, textAlign: 'right', fontSize: 11, color: '#8a8f98' }}>{count}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 6 }}>常见共现（同一句）</div>
            {view.cooc.length === 0 ? (
              <div style={{ fontSize: 12, color: '#b0b6c0' }}>还没有同一句里出现的两个码。</div>
            ) : (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {view.cooc.map((item) => (
                  <span
                    key={item.names}
                    style={{
                      fontSize: 11,
                      color: '#4b5563',
                      background: '#f6f7f9',
                      border: '1px solid #eceff3',
                      borderRadius: 999,
                      padding: '3px 10px',
                    }}
                  >
                    {item.names} · {item.count}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <aside className="workspace-card coding-analysis-right" style={{ gridColumn: 'span 2' }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
          {mode === 'personal' ? '我的编码' : '成员口径'}
        </div>
        {mode === 'personal' ? (
          <div style={{ fontSize: 12, color: '#5a6270', lineHeight: 1.9 }}>
            <div>我的编码：{view.mine.length} 条</div>
            {hasShared && (
              <div>
                挂在共享码上的：{view.mineAligned} / {view.mine.length}
                {view.mine.length > 0 ? `（${pct(view.mineAligned / view.mine.length)}）` : ''}
              </div>
            )}
            <div>我的码本：{shown?.name || '我的码本'}</div>
            <div style={{ marginTop: 10, fontSize: 11, color: '#8a8f98' }}>
              个人码的意义就是与他人不同；要比较不同访员的解释，用「对比」页按码名对照。
            </div>
            {hasShared && view.unaligned.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 6 }}>
                  这些个人码还没对齐到共享码（共享分析不计入）
                </div>
                {view.unaligned.slice(0, 8).map(({ code, count }) => (
                  <div key={code.id} style={{ display: 'flex', gap: 6, fontSize: 11, color: '#5a6270' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {code.name}
                    </span>
                    <span style={{ color: '#8a8f98' }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : !hasShared ? (
          <div style={{ fontSize: 12, color: '#b0b6c0' }}>没有共享码本。</div>
        ) : (
          <div style={{ fontSize: 12 }}>
            <div style={{ color: '#5a6270', marginBottom: 8 }}>
              我的共享码覆盖：{view.mineAligned} / {view.mine.length} 条
            </div>
            {view.members.length === 0 ? (
              <div style={{ color: '#b0b6c0' }}>还没有人编码。</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {view.members.map((m) => (
                  <div key={m.coder} style={{ borderBottom: '1px solid #f3f4f6', paddingBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontWeight: m.isMe ? 600 : 400 }}>{m.nick}</span>
                      <span style={{ color: '#8a8f98' }}>
                        共享 {m.aligned} / 全部 {m.total}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginTop: 2 }}>
                      文本覆盖 {pct(m.coverage)} · 常用：{m.top}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 11, color: '#8a8f98', lineHeight: 1.7 }}>
              共享码模式只认共享码本上的编码；个人码要先通过提案进入共享码本，才会进入这组统计。
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
