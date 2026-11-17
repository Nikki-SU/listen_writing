import { useEffect, useMemo, useState } from 'react'
import type { AttributeSet, CodingCase, CodingCode, CodingEntry, Sentence } from '../types'
import * as api from '../api'
import { applyAttributeSet as applySetToCases } from '../coding/store'

/**
 * 协作分析数据源：把后端 GroupCoding 适配成与个人版 AnalysisData 相同的接口，
 * 让七个 IDE 面板两边共用。个人模式=我标的；共享模式=共享码本口径。
 */
export function useGroupAnalysisData(groupId: string, materialId: string, sentences: Sentence[], deviceCode: string) {
  const [data, setData] = useState<api.GroupCoding | null>(null)
  const [mode, setMode] = useState<'personal' | 'shared'>('personal')

  const cases = data?.cases ?? []
  const attributeSets = data?.attribute_sets ?? []
  function persistCases(nextCases: CodingCase[], nextSets: AttributeSet[]) {
    setData((prev) => (prev ? { ...prev, cases: nextCases, attribute_sets: nextSets } : prev))
    void api.saveGroupCases(groupId, materialId, deviceCode, nextCases, nextSets).then((res) => {
      setData(res)
    }).catch(() => undefined)
  }
  function updateCaseAttrs(docId: string, attrs: { id: string; label: string; value: string }[]) {
    persistCases(cases.map((c) => (c.document_id === docId ? { ...c, attributes: attrs } : c)), attributeSets)
  }
  function applySet(docId: string, setId: string) {
    // 借用个人 store 的套用逻辑：用一个临时 store 算出加了字段的 cases。
    const tmp = { schema: 1 as const, project_id: groupId, codebook: { id: '', name: '', updated_at: '' },
      documents: [], attribute_sets: attributeSets, cases, codes, codings: myCodings, resolutions: [] }
    const next = applySetToCases(tmp, docId, setId)
    persistCases(next.cases, attributeSets)
  }
  function upsertSet(set: AttributeSet) {
    const exists = attributeSets.some((s) => s.id === set.id)
    persistCases(cases, exists ? attributeSets.map((s) => (s.id === set.id ? set : s)) : [...attributeSets, set])
  }
  function deleteSet(setId: string) {
    persistCases(cases, attributeSets.filter((s) => s.id !== setId))
  }

  useEffect(() => {
    let cancelled = false
    setData(null)
    void api.getGroupCoding(groupId, materialId).then((d) => {
      if (!cancelled) setData(d)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [groupId, materialId])

  const codes = useMemo<CodingCode[]>(() => data?.codes ?? [], [data])
  const topCodes = useMemo(() => codes.filter((c) => !c.parent_id), [codes])
  const myCodings = useMemo<CodingEntry[]>(() => {
    if (!data) return []
    if (mode === 'personal') return data.codings.filter((c) => c.coder_id === data.me)
    const sharedIds = new Set((data.shared_codebook?.codes ?? []).map((c) => c.id))
    return data.codings.filter((c) => sharedIds.has(c.code_id))
  }, [data, mode])

  const sentenceTime = useMemo(() => {
    const map = new Map<string, number>()
    sentences.forEach((s) => map.set(s.id, s.start_ms))
    return map
  }, [sentences])

  const codeByIdLocal = (id: string): CodingCode | undefined => codes.find((c) => c.id === id)

  function subtreeIds(codeId: string): Set<string> {
    const out = new Set<string>()
    const walk = (id: string) => {
      out.add(id)
      codes.filter((c) => c.parent_id === id).forEach((c) => walk(c.id))
    }
    walk(codeId)
    return out
  }

  // 协作材料只有一个 case，列名就是材料名（没有多案例对比）。
  const caseColumns = useMemo(() => [{
    key: `doc:${materialId}`, label: '本材料', docIds: [materialId],
  }], [materialId])

  function attributeColumns(): { key: string; label: string; docIds: string[] }[] {
    return caseColumns
  }

  function countInColumn(codeId: string, docIds: string[]): number {
    const sub = subtreeIds(codeId)
    return myCodings.filter((c) => docIds.includes(c.document_id) && sub.has(c.code_id)).length
  }

  function cooccurrence(aId: string, bId: string): number {
    if (aId === bId) {
      const sub = subtreeIds(aId)
      const keys = new Set<string>()
      for (const c of myCodings) {
        if (!sub.has(c.code_id)) continue
        for (const sp of c.spans) keys.add(`${c.document_id}::${sp.sentence_id}`)
      }
      return keys.size
    }
    const aSub = subtreeIds(aId)
    const bSub = subtreeIds(bId)
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
    const sub = subtreeIds(codeId)
    return myCodings.filter((c) => docIds.includes(c.document_id) && sub.has(c.code_id))
  }

  function evidenceForPair(rowId: string, colId: string): CodingEntry[] {
    const rs = subtreeIds(rowId)
    const cs = subtreeIds(colId)
    const r = new Map<string, Set<string>>()
    const c2 = new Map<string, Set<string>>()
    for (const c of myCodings) {
      for (const sp of c.spans) {
        const key = `${c.document_id}::${sp.sentence_id}`
        if (rs.has(c.code_id)) { if (!r.has(key)) r.set(key, new Set()); r.get(key)!.add(c.id) }
        if (cs.has(c.code_id)) { if (!c2.has(key)) c2.set(key, new Set()); c2.get(key)!.add(c.id) }
      }
    }
    const hits = new Set<string>()
    r.forEach((ids, key) => { if (c2.has(key)) ids.forEach((id) => hits.add(id)) })
    return (data?.codings ?? []).filter((c) => hits.has(c.id))
  }

  function searchCodings(query: string, codeFilter: string): CodingEntry[] {
    const q = query.trim().toLowerCase()
    const sub = codeFilter ? subtreeIds(codeFilter) : null
    return myCodings
      .filter((c) => (sub ? sub.has(c.code_id) : true))
      .filter((c) => (q ? c.quote.toLowerCase().includes(q) : true))
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

  const frameworkRows = [{ key: materialId, label: '本材料', docId: materialId }]

  function firstQuoteFor(docId: string, codeId: string): { entry: CodingEntry; count: number } | null {
    const sub = subtreeIds(codeId)
    const list = myCodings.filter((c) => c.document_id === docId && sub.has(c.code_id))
    return list.length ? { entry: list[0], count: list.length } : null
  }

  const caseAttrs = cases.find((c) => c.document_id === materialId)?.attributes ?? []
  const attributeLabels = Array.from(new Set(cases.flatMap((c) => c.attributes.map((a) => a.label.trim())).filter(Boolean)))
  const caseByDoc = (docId: string) => cases.find((c) => c.document_id === docId)

  return {
    codes, topCodes, attributes: attributeLabels, myCodings,
    caseValue: (docId: string, label: string) => caseByDoc(docId)?.attributes.find((a) => a.label === label)?.value ?? '',
    docTitle: (_docId: string) => caseByDoc(materialId)?.case_name?.trim() || '本材料',
    recordingOf: (_docId: string) => materialId,
    sentenceTime, caseColumns, attributeColumns,
    countInColumn, cooccurrence, evidenceForCell, evidenceForPair,
    searchCodings, wordFrequency, frameworkRows, firstQuoteFor,
    codeById: codeByIdLocal,
    currentDocId: materialId,
    sentences, mode, setMode, loading: !data,
    // 属性集编辑（协作）：走独立 cases 接口保存（各设备存自己的，不改码本）。
    attributeSets, applySet, upsertSet, deleteSet,
    caseAttributes: (docId: string) => caseByDoc(docId)?.attributes ?? caseAttrs,
    updateCaseAttrs,
  }
}
