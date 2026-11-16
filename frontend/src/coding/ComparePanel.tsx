import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import type { CodingCode } from '../types'
import { CodeChip, SideTitle } from './common'

/**
 * 对比：只发生在两个人之间。单人项目没有对比（已从工作区移除入口），
 * 共享材料里才有真实的两份独立编码可比较——这是它唯一成立的场景。
 */
export default function ComparePanel({
  groupId,
  materialId,
  sentences,
}: {
  groupId: string
  materialId: string
  sentences: { id: string; text: string; start_ms: number }[]
}) {
  const [coders, setCoders] = useState<{ coder_id: string; nick: string; count: number }[]>([])
  const [me, setMe] = useState('')
  const [other, setOther] = useState('')
  const [data, setData] = useState<api.CodingCompare | null>(null)
  const [codes, setCodes] = useState<CodingCode[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [side, setSide] = useState<'summary' | 'only_a' | 'only_b' | 'both'>('summary')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api.listGroupCodingCoders(groupId, materialId),
      api.getGroupCoding(groupId, materialId).catch(() => null),
    ])
      .then(([c, g]) => {
        if (cancelled) return
        setCoders(c.coders || [])
        setMe(c.me)
        setCodes(g?.codes || [])
        const candidates = (c.coders || []).filter((x) => x.coder_id !== c.me)
        setOther(candidates[0]?.coder_id || '')
        if (!candidates.length) setLoading(false)
      })
      .catch((e) => {
        setError(String(e))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [groupId, materialId])

  useEffect(() => {
    if (!other) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .compareGroupCoding(groupId, materialId, other)
      .then((d) => {
        if (cancelled) return
        setData(d)
        setError('')
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [groupId, materialId, other])

  const sentenceMap = useMemo(() => {
    const m = new Map<string, { text: string; start_ms: number }>()
    sentences.forEach((s) => m.set(s.id, s))
    return m
  }, [sentences])

  function codeOf(id: string): CodingCode | undefined {
    return codes.find((c) => c.id === id)
  }

  const otherOptions = coders.filter((c) => c.coder_id !== me)

  if (loading && !data) {
    return (
      <section className="workspace-card" style={{ gridColumn: 'span 5' }}>
        <SideTitle>对比 · 需要两位编码者</SideTitle>
        <div className="coding-empty">读取共享编码…</div>
      </section>
    )
  }

  if (!otherOptions.length) {
    return (
      <section className="workspace-card" style={{ gridColumn: 'span 5' }}>
        <SideTitle extra={materialId}>对比 · 还不能比</SideTitle>
        <div className="coding-compare-gate" style={{ border: 0 }}>
          <div className="coding-compare-gate-title">这份材料上还没有第二位编码者</div>
          <div className="coding-empty">
            对比的对象不是另造一份编码，而是另一位成员在<strong>同一份共享材料</strong>上独立留下的编码。
            把材料分享给同事、让对方用他自己的设备编一遍，这里就会出现真实的分歧与一致度。
          </div>
          <div className="coding-compare-steps">
            <span>① 在「成员与权限」里邀请读写权限的成员</span>
            <span>② 对方在自己的设备上对同一材料编码</span>
            <span>③ 回到这里选他做对比对象</span>
          </div>
          <div className="coding-hint">
            当前这份材料上的编码者：{coders.length ? coders.map((c) => `${c.nick || c.coder_id}（${c.count} 条）`).join('、') : '只有你'}
          </div>
        </div>
      </section>
    )
  }

  const stats = data?.stats

  return (
    <>
      <section className="workspace-card coding-analysis-left" style={{ gridColumn: 'span 3' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <SideTitle>对比两位编码者</SideTitle>
          <span style={{ fontSize: 12, color: '#5f5e5a' }}>我</span>
          <span style={{ fontSize: 12, color: '#245c9c' }}>{data?.a.nick || '我'}</span>
          <span style={{ fontSize: 12, color: '#8a8f98' }}>vs</span>
          <select value={other} onChange={(e) => setOther(e.target.value)} style={{ fontSize: 12, padding: 4 }}>
            {otherOptions.map((c) => (
              <option key={c.coder_id} value={c.coder_id}>
                {c.nick || c.coder_id}（{c.count} 条）
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div style={{ fontSize: 12, color: '#b00020', background: '#fdecea', borderRadius: 6, padding: '6px 8px', marginBottom: 8 }}>
            {error}
          </div>
        )}

        {stats && (
          <>
            <div className="coding-stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div><span>一致</span><b>{stats.both}</b></div>
              <div><span>仅我有</span><b>{stats.only_a}</b></div>
              <div><span>仅他有</span><b>{stats.only_b}</b></div>
              <div><span>一致率</span><b>{Math.round(stats.agreement * 100)}%</b></div>
            </div>
            <div className="coding-hint" style={{ marginTop: 6 }}>
              以「句子 × 码」为单位判定：两人都编=一致，只有一方编=分歧。
              交并比（Jaccard）{Math.round(stats.jaccard * 100)}%，比总一致率更能说明真实重合。
            </div>

            <div style={{ display: 'flex', gap: 6, margin: '10px 0 8px', flexWrap: 'wrap' }}>
              {(
                [
                  ['summary', '分歧清单'],
                  ['only_a', `仅我编（${stats.only_a}）`],
                  ['only_b', `仅他编（${stats.only_b}）`],
                  ['both', `两人一致（${stats.both}）`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="coding-ghost-btn"
                  style={side === key ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
                  onClick={() => setSide(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="coding-evidence-list scroll-hidden" style={{ maxHeight: 420 }}>
              {(side === 'summary'
                ? [...(data?.only_a || []), ...(data?.only_b || [])]
                : side === 'only_a'
                  ? data?.only_a || []
                  : side === 'only_b'
                    ? data?.only_b || []
                    : data?.both || []
              ).length === 0 && <div className="coding-empty">这一类暂时为空。</div>}

              {(side === 'summary'
                ? [
                    ...(data?.only_a || []).map((x) => ({ ...x, mine: true })),
                    ...(data?.only_b || []).map((x) => ({ ...x, mine: false })),
                  ]
                : side === 'only_a'
                  ? (data?.only_a || []).map((x) => ({ ...x, mine: true }))
                  : side === 'only_b'
                    ? (data?.only_b || []).map((x) => ({ ...x, mine: false }))
                    : (data?.both || []).map((x) => ({ ...x, mine: true }))
              ).map((item, i) => {
                const s = sentenceMap.get(item.sentence_id)
                const time = s ? s.start_ms : 0
                return (
                  <div key={`${item.sentence_id}-${item.code_id}-${i}`} className="coding-evidence-row">
                    <div className="coding-evidence-quote">“{item.quote}”</div>
                    <div className="coding-evidence-meta">
                      <span>{Math.floor(time / 60000)}:{String(Math.floor((time % 60000) / 1000)).padStart(2, '0')}</span>
                      {codeOf(item.code_id) && <CodeChip code={codeOf(item.code_id)!} />}
                      {'mine' in item && (
                        <span style={{ color: item.mine ? '#245c9c' : '#993556', fontSize: 11 }}>
                          {item.mine ? (data?.a.nick || '我') : (data?.b.nick || '对方')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

      <aside className="workspace-card coding-analysis-right" style={{ gridColumn: 'span 2' }}>
        <SideTitle>对比概览</SideTitle>
        {stats ? (
          <>
            <div className="coding-summary-row">
              {data?.a.nick || '我'} 编码 <b>{stats.both + stats.only_a}</b>
            </div>
            <div className="coding-summary-row">
              {data?.b.nick || '对方'} 编码 <b>{stats.both + stats.only_b}</b>
            </div>
            <div className="coding-summary-row">
              一致片段 <b>{stats.both}</b>
            </div>
            <div className="coding-summary-row">
              待裁决 <b>{stats.only_a + stats.only_b}</b>
            </div>
            <div className="coding-label">一致率</div>
            <div className="coding-relation vertical">
              <span>总一致 {Math.round(stats.agreement * 100)}%</span>
              <span>交并比 {Math.round(stats.jaccard * 100)}%</span>
            </div>
            <div className="coding-hint">
              逐条裁决（采纳对方 / 保留自己）属于下一步；这里先把分歧暴露出来，让你知道差在哪。
            </div>
          </>
        ) : (
          <div className="coding-empty">需要先选定一位对比对象。</div>
        )}
      </aside>
    </>
  )
}
