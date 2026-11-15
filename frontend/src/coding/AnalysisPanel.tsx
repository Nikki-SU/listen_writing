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
  | { type: 'theme'; themeId: string }

type Column = {
  key: string
  label: string
  docIds: string[]
}

const THEMES = [
  {
    id: 'theme_form',
    name: '在形式化治理中维持最低限度的参与',
    definition: '参与不是为了改变，而是为了不被指出问题。',
    codeIds: ['code_form', 'code_perf', 'code_must', 'code_powerless'],
  },
  {
    id: 'theme_boundary',
    name: '把政治说成日常：边界工作的两种说法',
    definition: '用玩笑、梗与“都明白”把敏感话题留在可说的边界内。',
    codeIds: ['code_boundary', 'code_depol', 'code_selfc'],
  },
  {
    id: 'theme_visible',
    name: '照片与表格构成的可见性',
    definition: '只有被拍下、被填进表格的行动才算“做了”。',
    codeIds: ['code_photo', 'code_table'],
  },
]

export default function AnalysisPanel({
  projectId,
  recordings,
  detail,
}: {
  projectId: string
  recordings: Recording[]
  detail: RecordingDetail | null
}) {
  const [store] = useState<CodingStore>(() => loadCodingStore(projectId))
  const [selected, setSelected] = useState<Selection | null>(null)
  const [dimension, setDimension] = useState<string>('case')

  const codes = store.codes.filter((c) => c.status === 'active')
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
    const map = new Map<string, { start: number; text: string }>()
    detail?.sentences.forEach((s) => map.set(s.id, { start: s.start_ms, text: s.text }))
    return map
  }, [detail])

  function docTitle(docId: string): string {
    const recording = recordings.find((r) => documentId(r.id) === docId)
    const name = caseFor(store, docId)?.case_name?.trim()
    return name || recording?.name || docId
  }

  function codingsForSelection(): CodingEntry[] {
    if (!selected) return []
    if (selected.type === 'cell') {
      const column = columns.find((c) => c.key === selected.columnKey)
      if (!column) return []
      const ids = subtreeIds(store, selected.codeId)
      return store.codings.filter(
        (c) =>
          c.coder_id === 'me' &&
          column.docIds.includes(c.document_id) &&
          ids.has(c.code_id),
      )
    }
    const theme = THEMES.find((t) => t.id === selected.themeId)
    if (!theme) return []
    const ids = new Set<string>()
    theme.codeIds.forEach((id) => subtreeIds(store, id).forEach((x) => ids.add(x)))
    return store.codings.filter((c) => c.coder_id === 'me' && ids.has(c.code_id))
  }

  const evidence = codingsForSelection()

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
                  c.coder_id === 'me' &&
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

  return (
    <>
      <section className="workspace-card coding-analysis-left" style={{ gridColumn: 'span 2' }}>
        <SideTitle extra={`${store.codings.length} 条编码`}>码 × 案例</SideTitle>
        <div className="coding-analysis-note">
          NVivo 式矩阵：行是码，列是案例或案例属性（职级、学科…）。点单元格看证据。
        </div>
        <div className="coding-matrix-controls">
          <span>列维度</span>
          <select value={dimension} onChange={(e) => { setDimension(e.target.value); setSelected(null) }}>
            <option value="case">案例（访谈对象）</option>
            {attributes.map((label) => (
              <option key={label} value={label}>
                属性：{label}
              </option>
            ))}
          </select>
        </div>
        {dimension !== 'case' && (
          <div className="coding-hint">
            按“{dimension}”分组；未填写的案例归入“未填写”。在编码页右栏的“案例属性”里补充值。
          </div>
        )}
        <div className="coding-matrix-wrap scroll-hidden">
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
        </div>
      </section>

      <section className="workspace-card coding-analysis-right" style={{ gridColumn: 'span 2' }}>
        <SideTitle extra={`${THEMES.length} 个`}>主题板</SideTitle>
        <div className="coding-theme-list">
          {THEMES.map((theme) => {
            const ids = new Set<string>()
            theme.codeIds.forEach((id) => subtreeIds(store, id).forEach((x) => ids.add(x)))
            const count = store.codings.filter(
              (c) => c.coder_id === 'me' && ids.has(c.code_id),
            ).length
            const active = selected?.type === 'theme' && selected.themeId === theme.id
            return (
              <button
                key={theme.id}
                type="button"
                className={`coding-theme-card${active ? ' active' : ''}`}
                onClick={() => setSelected({ type: 'theme', themeId: theme.id })}
              >
                <span className="coding-theme-name">{theme.name}</span>
                <span className="coding-theme-def">{theme.definition}</span>
                <span className="coding-theme-meta">证据 {count} 条</span>
                <span className="coding-theme-codes">
                  {theme.codeIds.map((id) => {
                    const code = codeById(store, id)
                    return code ? <CodeChip key={id} code={code} /> : null
                  })}
                </span>
              </button>
            )
          })}
        </div>

        <div className="coding-evidence-head">
          <SideTitle>
            {selected
              ? selected.type === 'cell'
                ? `证据 · ${codeById(store, selected.codeId)?.name || '码'} × ${
                    columns.find((c) => c.key === selected.columnKey)?.label || ''
                  }`
                : '证据 · 主题'
              : '证据'}
          </SideTitle>
          {selected && (
            <button type="button" className="coding-ghost-btn" onClick={() => setSelected(null)}>
              清除选择
            </button>
          )}
        </div>
        <div className="coding-evidence-list scroll-hidden">
          {!selected && (
            <div className="coding-empty">点矩阵单元格或主题卡片，这里列出对应片段。</div>
          )}
          {selected && evidence.length === 0 && (
            <div className="coding-empty">这个组合还没有编码片段。</div>
          )}
          {evidence.slice(0, 30).map((entry) => {
            const code = codeById(store, entry.code_id)
            const isCurrent = entry.document_id === documentId(currentRecordingId || '')
            const firstSpan = entry.spans[0]
            const time = isCurrent && firstSpan ? sentenceTime.get(firstSpan.sentence_id)?.start : undefined
            return (
              <div key={entry.id} className="coding-evidence-row">
                <div className="coding-evidence-quote">“{entry.quote}”</div>
                <div className="coding-evidence-meta">
                  <span>{docTitle(entry.document_id)}</span>
                  {time != null && (
                    <span>{`${Math.floor(time / 60000)}:${String(
                      Math.floor((time % 60000) / 1000),
                    ).padStart(2, '0')}`}</span>
                  )}
                  {code && <CodeChip code={code} />}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </>
  )
}
