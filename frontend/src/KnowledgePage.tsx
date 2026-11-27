import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { kbApi, chatApi, listGroups, listGroupMaterials, type KbLibrary, type KbDocument, type Chat, type ChatMessage, type StreamEvent, type MaterialChatContext, type MineruStatus } from './api'
import type { Recording } from './types'

/** 大文件 base64：分块拼接，避免 String.fromCharCode(...bytes) 爆调用栈（PDF 常见 >10MB）。 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 极简 Markdown 渲染：标题/粗体/行内代码/引用号标签/换行。够对话回答用，零依赖。 */
function renderMd(text: string): ReactNode[] {
  return text.split('\n').map((line, i) => {
    let html = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    html = html.replace(/(\[[MK]\d+\])/g, '<span class="cite-tag">$1</span>')
    if (html.startsWith('# ')) html = '<strong style="font-size:15px">' + html.slice(2) + '</strong>'
    else if (html.startsWith('## ')) html = '<strong>' + html.slice(3) + '</strong>'
    return <div key={i} dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} style={{ lineHeight: 1.7 }} />
  })
}

export default function KnowledgePage({
  projects, projectId, onProjectChange, recordings,
}: {
  projects: { id: string; name: string }[]
  projectId: string | null
  onProjectChange: (id: string) => void
  recordings: Recording[]
}) {
  const [libs, setLibs] = useState<KbLibrary[]>([])
  const [docs, setDocs] = useState<Record<string, KbDocument[]>>({})
  const [refs, setRefs] = useState<string[]>([])
  const [newLib, setNewLib] = useState('')
  const [chats, setChats] = useState<Chat[]>([])
  const [activeChat, setActiveChat] = useState<Chat | null>(null)
  const [input, setInput] = useState('')
  const [asking, setAsking] = useState(false)
  const [onlyEvidence, setOnlyEvidence] = useState(false)
  const [allLibs, setAllLibs] = useState(false)
  const [material, setMaterial] = useState('')  // 用户粘贴/选入的材料片段
  const [materialRec, setMaterialRec] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<{ kb: string; doc: KbDocument } | null>(null)
  // 群组材料上下文 / 流式 / 向量
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([])
  const [groupId, setGroupId] = useState('')
  const [groupMaterials, setGroupMaterials] = useState<{ id: string; name: string }[]>([])
  const [groupIdentity, setGroupIdentity] = useState('')
  const [materialVersion, setMaterialVersion] = useState('')
  const [streamDraft, setStreamDraft] = useState('')
  const [streamRefs, setStreamRefs] = useState<MaterialChatContext | null>(null)
  const abortRef = useRef<{ abort: () => void } | null>(null)
  const [embedStatus, setEmbedStatus] = useState<{ models: { key: string; label: string; ready: boolean }[]; max_loaded: number } | null>(null)
  const [embedError, setEmbedError] = useState('')
  const [mineru, setMineru] = useState<MineruStatus | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string>('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const reloadLibs = async () => {
    const r = await kbApi.listLibraries()
    setLibs(r.libraries)
    const d: Record<string, KbDocument[]> = {}
    await Promise.all(r.libraries.map(async (lib) => {
      try { d[lib.id] = (await kbApi.listDocs(lib.id)).docs } catch { d[lib.id] = [] }
    }))
    setDocs(d)
  }
  const reloadRefs = async () => {
    if (!projectId) { setRefs([]); return }
    try { setRefs((await kbApi.listRefs(projectId)).kb_refs) } catch { setRefs([]) }
  }
  const reloadChats = async () => {
    if (!projectId) { setChats([]); return }
    try { setChats((await chatApi.listChats(projectId)).chats) } catch { setChats([]) }
  }
  useEffect(() => { void reloadLibs() }, [])
  useEffect(() => { void reloadRefs(); void reloadChats(); setActiveChat(null) }, [projectId])
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [activeChat, asking, streamDraft])
  useEffect(() => {
    void listGroups().then((r) => { setGroups(r.groups || []); setGroupIdentity(r.identity?.device_code || '') }).catch(() => undefined)
    // 状态读不到时必须显式报错并可重试，不能永远停在「读取中」。
    void kbApi.embedStatus()
      .then((s) => { setEmbedStatus(s); setEmbedError('') })
      .catch((e) => setEmbedError(String(e).replace(/^Error:\s*/, '')))
    void kbApi.mineruStatus().then(setMineru).catch(() => undefined)
  }, [])
  // 安装 MinerU 是长任务：运行中每 1.5 秒刷新进度；结束后停在最终状态。
  useEffect(() => {
    if (!mineru?.install.running) return
    const timer = window.setInterval(() => {
      void kbApi.mineruStatus().then(setMineru).catch(() => undefined)
    }, 1500)
    return () => window.clearInterval(timer)
  }, [mineru?.install.running])
  useEffect(() => {
    if (!groupId) { setGroupMaterials([]); return }
    void listGroupMaterials(groupId).then((ms) => setGroupMaterials(ms.map((m) => ({ id: m.id, name: m.name })))).catch(() => setGroupMaterials([]))
  }, [groupId])

  async function createLib() {
    if (!newLib.trim()) return
    await kbApi.createLibrary(newLib.trim())
    setNewLib('')
    await reloadLibs()
  }
  async function toggleRef(kbId: string) {
    if (!projectId) { setNotice('请先选择一个项目'); return }
    if (refs.includes(kbId)) await kbApi.removeRef(projectId, kbId)
    else await kbApi.addRef(projectId, kbId)
    await reloadRefs()
  }
  async function uploadFile(kbId: string, file: File) {
    const name = file.name
    const ext = name.split('.').pop()?.toLowerCase()
    if (ext === 'pdf') {
      // 安装入口已移到「设置 → 组件安装」；导入前重新读一次状态，避免设置里装完后这里还是旧值。
      const latest = await kbApi.mineruStatus().catch(() => null)
      if (latest) setMineru(latest)
      if (!(latest?.available ?? mineru?.available)) {
        setNotice('PDF 需要 PDF 转换组件（MinerU）。请先到「设置 → 组件安装」安装后再导入。')
        return
      }
    }
    const text = ext === 'md' || ext === 'markdown' || ext === 'txt' ? await file.text() : undefined
    let base64: string | undefined
    if (!text) {
      const buf = await file.arrayBuffer()
      base64 = toBase64(buf)
    }
    try {
      if (ext === 'pdf') setNotice('PDF 转换中：页数多时可能要几分钟，请保持窗口开启…')
      const doc = await kbApi.addDocument(kbId, name, text, base64)
      setNotice(doc.conversion === 'docx-builtin' ? 'Word 已按内置方式解析（版式不保证）'
        : doc.conversion === 'mineru' ? 'PDF 已转换成 Markdown 并入库' : '文档已入库')
      await reloadLibs()
    } catch (e) {
      setNotice(`导入失败：${String(e).replace(/^Error:\s*/, '')}`)
    }
  }

  async function pickMaterial(recId: string) {
    const rec = recordings.find((r) => r.id === recId)
    if (!rec) return
    // 从项目里已有的转写 md 拼材料：这里只用条目名占位，实际片段由用户在对话时从全文选择；
    // 用户也可直接在下方文本框粘贴。
    setMaterial((prev) => (prev ? prev + '\n\n' : '') + `材料：${rec.name}`)
    setMaterialRec('')
  }
  async function pickGroupMaterial(materialId: string) {
    if (!groupId || !materialId) return
    try {
      const ctx = await kbApi.groupMaterialContext(groupId, materialId, groupIdentity)
      setStreamRefs(ctx)
      setMaterialVersion(ctx.material_version)
      // 把该成员有权看到的句子拼进材料上下文（审查模式已是脱敏稿）。
      const text = ctx.sentences.map((s) => (s.speaker ? `${s.speaker}：${s.text}` : s.text)).join('\n')
      setMaterial((prev) => (prev ? prev + '\n\n' : '') + `【群组材料《${ctx.material_name}》 v${ctx.material_version}${ctx.review_mode ? ' · 脱敏稿' : ''}】\n${text}`)
      setNotice(ctx.review_mode ? '已带入群组材料的脱敏稿（审查模式）' : `已带入群组材料 v${ctx.material_version}`)
    } catch (e) {
      setNotice(`带入群组材料失败：${String(e).replace(/^Error:\s*/, '')}`)
    }
  }
  async function newChat() {
    if (!projectId) { setNotice('请先选择一个项目'); return }
    const c = await chatApi.createChat(projectId)
    setActiveChat(c)
    await reloadChats()
  }
  async function openChat(id: string) {
    if (!projectId) return
    const c = await chatApi.getChat(projectId, id)
    setActiveChat(c)
  }
  async function send() {
    if (!projectId || !activeChat || !input.trim() || asking) return
    const question = input.trim()
    setInput('')
    setAsking(true)
    setStreamDraft('')
    const userMsg: ChatMessage = { role: 'user', text: question }
    setActiveChat({ ...activeChat, messages: [...activeChat.messages, userMsg] })
    let answer = ''
    let citations: ChatMessage['refs'] = []
    let ctxChars = 0
    try {
      const snippets = material.trim() ? [{
        text: material.trim(), doc_name: '材料上下文',
        sentence_id: streamRefs?.sentences?.[0]?.sentence_id,
        material_version: materialVersion || undefined,
      }] : []
      const handle = await chatApi.askStream(projectId, activeChat.id, {
        question,
        history: activeChat.messages.slice(-12),
        material_snippets: snippets,
        library_ids: refs,
        all_libraries: allLibs,
        only_evidence: onlyEvidence,
      }, (ev: StreamEvent) => {
        if (ev.type === 'sources') { citations = ev.citations; ctxChars = ev.context_chars; setNotice(ev.note) }
        else if (ev.type === 'delta') { answer += ev.text; setStreamDraft(answer) }
        else if (ev.type === 'done') {
          answer = ev.answer
          citations = ev.citations
          const assistant: ChatMessage = { role: 'assistant', text: answer, refs: citations, context_chars: ctxChars }
          void (async () => {
            await chatApi.appendMessages(projectId, activeChat.id, [userMsg, assistant])
            await reloadChats()
            const fresh = await chatApi.getChat(projectId, activeChat.id)
            setActiveChat(fresh)
            if (ev.fabricated_quotes.length || ev.invalid_citations.length) {
              setNotice(`引文校验：剔除 ${ev.invalid_citations.length} 个无效引用，标注 ${ev.fabricated_quotes.length} 处存疑引文`)
            }
          })()
        } else if (ev.type === 'cancelled') { setNotice('已停止生成') }
        else if (ev.type === 'error') { setNotice(`回答失败：${ev.error}`) }
      })
      abortRef.current = handle
    } catch (e) {
      setNotice(`回答失败：${String(e).replace(/^Error:\s*/, '')}`)
      setActiveChat((prev) => prev ? { ...prev, messages: prev.messages.slice(0, -1) } : prev)
    } finally {
      abortRef.current = null
      setAsking(false)
      setStreamDraft('')
    }
  }

  function stop() {
    abortRef.current?.abort()
    abortRef.current = null
    setNotice('正在停止…')
  }

  const card: React.CSSProperties = { border: '1px solid #e8ebf0', borderRadius: 12, background: '#fff', padding: 14, boxSizing: 'border-box' }
  const btn: React.CSSProperties = { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #e3e6ea', background: '#fff', cursor: 'pointer', color: '#3b4250' }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 12, padding: '0 12px 12px', boxSizing: 'border-box' }}>
      <div style={{ ...card, overflow: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>知识库</div>
        <div style={{ fontSize: 11, color: '#8a8f98', lineHeight: 1.6, marginBottom: 10 }}>
          库只有一份，项目只引用它。新增文档后，所有引用该库的项目立即可用。
        </div>
        <div style={{ border: '1px solid #eef0f2', borderRadius: 8, padding: 8, marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>本地能力</div>
          <div style={{ fontSize: 10, color: '#8a8f98', lineHeight: 1.7 }}>
            PDF 转换：{mineru?.available ? `已就绪${mineru.version ? ` v${mineru.version}` : ''}（${mineru.device}）`
              : mineru?.install.running ? `安装中 ${mineru.install.progress}%`
                : mineru?.install.status === 'interrupted' ? '上次安装中断（设置 → 组件安装可续传）'
                  : mineru?.install.status === 'cancelled' ? '安装已停止（设置 → 组件安装可续传）'
                    : '未安装（设置 → 组件安装）'}
            <br />
            向量模型：{embedStatus?.models.map((m) => `${m.label} ${m.ready ? '就绪' : '未下载'}`).join(' · ')
              || (embedError ? `读取失败（${embedError}）` : '读取中…')}
            <br />
            BM25 词法始终可用；未下载向量模型时只是召回弱一些。
          </div>
          <div style={{ fontSize: 10, color: '#8a8f98', marginTop: 4 }}>
            安装、重试与下载统一在「设置 → 组件安装」，这里只显示状态。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <input value={newLib} onChange={(e) => setNewLib(e.target.value)} placeholder="新建知识库名称" style={{ flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #d5dae2' }} />
          <button onClick={() => void createLib()} style={btn}>新建</button>
        </div>
        {libs.length === 0 && <div style={{ fontSize: 12, color: '#9aa0a6' }}>还没有知识库。先建一个，再导入文档。</div>}
        {libs.map((lib) => (
          <div key={lib.id} style={{ border: '1px solid #eef0f2', borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{lib.name}</span>
              <span style={{ fontSize: 10, color: '#8a8f98' }}>{lib.doc_count ?? 0} 文档 · {lib.chunk_count ?? 0} 块</span>
              <button onClick={() => void toggleRef(lib.id)} title={refs.includes(lib.id) ? '取消项目引用' : '项目引用此库'}
                style={{ ...btn, fontSize: 11, padding: '2px 8px', background: refs.includes(lib.id) ? '#e8f0fe' : '#fff', color: refs.includes(lib.id) ? '#245c9c' : '#5b6472' }}>
                {refs.includes(lib.id) ? '已引用' : '引用'}
              </button>
            </div>
            <div style={{ fontSize: 10, color: '#8a8f98', margin: '4px 0 8px' }}>
              {lib.ref_count ? `被 ${lib.ref_count} 个项目引用 · ` : ''}{lib.embedding_model || '词法检索（embedding 留待增强）'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
              {(docs[lib.id] || []).map((d) => (
                <span key={d.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, background: '#f5f7fa', borderRadius: 6, padding: '2px 6px' }}>
                  <span onClick={() => setPreview({ kb: lib.id, doc: d })} style={{ cursor: 'pointer' }} title={d.conversion}>{d.name}</span>
                  <button onClick={() => void kbApi.deleteDocument(lib.id, d.id).then(reloadLibs)} style={{ border: 'none', background: 'transparent', color: '#b00020', cursor: 'pointer', fontSize: 11 }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <button onClick={() => { uploadTarget.current = lib.id; fileRef.current?.click() }} style={{ ...btn, fontSize: 11 }}>导入文档（md/txt/docx/pdf）</button>
              <button disabled={!embedStatus?.models.some((m) => m.ready) || !(docs[lib.id] || []).length}
                onClick={() => void kbApi.buildIndex(lib.id, 'bge-small-zh').then((r) => setNotice(`已建 ${r.built} 个向量块`)).catch((e) => setNotice(String(e)))}
                title="为该库分块建向量索引（需先下载向量模型）" style={{ ...btn, fontSize: 11 }}>建向量索引</button>
            </div>
          </div>
        ))}
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,.docx,.pdf" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f && uploadTarget.current) void uploadFile(uploadTarget.current, f); e.target.value = '' }} />
      </div>

      <div style={{ ...card, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>证据对话</span>
          <select value={projectId || ''} onChange={(e) => onProjectChange(e.target.value)} style={{ fontSize: 11, padding: '3px 6px', borderRadius: 6 }}>
            <option value="">选择项目</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={() => void newChat()} style={{ ...btn, fontSize: 11 }}>+ 新对话</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap', fontSize: 11 }}>
          {chats.map((c) => (
            <button key={c.id} onClick={() => void openChat(c.id)}
              style={{ ...btn, fontSize: 11, background: activeChat?.id === c.id ? '#e8f0fe' : '#fff', color: activeChat?.id === c.id ? '#245c9c' : '#5b6472' }}>
              {c.title}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 11, color: '#5b6472' }}>
          <label><input type="checkbox" checked={onlyEvidence} onChange={(e) => setOnlyEvidence(e.target.checked)} /> 仅依据材料/库</label>
          <label><input type="checkbox" checked={allLibs} onChange={(e) => setAllLibs(e.target.checked)} /> 全库检索</label>
        </div>
        <div style={{ border: '1px solid #eef0f2', borderRadius: 8, padding: 8, marginBottom: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
            材料上下文（可选）
            {materialVersion && <span style={{ color: '#8a5a00', fontWeight: 400, marginLeft: 6 }}>基于 v{materialVersion}</span>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select value={materialRec} onChange={(e) => { setMaterialRec(e.target.value); if (e.target.value) void pickMaterial(e.target.value) }} style={{ fontSize: 11, flex: 1 }}>
              <option value="">从项目条目添加…</option>
              {recordings.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setMaterialRec('') }} style={{ fontSize: 11, flex: 1 }}>
              <option value="">选择群组…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <select value="" onChange={(e) => { if (e.target.value) void pickGroupMaterial(e.target.value) }} style={{ fontSize: 11, flex: 1 }} disabled={!groupId}>
              <option value="">从群组材料带入…</option>
              {groupMaterials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          {streamRefs?.review_mode && <div style={{ fontSize: 10, color: '#b06a00', marginBottom: 4 }}>审查模式：仅带入阶段≥2脱敏稿</div>}
          <textarea value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="粘贴要作为依据的材料片段（访谈稿/编码等）"
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 11, minHeight: 44, padding: 6, borderRadius: 6, border: '1px solid #e8ebf0', resize: 'vertical' }} />
        </div>
        <div style={{ flex: 1, minHeight: 120, overflow: 'auto', border: '1px solid #eef0f2', borderRadius: 8, padding: 10, marginBottom: 8 }}>
          {!activeChat && <div style={{ fontSize: 12, color: '#9aa0a6', textAlign: 'center', paddingTop: 40 }}>选择项目后新建或打开一个对话</div>}
          {activeChat && activeChat.messages.length === 0 && !streamDraft && !asking && (
            <div style={{ fontSize: 12, color: '#9aa0a6', textAlign: 'center', paddingTop: 40 }}>
              还没有消息。在下面问第一个问题吧。
            </div>
          )}
          {activeChat?.messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 12, padding: 8, borderRadius: 8, background: m.role === 'user' ? '#eef4ff' : '#f7f9fc' }}>
              <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>{m.role === 'user' ? '我' : '助手'}{m.context_chars ? ` · 依据 ${m.context_chars} 字` : ''}</div>
              <div style={{ fontSize: 13 }}>{m.role === 'user' ? m.text : renderMd(m.text)}</div>
              {m.refs && m.refs.length > 0 && (
                <div style={{ marginTop: 8, borderTop: '1px dashed #d5dae2', paddingTop: 6 }}>
                  {m.refs.map((r) => <div key={r.tag} style={{ fontSize: 10, color: '#8a8f98', marginBottom: 3 }}>
                    <b style={{ color: r.kind === 'kb' ? '#245c9c' : '#b06a00' }}>[{r.tag}]</b> {r.doc_name || r.title || r.kind}：{r.text.slice(0, 70)}…
                  </div>)}
                </div>
              )}
            </div>
          ))}
          {streamDraft && <div style={{ marginBottom: 12, padding: 8, borderRadius: 8, background: '#f7f9fc' }}>
            <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>助手 · 生成中…</div>
            <div style={{ fontSize: 13 }}>{renderMd(streamDraft)}</div>
          </div>}
          {asking && !streamDraft && <div style={{ fontSize: 12, color: '#8a8f98' }}>正在检索与生成…</div>}
          <div ref={bottomRef} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
            placeholder="问点什么（会先找依据再作答）" style={{ flex: 1, fontSize: 12, padding: '6px 8px', borderRadius: 6, border: '1px solid #d5dae2' }} />
          {asking ? (
            <button onClick={stop} style={{ ...btn, background: '#b00020', color: '#fff', border: 'none' }}>停止</button>
          ) : (
            <button onClick={() => void send()} disabled={!activeChat || !input.trim()} style={{ ...btn, background: '#245c9c', color: '#fff', border: 'none' }}>发送</button>
          )}
        </div>
        {notice && <div onClick={() => setNotice('')} style={{ fontSize: 11, color: '#8a5a00', background: '#fff4e0', borderRadius: 6, padding: '5px 8px', marginTop: 8, cursor: 'pointer' }}>{notice}</div>}
      </div>

      {preview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setPreview(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(720px,92vw)', maxHeight: '84vh', overflow: 'auto', background: '#fff', borderRadius: 12, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{preview.doc.name}</span>
              <button onClick={() => setPreview(null)} style={btn}>关闭</button>
            </div>
            <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 10 }}>{preview.doc.chunk_count} 块 · {preview.doc.char_count} 字 · {preview.doc.conversion}</div>
            <iframe title="markdown-preview" src={kbApi.markdownUrl(preview.kb, preview.doc.id)} style={{ width: '100%', minHeight: 420, border: '1px solid #eef0f2', borderRadius: 8 }} />
          </div>
        </div>
      )}
    </div>
  )
}
