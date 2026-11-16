import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type {
  CaseAttribute,
  CodingCode,
  CodingEntry,
  CodingSpan,
  CodingStore,
  RecordingDetail,
  Sentence,
} from '../types'
import { blendColors, hexToRgba } from './common'
import {
  addCode,
  addCodingEntry,
  caseFor,
  codeById,
  codingsFor,
  countCodings,
  documentId,
  ensureDocument,
  loadCodingStore,
  makeCode,
  makeCoding,
  recentCodes,
  removeCodingEntry,
  saveCodingStore,
  updateCase,
  updateCode,
} from './store'

const ME = 'me'

export type PendingSelection = {
  spans: CodingSpan[]
  quote: string
  sentenceId: string
}

/** 选区读取结果：从录音区 DOM 里读出命中的句子与句内字符区间。 */
export type SelectionRoot = HTMLElement | null

function sameSpans(a: CodingSpan[], b: CodingSpan[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (s, i) => s.sentence_id === b[i].sentence_id && s.start === b[i].start && s.end === b[i].end,
  )
}

export function coverageRatio(sentence: Sentence, codings: CodingEntry[]): number {
  const len = sentence.text.length
  if (len === 0) return 0
  const intervals = codings
    .flatMap((c) => c.spans.filter((sp) => sp.sentence_id === sentence.id))
    .map((sp) => [Math.max(0, sp.start), Math.min(len, sp.end)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let cursor = 0
  for (const [start, end] of intervals) {
    const from = Math.max(start, cursor)
    if (end > from) {
      covered += end - from
      cursor = end
    }
  }
  return covered / len
}

/**
 * 编码会话：把编码的**状态与数据操作**从 UI 里剥离。
 * 录音区（TranscriptPanel）与右栏（CodingInspector）各取所需，共享同一份 store。
 */
export function useCodingSession(
  projectId: string,
  recordingId: string,
  detail: RecordingDetail,
) {
  const { recording, sentences } = detail
  const version = recording.version?.current ?? ''
  const docId = documentId(recordingId)

  const [store, setStore] = useState<CodingStore>(() =>
    ensureDocument(loadCodingStore(projectId), recordingId, recording.name, version),
  )
  const [selection, setSelection] = useState<PendingSelection | null>(null)
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null)
  const [activeCodingId, setActiveCodingId] = useState<string | null>(null)
  const [activeCodeId, setActiveCodeId] = useState<string | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const codeInputRef = useRef<HTMLInputElement>(null)
  // 播放桥接：录音区（TranscriptPanel）注册它的 seek，右栏的“播放这一句/片段”复用它，
  // 不另起一套播放器——这正是“录音界面不做任何改变”的要求。
  const seekRef = useRef<(s: Sentence, onlyThis?: boolean) => void>(() => {})
  const registerSeek = useCallback((fn: (s: Sentence, onlyThis?: boolean) => void) => {
    seekRef.current = fn
  }, [])
  const playSentence = useCallback((s: Sentence, onlyThis = true) => {
    seekRef.current(s, onlyThis)
  }, [])
  const playCoding = useCallback(
    (entry: CodingEntry) => {
      const span = entry.spans[0]
      if (!span) return
      const s = sentences.find((x) => x.id === span.sentence_id)
      if (s) seekRef.current(s, true)
    },
    [sentences],
  )

  useEffect(() => {
    saveCodingStore(store)
  }, [store])

  // 切录音时重置瞬时选中态；store 本身按项目持久化，不动。
  useEffect(() => {
    setSelection(null)
    setActiveSentenceId(null)
    setActiveCodingId(null)
    setActiveCodeId(null)
    setCodeQuery('')
  }, [recordingId])

  const docCodings = useMemo(() => codingsFor(store, docId, ME), [store, docId])
  const activeCodes = useMemo(() => store.codes.filter((c) => c.status === 'active'), [store.codes])
  const recent = useMemo(() => recentCodes(store, docId, 6), [store, docId])
  const activeCoding = activeCodingId
    ? docCodings.find((c) => c.id === activeCodingId) || null
    : null
  const activeCode = activeCodeId ? codeById(store, activeCodeId) : null
  const caseProfile = caseFor(store, docId)

  const suggestions = useMemo(() => {
    const query = codeQuery.trim().toLowerCase()
    if (query) {
      return activeCodes
        .filter((c) => c.name.toLowerCase().includes(query) || c.definition.toLowerCase().includes(query))
        .slice(0, 8)
    }
    const seen = new Set<string>()
    const out: CodingCode[] = []
    for (const code of [...recent, ...activeCodes]) {
      if (seen.has(code.id)) continue
      seen.add(code.id)
      out.push(code)
      if (out.length >= 8) break
    }
    return out
  }, [codeQuery, activeCodes, recent])

  const exactCode = activeCodes.find(
    (c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase(),
  )

  const selectionCodings = useMemo(() => {
    if (!selection) return []
    return docCodings.filter((c) => sameSpans(c.spans, selection.spans))
  }, [docCodings, selection])

  const sentenceCodings = useCallback(
    (sentenceId: string) => docCodings.filter((c) => c.spans.some((sp) => sp.sentence_id === sentenceId)),
    [docCodings],
  )

  /** 从录音区读取用户框选的文字，换算成句子字符区间。 */
  const readSelection = useCallback((root: SelectionRoot) => {
    const native = window.getSelection()
    if (!native || native.rangeCount === 0 || native.isCollapsed) return
    const range = native.getRangeAt(0)
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return

    const spans: CodingSpan[] = []
    const parts: string[] = []
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-coding-sentence]'))) {
      if (!range.intersectsNode(el)) continue
      const sentenceId = el.dataset.codingSentence
      if (!sentenceId) continue
      const full = el.textContent || ''
      let start = 0
      let end = full.length
      if (el.contains(range.startContainer)) {
        const pre = document.createRange()
        pre.selectNodeContents(el)
        pre.setEnd(range.startContainer, range.startOffset)
        start = pre.toString().length
      }
      if (el.contains(range.endContainer)) {
        const pre = document.createRange()
        pre.selectNodeContents(el)
        pre.setEnd(range.endContainer, range.endOffset)
        end = pre.toString().length
      }
      while (start < end && /\s/.test(full[start])) start += 1
      while (end > start && /\s/.test(full[end - 1])) end -= 1
      if (end <= start) continue
      spans.push({ sentence_id: sentenceId, start, end })
      parts.push(full.slice(start, end))
    }
    if (spans.length === 0) return
    setSelection({ spans, quote: parts.join(' … '), sentenceId: spans[0].sentence_id })
    setActiveSentenceId(spans[0].sentence_id)
    setActiveCodingId(null)
    setCodeQuery('')
    native.removeAllRanges()
    window.setTimeout(() => codeInputRef.current?.focus(), 0)
  }, [])

  const clearSelection = useCallback(() => {
    setSelection(null)
    setCodeQuery('')
    setActiveCodingId(null)
  }, [])

  const selectCoding = useCallback(
    (entry: CodingEntry, scroll?: (sentenceId: string) => void) => {
      setActiveCodingId(entry.id)
      setActiveSentenceId(entry.spans[0]?.sentence_id || null)
      setActiveCodeId(entry.code_id)
      setSelection(null)
      const target = entry.spans[0]?.sentence_id
      if (target && scroll) scroll(target)
    },
    [],
  )

  const attachExisting = useCallback(
    (code: CodingCode) => {
      if (!selection) return
      const existing = docCodings.find(
        (c) => c.code_id === code.id && sameSpans(c.spans, selection.spans),
      )
      if (existing) {
        setActiveCodingId(existing.id)
        setActiveCodeId(code.id)
        setCodeQuery('')
        return
      }
      const entry = makeCoding(docId, code.id, selection.spans, selection.quote)
      setStore((prev) => addCodingEntry(prev, entry))
      setActiveCodingId(entry.id)
      setActiveCodeId(code.id)
      setCodeQuery('')
      window.setTimeout(() => codeInputRef.current?.focus(), 0)
    },
    [selection, docCodings, docId],
  )

  const attachNewCode = useCallback(
    (name: string) => {
      if (!selection) return
      const trimmed = name.trim()
      if (!trimmed) return
      const existing = activeCodes.find(
        (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
      )
      if (existing) {
        attachExisting(existing)
        return
      }
      const code = makeCode(store, trimmed, null)
      const entry = makeCoding(docId, code.id, selection.spans, selection.quote)
      setStore((prev) => addCodingEntry(addCode(prev, code), entry))
      setActiveCodingId(entry.id)
      setActiveCodeId(code.id)
      setCodeQuery('')
      window.setTimeout(() => codeInputRef.current?.focus(), 0)
    },
    [selection, activeCodes, attachExisting, store, docId],
  )

  const removeCoding = useCallback((codingId: string) => {
    setStore((prev) => removeCodingEntry(prev, codingId))
    setActiveCodingId((cur) => (cur === codingId ? null : cur))
  }, [])

  const submitCodeInput = useCallback(() => {
    const trimmed = codeQuery.trim()
    if (!trimmed) return
    if (exactCode) attachExisting(exactCode)
    else attachNewCode(trimmed)
  }, [codeQuery, exactCode, attachExisting, attachNewCode])

  const createTopCode = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const code = makeCode(store, trimmed, null)
      setStore((prev) => addCode(prev, code))
      setActiveCodeId(code.id)
    },
    [store],
  )

  const jumpToCode = useCallback(
    (codeId: string, scroll?: (sentenceId: string) => void) => {
      const first = docCodings
        .filter((c) => c.code_id === codeId)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
      if (!first) return
      selectCoding(first, scroll)
    },
    [docCodings, selectCoding],
  )

  const setCaseName = useCallback(
    (name: string) => setStore((prev) => updateCase(prev, docId, { case_name: name })),
    [docId],
  )
  const patchCaseAttribute = useCallback(
    (id: string, patch: Partial<CaseAttribute>) => {
      if (!caseProfile) return
      setStore((prev) =>
        updateCase(prev, docId, {
          attributes: caseProfile.attributes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        }),
      )
    },
    [caseProfile, docId],
  )
  const addCaseAttribute = useCallback(() => {
    if (!caseProfile) return
    setStore((prev) =>
      updateCase(prev, docId, {
        attributes: [
          ...caseProfile.attributes,
          { id: `attr_${Date.now().toString(36)}`, label: '', value: '' },
        ],
      }),
    )
  }, [caseProfile, docId])
  const removeCaseAttribute = useCallback(
    (id: string) => {
      if (!caseProfile) return
      setStore((prev) =>
        updateCase(prev, docId, {
          attributes: caseProfile.attributes.filter((a) => a.id !== id),
        }),
      )
    },
    [caseProfile, docId],
  )

  const updateCodeField = useCallback((codeId: string, patch: Partial<CodingCode>) => {
    setStore((prev) => updateCode(prev, codeId, patch))
  }, [])

  /**
   * 把句子正文渲染成带荧光标记的版本。无编码时原样返回；有编码时按区间切段着色。
   * data-coding-sentence 供 readSelection 反查句内偏移。
   */
  const decorateText = useCallback(
    (s: Sentence, onClickCoding?: (entry: CodingEntry) => void): ReactNode => {
      const text = s.text
      const pending = selection?.spans.filter((sp) => sp.sentence_id === s.id) || []
      const spans = docCodings.flatMap((entry) =>
        entry.spans
          .filter((sp) => sp.sentence_id === s.id)
          .map((sp) => ({ ...sp, entry })),
      )
      if (spans.length === 0 && pending.length === 0) return text
      const points = new Set<number>([0, text.length])
      spans.forEach((sp) => {
        points.add(Math.max(0, Math.min(text.length, sp.start)))
        points.add(Math.max(0, Math.min(text.length, sp.end)))
      })
      pending.forEach((sp) => {
        points.add(Math.max(0, Math.min(text.length, sp.start)))
        points.add(Math.max(0, Math.min(text.length, sp.end)))
      })
      const sorted = Array.from(points).sort((a, b) => a - b)
      const nodes: ReactNode[] = []
      for (let i = 0; i < sorted.length - 1; i += 1) {
        const from = sorted[i]
        const to = sorted[i + 1]
        if (to <= from) continue
        const covering = spans.filter((sp) => sp.start <= from && sp.end >= to).map((sp) => sp.entry)
        const unique = Array.from(new Map(covering.map((c) => [c.id, c])).values())
        const codes = unique
          .map((c) => codeById(store, c.code_id))
          .filter((c): c is CodingCode => Boolean(c))
        const inPending = pending.some((sp) => sp.start <= from && sp.end >= to)
        const isActive = unique.some((c) => c.id === activeCodingId)
        const background = codes.length
          ? hexToRgba(blendColors(codes.map((c) => c.color)), 0.3)
          : inPending
            ? 'rgba(37, 99, 235, 0.16)'
            : undefined
        const style: CSSProperties = {
          background,
          borderRadius: 2,
          boxShadow: inPending
            ? 'inset 0 0 0 2px rgba(37, 99, 235, 0.5)'
            : isActive
              ? `inset 0 0 0 1px ${codes[0]?.color || '#5b4bcc'}`
              : undefined,
          cursor: unique.length && onClickCoding ? 'pointer' : 'text',
        }
        nodes.push(
          <span
            key={`${s.id}-${from}-${to}`}
            style={style}
            title={
              unique.length
                ? unique.map((c) => `${codeById(store, c.code_id)?.name || '码'}：${c.quote}`).join('\n')
                : undefined
            }
            onClick={(e) => {
              if (!unique.length || !onClickCoding) return
              e.stopPropagation()
              onClickCoding(unique[0])
            }}
          >
            {text.slice(from, to)}
          </span>,
        )
      }
      return nodes
    },
    [selection, docCodings, store, activeCodingId],
  )

  return {
    // 数据
    store,
    docId,
    docCodings,
    activeCodes,
    recent,
    suggestions,
    exactCode,
    selection,
    selectionCodings,
    activeCoding,
    activeCode,
    activeSentenceId,
    activeCodingId,
    activeCodeId,
    caseProfile,
    codeQuery,
    setCodeQuery,
    codeInputRef,
    sentences,
    recording,
    version,
    // 操作
    readSelection,
    clearSelection,
    selectCoding,
    setActiveSentenceId,
    attachExisting,
    attachNewCode,
    removeCoding,
    submitCodeInput,
    createTopCode,
    jumpToCode,
    setCaseName,
    patchCaseAttribute,
    addCaseAttribute,
    removeCaseAttribute,
    updateCodeField,
    setActiveCodeId,
    sentenceCodings,
    decorateText,
    registerSeek,
    playSentence,
    playCoding,
    coverageOf: (s: Sentence) => coverageRatio(s, docCodings),
    countOf: (codeId: string, docIdFilter?: string) => countCodings(store, codeId, docIdFilter),
  }
}

export type CodingSession = ReturnType<typeof useCodingSession>
