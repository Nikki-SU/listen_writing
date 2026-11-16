import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { CodingEntry, CodingStore, Recording, RecordingDetail } from '../types'
import { CodeChip, SideTitle } from './common'
import {
  caseAttributeLabels,
  caseAttributeValue,
  caseFor,
  codeById,
  documentId,
  loadCodingStore,
  subtreeIds,
} from './store'

type Selection =
  | { type: 'cell'; codeId: string; columnKey: string }
  | { type: 'pair'; rowId: string; colId: string }

type Column = {
  key: string
  label: string
  docIds: string[]
}

type Tab = 'matrix' | 'framework' | 'search'

const ME = 'me'

function fmtTime(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export default function AnalysisPanel({
  projectId,
  recordings,
  detail,
  onJump,
}: {
  projectId: string
  recordings: Recording[]
  detail: RecordingDetail | null
  onJump?: (recordingId: string, sentenceId: string) => void
}) {
  const [store] = useState<CodingStore>(() => loadCodingStore(projectId))
  const [tab, setTab] = useState<Tab>('matrix')
  const [dimension, setDimension] = useState<string>('case')
  const [matrixMode, setMatrixMode] = useState<'case' | 'cooccur'>('case')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [query, setQuery] = useState('')
  const [codeFilter, setCodeFilter] = useState<string>('')

  const codes = store.codes.filter((c) => c.status === 'active')
  const topCodes = codes.filter((c) => !c.parent_id)
  const attributes = caseAttributeLabels(store)
  const currentRecordingId = detail?.recording.id || null

  const columns = useMemo<Column[]>(() => {
    if (dimension === 'case') {
      return recordings.map((r) => {
        const doc = documentId(r.id)
        return {
          key: doc,
          label: caseFor(store, doc)?.case_name?.trim() || r.name,
          docIds: [doc],
        }
      })
    }
    const grouped = new Map<string, string[]>()
    for (const r of recordings) {
      const doc = documentId(r.id)
      const value = caseAttributeValue(store, doc, dimension) || '未填写'
      grouped.set(value, [...(grouped.get(value) || []), doc])
    }
    return Array.from(grouped.entries()).map(([label, docIds]) => ({
      key: `attr:${dimension}:${label}`,
      label,
      docIds,
    }))
  }, [dimension, recordings, store])

  const sentenceTime = useMemo(() => {
    const map = new Map<string, { start: number }>()
    detail?.sentences.forEach((s) => map.set(s.id, { start: s.start_ms }))
    return map
  }, [detail])

  function docTitle(docId: string): string {
    const rec = recordings.find((r) => documentId(r.id) === docId)
    const name = caseFor(store, docId)?.case_name?.trim()
    return name || rec?.name || docId
  }

  function recordingOf(docId: string): string | undefined {
    return recordings.find((r) => documentId(r.id) === docId)?.id
  }

  /** 证据点击：切到对应录音的转写页并定位句子。只有当前录音能拿到时间戳。 */
  function jump(entry: CodingEntry) {
    const sentenceId = entry.spans[0]?.sentence_id
    const recId = recordingOf(entry.document_id)
    if (sentenceId && recId && onJump) onJump(recId, sentenceId)
  }

  const evidence = useMemo<CodingEntry[]>(() => {
    if (!selected) return []
    if (selected.type === 'cell') {
      const column = columns.find((c) => c.key === selected.columnKey)
      if (!column) return []
      const ids = subtreeIds(store, selected.codeId)
      return store.codings.filter(
        (c) => c.coder_id === ME && column.docIds.includes(c.document_id) && ids.has(c.code_id),
      )
    }
    // 共现：同一文档里两段码在同一句上同时出现
    const rowSub = subtreeIds(store, selected.rowId)
    const colSub = subtreeIds(store, selected.colId)
    const rowsBySentence = new Map<string, Set<string>>()
    const colsBySentence = new Map<string, Set<string>>()
    for (const c of store.codings) {
      if (c.coder_id !== ME) continue
      for (const sp of c.spans) {
        const key = `${c.document_id}::${sp.sentence_id}`
        if (rowSub.has(c.code_id)) {
          if (!rowsBySentence.has(key)) rowsBySentence.set(key, new Set())
          rowsBySentence.get(key)!.add(c.id)
        }
        if (colSub.has(c.code_id)) {
          if (!colsBySentence.has(key)) colsBySentence.set(key, new Set())
          colsBySentence.get(key)!.add(c.id)
        }
      }
    }
    const hits = new Set<string>()
    rowsBySentence.forEach((rowIds, key) => {
      if (colsBySentence.has(key)) rowIds.forEach((id) => hits.add(id))
    })
    return store.codings.filter((c) => hits.has(c.id))
  }, [selected, columns, store])

  const matrixRows = (parentId: string | null, depth: number): ReactNode[] =>
    codes
      .filter((c) => c.parent_id === parentId)
      .flatMap((code) => {
        const subtree = subtreeIds(store, code.id)
        const row = (
          <tr key={code.id}>
            <td className="coding-matrix-code" style={{ paddingLeft: 8 + depth * 14 }}>
              <span className="coding-dot" style={{ background: code.color }} />
              {code.name}
            </td>
            {columns.map((column) => {
              const count = store.codings.filter(
                (c) =>
                  c.coder_id === ME &&
                  column.docIds.includes(c.document_id) &&
                  subtree.has(c.code_id),
              ).length
              const active =
                selected?.type === 'cell' &&
                selected.codeId === code.id &&
                selected.columnKey === column.key
              return (
                <td key={column.key}>
                  <button
                    type="button"
                    className={`coding-matrix-cell${count ? '' : ' zero'}${active ? ' active' : ''}`}
                    onClick={() =>
                      setSelected({ type: 'cell', codeId: code.id, columnKey: column.key })
                    }
                    title={`${code.name} × ${column.label}：${count} 条编码`}
                  >
                    {count}
                  </button>
                </td>
              )
            })}
          </tr>
        )
        return [row, ...matrixRows(code.id, depth + 1)]
      })

  /** 码×码共现计数：两个码在同一条编码跨句交集（同一句）上的出现次数。 */
  function cooccurrence(aId: string, bId: string): number {
    if (aId === bId) {
      const sub = subtreeIds(store, aId)
      const keys = new Set<string>()
      for (const c of store.codings) {
        if (c.coder_id !== ME || !sub.has(c.code_id)) continue
        for (const sp of c.spans) keys.add(`${c.document_id}::${sp.sentence_id}`)
      }
      return keys.size
    }
    const aSub = subtreeIds(store, aId)
    const bSub = subtreeIds(store, bId)
    const a = new Map<string, Set<string>>()
    const b = new Map<string, Set<string>>()
    for (const c of store.codings) {
      if (c.coder_id !== ME) continue
      for (const sp of c.spans) {
        const key = `${c.document_id}::${sp.sentence_id}`
        if (aSub.has(c.code_id)) {
          if (!a.has(key)) a.set(key, new Set())
          a.get(key)!.add(c.id)
        }
        if (bSub.has(c.code_id)) {
          if (!b.has(key)) b.set(key, new Set())
          b.get(key)!.add(c.id)
        }
      }
    }
    let n = 0
    a.forEach((ids, key) => {
      if (b.has(key)) n += Math.min(ids.size, b.get(key)!.size)
    })
    return n
  }

  /* ---------------- 框架矩阵：行=案例，列=顶层码 ---------------- */

  const frameworkRows = recordings.map((r) => {
    const doc = documentId(r.id)
    return {
      key: doc,
      label: caseFor(store, doc)?.case_name?.trim() || r.name,
      recordingId: r.id,
      docId: doc,
    }
  })

  function firstQuoteFor(docId: string, codeId: string): { entry: CodingEntry; count: number } | null {
    const sub = subtreeIds(store, codeId)
    const list = store.codings.filter(
      (c) => c.coder_id === ME && c.document_id === docId && sub.has(c.code_id),
    )
    if (!list.length) return null
    return { entry: list[0], count: list.length }
  }

  /* ---------------- 检索 ---------------- */

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase()
    const codeSub = codeFilter ? subtreeIds(store, codeFilter) : null
    return store.codings
      .filter((c) => c.coder_id === ME)
      .filter((c) => (codeSub ? codeSub.has(c.code_id) : true))
      .filter((c) => (q ? c.quote.toLowerCase().includes(q) : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 80)
  }, [store, query, codeFilter])

  const wordFrequency = useMemo(() => {
    const q = query.trim()
    if (!q) return []
    const counter = new Map<string, number>()
    for (const c of store.codings) {
      if (c.coder_id !== ME) continue
      let idx = c.quote.indexOf(q)
      while (idx !== -1) {
        counter.set(c.document_id, (counter.get(c.document_id) || 0) + 1)
        idx = c.quote.indexOf(q, idx + q.length)
      }
    }
    return Array.from(counter.entries()).map(([docId, n]) => ({ docId, n }))
  }, [store, query])

  const totalCodings = store.codings.filter((c) => c.coder_id === ME).length

  return (
    <>
      <section className="workspace-card coding-analysis-left" style={{ gridColumn: 'span 2' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div className="coding-modebar" style={{ margin: 0, border: 0, padding: 0, flex: 1 }}>
            {' '}
          </div>
          <button
            type="button"
            className={`coding-ghost-btn${tab === 'matrix' ? ' active' : ''}`}
            style={tab === 'matrix' ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
            onClick={() => { setTab('matrix'); setSelected(null) }}
          >
            矩阵查询
          </button>
          <button
            type="button"
            className={`coding-ghost-btn${tab === 'framework' ? ' active' : ''}`}
            style={tab === 'framework' ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
            onClick={() => { setTab('framework'); setSelected(null) }}
          >
            框架矩阵
          </button>
          <button
            type="button"
            className={`coding-ghost-btn${tab === 'search' ? ' active' : ''}`}
            style={tab === 'search' ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
            onClick={() => { setTab('search'); setSelected(null) }}
          >
            检索
          </button>
        </div>

        {tab === 'matrix' && (
          <>
            <div className="coding-matrix-controls">
              <span>{matrixMode === 'case' ? '列维度' : '共现行'}</span>
              {matrixMode === 'case' ? (
                <select value={dimension} onChange={(e) => { setDimension(e.target.value); setSelected(null) }}>
                  <option value="case">案例（访谈对象）</option>
                  {attributes.map((label) => (
                    <option key={label} value={label}>属性：{label}</option>
                  ))}
                </select>
              ) : (
                <select value={codeFilter} onChange={(e) => { setCodeFilter(e.target.value); setSelected(null) }}>
                  <option value="">全部顶层码</option>
                  {topCodes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="coding-ghost-btn"
                  style={matrixMode === 'case' ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
                  onClick={() => { setMatrixMode('case'); setSelected(null) }}
                >
                  码 × 案例
                </button>
                <button
                  type="button"
                  className="coding-ghost-btn"
                  style={matrixMode === 'cooccur' ? { borderColor: '#8ab4f8', color: '#245c9c' } : undefined}
                  onClick={() => { setMatrixMode('cooccur'); setSelected(null) }}
                >
                  码 × 码共现
                </button>
              </div>
            </div>
            {matrixMode === 'case' && dimension !== 'case' && (
              <div className="coding-hint">
                按「{dimension}」分组；未填写的案例归入「未填写」。在编码页右栏的「案例属性」里补充值。
              </div>
            )}

            <div className="coding-matrix-wrap scroll-hidden">
              {matrixMode === 'case' ? (
                <table className="coding-matrix">
                  <thead>
                    <tr>
                      <th>码</th>
                      {columns.map((column) => (
                        <th key={column.key} title={column.docIds.map(docTitle).join('、')}>
                          <span className="coding-matrix-case">{column.label}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>{matrixRows(null, 0)}</tbody>
                </table>
              ) : (
                <table className="coding-matrix">
                  <thead>
                    <tr>
                      <th>码 \ 码</th>
                      {topCodes.map((c) => (
                        <th key={c.id} title={c.name}>
                          <span className="coding-matrix-case">{c.name}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {topCodes.map((row) => (
                      <tr key={row.id}>
                        <td className="coding-matrix-code">
                          <span className="coding-dot" style={{ background: row.color }} />
                          {row.name}
                        </td>
                        {topCodes.map((col) => {
                          const n = cooccurrence(row.id, col.id)
                          const active =
                            selected?.type === 'pair' &&
                            selected.rowId === row.id &&
                            selected.colId === col.id
                          return (
                            <td key={col.id}>
                              <button
                                type="button"
                                className={`coding-matrix-cell${n ? '' : ' zero'}${active ? ' active' : ''}`}
                                onClick={() => setSelected({ type: 'pair', rowId: row.id, colId: col.id })}
                                title={`${row.name} × ${col.name}：同一句上共现 ${n} 次`}
                              >
                                {n}
                              </button>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}

        {tab === 'framework' && (
          <>
            <div className="coding-analysis-note">
              框架矩阵（NVivo Framework Matrix）：行是案例，列是顶层码，格子是该案例在该码下的代表引文与条数。点引文跳到对应录音。
            </div>
            <div className="coding-matrix-wrap scroll-hidden">
              <table className="coding-matrix">
                <thead>
                  <tr>
                    <th>案例</th>
                    {topCodes.map((c) => (
                      <th key={c.id} title={c.definition || c.name}>
                        <span className="coding-matrix-case">{c.name}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {frameworkRows.map((row) => (
                    <tr key={row.key}>
                      <td className="coding-matrix-code">{row.label}</td>
                      {topCodes.map((code) => {
                        const hit = firstQuoteFor(row.docId, code.id)
                        return (
                          <td key={code.id} style={{ minWidth: 160, verticalAlign: 'top' }}>
                            {hit ? (
                              <button
                                type="button"
                                onClick={() => jump(hit.entry)}
                                style={{
                                  display: 'block', textAlign: 'left', width: '100%',
                                  background: 'transparent', border: 0, padding: 2, cursor: 'pointer',
                                  fontSize: 11, lineHeight: 1.5, color: '#3b4250',
                                }}
                                title={`点开跳到原文（该格共 ${hit.count} 条）`}
                              >
                                {hit.entry.quote.slice(0, 60)}
                                {hit.entry.quote.length > 60 ? '…' : ''}
                                {hit.count > 1 && <span style={{ color: '#8a8f98' }}> ＋{hit.count - 1}</span>}
                              </button>
                            ) : (
                              <span style={{ color: '#d0d4da', fontSize: 11 }}>—</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'search' && (
          <>
            <div className="coding-matrix-controls" style={{ alignItems: 'center' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜编码引文里的词或短语"
                style={{ flex: 1, minWidth: 120, fontSize: 12, padding: '5px 8px', border: '1px solid #d5dae2', borderRadius: 6 }}
              />
              <select value={codeFilter} onChange={(e) => setCodeFilter(e.target.value)} style={{ fontSize: 12, padding: 4 }}>
                <option value="">全部码</option>
                {codes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {(query || codeFilter) && (
                <button type="button" className="coding-ghost-btn" onClick={() => { setQuery(''); setCodeFilter('') }}>
                  清空
                </button>
              )}
            </div>
            {query.trim() && wordFrequency.length > 0 && (
              <div className="coding-hint">
                {wordFrequency.map((w) => `${docTitle(w.docId)} ${w.n} 次`).join(' · ')}
              </div>
            )}
            <div className="coding-label">
              {query || codeFilter ? `${searchResults.length} 条匹配` : `全部 ${totalCodings} 条编码`}
            </div>
            <div className="coding-evidence-list scroll-hidden">
              {searchResults.length === 0 && <div className="coding-empty">没有匹配的编码片段。</div>}
              {searchResults.map((entry) => {
                const code = codeById(store, entry.code_id)
                const isCurrent = entry.document_id === documentId(currentRecordingId || '')
                const firstSpan = entry.spans[0]
                const time = isCurrent && firstSpan ? sentenceTime.get(firstSpan.sentence_id)?.start : undefined
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className="coding-evidence-row"
                    onClick={() => jump(entry)}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' }}
                    title="跳到原文并播放"
                  >
                    <div className="coding-evidence-quote">“{entry.quote}”</div>
                    <div className="coding-evidence-meta">
                      <span>{docTitle(entry.document_id)}</span>
                      {time != null && <span>{fmtTime(time)}</span>}
                      {code && <CodeChip code={code} />}
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </section>

      <aside className="workspace-card coding-analysis-right" style={{ gridColumn: 'span 2' }}>
        <SideTitle>
          {selected
            ? selected.type === 'cell'
              ? `证据 · ${codeById(store, selected.codeId)?.name || '码'} × ${
                  columns.find((c) => c.key === selected.columnKey)?.label || ''
                }`
              : `共现 · ${codeById(store, selected.rowId)?.name || ''} × ${codeById(store, selected.colId)?.name || ''}`
            : '证据'}
        </SideTitle>
        {selected && (
          <button type="button" className="coding-ghost-btn" onClick={() => setSelected(null)}>
            清除选择
          </button>
        )}
        <div className="coding-evidence-list scroll-hidden" style={{ marginTop: 8 }}>
          {!selected && (
            <div className="coding-empty">
              {matrixMode === 'cooccur' && tab === 'matrix'
                ? '点共现矩阵的格子，看看两个码在哪些句子上同时出现。'
                : '点矩阵单元格、框架矩阵引文，或直接检索，这里列出对应片段；点片段跳到原文并播放。'}
            </div>
          )}
          {selected && evidence.length === 0 && (
            <div className="coding-empty">这个组合还没有编码片段。</div>
          )}
          {evidence.slice(0, 40).map((entry) => {
            const code = codeById(store, entry.code_id)
            const isCurrent = entry.document_id === documentId(currentRecordingId || '')
            const firstSpan = entry.spans[0]
            const time = isCurrent && firstSpan ? sentenceTime.get(firstSpan.sentence_id)?.start : undefined
            return (
              <button
                key={entry.id}
                type="button"
                className="coding-evidence-row"
                onClick={() => jump(entry)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' }}
                title="跳到原文并播放"
              >
                <div className="coding-evidence-quote">“{entry.quote}”</div>
                <div className="coding-evidence-meta">
                  <span>{docTitle(entry.document_id)}</span>
                  {time != null && <span>{fmtTime(time)}</span>}
                  {code && <CodeChip code={code} />}
                </div>
              </button>
            )
          })}
        </div>
      </aside>
    </>
  )
}
