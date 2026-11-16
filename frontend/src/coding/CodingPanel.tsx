import { useState } from 'react'
import type { ReactNode } from 'react'
import { CodeChip, SideTitle, densityColor } from './common'
import { useOptionalCoding } from './CodingContext'
import { subtreeIds } from './store'

/**
 * 编码右栏。录音区由共用的 TranscriptPanel 渲染（见 App.tsx），本组件只负责右侧的
 * 阅读编码 / 码本面板——这样编码页与转写页的录音界面完全一致，不做任何多余改动。
 */
export default function CodingPanel() {
  const coding = useOptionalCoding()
  const [rightTab, setRightTab] = useState<'reading' | 'codebook'>('reading')
  const [newCodeName, setNewCodeName] = useState('')
  const [dragCodeId, setDragCodeId] = useState<string | null>(null)
  const [dropCodeId, setDropCodeId] = useState<string | null>(null)

  if (!coding) return null

  const {
    store,
    docId,
    docCodings,
    recent,
    suggestions,
    exactCode,
    selection,
    selectionCodings,
    activeCoding,
    activeCode,
    activeSentenceId,
    caseProfile,
    codeQuery,
    setCodeQuery,
    codeInputRef,
    sentences,
    recording,
    version,
    clearSelection,
    selectCoding,
    setActiveSentenceId,
    attachExisting,
    attachNewCode,
    removeCoding,
    deleteCodeById,
    moveCodeTo,
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
    playSentence,
    playCoding,
    coverageOf,
    countOf,
  } = coding

  const activeSentence = activeSentenceId
    ? sentences.find((s) => s.id === activeSentenceId) || null
    : null

  const scrollToSentence = (sentenceId: string) => {
    window.setTimeout(() => {
      document.getElementById(`sentence-${sentenceId}`)?.scrollIntoView({ block: 'nearest' })
      setActiveSentenceId(sentenceId)
    }, 0)
  }

  const codeTreeRows = (parentId: string | null, depth: number): ReactNode[] => {
    return store.codes
      .filter((c) => c.parent_id === parentId && c.status === 'active')
      .sort((a, b) => countOf(b.id) - countOf(a.id) || a.name.localeCompare(b.name, 'zh'))
      .flatMap((code) => {
        const count = countOf(code.id)
        const row = (
          <button
            key={code.id}
            type="button"
            draggable
            className={`coding-tree-row${activeCode?.id === code.id ? ' active' : ''}${
              dragCodeId === code.id ? ' dragging' : ''
            }${dropCodeId === code.id ? ' dnd-over' : ''}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            title="单击查看 · 双击删除 · 拖到另一个码上就变成它的子码"
            onClick={() => {
              setActiveCodeId(code.id)
              setRightTab('codebook')
            }}
            onDoubleClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              deleteCodeById(code.id)
            }}
            onDragStart={(e) => {
              e.stopPropagation()
              setDragCodeId(code.id)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', code.id)
            }}
            onDragOver={(e) => {
              if (!dragCodeId || dragCodeId === code.id) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropCodeId(code.id)
            }}
            onDragLeave={() => setDropCodeId((cur) => (cur === code.id ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragCodeId && dragCodeId !== code.id) moveCodeTo(dragCodeId, code.id)
              setDragCodeId(null)
              setDropCodeId(null)
            }}
            onDragEnd={() => {
              setDragCodeId(null)
              setDropCodeId(null)
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
                const code = store.codes.find((c) => c.id === entry.code_id)
                if (!code) return null
                return (
                  <CodeChip key={entry.id} code={code} active onRemove={() => removeCoding(entry.id)} />
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
                width: '100%', fontSize: 13, padding: '6px 9px',
                border: '1px solid #d5dae2', borderRadius: 6, boxSizing: 'border-box',
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
                  <span className="coding-suggest-count">{countOf(code.id)}</span>
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
          <button type="button" className="coding-ghost-btn" onClick={clearSelection}>取消选区</button>
        </div>
      )
    }

    if (activeCoding) {
      const code = store.codes.find((c) => c.id === activeCoding.code_id)
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
            const text = sentences.find((s) => s.id === sp.sentence_id)?.text || ''
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
          <SideTitle extra={`${Math.floor(activeSentence.start_ms / 1000)}s`}>当前句子</SideTitle>
          <div className="coding-quote">{activeSentence.text}</div>
          <div className="coding-label">已挂编码（{list.length}）</div>
          <div className="coding-chips">
            {list.length ? (
              list.map((entry) => {
                const code = store.codes.find((c) => c.id === entry.code_id)
                if (!code) return null
                return (
                  <CodeChip
                    key={entry.id}
                    code={code}
                    active
                    onClick={() => selectCoding(entry, scrollToSentence)}
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
            <span className="coding-density-swatch" style={{ background: densityColor(coverageOf(activeSentence)) }} />
            <span>{Math.round(coverageOf(activeSentence) * 100)}% 的字符被编码覆盖</span>
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
          <div><span>句子</span><b>{sentences.length}</b></div>
          <div><span>编码</span><b>{docCodings.length}</b></div>
          <div><span>码</span><b>{new Set(docCodings.map((c) => c.code_id)).size}</b></div>
          <div>
            <span>密度</span>
            <b>
              {sentences.length
                ? `${Math.round((sentences.reduce((sum, s) => sum + coverageOf(s), 0) / sentences.length) * 100)}%`
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
                  <input value={attr.label} placeholder="属性名" onChange={(e) => patchCaseAttribute(attr.id, { label: e.target.value })} />
                  <input value={attr.value} placeholder="值" onChange={(e) => patchCaseAttribute(attr.id, { value: e.target.value })} />
                  <button type="button" className="case-attr-remove" title="删除这个属性" onClick={() => removeCaseAttribute(attr.id)}>×</button>
                </div>
              ))}
            </div>
            <button type="button" className="case-attr-add" onClick={addCaseAttribute}>＋ 添加属性</button>
            <div className="coding-hint">属性用于分析：例如按“职级 / 学科”对比不同案例中的同一批码。</div>
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
                count={countOf(code.id, docId)}
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
          ③ 选码或直接输入新码，正文立即出现荧光标记；<br />
          ④ 单击编码区查看，双击撤销这条编码；码本里双击码删除整个码。
        </div>
        <div className="coding-label">数据关系</div>
        <div className="coding-relation vertical">
          <span>项目 {store.project_id}</span>
          <span>└ 录音 {recording.id}</span>
          <span>　└ 文档 {docId}</span>
          <span>　　 └ 句子 {sentences.length}</span>
          <span>　　　 └ 编码 {docCodings.length}</span>
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
                createTopCode(newCodeName)
                setNewCodeName('')
              }
            }}
            style={{
              flex: 1, minWidth: 0, fontSize: 12, padding: '5px 8px',
              border: '1px solid #d5dae2', borderRadius: 6,
            }}
          />
          <button type="button" className="coding-primary-btn" onClick={() => { createTopCode(newCodeName); setNewCodeName('') }}>
            添加
          </button>
        </div>
        <div className="coding-tree scroll-hidden">{codeTreeRows(null, 0)}</div>
        <div className="coding-hint">
          单击查看 · 双击删除；拖到另一个码上就变成它的子码。同级不手排，按使用次数自动从多到少。
        </div>
        <div
          className={`coding-tree-root-drop${dropCodeId === '__root' ? ' dnd-over' : ''}`}
          onDragOver={(e) => {
            if (!dragCodeId) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropCodeId('__root')
          }}
          onDragLeave={() => setDropCodeId((cur) => (cur === '__root' ? null : cur))}
          onDrop={(e) => {
            e.preventDefault()
            if (dragCodeId) moveCodeTo(dragCodeId, null)
            setDragCodeId(null)
            setDropCodeId(null)
          }}
        >
          拖到这里：移到顶层
        </div>
        {activeCode ? (
          <div className="coding-code-detail">
            <div className="coding-code-detail-head">
              <span className="coding-dot" style={{ background: activeCode.color }} />
              <input
                value={activeCode.name}
                onChange={(e) => updateCodeField(activeCode.id, { name: e.target.value })}
                style={{
                  flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600,
                  border: '1px solid transparent', borderRadius: 4, padding: '2px 4px', background: 'transparent',
                }}
              />
              <span className="coding-muted">{countOf(activeCode.id)} 条</span>
            </div>
            <textarea
              value={activeCode.definition}
              placeholder="这个码的定义 / 纳入与排除标准…"
              onChange={(e) => updateCodeField(activeCode.id, { definition: e.target.value })}
              style={{
                width: '100%', boxSizing: 'border-box', minHeight: 54, fontSize: 12, lineHeight: 1.6,
                padding: '5px 8px', border: '1px solid #e3e6ea', borderRadius: 6, resize: 'vertical',
              }}
            />
            <div className="coding-label">移动到…</div>
            <select
              value={activeCode.parent_id || ''}
              onChange={(e) => moveCodeTo(activeCode.id, e.target.value || null)}
              className="coding-move-select"
            >
              <option value="">顶层</option>
              {store.codes
                .filter(
                  (c) =>
                    c.id !== activeCode.id &&
                    c.status === 'active' &&
                    !subtreeIds(store, activeCode.id).has(c.id),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <div className="coding-actions">
              <button type="button" className="coding-primary-btn" onClick={() => jumpToCode(activeCode.id, scrollToSentence)}>
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

  return (
    <aside className="workspace-card coding-inspector" style={{ gridColumn: 'span 1' }}>
      <div className="coding-right-tabs">
        <button type="button" className={rightTab === 'reading' ? 'active' : ''} onClick={() => setRightTab('reading')}>
          阅读编码
        </button>
        <button type="button" className={rightTab === 'codebook' ? 'active' : ''} onClick={() => setRightTab('codebook')}>
          码本
        </button>
      </div>
      <div className="coding-inspector-scroll scroll-hidden">
        {rightTab === 'reading' ? renderInspector() : renderCodebook()}
      </div>
      <div className="coding-doc-meta">
        <span>录音 {recording.id} · audio.{recording.format || '—'}</span>
        <span>文档 {docId} · v{version || '—'}</span>
        <span>{sentences.length} 句 · {docCodings.length} 条编码 · 自动保存</span>
      </div>
    </aside>
  )
}
