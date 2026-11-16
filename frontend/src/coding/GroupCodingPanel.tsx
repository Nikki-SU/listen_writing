import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as api from '../api'
import SentenceRow from '../SentenceRow'
import type { CodingCode, CodingEntry, CodingSpan, Sentence } from '../types'
import { CodeChip, SideTitle, blendColors, densityColor, fmtMs, hexToRgba } from './common'

const CODE_COLORS = ['#5b4bcc', '#2f6fed', '#0f9d9d', '#c2760a']

type Tab = 'reading' | 'codebook'

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

function sameSpans(a: CodingSpan[], b: CodingSpan[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (s, i) => s.sentence_id === b[i].sentence_id && s.start === b[i].start && s.end === b[i].end,
  )
}

function coverage(sentence: Sentence, codings: CodingEntry[]): number {
  const len = sentence.text.length
  if (!len) return 0
  const intervals = codings
    .flatMap((c) => c.spans.filter((sp) => sp.sentence_id === sentence.id))
    .map((sp) => [Math.max(0, sp.start), Math.min(len, sp.end)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])
  let covered = 0
  let cursor = 0
  for (const [s, e] of intervals) {
    const from = Math.max(s, cursor)
    if (e > from) {
      covered += e - from
      cursor = e
    }
  }
  return covered / len
}

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

/**
 * 共享材料里的编码工作区：数据来自群组（后端），不是本机 localStorage。
 * 这是多人对比能成立的前提——同一材料上的编码必须放在一起看。
 */
export default function GroupCodingPanel({
  groupId,
  materialId,
  sentences,
  nick,
  canPlay,
  audioSrc,
}: {
  groupId: string
  materialId: string
  sentences: Sentence[]
  nick: string
  canPlay: boolean
  audioSrc: string
}) {
  const [codes, setCodes] = useState<CodingCode[]>([])
  const [codings, setCodings] = useState<CodingEntry[]>([])
  const [me, setMe] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<Tab>('reading')
  const [selection, setSelection] = useState<{ spans: CodingSpan[]; quote: string } | null>(null)
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null)
  const [activeCodingId, setActiveCodingId] = useState<string | null>(null)
  const [activeCodeId, setActiveCodeId] = useState<string | null>(null)
  const [codeQuery, setCodeQuery] = useState('')
  const [newCodeName, setNewCodeName] = useState('')

  const listRef = useRef<HTMLUListElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const stopAtRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .getGroupCoding(groupId, materialId)
      .then((d) => {
        if (cancelled) return
        setCodes(d.codes?.length ? d.codes : [])
        setCodings(d.codings || [])
        setMe(d.me)
        setError('')
      })
      .catch((e) => setError(`读取共享编码失败：${String(e)}`))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [groupId, materialId])

  const mine = useMemo(() => codings.filter((c) => c.coder_id === me), [codings, me])
  const activeCodes = codes.filter((c) => c.status === 'active')

  const persist = useCallback(
    (nextCodes: CodingCode[], nextCodings: CodingEntry[]) => {
      setSaving(true)
      api
        .saveGroupCoding(groupId, materialId, nextCodes, nextCodings)
        .then((d) => {
          setCodings(d.codings || [])
          setCodes(d.codes || [])
          setError('')
        })
        .catch((e) => setError(`保存失败：${String(e)}`))
        .finally(() => setSaving(false))
    },
    [groupId, materialId],
  )

  const activeCoding = activeCodingId ? mine.find((c) => c.id === activeCodingId) || null : null
  const activeCode = activeCodeId ? codes.find((c) => c.id === activeCodeId) || null : null
  const activeSentence = activeSentenceId ? sentences.find((s) => s.id === activeSentenceId) || null : null

  const suggestions = useMemo(() => {
    const q = codeQuery.trim().toLowerCase()
    if (q) {
      return activeCodes
        .filter((c) => c.name.toLowerCase().includes(q) || c.definition.toLowerCase().includes(q))
        .slice(0, 8)
    }
    const seen = new Set<string>()
    const out: CodingCode[] = []
    for (const c of [...mine].reverse()) {
      const code = codes.find((x) => x.id === c.code_id)
      if (!code || seen.has(code.id)) continue
      seen.add(code.id)
      out.push(code)
      if (out.length >= 8) break
    }
    for (const c of activeCodes) {
      if (seen.has(c.id)) continue
      out.push(c)
      if (out.length >= 8) break
    }
    return out
  }, [codeQuery, activeCodes, codes, mine])

  function readSelection() {
    const native = window.getSelection()
    if (!native || native.rangeCount === 0 || native.isCollapsed) return
    const range = native.getRangeAt(0)
    const root = listRef.current
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return
    const spans: CodingSpan[] = []
    const parts: string[] = []
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-sentence-id]'))) {
      if (!range.intersectsNode(el)) continue
      const sid = el.dataset.sentenceId
      if (!sid) continue
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
      spans.push({ sentence_id: sid, start, end })
      parts.push(full.slice(start, end))
    }
    if (!spans.length) return
    setSelection({ spans, quote: parts.join(' … ') })
    setActiveSentenceId(spans[0].sentence_id)
    setActiveCodingId(null)
    native.removeAllRanges()
  }

  function attachCode(code: CodingCode) {
    if (!selection) return
    const exists = mine.find((c) => c.code_id === code.id && sameSpans(c.spans, selection.spans))
    if (exists) {
      setActiveCodingId(exists.id)
      setCodeQuery('')
      return
    }
    const entry: CodingEntry = {
      id: uid('cd'),
      document_id: materialId,
      code_id: code.id,
      spans: selection.spans,
      quote: selection.quote,
      coder_id: me || 'me',
      source: 'human',
      created_at: new Date().toISOString(),
    }
    const next = [...codings, entry]
    setCodings(next)
    setActiveCodingId(entry.id)
    setCodeQuery('')
    setSelection(null)
    persist(codes, next)
  }

  function attachNew(name: string) {
    if (!selection) return
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = activeCodes.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      attachCode(existing)
      return
    }
    const topCount = codes.filter((c) => !c.parent_id).length
    const code: CodingCode = {
      id: uid('code'),
      codebook_id: `cb_${materialId}`,
      parent_id: null,
      name: trimmed,
      definition: '',
      color: CODE_COLORS[topCount % CODE_COLORS.length],
      status: 'active',
      created_at: new Date().toISOString(),
    }
    const entry: CodingEntry = {
      id: uid('cd'),
      document_id: materialId,
      code_id: code.id,
      spans: selection.spans,
      quote: selection.quote,
      coder_id: me || 'me',
      source: 'human',
      created_at: new Date().toISOString(),
    }
    const nextCodes = [...codes, code]
    const nextCodings = [...codings, entry]
    setCodes(nextCodes)
    setCodings(nextCodings)
    setActiveCodingId(entry.id)
    setCodeQuery('')
    setSelection(null)
    persist(nextCodes, nextCodings)
  }

  function removeCoding(id: string) {
    const next = codings.filter((c) => c.id !== id)
    setCodings(next)
    if (activeCodingId === id) setActiveCodingId(null)
    persist(codes, next)
  }

  function createTopCode() {
    const name = newCodeName.trim()
    if (!name) return
    const topCount = codes.filter((c) => !c.parent_id).length
    const code: CodingCode = {
      id: uid('code'),
      codebook_id: `cb_${materialId}`,
      parent_id: null,
      name,
      definition: '',
      color: CODE_COLORS[topCount % CODE_COLORS.length],
      status: 'active',
      created_at: new Date().toISOString(),
    }
    const next = [...codes, code]
    setCodes(next)
    setActiveCodeId(code.id)
    setNewCodeName('')
    persist(next, codings)
  }

  function playSentence(s: Sentence) {
    const audio = audioRef.current
    if (!audio || !canPlay) return
    stopAtRef.current = s.end_ms
    audio.currentTime = s.start_ms / 1000
    void audio.play().catch(() => setError('无法播放：请确认播放申请已获批'))
  }

  function onTimeUpdate() {
    const audio = audioRef.current
    if (!audio) return
    const ms = audio.currentTime * 1000
    const stop = stopAtRef.current
    if (stop != null && ms >= stop) {
      stopAtRef.current = null
      audio.pause()
    }
    const cur = sentences.find((s) => ms >= s.start_ms && ms < s.end_ms)
    if (cur) setActiveSentenceId(cur.id)
  }

  function renderText(s: Sentence): ReactNode {
    const spans = mine.flatMap((entry) =>
      entry.spans.filter((sp) => sp.sentence_id === s.id).map((sp) => ({ ...sp, entry })),
    )
    if (!spans.length) return s.text
    const points = new Set<number>([0, s.text.length])
    spans.forEach((sp) => {
      points.add(Math.max(0, Math.min(s.text.length, sp.start)))
      points.add(Math.max(0, Math.min(s.text.length, sp.end)))
    })
    const sorted = Array.from(points).sort((a, b) => a - b)
    const nodes: ReactNode[] = []
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const from = sorted[i]
      const to = sorted[i + 1]
      if (to <= from) continue
      const covering = spans.filter((sp) => sp.start <= from && sp.end >= to).map((sp) => sp.entry)
      const uniq = Array.from(new Map(covering.map((c) => [c.id, c])).values())
      const cols = uniq.map((c) => codes.find((x) => x.id === c.code_id)).filter((c): c is CodingCode => Boolean(c))
      const style: CSSProperties = {
        background: cols.length ? hexToRgba(blendColors(cols.map((c) => c.color)), 0.28) : undefined,
        borderRadius: 2,
        cursor: uniq.length ? 'pointer' : 'text',
      }
      nodes.push(
        <span
          key={`${s.id}-${from}-${to}`}
          style={style}
          title={uniq.map((c) => `${codes.find((x) => x.id === c.code_id)?.name || '码'}：${c.quote}`).join('\n')}
          onClick={(e) => {
            if (!uniq.length) return
            e.stopPropagation()
            setActiveCodingId(uniq[0].id)
            setTab('reading')
          }}
        >
          {s.text.slice(from, to)}
        </span>,
      )
    }
    return nodes
  }

  const codeTreeRows = (parentId: string | null, depth: number): ReactNode[] =>
    codes
      .filter((c) => c.parent_id === parentId && c.status === 'active')
      .flatMap((code) => {
        const sub = subtree(codes, code.id)
        const count = mine.filter((c) => sub.has(c.code_id)).length
        const row = (
          <button
            key={code.id}
            type="button"
            className={`coding-tree-row${activeCodeId === code.id ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            onClick={() => {
              setActiveCodeId(code.id)
              setTab('codebook')
            }}
          >
            <span className="coding-dot" style={{ background: code.color }} />
            <span className="coding-tree-name">{code.name}</span>
            <span className="coding-tree-count">{count}</span>
          </button>
        )
        return [row, ...codeTreeRows(code.id, depth + 1)]
      })

  return (
    <>
      <div style={{ display: 'flex', gap: 12, minHeight: 0, flex: 1 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!canPlay && (
            <div style={{ fontSize: 11, color: '#8a5a00', background: '#fff8e6', border: '1px solid #f0d9a8', borderRadius: 6, padding: '5px 8px', marginBottom: 8 }}>
              播放未获批：编码照常可用，只是点句不能播放音频。
            </div>
          )}
          {canPlay && (
            <audio
              ref={audioRef}
              src={audioSrc}
              controls
              preload="metadata"
              onTimeUpdate={onTimeUpdate}
              style={{ width: '100%', height: 36, marginBottom: 10 }}
            />
          )}

          {error && (
            <div style={{ fontSize: 11, color: '#b00020', background: '#fdecea', borderRadius: 6, padding: '5px 8px', marginBottom: 8 }}>
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ fontSize: 12, color: '#8a8f98', marginTop: 20 }}>读取共享编码…</div>
          ) : (
            <ul
              ref={listRef}
              className="scroll-hidden"
              onMouseUp={readSelection}
              style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minWidth: 0, minHeight: 0 }}
            >
              {sentences.map((s) => {
                const list = mine.filter((c) => c.spans.some((sp) => sp.sentence_id === s.id))
                const ratio = coverage(s, mine)
                const active = s.id === activeSentenceId
                return (
                  <SentenceRow
                    key={s.id}
                    sentence={s}
                    id={`gcs-${s.id}`}
                    active={active}
                    onClick={() => {
                      if (window.getSelection()?.toString().trim()) return
                      setActiveSentenceId(s.id)
                      setActiveCodingId(null)
                      setTab('reading')
                    }}
                    style={{
                      background: active ? '#eef4ff' : 'transparent',
                      borderLeft: active ? '3px solid #4285f4' : '3px solid transparent',
                    }}
                    playButton={
                      <button
                        type="button"
                        title={canPlay ? '只播这一句' : '播放未获批'}
                        onClick={(e) => {
                          e.stopPropagation()
                          playSentence(s)
                        }}
                        style={{
                          flexShrink: 0, fontSize: 12, lineHeight: 1.2, padding: '3px 8px',
                          alignSelf: 'flex-start', color: canPlay ? '#1d4ed8' : '#b9c0c9',
                          background: canPlay ? '#eef4ff' : '#f4f5f7', border: 'none', borderRadius: 8,
                          cursor: canPlay ? 'pointer' : 'not-allowed',
                        }}
                      >
                        ▶
                      </button>
                    }
                    body={
                      <div className="transcript-line">
                        <button
                          type="button"
                          style={{
                            fontSize: 11, color: '#8a8f98', background: '#f7f8fa',
                            border: '1px dashed #d7dce3', borderRadius: 4, padding: '1px 6px',
                            alignSelf: 'flex-start', flexShrink: 0,
                          }}
                        >
                          {s.speaker || '未标注'}
                        </button>
                        <span
                          data-sentence-id={s.id}
                          style={{ fontSize: 15, lineHeight: 1.6, flex: 1, whiteSpace: 'pre-wrap' }}
                        >
                          {renderText(s)}
                        </span>
                        {list.length > 0 && <span style={{ fontSize: 10, color: '#8a8f98', alignSelf: 'flex-start' }}>{list.length} 码</span>}
                      </div>
                    }
                    gutter={
                      <span
                        title={`本句编码密度 ${Math.round(ratio * 100)}%`}
                        style={{
                          width: 5, alignSelf: 'stretch', minHeight: 20, borderRadius: 3, flexShrink: 0,
                          background: list.length ? densityColor(ratio) : 'transparent',
                        }}
                      />
                    }
                  />
                )
              })}
            </ul>
          )}
        </div>

        <aside
          style={{
            width: 260, flexShrink: 0, borderLeft: '1px solid #eee', paddingLeft: 12,
            display: 'flex', flexDirection: 'column', minHeight: 0,
          }}
        >
          <div className="coding-right-tabs">
            <button type="button" className={tab === 'reading' ? 'active' : ''} onClick={() => setTab('reading')}>
              阅读编码
            </button>
            <button type="button" className={tab === 'codebook' ? 'active' : ''} onClick={() => setTab('codebook')}>
              码本
            </button>
          </div>
          <div className="coding-inspector-scroll scroll-hidden" style={{ flex: 1, minHeight: 0 }}>
            {tab === 'reading' ? (
              <div className="coding-inspector-body">
                {selection ? (
                  <>
                    <SideTitle extra={`${selection.spans.length} 句`}>选中片段</SideTitle>
                    <div className="coding-quote">“{selection.quote}”</div>
                    <div className="coding-label">贴到码</div>
                    <div className="coding-code-input-wrap">
                      <input
                        value={codeQuery}
                        placeholder="输入码名，回车贴码"
                        onChange={(e) => setCodeQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setSelection(null)
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            const exact = activeCodes.find((c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase())
                            if (exact) attachCode(exact)
                            else attachNew(codeQuery)
                          }
                        }}
                        style={{ width: '100%', fontSize: 13, padding: '6px 9px', border: '1px solid #d5dae2', borderRadius: 6, boxSizing: 'border-box' }}
                      />
                      <div className="coding-suggest">
                        {suggestions.map((code) => (
                          <button key={code.id} type="button" className="coding-suggest-row" onMouseDown={(e) => e.preventDefault()} onClick={() => attachCode(code)}>
                            <span className="coding-dot" style={{ background: code.color }} />
                            <span className="coding-suggest-name">{code.name}</span>
                          </button>
                        ))}
                        {codeQuery.trim() && !activeCodes.some((c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase()) && (
                          <button type="button" className="coding-suggest-row create" onMouseDown={(e) => e.preventDefault()} onClick={() => attachNew(codeQuery)}>
                            <span className="coding-plus">＋</span>
                            <span className="coding-suggest-name">新建码「{codeQuery.trim()}」</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <button type="button" className="coding-ghost-btn" onClick={() => setSelection(null)}>取消选区</button>
                  </>
                ) : activeCoding ? (
                  <>
                    <SideTitle extra={codes.find((c) => c.id === activeCoding.code_id)?.name}>选中编码</SideTitle>
                    <div className="coding-quote">“{activeCoding.quote}”</div>
                    <div className="coding-actions">
                      <button type="button" className="coding-primary-btn" onClick={() => {
                        const sp = activeCoding.spans[0]
                        const s = sp && sentences.find((x) => x.id === sp.sentence_id)
                        if (s) playSentence(s)
                      }}>▶ 播放片段</button>
                      <button type="button" className="coding-danger-btn" onClick={() => removeCoding(activeCoding.id)}>删除这条编码</button>
                    </div>
                  </>
                ) : activeSentence ? (
                  <>
                    <SideTitle extra={fmtMs(activeSentence.start_ms)}>当前句子</SideTitle>
                    <div className="coding-quote">{activeSentence.text}</div>
                    <div className="coding-label">已挂编码（{mine.filter((c) => c.spans.some((sp) => sp.sentence_id === activeSentence.id)).length}）</div>
                    <div className="coding-chips">
                      {mine
                        .filter((c) => c.spans.some((sp) => sp.sentence_id === activeSentence.id))
                        .map((entry) => {
                          const code = codes.find((c) => c.id === entry.code_id)
                          return code ? <CodeChip key={entry.id} code={code} active onClick={() => setActiveCodingId(entry.id)} onRemove={() => removeCoding(entry.id)} /> : null
                        })}
                    </div>
                  </>
                ) : (
                  <>
                    <SideTitle extra={nick || '我'}>共享编码</SideTitle>
                    <div className="coding-stat-grid">
                      <div><span>句子</span><b>{sentences.length}</b></div>
                      <div><span>我的编码</span><b>{mine.length}</b></div>
                      <div><span>全部编码</span><b>{codings.length}</b></div>
                      <div><span>编码者</span><b>{new Set(codings.map((c) => c.coder_id)).size}</b></div>
                    </div>
                    <div className="coding-hint">
                      这是共享材料：你的编码会存到群组，其他成员的编码也在这里，所以能做真正的对比。
                      拖选文字贴码即可；只保留你自己的编码，不会覆盖别人。
                    </div>
                    {saving && <div className="coding-hint">保存中…</div>}
                  </>
                )}
              </div>
            ) : (
              <div className="coding-inspector-body">
                <SideTitle extra={`${codes.length} 个码`}>码本</SideTitle>
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
                    style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '5px 8px', border: '1px solid #d5dae2', borderRadius: 6 }}
                  />
                  <button type="button" className="coding-primary-btn" onClick={createTopCode}>添加</button>
                </div>
                <div className="coding-tree scroll-hidden">{codeTreeRows(null, 0)}</div>
                {activeCode ? (
                  <div className="coding-code-detail">
                    <div className="coding-code-detail-head">
                      <span className="coding-dot" style={{ background: activeCode.color }} />
                      <input
                        value={activeCode.name}
                        onChange={(e) => {
                          const next = codes.map((c) => (c.id === activeCode.id ? { ...c, name: e.target.value } : c))
                          setCodes(next)
                        }}
                        onBlur={() => persist(codes, codings)}
                        style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, border: '1px solid transparent', borderRadius: 4, padding: '2px 4px', background: 'transparent' }}
                      />
                    </div>
                    <textarea
                      value={activeCode.definition}
                      placeholder="这个码的定义 / 纳入与排除标准…"
                      onChange={(e) => {
                        const next = codes.map((c) => (c.id === activeCode.id ? { ...c, definition: e.target.value } : c))
                        setCodes(next)
                      }}
                      onBlur={() => persist(codes, codings)}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 54, fontSize: 12, lineHeight: 1.6, padding: '5px 8px', border: '1px solid #e3e6ea', borderRadius: 6, resize: 'vertical' }}
                    />
                  </div>
                ) : (
                  <div className="coding-empty">点一个码查看定义与计数。</div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
