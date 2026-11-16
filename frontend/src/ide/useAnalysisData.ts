import { useEffect, useMemo, useState } from 'react'
import type { CodingEntry, CodingStore, Recording, RecordingDetail } from '../types'
import {
  applyAttributeSet, caseAttributeLabels, caseAttributeValue, caseFor, codeById, documentId,
  hydrateCodingStore, loadCodingStore, saveCodingStore, subtreeIds, upsertAttributeSet, deleteAttributeSet,
} from '../coding/store'
import type { AttributeSet } from '../types'

const ME = 'me'

/** 分析数据源：个人本机码库。面板通过它取数，不各自读 store。 */
export function useAnalysisData(projectId: string, recordings: Recording[], detail: RecordingDetail | null) {
  const [store, setStore] = useState<CodingStore>(() => loadCodingStore(projectId))

  useEffect(() => {
    setStore(loadCodingStore(projectId))
    let cancelled = false
    void hydrateCodingStore(projectId).then((remote) => {
      if (!cancelled && remote) setStore(remote)
    })
    return () => { cancelled = true }
  }, [projectId])

  const codes = useMemo(() => store.codes.filter((c) => c.status === 'active'), [store])
  const topCodes = useMemo(() => codes.filter((c) => !c.parent_id), [codes])
  const attributes = useMemo(() => caseAttributeLabels(store), [store])
  const myCodings = useMemo(() => store.codings.filter((c) => c.coder_id === ME), [store])

  const docTitle = (docId: string): string =>
    caseFor(store, docId)?.case_name?.trim() ||
    recordings.find((r) => documentId(r.id) === docId)?.name || docId

  const recordingOf = (docId: string): string | undefined =>
    recordings.find((r) => documentId(r.id) === docId)?.id

  const sentenceTime = useMemo(() => {
    const map = new Map<string, number>()
    detail?.sentences.forEach((s) => map.set(s.id, s.start_ms))
    return map
  }, [detail])

  const caseColumns = useMemo(() => recordings.map((r) => {
    const doc = documentId(r.id)
    return { key: doc, label: caseFor(store, doc)?.case_name?.trim() || r.name, docIds: [doc] }
  }), [recordings, store])

  function attributeColumns(dimension: string) {
    const grouped = new Map<string, string[]>()
    for (const r of recordings) {
      const doc = documentId(r.id)
      const value = caseAttributeValue(store, doc, dimension) || '未填写'
      grouped.set(value, [...(grouped.get(value) || []), doc])
    }
    return Array.from(grouped.entries()).map(([label, docIds]) => ({
      key: `attr:${dimension}:${label}`, label, docIds,
    }))
  }

  function countInColumn(codeId: string, docIds: string[]): number {
    const sub = subtreeIds(store, codeId)
    return myCodings.filter((c) => docIds.includes(c.document_id) && sub.has(c.code_id)).length
  }

  function cooccurrence(aId: string, bId: string): number {
    if (aId === bId) {
      const sub = subtreeIds(store, aId)
      const keys = new Set<string>()
      for (const c of myCodings) {
        if (!sub.has(c.code_id)) continue
        for (const sp of c.spans) keys.add(`${c.document_id}::${sp.sentence_id}`)
      }
      return keys.size
    }
    const aSub = subtreeIds(store, aId)
    const bSub = subtreeIds(store, bId)
    const a = new Map<string, Set<string>>()
    const b = new Map<string, Set<string>>()
    for (const c of myCodings) {
      for (const sp of c.spans) {
        const key = `${c.document_id}::${sp.sentence_id}`
        if (aSub.has(c.code_id)) { if (!a.has(key)) a.set(key, new Set()); a.get(key)!.add(c.id) }
        if (bSub.has(c.code_id)) { if (!b.has(key)) b.set(key, new Set()); b.get(key)!.add(c.id) }
      }
    }
    let n = 0
    a.forEach((ids, key) => { if (b.has(key)) n += Math.min(ids.size, b.get(key)!.size) })
    return n
  }

  function evidenceForCell(codeId: string, docIds: string[]): CodingEntry[] {
    const sub = subtreeIds(store, codeId)
    return myCodings.filter((c) => docIds.includes(c.document_id) && sub.has(c.code_id))
  }

  function evidenceForPair(rowId: string, colId: string): CodingEntry[] {
    const rowSub = subtreeIds(store, rowId)
    const colSub = subtreeIds(store, colId)
    const rowsBySentence = new Map<string, Set<string>>()
    const colsBySentence = new Map<string, Set<string>>()
    for (const c of myCodings) {
      for (const sp of c.spans) {
        const key = `${c.document_id}::${sp.sentence_id}`
        if (rowSub.has(c.code_id)) { if (!rowsBySentence.has(key)) rowsBySentence.set(key, new Set()); rowsBySentence.get(key)!.add(c.id) }
        if (colSub.has(c.code_id)) { if (!colsBySentence.has(key)) colsBySentence.set(key, new Set()); colsBySentence.get(key)!.add(c.id) }
      }
    }
    const hits = new Set<string>()
    rowsBySentence.forEach((ids, key) => { if (colsBySentence.has(key)) ids.forEach((id) => hits.add(id)) })
    return store.codings.filter((c) => hits.has(c.id))
  }

  function searchCodings(query: string, codeFilter: string): CodingEntry[] {
    const q = query.trim().toLowerCase()
    const sub = codeFilter ? subtreeIds(store, codeFilter) : null
    return myCodings
      .filter((c) => (sub ? sub.has(c.code_id) : true))
      .filter((c) => (q ? c.quote.toLowerCase().includes(q) : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 80)
  }

  function wordFrequency(query: string): { docId: string; n: number }[] {
    const q = query.trim()
    if (!q) return []
    const counter = new Map<string, number>()
    for (const c of myCodings) {
      let idx = c.quote.indexOf(q)
      while (idx !== -1) {
        counter.set(c.document_id, (counter.get(c.document_id) || 0) + 1)
        idx = c.quote.indexOf(q, idx + q.length)
      }
    }
    return Array.from(counter.entries()).map(([docId, n]) => ({ docId, n }))
  }

  const frameworkRows = recordings.map((r) => {
    const doc = documentId(r.id)
    return { key: doc, label: caseFor(store, doc)?.case_name?.trim() || r.name, docId: doc }
  })

  function firstQuoteFor(docId: string, codeId: string): { entry: CodingEntry; count: number } | null {
    const sub = subtreeIds(store, codeId)
    const list = myCodings.filter((c) => c.document_id === docId && sub.has(c.code_id))
    return list.length ? { entry: list[0], count: list.length } : null
  }

  function mutate(fn: (s: CodingStore) => CodingStore) {
    setStore((prev) => {
      const next = fn(prev)
      saveCodingStore(next)
      return next
    })
  }

  function updateCaseAttrs(docId: string, attrs: { id: string; label: string; value: string }[]) {
    mutate((s) => ({
      ...s,
      cases: s.cases.map((c) => (c.document_id === docId ? { ...c, attributes: attrs } : c)),
    }))
  }

  return {
    store, codes, topCodes, attributes, myCodings,
    codeById: (id: string) => codeById(store, id),
    caseValue: (docId: string, label: string) => caseAttributeValue(store, docId, label),
    docTitle, recordingOf, sentenceTime, caseColumns, attributeColumns,
    countInColumn, cooccurrence, evidenceForCell, evidenceForPair,
    searchCodings, wordFrequency, frameworkRows, firstQuoteFor,
    currentDocId: detail?.recording.id ? documentId(detail.recording.id) : null,
    sentences: detail?.sentences ?? [],
    // 属性集编辑（个人版）：面板通过它们导入属性集 + 加自定义字段。
    attributeSets: store.attribute_sets ?? [],
    applySet: (docId: string, setId: string) => mutate((s) => applyAttributeSet(s, docId, setId)),
    upsertSet: (set: AttributeSet) => mutate((s) => upsertAttributeSet(s, set)),
    deleteSet: (setId: string) => mutate((s) => deleteAttributeSet(s, setId)),
    caseAttributes: (docId: string) => caseFor(store, docId)?.attributes ?? [],
    updateCaseAttrs,
  }
}

export type AnalysisData = ReturnType<typeof useAnalysisData>
