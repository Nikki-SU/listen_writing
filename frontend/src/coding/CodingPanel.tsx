import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as api from '../api'
import SentenceRow from '../SentenceRow'
import type {
  CaseAttribute,
  CodingCode,
  CodingEntry,
  CodingSpan,
  CodingStore,
  RecordingDetail,
  Sentence,
} from '../types'
import {
  CodeChip,
  SideTitle,
  blendColors,
  densityColor,
  fmtMs,
  hexToRgba,
} from './common'
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

type PendingSelection = {
  spans: CodingSpan[]
  quote: string
  sentenceId: string
}

function sameSpans(a: CodingSpan[], b: CodingSpan[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (s, i) => s.sentence_id === b[i].sentence_id && s.start === b[i].start && s.end === b[i].end,
  )
}

function coverageRatio(sentence: Sentence, codings: CodingEntry[]): number {
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

export default function CodingPanel({
  projectId,
  recordingId,
  detail,
  onError,
}: {
  projectId: string
  recordingId: string
  detail: RecordingDetail
  onError: (msg: string) => void
}) {
  const { recording, transcribe, sentences } = detail
  const version = recording.version?.current ?? ''

  const [store, setStore] = useState<CodingStore>(() =>
    ensureDocument(loadCodingStore(projectId), recordingId, recording.name, version),
  )
  const [rightTab, setRightTab] = useState<'reading' | 'codebook'>('reading')
  const [selection, setSelection] = useState<PendingSelection | null>(null)
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null)
  const [activeCodingId, setActiveCodingId] = useState<string | null>(null)
  const [activeCodeId, setActiveCodeId] = useState<string | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [newCodeName, setNewCodeName] = useState('')

  const transcriptRef = useRef<HTMLUListElement>(null)
  const codeInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const stopAtRef = useRef<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [rate, setRate] = useState(1)
  const [playingSentenceId, setPlayingSentenceId] = useState<string | null>(null)

  useEffect(() => {
    saveCodingStore(store)
  }, [store])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = rate
  }, [rate])

  const docId = documentId(recordingId)
  const docCodings = useMemo(
    () => codingsFor(store, docId, ME),
    [store, docId],
  )
  const activeCodes = useMemo(
    () => store.codes.filter((c) => c.status === 'active'),
    [store.codes],
  )
  const recent = useMemo(() => recentCodes(store, docId, 6), [store, docId])
  const totalMs = Math.max(
    recording.duration_sec * 1000,
    sentences.length ? sentences[sentences.length - 1].end_ms : 0,
  )

  const selectionCodings = useMemo(() => {
    if (!selection) return []
    return docCodings.filter((c) => sameSpans(c.spans, selection.spans))
  }, [docCodings, selection])

  const activeCoding = activeCodingId
    ? docCodings.find((c) => c.id === activeCodingId) || null
    : null
  const activeSentence = activeSentenceId
    ? sentences.find((s) => s.id === activeSentenceId) || null
    : null
  const activeCode = activeCodeId ? codeById(store, activeCodeId) : null
  const caseProfile = caseFor(store, docId)

  const suggestions = useMemo(() => {
    const query = codeQuery.trim().toLowerCase()
    if (query) {
      return activeCodes
        .filter(
          (c) =>
            c.name.toLowerCase().includes(query) ||
            c.definition.toLowerCase().includes(query),
        )
        .slice(0, 8)
    }
    const seen = new Set<string>()
    const list: CodingCode[] = []
    for (const code of [...recent, ...activeCodes]) {
      if (seen.has(code.id)) continue
      seen.add(code.id)
      list.push(code)
      if (list.length >= 8) break
    }
    return list
  }, [codeQuery, activeCodes, recent])

  const exactCode = activeCodes.find(
    (c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase(),
  )

  function currentSentenceText(sentenceId: string): string {
    return sentences.find((s) => s.id === sentenceId)?.text || ''
  }

  function readSelection() {
    const native = window.getSelection()
    if (!native || native.rangeCount === 0 || native.isCollapsed) return
    const range = native.getRangeAt(0)
    const root = transcriptRef.current
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return

    const spans: CodingSpan[] = []
    const parts: string[] = []
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-sentence-id]'))) {
      if (!range.intersectsNode(el)) continue
      const sentenceId = el.dataset.sentenceId
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
    setSelection({
      spans,
      quote: parts.join(' … '),
      sentenceId: spans[0].sentence_id,
    })
    setActiveSentenceId(spans[0].sentence_id)
    setActiveCodingId(null)
    setRightTab('reading')
    setCodeQuery('')
    native.removeAllRanges()
    window.setTimeout(() => codeInputRef.current?.focus(), 0)
  }

  function clearSelection() {
    setSelection(null)
    setCodeQuery('')
    setActiveCodingId(null)
  }

  function selectCoding(entry: CodingEntry) {
    setActiveCodingId(entry.id)
    setActiveSentenceId(entry.spans[0]?.sentence_id || null)
    setActiveCodeId(entry.code_id)
    setRightTab('reading')
    setSelection(null)
    const target = entry.spans[0]?.sentence_id
    if (target) {
      window.setTimeout(() => {
        document.getElementById(`coding-sentence-${target}`)?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }
  }

  function attachExisting(code: CodingCode) {
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
  }

  function attachNewCode(name: string) {
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
  }

  function removeCoding(codingId: string) {
    setStore((prev) => removeCodingEntry(prev, codingId))
    if (activeCodingId === codingId) setActiveCodingId(null)
  }

  function submitCodeInput() {
    const trimmed = codeQuery.trim()
    if (!trimmed) return
    if (exactCode) attachExisting(exactCode)
    else attachNewCode(trimmed)
  }

  function createTopCode() {
    const name = newCodeName.trim()
    if (!name) return
    const code = makeCode(store, name, null)
    setStore((prev) => addCode(prev, code))
    setActiveCodeId(code.id)
    setRightTab('codebook')
    setNewCodeName('')
  }

  function jumpToCode(codeId: string) {
    const entries = docCodings
      .filter((c) => c.code_id === codeId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    const first = entries[0]
    if (!first) return
    setRightTab('reading')
    selectCoding(first)
  }

  // ---- 案例属性（NVivo 式 case attributes） ----

  function setCaseName(name: string) {
    setStore((prev) => updateCase(prev, docId, { case_name: name }))
  }

  function patchCaseAttribute(id: string, patch: Partial<CaseAttribute>) {
    if (!caseProfile) return
    setStore((prev) =>
      updateCase(prev, docId, {
        attributes: caseProfile.attributes.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      }),
    )
  }

  function addCaseAttribute() {
    if (!caseProfile) return
    setStore((prev) =>
      updateCase(prev, docId, {
        attributes: [
          ...caseProfile.attributes,
          { id: `attr_${Date.now().toString(36)}`, label: '', value: '' },
        ],
      }),
    )
  }

  function removeCaseAttribute(id: string) {
    if (!caseProfile) return
    setStore((prev) =>
      updateCase(prev, docId, {
        attributes: caseProfile.attributes.filter((a) => a.id !== id),
      }),
    )
  }

  // ---- 播放 ----

  function pauseAudio() {
    stopAtRef.current = null
    audioRef.current?.pause()
    setPlaying(false)
  }

  function togglePlay() {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      stopAtRef.current = null
      void audio.play().catch(() => onError('无法播放音频：请检查本地后端是否在线'))
    } else {
      pauseAudio()
    }
  }

  function playSentence(sentence: Sentence, onlyThis: boolean) {
    const audio = audioRef.current
    if (!audio) return
    stopAtRef.current = onlyThis ? sentence.end_ms : null
    audio.currentTime = sentence.start_ms / 1000
    void audio.play().catch(() => onError('无法播放音频：请检查本地后端是否在线'))
    setPlayingSentenceId(sentence.id)
    setActiveSentenceId(sentence.id)
  }

  function playCoding(entry: CodingEntry) {
    const span = entry.spans[0]
    if (!span) return
    const sentence = sentences.find((s) => s.id === span.sentence_id)
    const audio = audioRef.current
    if (!sentence || !audio) return
    const length = Math.max(1, sentence.text.length)
    const start = sentence.start_ms + (span.start / length) * (sentence.end_ms - sentence.start_ms)
    const end = sentence.start_ms + (span.end / length) * (sentence.end_ms - sentence.start_ms)
    stopAtRef.current = end
    audio.currentTime = start / 1000
    void audio.play().catch(() => onError('无法播放音频：请检查本地后端是否在线'))
    setPlayingSentenceId(sentence.id)
    setActiveSentenceId(sentence.id)
    setActiveCodingId(entry.id)
  }

  function stepSentence(direction: -1 | 1) {
    if (sentences.length === 0) return
    const baseId = playingSentenceId || activeSentenceId
    const index = Math.max(0, sentences.findIndex((s) => s.id === baseId))
    const next = sentences[Math.max(0, Math.min(sentences.length - 1, index + direction))]
    playSentence(next, true)
  }

  function onTimeUpdate() {
    const audio = audioRef.current
    if (!audio) return
    const ms = audio.currentTime * 1000
    setCurrentMs(ms)
    const stopAt = stopAtRef.current
    if (stopAt != null && ms >= stopAt) {
      stopAtRef.current = null
      audio.pause()
    }
    const current = sentences.find((s) => ms >= s.start_ms && ms < s.end_ms)
    if (current) setPlayingSentenceId(current.id)
  }

  // ---- 正文渲染 ----

  function renderSentenceText(sentence: Sentence): ReactNode {
    const spans = docCodings.flatMap((entry) =>
      entry.spans
        .filter((sp) => sp.sentence_id === sentence.id)
        .map((sp) => ({ ...sp, entry })),
    )
    const pending = selection?.spans.filter((sp) => sp.sentence_id === sentence.id) || []
    if (spans.length === 0 && pending.length === 0) return sentence.text

    const points = new Set<number>([0, sentence.text.length])
    spans.forEach((sp) => {
      points.add(Math.max(0, Math.min(sentence.text.length, sp.start)))
      points.add(Math.max(0, Math.min(sentence.text.length, sp.end)))
    })
    pending.forEach((sp) => {
      points.add(Math.max(0, Math.min(sentence.text.length, sp.start)))
      points.add(Math.max(0, Math.min(sentence.text.length, sp.end)))
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
        cursor: unique.length ? 'pointer' : 'text',
      }
      nodes.push(
        <span
          key={`${sentence.id}-${from}-${to}`}
          style={style}
          title={
            unique.length
              ? unique
                  .map((c) => `${codeById(store, c.code_id)?.name || '码'}：${c.quote}`)
                  .join('\n')
              : undefined
          }
          onClick={(e) => {
            if (!unique.length) return
            e.stopPropagation()
            selectCoding(unique[0])
          }}
        >
          {sentence.text.slice(from, to)}
        </span>,
      )
    }
    return nodes
  }

  function sentenceCodings(sentenceId: string): CodingEntry[] {
    return docCodings.filter((c) => c.spans.some((sp) => sp.sentence_id === sentenceId))
  }

  // ---- 码本树 ----

  const codeTreeRows = (parentId: string | null, depth: number): ReactNode[] => {
    return store.codes
      .filter((c) => c.parent_id === parentId && c.status === 'active')
      .flatMap((code) => {
        const count = countCodings(store, code.id, docId)
        const row = (
          <button
            key={code.id}
            type="button"
            className={`coding-tree-row${activeCodeId === code.id ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => {
              setActiveCodeId(code.id)
              setRightTab('codebook')
            }}
          >
            <span className="coding-dot" style={{ background: code.color }} />
            <span className="coding-tree-name">{code.name}</span>
            <span className="coding-tree-count">{count}</span>
          </button>
        )
        return [row, ...codeTreeRows(code.id, depth + 1)]
      })
  }

  function renderInspector(): ReactNode {
    if (selection) {
      return (
        <div className="coding-inspector-body">
          <SideTitle extra={`${selection.spans.length} 句`}>选中片段</SideTitle>
          <div className="coding-quote">“{selection.quote}”</div>
          <div className="coding-label">贴到已有码</div>
          <div className="coding-chips">
            {selectionCodings.length ? (
              selectionCodings.map((entry) => {
                const code = codeById(store, entry.code_id)
                if (!code) return null
                return (
                  <CodeChip
                    key={entry.id}
                    code={code}
                    active
                    onRemove={() => removeCoding(entry.id)}
                  />
                )
              })
            ) : (
              <span className="coding-empty">还没有码，选一个或直接输入新码。</span>
            )}
          </div>

          <div className="coding-label">编码 / 新建码</div>
          <div className="coding-code-input-wrap">
            <input
              ref={codeInputRef}
              value={codeQuery}
              placeholder="输入码名，回车贴码"
              onChange={(e) => setCodeQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') clearSelection()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitCodeInput()
                }
              }}
              style={{
                width: '100%',
                fontSize: 13,
                padding: '6px 9px',
                border: '1px solid #d5dae2',
                borderRadius: 6,
                boxSizing: 'border-box',
              }}
            />
            <div className="coding-suggest">
              {suggestions.map((code) => (
                <button
                  key={code.id}
                  type="button"
                  className="coding-suggest-row"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => attachExisting(code)}
                >
                  <span className="coding-dot" style={{ background: code.color }} />
                  <span className="coding-suggest-name">{code.name}</span>
                  <span className="coding-suggest-count">{countCodings(store, code.id)}</span>
                </button>
              ))}
              {codeQuery.trim() && !exactCode && (
                <button
                  type="button"
                  className="coding-suggest-row create"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => attachNewCode(codeQuery)}
                >
                  <span className="coding-plus">＋</span>
                  <span className="coding-suggest-name">新建码「{codeQuery.trim()}」</span>
                </button>
              )}
              {!codeQuery.trim() && (
                <div className="coding-suggest-hint">输入即过滤；没有合适的选择“新建码”。</div>
              )}
            </div>
          </div>

          <button type="button" className="coding-ghost-btn" onClick={clearSelection}>
            取消选区
          </button>
        </div>
      )
    }

    if (activeCoding) {
      const code = codeById(store, activeCoding.code_id)
      return (
        <div className="coding-inspector-body">
          <SideTitle extra={code?.name}>选中编码</SideTitle>
          <div className="coding-quote">“{activeCoding.quote}”</div>
          <div className="coding-chips">
            {code && <CodeChip code={code} active />}
            {code && <span className="coding-muted">{code.definition || '（未填写定义）'}</span>}
          </div>
          <div className="coding-actions">
            <button type="button" className="coding-primary-btn" onClick={() => playCoding(activeCoding)}>
              ▶ 播放片段
            </button>
            <button type="button" className="coding-danger-btn" onClick={() => removeCoding(activeCoding.id)}>
              删除这条编码
            </button>
          </div>
          {activeCoding.spans.map((sp) => {
            const text = currentSentenceText(sp.sentence_id)
            return (
              <div key={`${sp.sentence_id}-${sp.start}`} className="coding-span-row">
                <span className="coding-span-id">{sp.sentence_id}</span>
                <span className="coding-span-text">{text.slice(sp.start, sp.end)}</span>
              </div>
            )
          })}
        </div>
      )
    }

    if (activeSentence) {
      const list = sentenceCodings(activeSentence.id)
      return (
        <div className="coding-inspector-body">
          <SideTitle extra={fmtMs(activeSentence.start_ms)}>当前句子</SideTitle>
          <div className="coding-quote">{activeSentence.text}</div>
          <div className="coding-label">已挂编码（{list.length}）</div>
          <div className="coding-chips">
            {list.length ? (
              list.map((entry) => {
                const code = codeById(store, entry.code_id)
                if (!code) return null
                return (
                  <CodeChip
                    key={entry.id}
                    code={code}
                    active
                    onClick={() => selectCoding(entry)}
                    onRemove={() => removeCoding(entry.id)}
                  />
                )
              })
            ) : (
              <span className="coding-empty">在正文里拖选一段文字，就能贴码。</span>
            )}
          </div>
          <div className="coding-label">本句密度</div>
          <div className="coding-density-readout">
            <span
              className="coding-density-swatch"
              style={{
                background: densityColor(
                  coverageRatio(activeSentence, sentenceCodings(activeSentence.id)),
                ),
              }}
            />
            <span>
              {Math.round(coverageRatio(activeSentence, sentenceCodings(activeSentence.id)) * 100)}%
              的字符被编码覆盖
            </span>
          </div>
          <div className="coding-actions">
            <button type="button" className="coding-primary-btn" onClick={() => playSentence(activeSentence, true)}>
              ▶ 播放这一句
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="coding-inspector-body">
        <SideTitle extra={recording.name}>文档概览</SideTitle>
        <div className="coding-stat-grid">
          <div>
            <span>句子</span>
            <b>{sentences.length}</b>
          </div>
          <div>
            <span>编码</span>
            <b>{docCodings.length}</b>
          </div>
          <div>
            <span>码</span>
            <b>{new Set(docCodings.map((c) => c.code_id)).size}</b>
          </div>
          <div>
            <span>密度</span>
            <b>
              {sentences.length
                ? `${Math.round(
                    (sentences.reduce((sum, s) => sum + coverageRatio(s, docCodings), 0) /
                      sentences.length) *
                      100,
                  )}%`
                : '0%'}
            </b>
          </div>
        </div>
        <div className="coding-label">案例属性</div>
        {caseProfile ? (
          <div className="case-editor">
            <input
              className="case-name-input"
              value={caseProfile.case_name}
              placeholder="访谈对象，例如 王老师"
              onChange={(e) => setCaseName(e.target.value)}
            />
            <div className="case-attr-list">
              {caseProfile.attributes.map((attr) => (
                <div key={attr.id} className="case-attr-row">
                  <input
                    value={attr.label}
                    placeholder="属性名"
                    onChange={(e) => patchCaseAttribute(attr.id, { label: e.target.value })}
                  />
                  <input
                    value={attr.value}
                    placeholder="值"
                    onChange={(e) => patchCaseAttribute(attr.id, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="case-attr-remove"
                    title="删除这个属性"
                    onClick={() => removeCaseAttribute(attr.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="case-attr-add" onClick={addCaseAttribute}>
              ＋ 添加属性
            </button>
            <div className="coding-hint">
              属性用于分析：例如按“职级 / 学科”对比不同案例中的同一批码。
            </div>
          </div>
        ) : (
          <div className="coding-empty">案例属性尚未建立。</div>
        )}
        <div className="coding-label">最近使用码</div>
        <div className="coding-chips">
          {recent.length ? (
            recent.map((code) => (
              <CodeChip
                key={code.id}
                code={code}
                count={countCodings(store, code.id, docId)}
                onClick={() => {
                  setActiveCodeId(code.id)
                  setRightTab('codebook')
                }}
              />
            ))
          ) : (
            <span className="coding-empty">贴过码后，这里会出现最近使用的码。</span>
          )}
        </div>
        <div className="coding-label">怎么开始</div>
        <div className="coding-empty">
          ① 在正文里拖选一段文字；<br />
          ② 右栏会出现码输入框与备选码；<br />
          ③ 选码或直接输入新码，正文立即出现荧光标记。
        </div>
        <div className="coding-label">数据关系</div>
        <div className="coding-relation vertical">
          <span>项目 {projectId}</span>
          <span>└ 录音（音频）{recording.id}</span>
          <span>　└ 文档（转写稿）{docId}</span>
          <span>　　└ 句子 {sentences.length}</span>
          <span>　　　└ 编码 {docCodings.length}</span>
        </div>
      </div>
    )
  }

  function renderCodebook(): ReactNode {
    return (
      <div className="coding-inspector-body">
        <SideTitle extra={`${store.codes.length} 个码`}>码本</SideTitle>
        <div className="coding-code-search">
          <input
            value={newCodeName}
            placeholder="新建顶层码，回车添加"
            onChange={(e) => setNewCodeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                createTopCode()
              }
            }}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              padding: '5px 8px',
              border: '1px solid #d5dae2',
              borderRadius: 6,
            }}
          />
          <button type="button" className="coding-primary-btn" onClick={createTopCode}>
            添加
          </button>
        </div>
        <div className="coding-tree scroll-hidden">{codeTreeRows(null, 0)}</div>
        {activeCode ? (
          <div className="coding-code-detail">
            <div className="coding-code-detail-head">
              <span className="coding-dot" style={{ background: activeCode.color }} />
              <input
                value={activeCode.name}
                onChange={(e) =>
                  setStore((prev) => updateCode(prev, activeCode.id, { name: e.target.value }))
                }
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 13,
                  fontWeight: 600,
                  border: '1px solid transparent',
                  borderRadius: 4,
                  padding: '2px 4px',
                  background: 'transparent',
                }}
              />
              <span className="coding-muted">{countCodings(store, activeCode.id, docId)} 条</span>
            </div>
            <textarea
              value={activeCode.definition}
              placeholder="这个码的定义 / 纳入与排除标准…"
              onChange={(e) =>
                setStore((prev) => updateCode(prev, activeCode.id, { definition: e.target.value }))
              }
              style={{
                width: '100%',
                boxSizing: 'border-box',
                minHeight: 54,
                fontSize: 12,
                lineHeight: 1.6,
                padding: '5px 8px',
                border: '1px solid #e3e6ea',
                borderRadius: 6,
                resize: 'vertical',
              }}
            />
            <div className="coding-actions">
              <button type="button" className="coding-primary-btn" onClick={() => jumpToCode(activeCode.id)}>
                在正文中定位
              </button>
            </div>
          </div>
        ) : (
          <div className="coding-empty">点一个码查看定义、计数，并定位到正文。</div>
        )}
      </div>
    )
  }

  if (transcribe.status === 'pending' || transcribe.status === 'transcribing') {
    return (
      <div className="coding-wait">
        <div>转写中 {transcribe.progress}% · 已出 {sentences.length} 句</div>
        <div className="coding-muted">
          有句子后就能开始编码；后面的句子会继续追加，已有的编码不会丢。
        </div>
      </div>
    )
  }

  if (transcribe.status === 'error') {
    return <div className="coding-wait error">转写失败：{transcribe.error}</div>
  }

  if (sentences.length === 0) {
    return <div className="coding-wait">这条录音还没有识别到句子。</div>
  }

  return (
    <>
      {/* 第 2–4 列：音频 + 文档一体 */}
      <section className="workspace-card coding-reader" style={{ gridColumn: 'span 3' }}>
        <div className="coding-reader-head">
          <div className="coding-reader-title">
            <span>文档 · {recording.name}</span>
            <span className="coding-muted">
              {docId} · v{version || '—'} · {sentences.length} 句
            </span>
          </div>
          <div className="coding-density-legend" title="按句子被编码覆盖的字符比例：绿低、红高">
            <span>密度</span>
            <span className="coding-density-gradient" />
            <span className="coding-muted">低 → 高</span>
          </div>
        </div>

        <audio
          ref={audioRef}
          src={api.audioUrl(projectId, recordingId)}
          preload="metadata"
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => onError('音频加载失败：请确认本地后端在线')}
          style={{ display: 'none' }}
        />

        <div className="coding-player">
          <button type="button" className="coding-play-main" onClick={togglePlay} title={playing ? '暂停' : '播放'}>
            {playing ? '■' : '▶'}
          </button>
          <span className="coding-time">
            {fmtMs(currentMs)} / {fmtMs(totalMs)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            value={Math.min(Math.max(0, currentMs), Math.max(1, totalMs))}
            onChange={(e) => {
              const audio = audioRef.current
              const ms = Number(e.target.value)
              setCurrentMs(ms)
              if (audio) audio.currentTime = ms / 1000
            }}
            className="coding-scrub"
            aria-label="播放进度"
          />
          <button type="button" className="coding-step-btn" onClick={() => stepSentence(-1)} title="上一句">
            ‹
          </button>
          <button type="button" className="coding-step-btn" onClick={() => stepSentence(1)} title="下一句">
            ›
          </button>
          <select
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="coding-rate"
            aria-label="播放速度"
          >
            {[0.75, 1, 1.25, 1.5, 2].map((v) => (
              <option key={v} value={v}>
                {v}x
              </option>
            ))}
          </select>
        </div>

        <ul
          ref={transcriptRef}
          className="coding-transcript scroll-hidden"
          onMouseUp={readSelection}
        >
          {sentences.map((s) => {
            const list = sentenceCodings(s.id)
            const ratio = coverageRatio(s, list)
            const active = s.id === activeSentenceId
            const isPlaying = s.id === playingSentenceId && playing
            return (
              <SentenceRow
                key={s.id}
                sentence={s}
                id={`coding-sentence-${s.id}`}
                active={active}
                playing={isPlaying}
                onClick={() => {
                  if (window.getSelection()?.toString().trim()) return
                  setActiveSentenceId(s.id)
                  setActiveCodingId(null)
                  setRightTab('reading')
                }}
                playButton={
                  <button
                    type="button"
                    className="coding-sentence-play"
                    title="只播这一句"
                    onClick={(e) => {
                      e.stopPropagation()
                      playSentence(s, true)
                    }}
                  >
                    ▶
                  </button>
                }
                body={
                  <>
                    <div className="coding-sentence-meta">
                      {s.speaker && <span className="coding-speaker">{s.speaker}</span>}
                      {list.slice(0, 4).map((entry) => {
                        const code = codeById(store, entry.code_id)
                        if (!code) return null
                        return (
                          <span
                            key={entry.id}
                            className="coding-mini-code"
                            style={{
                              color: code.color,
                              background: hexToRgba(code.color, 0.1),
                              borderColor: hexToRgba(code.color, 0.35),
                            }}
                            onClick={(e) => {
                              e.stopPropagation()
                              selectCoding(entry)
                            }}
                            title={`${code.name}：${entry.quote}`}
                          >
                            {code.name}
                          </span>
                        )
                      })}
                      {list.length > 4 && <span className="coding-muted">+{list.length - 4}</span>}
                    </div>
                    <div className="coding-sentence-text" data-sentence-id={s.id}>
                      {renderSentenceText(s)}
                    </div>
                  </>
                }
                gutter={
                  <div
                    className="coding-density-bar"
                    style={{ background: densityColor(ratio) }}
                    title={`本句编码密度 ${Math.round(ratio * 100)}% · ${list.length} 条编码`}
                  />
                }
              />
            )
          })}
        </ul>
      </section>

      {/* 第 5 列：阅读编码 / 码本 切换 */}
      <aside className="workspace-card coding-inspector" style={{ gridColumn: 'span 1' }}>
        <div className="coding-right-tabs">
          <button
            type="button"
            className={rightTab === 'reading' ? 'active' : ''}
            onClick={() => setRightTab('reading')}
          >
            阅读编码
          </button>
          <button
            type="button"
            className={rightTab === 'codebook' ? 'active' : ''}
            onClick={() => setRightTab('codebook')}
          >
            码本
          </button>
        </div>
        <div className="coding-inspector-scroll scroll-hidden">
          {rightTab === 'reading' ? renderInspector() : renderCodebook()}
        </div>
        <div className="coding-doc-meta">
          <span>
            录音 {recording.id} · audio.{recording.format || '—'}
          </span>
          <span>
            文档 {docId} · v{version || '—'}
          </span>
          <span>
            {sentences.length} 句 · {docCodings.length} 条编码 · 自动保存
          </span>
        </div>
      </aside>
    </>
  )
}
