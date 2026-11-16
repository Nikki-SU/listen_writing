import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CodingCode, CodingEntry } from '../types'
import { useIde } from './IdeContext'

/** 面板所需的最小数据接口：个人与协作两个数据源都满足它。 */
export type IdeData = {
  codes: CodingCode[]
  topCodes: CodingCode[]
  attributes: string[]
  myCodings: CodingEntry[]
  codeById: (id: string) => CodingCode | undefined
  caseValue: (docId: string, label: string) => string
  docTitle: (docId: string) => string
  recordingOf: (docId: string) => string | undefined
  sentenceTime: Map<string, number>
  caseColumns: { key: string; label: string; docIds: string[] }[]
  attributeColumns: (dim: string) => { key: string; label: string; docIds: string[] }[]
  countInColumn: (codeId: string, docIds: string[]) => number
  cooccurrence: (aId: string, bId: string) => number
  evidenceForCell: (codeId: string, docIds: string[]) => CodingEntry[]
  evidenceForPair: (rowId: string, colId: string) => CodingEntry[]
  searchCodings: (q: string, codeFilter: string) => CodingEntry[]
  wordFrequency: (q: string) => { docId: string; n: number }[]
  frameworkRows: { key: string; label: string; docId: string }[]
  firstQuoteFor: (docId: string, codeId: string) => { entry: CodingEntry; count: number } | null
  currentDocId: string | null
  sentences: { id: string; text: string; start_ms: number }[]
}
import { CodeChip } from '../coding/common'
function fmtTime(ms: number): string {
  const t = Math.floor(ms / 1000)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

type Column = { key: string; label: string; docIds: string[] }

/** 矩阵查询：码×案例 / 码×码共现，点格子联动到证据面板。 */
export function MatrixQueryPanel({ data }: { data: IdeData }) {
  const { selection, setSelection } = useIde()
  const [dimension, setDimension] = useState('case')
  const [mode, setMode] = useState<'case' | 'cooccur'>('case')

  const columns: Column[] = useMemo(
    () => (dimension === 'case' ? data.caseColumns : data.attributeColumns(dimension)),
    [dimension, data],
  )

  const matrixRows = (parentId: string | null, depth: number): ReactNode[] =>
    data.codes.filter((c) => c.parent_id === parentId).flatMap((code) => [
      <tr key={code.id}>
        <td className="coding-matrix-code" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="coding-dot" style={{ background: code.color }} />{code.name}
        </td>
        {(mode === 'case' ? columns : data.topCodes).map((col: Column | { id: string; name: string }) => {
          const isCol = 'docIds' in col
          const key = isCol ? col.key : col.id
          const label = isCol ? col.label : col.name
          const count = isCol ? data.countInColumn(code.id, col.docIds) : data.cooccurrence(code.id, col.id)
          const active = selection.codeId === code.id && selection.highlight === key
          return (
            <td key={key}>
              <button type="button"
                className={`coding-matrix-cell${count ? '' : ' zero'}${active ? ' active' : ''}`}
                onClick={() => {
                  setSelection({ codeId: code.id, highlight: key, documentId: null })
                  window.dispatchEvent(new CustomEvent('ide:evidence', {
                    detail: isCol
                      ? { kind: 'cell', codeId: code.id, docIds: col.docIds }
                      : { kind: 'pair', rowId: code.id, colId: col.id },
                  }))
                }}
                title={`${code.name} × ${label}`}>{count}</button>
            </td>
          )
        })}
      </tr>,
      ...matrixRows(code.id, depth + 1),
    ])

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <select value={dimension} onChange={(e) => setDimension(e.target.value)}
          style={{ fontSize: 11, borderRadius: 6, padding: '3px 6px' }}>
          <option value="case">案例（访谈对象）</option>
          {data.attributes.map((a) => <option key={a} value={a}>属性：{a}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button className={`coding-ghost-btn${mode === 'case' ? ' active' : ''}`} onClick={() => setMode('case')}>码 × 案例</button>
        <button className={`coding-ghost-btn${mode === 'cooccur' ? ' active' : ''}`} onClick={() => setMode('cooccur')}>码 × 码共现</button>
      </div>
      <div style={{ overflow: 'auto' }}>
        <table className="coding-matrix">
          <thead><tr><th>码</th>
            {(mode === 'case' ? columns : data.topCodes).map((c) =>
              <th key={'docIds' in c ? c.key : c.id}>{'docIds' in c ? c.label : c.name}</th>)}
          </tr></thead>
          <tbody>{matrixRows(null, 0)}</tbody>
        </table>
      </div>
    </div>
  )
}

/** 证据：跟随矩阵选择，列出对应编码引文；点引文跳到原文。 */
export function EvidencePanel({ data, onJump }: { data: IdeData; onJump?: (recordingId: string, sentenceId: string) => void }) {
  const [entries, setEntries] = useState<ReturnType<IdeData['evidenceForCell']>>([])

  useEffect(() => {
    const onEvidence = (e: Event) => {
      const d = (e as CustomEvent).detail
      setEntries(d.kind === 'cell' ? data.evidenceForCell(d.codeId, d.docIds) : data.evidenceForPair(d.rowId, d.colId))
    }
    window.addEventListener('ide:evidence', onEvidence)
    return () => window.removeEventListener('ide:evidence', onEvidence)
  }, [data])

  return (
    <div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: '#9aa0a6', paddingTop: 16, textAlign: 'center' }}>点矩阵单元格查看证据</div>
      ) : entries.map((c) => {
        const sid = c.spans[0]?.sentence_id
        const rec = data.recordingOf(c.document_id)
        const code = data.codeById(c.code_id)
        return (
          <div key={c.id} style={{ border: '1px solid #e8ebf0', borderRadius: 8, padding: 8, marginBottom: 6 }}>
            {code && <CodeChip code={code} />}
            <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>{c.quote}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 10, color: '#8a8f98', flex: 1 }}>{data.docTitle(c.document_id)} · {fmtTime(data.sentenceTime.get(c.spans[0]?.sentence_id ?? '') ?? 0)}</span>
              {sid && rec && onJump && <button onClick={() => onJump(rec, sid)} style={{ fontSize: 10, padding: '1px 6px' }}>跳转</button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 框架矩阵：行=案例，列=顶层码，格子=代表引文与条数。 */
export function FrameworkMatrixPanel({ data, onJump }: { data: IdeData; onJump?: (recordingId: string, sentenceId: string) => void }) {
  return (
    <div style={{ overflow: 'auto' }}>
      <table className="coding-matrix">
        <thead><tr><th>案例</th>{data.topCodes.map((c) => <th key={c.id} title={c.definition || c.name}><span className="coding-matrix-case">{c.name}</span></th>)}</tr></thead>
        <tbody>
          {data.frameworkRows.map((row) => (
            <tr key={row.key}>
              <td className="coding-matrix-code">{row.label}</td>
              {data.topCodes.map((code) => {
                const hit = data.firstQuoteFor(row.docId, code.id)
                return (
                  <td key={code.id} style={{ minWidth: 160, verticalAlign: 'top' }}>
                    {hit ? (
                      <button type="button" onClick={() => { const sid = hit.entry.spans[0]?.sentence_id; const rec = data.recordingOf(hit.entry.document_id); if (sid && rec && onJump) onJump(rec, sid) }}
                        style={{ display: 'block', textAlign: 'left', width: '100%', background: 'transparent', border: 0, padding: 2, cursor: 'pointer', fontSize: 11, lineHeight: 1.5, color: '#3b4250' }}
                        title={`点开跳到原文（该格共 ${hit.count} 条）`}>
                        {hit.entry.quote.slice(0, 60)}{hit.entry.quote.length > 60 ? '…' : ''}
                        {hit.count > 1 && <span style={{ color: '#8a8f98' }}> ＋{hit.count - 1}</span>}
                      </button>
                    ) : <span style={{ color: '#d0d4da', fontSize: 11 }}>—</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 检索：按词/码过滤编码引文，点结果跳到原文。 */
export function SearchPanel({ data, onJump }: { data: IdeData; onJump?: (recordingId: string, sentenceId: string) => void }) {
  const [query, setQuery] = useState('')
  const [codeFilter, setCodeFilter] = useState('')
  const results = data.searchCodings(query, codeFilter)
  const freq = data.wordFrequency(query)
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜编码引文里的词或短语"
          style={{ flex: 1, minWidth: 120, fontSize: 12, padding: '5px 8px', border: '1px solid #d5dae2', borderRadius: 6 }} />
        <select value={codeFilter} onChange={(e) => setCodeFilter(e.target.value)} style={{ fontSize: 12, padding: 4, borderRadius: 6 }}>
          <option value="">全部码</option>
          {data.codes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {(query || codeFilter) && <button className="coding-ghost-btn" onClick={() => { setQuery(''); setCodeFilter('') }}>清空</button>}
      </div>
      {query.trim() && freq.length > 0 && (
        <div className="coding-hint">{freq.map((w) => `${data.docTitle(w.docId)} ${w.n} 次`).join(' · ')}</div>
      )}
      <div className="coding-label">{query || codeFilter ? `${results.length} 条匹配` : `全部 ${data.myCodings.length} 条编码`}</div>
      <div className="coding-evidence-list scroll-hidden">
        {results.length === 0 && <div className="coding-empty">没有匹配的编码片段。</div>}
        {results.map((entry) => {
          const code = data.codeById(entry.code_id)
          const firstSpan = entry.spans[0]
          const time = firstSpan ? data.sentenceTime.get(firstSpan.sentence_id) : undefined
          return (
            <button key={entry.id} type="button" className="coding-evidence-row" onClick={() => { const sid = firstSpan?.sentence_id; const rec = data.recordingOf(entry.document_id); if (sid && rec && onJump) onJump(rec, sid) }}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' }} title="跳到原文并播放">
              <div className="coding-evidence-quote">“{entry.quote}”</div>
              <div className="coding-evidence-meta">
                <span>{data.docTitle(entry.document_id)}</span>
                {time != null && <span>{fmtTime(time)}</span>}
                {code && <CodeChip code={code} />}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 文本展示：当前条目的转写正文，点句子更新共享上下文。 */
export function TextPanel({ data }: { data: IdeData }) {
  const { selection, setSelection } = useIde()
  return (
    <div>
      {data.sentences.map((s) => {
        const active = selection.sentenceId === s.id
        return (
          <div key={s.id} onClick={() => setSelection({ sentenceId: s.id, documentId: data.currentDocId })}
            style={{ fontSize: 13, lineHeight: 1.8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: active ? '#eef4ff' : 'transparent', marginBottom: 2 }}>
            <span style={{ fontSize: 10, color: '#8a8f98', marginRight: 8 }}>{fmtTime(s.start_ms)}</span>{s.text}
          </div>
        )
      })}
      {data.sentences.length === 0 && <div style={{ fontSize: 12, color: '#9aa0a6' }}>当前没有转写正文</div>}
    </div>
  )
}

/** 条目属性：挂在 case 上，展示当前条目的自定义字段。 */
export type CasePropsEdit = {
  attributeSets: { id: string; name: string; fields: string[] }[]
  applySet: (docId: string, setId: string) => void
  upsertSet: (set: { id: string; name: string; fields: string[] }) => void
  deleteSet: (setId: string) => void
  caseAttributes: (docId: string) => { id: string; label: string; value: string }[]
  updateCaseAttrs: (docId: string, attrs: { id: string; label: string; value: string }[]) => void
}

export function CasePropsPanel({ data, edit }: { data: IdeData; edit?: CasePropsEdit }) {
  const docId = data.currentDocId
  const [setId, setSetId] = useState('')
  const [manage, setManage] = useState(false)
  const [draft, setDraft] = useState<{ id: string; name: string; fields: string[] }[]>([])

  const attrs = edit && docId ? edit.caseAttributes(docId) : []
  const patchAttr = (id: string, patch: { label?: string; value?: string }) => {
    if (!edit || !docId) return
    edit.updateCaseAttrs(docId, attrs.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }
  const removeAttr = (id: string) => {
    if (!edit || !docId) return
    edit.updateCaseAttrs(docId, attrs.filter((a) => a.id !== id))
  }
  const addAttr = () => {
    if (!edit || !docId) return
    edit.updateCaseAttrs(docId, [...attrs, { id: `attr_${Date.now()}`, label: '', value: '' }])
  }

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{docId ? data.docTitle(docId) : '未选择条目'}</div>
      {edit && docId ? (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
            <select value={setId} onChange={(e) => setSetId(e.target.value)} style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6, flex: 1 }}>
              <option value="">选择属性集</option>
              {edit.attributeSets.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.fields.length} 字段）</option>)}
            </select>
            <button disabled={!setId} onClick={() => { edit.applySet(docId, setId); setSetId('') }} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6 }}>导入</button>
            <button onClick={() => { setDraft(edit.attributeSets.map((s) => ({ ...s, fields: [...s.fields] }))); setManage((v) => !v) }} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6 }}>管理属性集</button>
          </div>
          {manage && (
            <div style={{ border: '1px solid #e8ebf0', borderRadius: 8, padding: 8, marginBottom: 10 }}>
              {draft.map((s, si) => (
                <div key={si} style={{ borderBottom: '1px solid #f0f2f5', paddingBottom: 6, marginBottom: 6 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                    <input value={s.name} onChange={(e) => setDraft((d) => d.map((x, i) => i === si ? { ...x, name: e.target.value } : x))} placeholder="属性集名" style={{ fontSize: 11, flex: 1, padding: '3px 6px', borderRadius: 5, border: '1px solid #d5dae2' }} />
                    <button onClick={() => setDraft((d) => d.filter((_, i) => i !== si))} style={{ fontSize: 11 }}>×</button>
                  </div>
                  <input value={s.fields.join(', ')} onChange={(e) => setDraft((d) => d.map((x, i) => i === si ? { ...x, fields: e.target.value.split(',').map((f) => f.trim()).filter(Boolean) } : x))} placeholder="字段，用逗号分隔" style={{ fontSize: 11, width: '100%', boxSizing: 'border-box', padding: '3px 6px', borderRadius: 5, border: '1px solid #d5dae2' }} />
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => setDraft((d) => [...d, { id: `as_${Date.now()}`, name: '', fields: [] }])} style={{ fontSize: 11, padding: '2px 8px' }}>+ 新建集</button>
                <button onClick={() => { draft.filter((s) => s.name.trim()).forEach((s) => edit.upsertSet(s)); setManage(false) }} style={{ fontSize: 11, padding: '2px 8px' }}>保存</button>
                <button onClick={() => setManage(false)} style={{ fontSize: 11, padding: '2px 8px' }}>取消</button>
              </div>
            </div>
          )}
          {attrs.map((a) => (
            <div key={a.id} style={{ display: 'flex', gap: 6, padding: '4px 0', borderBottom: '1px solid #f0f2f5', alignItems: 'center' }}>
              <input value={a.label} onChange={(e) => patchAttr(a.id, { label: e.target.value })} placeholder="字段名" style={{ fontSize: 11, width: 84, padding: '3px 5px', borderRadius: 5, border: '1px solid #e8ebf0' }} />
              <input value={a.value} onChange={(e) => patchAttr(a.id, { value: e.target.value })} placeholder="值" style={{ fontSize: 11, flex: 1, minWidth: 0, padding: '3px 5px', borderRadius: 5, border: '1px solid #e8ebf0' }} />
              <button onClick={() => removeAttr(a.id)} style={{ fontSize: 11, color: '#b00020', border: 'none', background: 'transparent', cursor: 'pointer' }}>×</button>
            </div>
          ))}
          <button onClick={addAttr} style={{ fontSize: 11, marginTop: 8, padding: '2px 8px', borderRadius: 6 }}>＋ 自定义字段</button>
        </>
      ) : (
        <>
          {data.attributes.map((label) => (
            <div key={label} style={{ display: 'flex', gap: 8, padding: '5px 0', borderBottom: '1px solid #f0f2f5', fontSize: 12 }}>
              <span style={{ color: '#8a8f98', width: 100, flexShrink: 0 }}>{label}</span>
              <span>{docId ? data.caseValue(docId, label) || '—' : '—'}</span>
            </div>
          ))}
          {data.attributes.length === 0 && <div style={{ fontSize: 12, color: '#9aa0a6' }}>该项目还没有条目属性</div>}
        </>
      )}
    </div>
  )
}

/** 辅助编码：当前条目的编码，点码更新共享上下文。 */
export function CodingListPanel({ data }: { data: IdeData }) {
  const { selection, setSelection } = useIde()
  const list = data.myCodings.filter((c) => !selection.documentId || c.document_id === selection.documentId)
  return (
    <div>
      {list.map((c) => {
        const code = data.codeById(c.code_id)
        return (
          <div key={c.id} onClick={() => setSelection({ codeId: c.code_id })}
            style={{ padding: 8, border: '1px solid #e8ebf0', borderRadius: 8, marginBottom: 6, cursor: 'pointer', background: selection.codeId === c.code_id ? '#eef4ff' : '#fff' }}>
            {code && <CodeChip code={code} />}
            <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 4 }}>{c.quote}</div>
          </div>
        )
      })}
      {list.length === 0 && <div style={{ fontSize: 12, color: '#9aa0a6' }}>当前条目还没有编码</div>}
    </div>
  )
}

/** AI 助手 / 产物：后端能力尚未接入，给真实空态，不造假。 */
export function AiPanel() {
  return <div style={{ fontSize: 12, color: '#9aa0a6', paddingTop: 16, textAlign: 'center' }}>AI 助手尚未接入</div>
}
export function ArtifactsPanel() {
  return <div style={{ fontSize: 12, color: '#9aa0a6', paddingTop: 16, textAlign: 'center' }}>产物留档尚未接入</div>
}
