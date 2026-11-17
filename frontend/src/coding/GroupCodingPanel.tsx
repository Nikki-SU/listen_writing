import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as api from '../api'
import { TranscriptAudio, TranscriptList } from '../TranscriptBody'
import { useSentencePlayer } from '../useSentencePlayer'
import { speakerOrderFrom } from '../SpeakerTag'
import SentenceLine from '../SentenceLine'
import type { CodingCode, CodingEntry, CodingSpan, Sentence } from '../types'
import { CodeChip, SideTitle, blendColors, densityColor, fmtMs, hexToRgba } from './common'

const CODE_COLORS = ['#5b4bcc', '#2f6fed', '#0f9d9d', '#c2760a']

type Tab = 'reading' | 'codebook' | 'shared'

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
 * 共享材料里的编码工作区。
 *
 * 关键规则（来自产品讨论）：
 * - 材料是共享的，编码是各人的：每个人一份码本，别人只读可见，用于对照；
 * - 共享码本是组内公共资产，只有群主 + 全部管理员同意后才生效；
 * - 因此这里的写操作只写「我的」码本和「我的」编码，绝不覆盖别人。
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
  const [data, setData] = useState<api.GroupCoding | null>(null)
  const [codes, setCodes] = useState<CodingCode[]>([])
  const [codings, setCodings] = useState<CodingEntry[]>([])
  const [me, setMe] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<Tab>('reading')
  const [selection, setSelection] = useState<{ spans: CodingSpan[]; quote: string } | null>(null)
  const [activeCodingId, setActiveCodingId] = useState<string | null>(null)
  const [activeCodeId, setActiveCodeId] = useState<string | null>(null)
  const [multiSelect, setMultiSelect] = useState(false)
  const [selectedCodes, setSelectedCodes] = useState<Set<string>>(new Set())
  const [codeQuery, setCodeQuery] = useState('')
  const [newCodeName, setNewCodeName] = useState('')
  const [viewer, setViewer] = useState('mine')
  const [busyProposal, setBusyProposal] = useState(false)

  const listRef = useRef<HTMLUListElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const dragRef = useRef<string | null>(null)
  // 播放逻辑与本地/协作转写共用同一个 hook（播放器行为只有一份）。
  const player = useSentencePlayer(sentences, audioRef)
  const { activeId: activeSentenceId, setActiveId: setActiveSentenceId } = player
  // 与个人页同源的发言人配色：同一个人在所有视图同色。
  const speakerOrder = useMemo(() => speakerOrderFrom(sentences), [sentences])

  const applyPayload = useCallback((d: api.GroupCoding) => {
    setData(d)
    setMe(d.me)
    setCodes(d.my_codebook?.codes || [])
    setCodings(d.codings || [])
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .getGroupCoding(groupId, materialId)
      .then((d) => {
        if (cancelled) return
        applyPayload(d)
        setError('')
      })
      .catch((e) => setError(`读取共享编码失败：${String(e)}`))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [groupId, materialId, applyPayload])

  const mine = useMemo(() => codings.filter((c) => c.coder_id === me), [codings, me])
  const shared = data?.shared_codebook || null
  const legacy = data?.legacy_codes || []
  const books = data?.codebooks || []
  const proposals = data?.proposals || []
  const pending = proposals.filter((p) => p.status === 'pending')

  const allCodes = useMemo(() => {
    const map = new Map<string, CodingCode>()
    for (const c of [...(data?.codes || []), ...codes, ...(shared?.codes || []), ...legacy]) {
      if (c?.id) map.set(c.id, c)
    }
    return map
  }, [data, codes, shared, legacy])

  const codeOf = useCallback((id: string) => allCodes.get(id), [allCodes])

  // 贴码优先用共享码本（组内统一口径）；没有共享码本时用自己的码本。
  const attachPool = useMemo(() => {
    const active = (shared?.codes || []).filter((c) => c.status === 'active')
    return active.length ? active : codes.filter((c) => c.status === 'active')
  }, [shared, codes])

  const otherBooks = useMemo(() => books.filter((b) => !b.is_me), [books])

  useEffect(() => {
    if (viewer === 'shared' && !shared) setViewer('mine')
    if (viewer === 'legacy' && !legacy.length) setViewer('mine')
    if (viewer !== 'mine' && viewer !== 'shared' && viewer !== 'legacy' && !otherBooks.some((b) => b.coder_id === viewer)) {
      setViewer('mine')
    }
  }, [viewer, shared, legacy.length, otherBooks])

  const viewCodes = useMemo(() => {
    if (viewer === 'mine') return codes
    if (viewer === 'shared') return shared?.codes || []
    if (viewer === 'legacy') return legacy
    return otherBooks.find((b) => b.coder_id === viewer)?.codes || []
  }, [viewer, codes, shared, legacy, otherBooks])

  const viewCodings = useMemo(() => {
    if (viewer === 'mine') return mine
    if (viewer === 'shared' || viewer === 'legacy') {
      const ids = new Set(viewCodes.map((c) => c.id))
      return codings.filter((c) => ids.has(c.code_id))
    }
    return codings.filter((c) => c.coder_id === viewer)
  }, [viewer, mine, codings, viewCodes])

  const viewName =
    viewer === 'mine'
      ? `${nick || '我'}的码本`
      : viewer === 'shared'
        ? `${shared?.name || '共享码本'}${shared?.version ? ` v${shared.version}` : ''}`
        : viewer === 'legacy'
          ? '旧版共享码本'
          : otherBooks.find((b) => b.coder_id === viewer)?.nick || '成员码本'

  const editable = viewer === 'mine'

  const persist = useCallback(
    (nextCodes: CodingCode[], nextCodings: CodingEntry[]) => {
      setSaving(true)
      api
        .saveGroupCoding(groupId, materialId, nextCodes, nextCodings)
        .then((d) => {
          applyPayload(d)
          setError('')
        })
        .catch((e) => setError(`保存失败：${String(e)}`))
        .finally(() => setSaving(false))
    },
    [groupId, materialId, applyPayload],
  )

  const activeCoding = activeCodingId ? mine.find((c) => c.id === activeCodingId) || null : null
  const activeCode = activeCodeId ? viewCodes.find((c) => c.id === activeCodeId) || null : null
  const activeSentence = activeSentenceId ? sentences.find((s) => s.id === activeSentenceId) || null : null

  const suggestions = useMemo(() => {
    const q = codeQuery.trim().toLowerCase()
    if (q) {
      const pool = [...attachPool, ...codes]
      return pool
        .filter((c) => c.name.toLowerCase().includes(q) || c.definition.toLowerCase().includes(q))
        .slice(0, 8)
    }
    const seen = new Set<string>()
    const out: CodingCode[] = []
    for (const c of [...mine].reverse()) {
      const code = codeOf(c.code_id)
      if (!code || seen.has(code.id)) continue
      seen.add(code.id)
      out.push(code)
      if (out.length >= 8) break
    }
    for (const c of attachPool) {
      if (seen.has(c.id)) continue
      out.push(c)
      if (out.length >= 8) break
    }
    return out
  }, [codeQuery, attachPool, codes, mine, codeOf])

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
    const existing = attachPool.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      attachCode(existing)
      return
    }
    const topCount = codes.filter((c) => !c.parent_id).length
    const code: CodingCode = {
      id: uid('code'),
      codebook_id: `pcb_${me || 'me'}`,
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

  /** 删除一条我的编码；若这个码在我全材料只剩这一处，顺手撤掉空码。 */
  function removeCoding(id: string) {
    const target = codings.find((c) => c.id === id)
    if (!target || target.coder_id !== me) return
    const next = codings.filter((c) => c.id !== id)
    setCodings(next)
    if (activeCodingId === id) setActiveCodingId(null)

    const codeId = target.code_id
    const stillUsed = next.some((c) => c.coder_id === me && c.code_id === codeId)
    const hasChildren = codes.some((c) => c.parent_id === codeId)
    if (!stillUsed && !hasChildren && codes.some((c) => c.id === codeId)) {
      const nextCodes = codes.filter((c) => c.id !== codeId)
      setCodes(nextCodes)
      persist(nextCodes, next)
      return
    }
    persist(codes, next)
  }

  function createTopCode() {
    const name = newCodeName.trim()
    if (!name) return
    const topCount = codes.filter((c) => !c.parent_id).length
    const code: CodingCode = {
      id: uid('code'),
      codebook_id: `pcb_${me || 'me'}`,
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

  function deleteMyCode(codeId: string) {
    if (!editable) return
    const code = codes.find((c) => c.id === codeId)
    if (!code) return
    const nextCodes = codes
      .filter((c) => c.id !== codeId)
      .map((c) => (c.parent_id === codeId ? { ...c, parent_id: code.parent_id } : c))
    const nextCodings = codings.filter((c) => !(c.coder_id === me && c.code_id === codeId))
    setCodes(nextCodes)
    setCodings(nextCodings)
    if (activeCodeId === codeId) setActiveCodeId(null)
    persist(nextCodes, nextCodings)
  }

  function deleteMyCodes(ids: string[]) {
    if (!editable || !ids.length) return
    const idSet = new Set(ids)
    const nextCodes = codes
      .filter((c) => !idSet.has(c.id))
      .map((c) => (c.parent_id && idSet.has(c.parent_id) ? { ...c, parent_id: null } : c))
    const nextCodings = codings.filter((c) => !(c.coder_id === me && idSet.has(c.code_id)))
    setCodes(nextCodes)
    setCodings(nextCodings)
    if (activeCodeId && idSet.has(activeCodeId)) setActiveCodeId(null)
    persist(nextCodes, nextCodings)
  }

  function jumpToCode(codeId: string) {
    const sub = subtree(codes, codeId)
    const hit = codings.find((c) => c.coder_id === me && sub.has(c.code_id)) || codings.find((c) => sub.has(c.code_id))
    const sid = hit?.spans?.[0]?.sentence_id
    if (!sid) return
    setTab('reading')
    window.setTimeout(() => {
      listRef.current?.querySelector(`[data-sentence-id="${sid}"]`)?.scrollIntoView({ block: 'center' })
    }, 50)
  }

  function moveMyCode(codeId: string, parentId: string | null) {
    if (!editable) return
    const code = codes.find((c) => c.id === codeId)
    if (!code || code.parent_id === parentId) return
    // 不能移到自己或自己的后代下面，否则层级成环。
    if (parentId && (parentId === codeId || subtree(codes, codeId).has(parentId))) return
    const next = codes.map((c) => (c.id === codeId ? { ...c, parent_id: parentId } : c))
    setCodes(next)
    persist(next, codings)
  }

  function updateCode(codeId: string, patch: Partial<CodingCode>, save = false) {
    if (!editable) return
    const next = codes.map((c) => (c.id === codeId ? { ...c, ...patch } : c))
    setCodes(next)
    if (save) persist(next, codings)
  }

  function propose() {
    if (busyProposal) return
    setBusyProposal(true)
    api
      .proposeGroupCodebook(groupId, materialId)
      .then((d) => {
        applyPayload(d)
        setError('')
      })
      .catch((e) => setError(`提案失败：${String(e)}`))
      .finally(() => setBusyProposal(false))
  }

  function decide(ids: string[], decision: 'approve' | 'reject') {
    if (!ids.length || busyProposal) return
    setBusyProposal(true)
    api
      .decideGroupCodebookProposals(groupId, materialId, ids, decision)
      .then((d) => {
        applyPayload(d)
        setError('')
      })
      .catch((e) => setError(`审批失败：${String(e)}`))
      .finally(() => setBusyProposal(false))
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
      const cols = uniq.map((c) => codeOf(c.code_id)).filter((c): c is CodingCode => Boolean(c))
      const style: CSSProperties = {
        background: cols.length ? hexToRgba(blendColors(cols.map((c) => c.color)), 0.28) : undefined,
        borderRadius: 2,
        cursor: uniq.length ? 'pointer' : 'text',
      }
      nodes.push(
        <span
          key={`${s.id}-${from}-${to}`}
          style={style}
          title={uniq.map((c) => `${codeOf(c.code_id)?.name || '码'}：${c.quote}`).join('\n')}
          onClick={(e) => {
            if (!uniq.length) return
            e.stopPropagation()
            setActiveCodingId(uniq[0].id)
            setTab('reading')
          }}
          onDoubleClick={(e) => {
            if (!uniq.length) return
            e.preventDefault()
            e.stopPropagation()
            removeCoding(uniq[uniq.length - 1].id)
          }}
        >
          {s.text.slice(from, to)}
        </span>,
      )
    }
    return nodes
  }

  /** 同一级别里编码最多的排最上面，其余按名称；不提供手工上下排序。 */
  const siblingRows = (bookCodes: CodingCode[], ownerCodings: CodingEntry[], parentId: string | null, depth: number): ReactNode[] =>
    bookCodes
      .filter((c) => c.parent_id === parentId && c.status === 'active')
      .map((code) => {
        const sub = subtree(bookCodes, code.id)
        return { code, count: ownerCodings.filter((c) => sub.has(c.code_id)).length }
      })
      .sort((a, b) => b.count - a.count || a.code.name.localeCompare(b.code.name, 'zh'))
      .flatMap(({ code, count }) => {
        const row = (
          <button
            key={code.id}
            type="button"
            className={`coding-tree-row${activeCodeId === code.id ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 16, ...(multiSelect && selectedCodes.has(code.id) ? { background: '#eef4ff' } : {}) }}
            draggable={editable}
            title={editable ? '单击查看，双击删除，拖到别的码上改变层级' : '别人的码，只读'}
            onClick={() => {
              if (multiSelect) {
                setSelectedCodes((prev) => {
                  const next = new Set(prev)
                  if (next.has(code.id)) next.delete(code.id); else next.add(code.id)
                  return next
                })
              } else setActiveCodeId(code.id)
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              if (!multiSelect) deleteMyCode(code.id)
            }}
            onDragStart={() => {
              dragRef.current = code.id
            }}
            onDragOver={(e) => {
              if (editable && dragRef.current && dragRef.current !== code.id) e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (dragRef.current) moveMyCode(dragRef.current, code.id)
              dragRef.current = null
            }}
            onDragEnd={() => {
              dragRef.current = null
            }}
          >
            <span className="coding-dot" style={{ background: code.color }} />
            <span className="coding-tree-name">{code.name}</span>
            <span className="coding-tree-count">{count}</span>
          </button>
        )
        return [row, ...siblingRows(bookCodes, ownerCodings, code.id, depth + 1)]
      })

  const originTag = (code: CodingCode): string => {
    if ((shared?.codes || []).some((c) => c.id === code.id)) return '共享'
    if (legacy.some((c) => c.id === code.id)) return '旧版'
    return '个人'
  }

  const myPending = pending.filter((p) => {
    const decision = p.decisions?.[me]?.decision
    return decision !== 'approve' && decision !== 'reject'
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
            <TranscriptAudio
              audioRef={audioRef}
              audioUrl={audioSrc}
              onTimeUpdate={player.onTimeUpdate}
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
<TranscriptList
              sentences={sentences}
              activeId={activeSentenceId}
              listRef={listRef}
              onMouseUp={readSelection}
              onPlayPressStart={player.playPressStart}
              onPlayPressEnd={player.playPressEnd}
              onPlayPressCancel={player.playPressCancel}
              onRowClick={(s) => {
                if (window.getSelection()?.toString().trim()) return
                setActiveSentenceId(s.id)
                setActiveCodingId(null)
                setTab('reading')
              }}
              rowStyle={(_s, active) => ({
                background: active ? '#eef4ff' : 'transparent',
                borderLeft: active ? '3px solid #4285f4' : '3px solid transparent',
              })}
              renderBody={(s) => {
                const list = mine.filter((c) => c.spans.some((sp) => sp.sentence_id === s.id))
                return <SentenceLine
                  sentence={s}
                  order={speakerOrder}
                  textAttrs={{ 'data-sentence-id': s.id }}
                  tail={list.length > 0 ? <span style={{ fontSize: 10, color: '#8a8f98', alignSelf: 'flex-start' }}>{list.length} 码</span> : undefined}
                >{renderText(s)}</SentenceLine>
              }}
              renderGutter={(s) => {
                const list = mine.filter((c) => c.spans.some((sp) => sp.sentence_id === s.id))
                const ratio = coverage(s, mine)
                return <span title={`本句编码密度 ${Math.round(ratio * 100)}%`} style={{ width: 5, alignSelf: 'stretch', minHeight: 20, borderRadius: 3, flexShrink: 0, background: list.length ? densityColor(ratio) : 'transparent' }} />
              }}
            />          )}
        </div>

        <aside
          style={{
            width: 280, flexShrink: 0, borderLeft: '1px solid #eee', paddingLeft: 12,
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
            <button type="button" className={tab === 'shared' ? 'active' : ''} onClick={() => setTab('shared')}>
              共享{shared ? ` v${shared.version}` : ''}
              {pending.length > 0 && <span className="coding-tree-count" style={{ marginLeft: 4 }}>{pending.length}</span>}
            </button>
          </div>
          <div className="coding-inspector-scroll scroll-hidden" style={{ flex: 1, minHeight: 0 }}>
            {tab === 'reading' ? (
              <div className="coding-inspector-body">
                {selection ? (
                  <>
                    <SideTitle extra={`${selection.spans.length} 句`}>选中片段</SideTitle>
                    <div className="coding-quote">“{selection.quote}”</div>
                    <div className="coding-label">贴到码{shared ? '（共享优先）' : ''}</div>
                    <div className="coding-code-input-wrap">
                      <input
                        value={codeQuery}
                        placeholder="输入码名，回车贴码"
                        onChange={(e) => setCodeQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setSelection(null)
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            const exact = attachPool.find((c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase())
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
                            <span className="coding-tree-count">{originTag(code)}</span>
                          </button>
                        ))}
                        {codeQuery.trim() && !attachPool.some((c) => c.name.trim().toLowerCase() === codeQuery.trim().toLowerCase()) && (
                          <button type="button" className="coding-suggest-row create" onMouseDown={(e) => e.preventDefault()} onClick={() => attachNew(codeQuery)}>
                            <span className="coding-plus">＋</span>
                            <span className="coding-suggest-name">新建个人码「{codeQuery.trim()}」</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <button type="button" className="coding-ghost-btn" onClick={() => setSelection(null)}>取消选区</button>
                  </>
                ) : activeCoding ? (
                  <>
                    <SideTitle extra={codeOf(activeCoding.code_id)?.name}>选中编码</SideTitle>
                    <div className="coding-quote">“{activeCoding.quote}”</div>
                    <div className="coding-actions">
                      <button type="button" className="coding-primary-btn" onClick={() => {
                        const sp = activeCoding.spans[0]
                        const s = sp && sentences.find((x) => x.id === sp.sentence_id)
                        if (s) player.seek(s, true)
                      }}>▶ 播放片段</button>
                      <button type="button" className="coding-danger-btn" onClick={() => removeCoding(activeCoding.id)}>删除这条编码</button>
                    </div>
                    <div className="coding-hint">双击正文里的编码区也能直接撤销；这是你自己的编码，不会影响别人。</div>
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
                          const code = codeOf(entry.code_id)
                          return code ? <CodeChip key={entry.id} code={code} active onClick={() => setActiveCodingId(entry.id)} onRemove={() => removeCoding(entry.id)} /> : null
                        })}
                    </div>
                  </>
                ) : (
                  <>
                    <SideTitle extra={nick || '我'}>共享材料 · 各自编码</SideTitle>
                    <div className="coding-stat-grid">
                      <div><span>句子</span><b>{sentences.length}</b></div>
                      <div><span>我的编码</span><b>{mine.length}</b></div>
                      <div><span>全部编码</span><b>{codings.length}</b></div>
                      <div><span>编码者</span><b>{new Set(codings.map((c) => c.coder_id)).size}</b></div>
                    </div>
                    <div className="coding-hint">
                      材料共享，编码各人独立：你的码本与编码只有你能改，别人只能看，用来对照。
                      想让全组用同一套码，就在「共享」里提案，需要群主和全部管理员同意。
                    </div>
                    {saving && <div className="coding-hint">保存中…</div>}
                  </>
                )}
              </div>
            ) : tab === 'codebook' ? (
              <div className="coding-inspector-body">
                <SideTitle extra={`${viewCodes.length} 个码`}>码本</SideTitle>
                <select
                  value={viewer}
                  onChange={(e) => {
                    setViewer(e.target.value)
                    setActiveCodeId(null)
                  }}
                  style={{ width: '100%', fontSize: 12, padding: '4px 6px', marginBottom: 6 }}
                >
                  <option value="mine">{nick || '我'}的码本（我的）</option>
                  {shared && <option value="shared">共享码本 v{shared.version}</option>}
                  {legacy.length > 0 && <option value="legacy">旧版共享码本</option>}
                  {otherBooks.map((b) => (
                    <option key={b.coder_id} value={b.coder_id}>
                      {b.nick || b.coder_id} 的码本（{b.coding_count ?? 0} 条）
                    </option>
                  ))}
                </select>
                {editable ? (
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
                ) : (
                  <div className="coding-hint">{viewName}：只读。各人码本独立，只有本人能改。</div>
                )}
                {editable && (
                  <div className="coding-bulk-bar">
                    <button type="button" className={`coding-ghost-btn${multiSelect ? ' on' : ''}`}
                      onClick={() => { setMultiSelect((v) => !v); setSelectedCodes(new Set()) }}
                      title="多选模式：一次勾选多个码批量删除">
                      {multiSelect ? '退出多选' : '多选删除'}
                    </button>
                    {multiSelect && (
                      <>
                        <button type="button" className="coding-ghost-btn" onClick={() => setSelectedCodes(new Set(viewCodes.filter((c) => c.status === 'active').map((c) => c.id)))}>全选</button>
                        <span className="coding-bulk-count">已选 {selectedCodes.size}</span>
                        <button type="button" className="coding-danger-btn" disabled={!selectedCodes.size}
                          onClick={() => {
                            const affected = codings.filter((c) => c.coder_id === me && selectedCodes.has(c.code_id)).length
                            if (!window.confirm(`删除 ${selectedCodes.size} 个码、${affected} 条编码？`)) return
                            deleteMyCodes(Array.from(selectedCodes))
                            setSelectedCodes(new Set())
                            setMultiSelect(false)
                          }}>
                          删除 {selectedCodes.size} 个码
                        </button>
                      </>
                    )}
                  </div>
                )}
                <div
                  className="coding-tree scroll-hidden"
                  onDragOver={(e) => {
                    if (editable && dragRef.current) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragRef.current) moveMyCode(dragRef.current, null)
                    dragRef.current = null
                  }}
                  title={editable ? '拖到空白处变为顶层码' : undefined}
                >
                  {siblingRows(viewCodes, viewCodings, null, 0)}
                  {viewCodes.length === 0 && <div className="coding-empty">这个码本还是空的。</div>}
                </div>
                {activeCode ? (
                  <div className="coding-code-detail">
                    <div className="coding-code-detail-head">
                      <span className="coding-dot" style={{ background: activeCode.color }} />
                      <input
                        value={activeCode.name}
                        readOnly={!editable}
                        onChange={(e) => updateCode(activeCode.id, { name: e.target.value })}
                        onBlur={() => editable && persist(codes, codings)}
                        style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, border: '1px solid transparent', borderRadius: 4, padding: '2px 4px', background: 'transparent' }}
                      />
                      <span className="coding-tree-count">{originTag(activeCode)}</span>
                    </div>
                    <textarea
                      value={activeCode.definition}
                      readOnly={!editable}
                      placeholder="这个码的定义 / 纳入与排除标准…"
                      onChange={(e) => updateCode(activeCode.id, { definition: e.target.value })}
                      onBlur={() => editable && persist(codes, codings)}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 54, fontSize: 12, lineHeight: 1.6, padding: '5px 8px', border: '1px solid #e3e6ea', borderRadius: 6, resize: 'vertical' }}
                    />
                    {editable && (
                      <>
                        <div className="coding-label">移动到…</div>
                        <select value={activeCode.parent_id || ''} onChange={(e) => moveMyCode(activeCode.id, e.target.value || null)}
                          className="coding-move-select" style={{ fontSize: 11, width: '100%', marginBottom: 6 }}>
                          <option value="">顶层</option>
                          {viewCodes.filter((c) => c.id !== activeCode.id && c.status === 'active' && !subtree(viewCodes, activeCode.id).has(c.id)).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                        <div className="coding-actions" style={{ marginBottom: 6 }}>
                          <button type="button" className="coding-primary-btn" onClick={() => jumpToCode(activeCode.id)}>在正文中定位</button>
                        </div>
                      </>
                    )}
                    {editable ? (
                      <div className="coding-hint">
                        双击码名可删除；把码拖到另一个码上或用「移动到…」改变层级；同级按编码数量自动排序。
                      </div>
                    ) : (
                      <div className="coding-hint">这是 {viewName}，别人的码只读，不会与你的编码混在一起。</div>
                    )}
                  </div>
                ) : (
                  <div className="coding-empty">点一个码查看定义与计数。</div>
                )}
              </div>
            ) : (
              <div className="coding-inspector-body">
                <SideTitle extra={data?.can_approve ? '你可审批' : '仅可提案'}>共享码本</SideTitle>
                {shared ? (
                  <>
                    <div className="coding-summary-row">
                      {shared.name || '共享码本'} <b>v{shared.version}</b>
                    </div>
                    <div className="coding-summary-row">
                      码数 <b>{(shared.codes || []).length}</b>
                    </div>
                    <div className="coding-hint">
                      共享码本已生效。个人码本仍可用，贴码时优先用共享码，避免各人命名漂移。
                    </div>
                  </>
                ) : (
                  <div className="coding-hint">
                    还没有共享码本。组内可以各自编码；需要统一口径时，由任一成员用自己的码本提案，
                    群主 + 全部管理员同意后生效。
                  </div>
                )}

                <button
                  type="button"
                  className="coding-primary-btn"
                  style={{ marginTop: 8, width: '100%' }}
                  disabled={busyProposal || !codes.length}
                  onClick={propose}
                >
                  {shared ? `用我的码本提案修改（v${shared.version || 1} → v${(shared.version || 1) + 1}）` : '用我的码本建立共享码本'}
                </button>
                {!codes.length && <div className="coding-hint">先在自己的码本里建码，才能提案。</div>}

                <div className="coding-label" style={{ marginTop: 12 }}>
                  审批人（{data?.approvers.length || 0}）
                </div>
                <div className="coding-hint">
                  {(data?.approvers || []).map((a) => `${a.nick || a.device_code}（${a.role}）`).join('、') || '暂无'}
                  {' · '}提案 7 天未决自动过期，不会默认通过。
                </div>

                {pending.length > 0 && data?.can_approve && myPending.length > 1 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button type="button" className="coding-primary-btn" disabled={busyProposal} onClick={() => decide(myPending.map((p) => p.id), 'approve')}>
                      全部同意
                    </button>
                    <button type="button" className="coding-danger-btn" disabled={busyProposal} onClick={() => decide(myPending.map((p) => p.id), 'reject')}>
                      全部拒绝
                    </button>
                  </div>
                )}

                <div className="coding-label" style={{ marginTop: 12 }}>提案记录（{proposals.length}）</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {proposals.length === 0 && <div className="coding-empty">还没有人提案。</div>}
                  {proposals.map((p) => {
                    const mineDecision = p.decisions?.[me]?.decision
                    const approved = p.approvals?.length || 0
                    const label =
                      p.status === 'approved' ? `已生效 v${p.applied_version || ''}`
                        : p.status === 'rejected' ? '已驳回'
                          : p.status === 'expired' ? '已过期' : '待审批'
                    return (
                      <div key={p.id} style={{ border: '1px solid #e3e6ea', borderRadius: 6, padding: '7px 8px', background: '#fff' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                          <b style={{ color: '#3b4250' }}>{p.kind === 'create' ? '新建' : '修改'}</b>
                          <span style={{ color: '#8a8f98' }}>{p.by || '成员'} · {new Date(p.created_at).toLocaleDateString()}</span>
                          <span style={{ marginLeft: 'auto', color: p.status === 'pending' ? '#8a5a00' : '#5f5e5a' }}>{label}</span>
                        </div>
                        <div className="coding-hint" style={{ marginTop: 3 }}>
                          {p.name} · {p.codes.length} 个码 · 同意 {approved}/{p.required.length}
                          {p.status === 'pending' && <> · 截止 {new Date(p.expires_at).toLocaleDateString()}</>}
                        </div>
                        {p.status === 'pending' && data?.can_approve && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button
                              type="button"
                              className="coding-primary-btn"
                              disabled={busyProposal || mineDecision === 'approve'}
                              onClick={() => decide([p.id], 'approve')}
                            >
                              {mineDecision === 'approve' ? '我已同意' : '同意'}
                            </button>
                            <button
                              type="button"
                              className="coding-danger-btn"
                              disabled={busyProposal || mineDecision === 'reject'}
                              onClick={() => decide([p.id], 'reject')}
                            >
                              拒绝
                            </button>
                          </div>
                        )}
                        {p.status === 'rejected' && <div className="coding-hint">任一审批人拒绝即驳回。</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </>
  )
}
