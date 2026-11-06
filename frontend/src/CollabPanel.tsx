import { useEffect, useMemo, useState } from 'react'
import * as api from './api'
import type {
  CollabAccess,
  CollabApproval,
  CollabGroupSummary,
  CollabMaterial,
  CollabMaterialDetail,
  CollabMember,
  CollabProposal,
  CollabRole,
  Project,
  Recording,
  Sentence,
} from './types'

const CAP_LABELS: Record<string, string> = {
  view: '查看',
  edit: '编辑正文',
  submit: '提交修改',
  merge: '合并提案',
  material: '灌入材料',
  approve: '批准播放',
  members: '管理成员',
  roles: '改权限',
  review: '审查模式',
  manage: '管理群组',
}

const ROLE_ORDER = ['owner', 'admin', 'editor', 'reader', 'reviewer']

const TABS = [
  ['material', '材料'],
  ['members', '成员与权限'],
  ['proposals', '修改提案'],
  ['approvals', '播放审批'],
  ['access', '访问留痕'],
] as const

type Tab = (typeof TABS)[number][0]

function errText(e: unknown): string {
  return String(e)
}

function fmtTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] || c))
}

export default function CollabPanel({ projects, onClose }: { projects: Project[]; onClose: () => void }) {
  const [groups, setGroups] = useState<CollabGroupSummary[]>([])
  const [identity, setIdentity] = useState<{ nick: string; device_code: string }>({ nick: '', device_code: '' })
  const [selected, setSelected] = useState<CollabGroupSummary | null>(null)
  const [tab, setTab] = useState<Tab>('material')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const [newName, setNewName] = useState('')
  const [newMode, setNewMode] = useState<'authoritative' | 'replica'>('authoritative')
  const [joinCode, setJoinCode] = useState('')
  const [joinRole, setJoinRole] = useState<'reader' | 'reviewer'>('reader')

  const [members, setMembers] = useState<CollabMember[]>([])
  const [roles, setRoles] = useState<Record<string, CollabRole>>({})
  const [requests, setRequests] = useState<{
    id: string
    device_code: string
    nick: string
    role: string
    by_nick: string
    at: string
    status: string
  }[]>([])
  const [materials, setMaterials] = useState<CollabMaterial[]>([])
  const [proposals, setProposals] = useState<CollabProposal[]>([])
  const [approvals, setApprovals] = useState<CollabApproval[]>([])
  const [access, setAccess] = useState<CollabAccess[]>([])

  const [addProject, setAddProject] = useState('')
  const [addRecording, setAddRecording] = useState('')
  const [recordings, setRecordings] = useState<Recording[]>([])

  const [materialView, setMaterialView] = useState<CollabMaterialDetail | null>(null)
  const [editSentence, setEditSentence] = useState<Sentence | null>(null)
  const [editText, setEditText] = useState('')
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({})
  const [localEditing, setLocalEditing] = useState<Sentence | null>(null)
  const [localText, setLocalText] = useState('')
  const [mergeConflicts, setMergeConflicts] = useState<{
    sentence_id: string
    index: number
    base: string
    current: string
    incoming: string
  }[] | null>(null)
  const [playMode, setPlayMode] = useState<'burn' | 'permanent' | 'timed'>('timed')

  const myRole = selected?.my_role || ''
  const myCaps = (roles[myRole]?.caps || []) as string[]
  const has = (cap: string) => myCaps.includes(cap)

  async function run(fn: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  async function loadGroups() {
    const data = await api.listGroups()
    setGroups(data.groups)
    setIdentity(data.identity)
  }

  useEffect(() => {
    void run(loadGroups)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadGroup(id: string) {
    const [g, m, mat, p, a] = await Promise.all([
      api.groupDetail(id),
      api.groupMembers(id),
      api.listGroupMaterials(id),
      api.listProposals(id),
      api.listApprovals(id),
    ])
    setSelected(g)
    setRoles(m.roles)
    setMembers(m.members)
    setRequests(m.member_requests || [])
    setMaterials(mat)
    setProposals(p)
    setApprovals(a)
    const caps = (m.roles[g.my_role || '']?.caps || []) as string[]
    if (caps.includes('members')) {
      try {
        setAccess(await api.groupAccess(id))
      } catch {
        setAccess([])
      }
    } else {
      setAccess([])
    }
  }

  async function selectGroup(id: string) {
    setMaterialView(null)
    setLocalEdits({})
    setLocalEditing(null)
    setMergeConflicts(null)
    await run(async () => {
      await loadGroup(id)
    })
  }

  async function openMaterial(id: string) {
    if (!selected) return
    setLocalEdits({})
    setLocalEditing(null)
    setMergeConflicts(null)
    await run(async () => {
      setMaterialView(await api.groupMaterial(selected.id, id))
    })
  }

  function saveLocalEdit() {
    if (!localEditing) return
    setLocalEdits((prev) => ({ ...prev, [localEditing.id]: localText }))
    setLocalEditing(null)
    setLocalText('')
  }

  function localSentences(): Sentence[] {
    if (!materialView) return []
    return materialView.material.sentences.map((s) =>
      localEdits[s.id] !== undefined ? { ...s, text: localEdits[s.id] } : s,
    )
  }

  async function onCreate() {
    await run(async () => {
      await api.createGroup(newName.trim(), newMode)
      setNewName('')
      await loadGroups()
    })
  }

  async function onJoin() {
    await run(async () => {
      const g = await api.joinGroup(joinCode.trim(), joinRole)
      setJoinCode('')
      await loadGroups()
      await loadGroup(g.id)
      setTab('material')
    })
  }

  async function onAddMaterial() {
    if (!selected || !addProject || !addRecording) return
    await run(async () => {
      await api.addGroupMaterial(selected.id, addProject, addRecording)
      setAddProject('')
      setAddRecording('')
      setRecordings([])
      await loadGroup(selected.id)
    })
  }

  async function onProjectChange(pid: string) {
    setAddProject(pid)
    setAddRecording('')
    setRecordings([])
    if (!pid) return
    try {
      setRecordings(await api.listRecordings(pid))
    } catch (e) {
      setError(String(e))
    }
  }

  async function onSubmitProposal() {
    if (!selected || !materialView || !editSentence) return
    await run(async () => {
      await api.createProposal(selected.id, materialView.material.id, editSentence.id, editText)
      setEditSentence(null)
      setEditText('')
      setNotice('提案已提交，等待合并')
      await loadGroup(selected.id)
    })
  }

  async function onDecideProposal(id: string, accept: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decideProposal(selected.id, id, accept)
      await loadGroup(selected.id)
      if (materialView) {
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      }
    })
  }

  async function onPlayback(mode: 'burn' | 'permanent' | 'timed') {
    if (!selected || !materialView) return
    await run(async () => {
      await api.requestPlayback(selected.id, materialView.material.id, mode, 7)
      setNotice('播放申请已提交，等待群主/管理员批准')
      await loadGroup(selected.id)
      setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
    })
  }

  async function onDecideApproval(id: string, approve: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decidePlayback(selected.id, id, approve)
      await loadGroup(selected.id)
      if (materialView) {
        setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
      }
    })
  }

  async function onConsume(approvalId: string) {
    if (!selected) return
    try {
      await api.consumePlayback(selected.id, approvalId)
    } catch {
      // 播放已经结束，上报失败不打扰用户
    }
  }

  async function onRoleChange(deviceCode: string, role: string) {
    if (!selected) return
    await run(async () => {
      const res = await api.updateMember(selected.id, deviceCode, role)
      if (res?.pending) setNotice('已提交群主审批：管理员互任需群主通过')
      await loadGroup(selected.id)
    })
  }

  async function onRemoveMember(deviceCode: string) {
    if (!selected) return
    await run(async () => {
      await api.removeMember(selected.id, deviceCode)
      await loadGroup(selected.id)
    })
  }

  async function onDecideRequest(id: string, approve: boolean) {
    if (!selected) return
    await run(async () => {
      await api.decideMemberRequest(selected.id, id, approve)
      await loadGroup(selected.id)
    })
  }

  async function onSaveRole(role: string, name: string, caps: string[]) {
    if (!selected) return
    await run(async () => {
      await api.updateRole(selected.id, role, caps, name)
      setNotice('权限已保存')
      await loadGroup(selected.id)
    })
  }

  const watermark = useMemo(() => {
    const label = `${identity.nick || '本机'} · ${fmtTime(new Date().toISOString())} · 审查可见`
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="190"><text x="18" y="110" font-size="13" font-family="sans-serif" fill="rgba(0,0,0,0.07)" transform="rotate(-24 150 95)">${escapeXml(label)}</text></svg>`
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
  }, [identity.nick])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(28, 32, 38, .38)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 20,
        boxSizing: 'border-box',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 12,
          width: 'min(980px, 100%)',
          maxHeight: '88vh',
          overflow: 'auto',
          boxShadow: '0 18px 60px rgba(0,0,0,.22)',
          padding: 18,
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>局域网协作</h2>
          <span style={{ fontSize: 11, color: '#8a8f98' }}>
            本机 {identity.nick || '—'} · {identity.device_code}
          </span>
          <button onClick={onClose} style={{ marginLeft: 'auto', fontSize: 12, padding: '4px 10px' }}>
            关闭
          </button>
        </div>

        {error && <div style={{ color: '#b00020', fontSize: 12, marginBottom: 8 }}>{error}</div>}
        {notice && <div style={{ color: '#1e7e34', fontSize: 12, marginBottom: 8 }}>{notice}</div>}

        {!selected ? (
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <section style={{ flex: '1 1 320px', minWidth: 280 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>我的群组</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>还没有群组，先建一个或输入配对码加入。</div>}
                {groups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => void selectGroup(g.id)}
                    style={{
                      textAlign: 'left',
                      border: '1px solid #e2e6ec',
                      borderRadius: 8,
                      background: '#fbfcfe',
                      padding: '8px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</span>
                      <span style={{ fontSize: 11, color: '#8a8f98' }}>
                        {g.mode === 'replica' ? '有副本' : '无副本'} · {g.my_role_name}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginTop: 3 }}>
                      配对码 {g.code} · {g.member_count} 人 · {g.material_count} 份材料
                      {g.pending_proposals > 0 ? ` · ${g.pending_proposals} 条待合并` : ''}
                      {g.pending_playbacks > 0 ? ` · ${g.pending_playbacks} 条播放待批` : ''}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section style={{ flex: '1 1 240px', minWidth: 220 }}>
              <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>新建群组</h3>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="群组名称"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
              />
              <select
                value={newMode}
                onChange={(e) => setNewMode(e.target.value as 'authoritative' | 'replica')}
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
              >
                <option value="authoritative">无副本（群主权威，只读播放）</option>
                <option value="replica">有副本（节点提交与三方合并）</option>
              </select>
              <button disabled={busy || !newName.trim()} onClick={() => void onCreate()} style={{ fontSize: 12, padding: '4px 12px' }}>
                创建
              </button>

              <h3 style={{ fontSize: 13, margin: '16px 0 8px' }}>加入群组</h3>
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位配对码"
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
              />
              <select
                value={joinRole}
                onChange={(e) => setJoinRole(e.target.value as 'reader' | 'reviewer')}
                style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6 }}
              >
                <option value="reader">只读</option>
                <option value="reviewer">审查者（仅看版本 2 之后）</option>
              </select>
              <button disabled={busy || joinCode.length !== 6} onClick={() => void onJoin()} style={{ fontSize: 12, padding: '4px 12px' }}>
                加入
              </button>
            </section>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <button onClick={() => { setSelected(null); setMaterialView(null) }} style={{ fontSize: 12, padding: '3px 10px' }}>
                ← 群组
              </button>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{selected.name}</span>
              <span style={{ fontSize: 11, color: '#8a8f98' }}>
                {selected.mode === 'replica' ? '有副本' : '无副本'} · 我是 {selected.my_role ? roles[selected.my_role]?.name || selected.my_role : ''}
              </span>
              <span
                style={{ fontSize: 12, color: '#245c9c', background: '#eef5ff', padding: '2px 8px', borderRadius: 4, cursor: 'pointer' }}
                onClick={() => void navigator.clipboard?.writeText(selected.code)}
                title="点击复制配对码"
              >
                配对码 {selected.code}
              </span>
              {requests.filter((r) => r.status === 'pending').length > 0 && has('roles') && (
                <span style={{ fontSize: 11, color: '#8a5a00' }}>
                  {requests.filter((r) => r.status === 'pending').length} 条管理员任免待你决定
                </span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #eee', marginBottom: 12 }}>
              {TABS.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => { setTab(key); setMaterialView(null) }}
                  style={{
                    fontSize: 12,
                    padding: '5px 12px',
                    border: 'none',
                    borderBottom: tab === key ? '2px solid #245c9c' : '2px solid transparent',
                    background: 'transparent',
                    color: tab === key ? '#245c9c' : '#666',
                    cursor: 'pointer',
                  }}
                >
                  {label}
                  {key === 'proposals' && proposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length > 0
                    ? ` (${proposals.filter((p) => p.status === 'pending' || p.status === 'conflict').length})`
                    : ''}
                  {key === 'approvals' && approvals.filter((a) => a.status === 'pending').length > 0
                    ? ` (${approvals.filter((a) => a.status === 'pending').length})`
                    : ''}
                </button>
              ))}
            </div>

            {/* ---- 材料 ---- */}
            {tab === 'material' && !materialView && (
              <div>
                {has('material') && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
                    <select value={addProject} onChange={(e) => void onProjectChange(e.target.value)} style={{ fontSize: 12 }}>
                      <option value="">选择项目</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                    <select value={addRecording} onChange={(e) => setAddRecording(e.target.value)} style={{ fontSize: 12 }}>
                      <option value="">选择录音</option>
                      {recordings.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                    <button
                      disabled={busy || !addRecording}
                      onClick={() => void onAddMaterial()}
                      style={{ fontSize: 12, padding: '3px 10px' }}
                    >
                      灌入当前版本
                    </button>
                    <span style={{ fontSize: 11, color: '#8a8f98' }}>材料是快照；之后原录音再改不会自动同步。</span>
                  </div>
                )}
                {materials.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>这个群组还没有材料。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {materials.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => void openMaterial(m.id)}
                        style={{ textAlign: 'left', border: '1px solid #e2e6ec', borderRadius: 8, background: '#fbfcfe', padding: '8px 10px', cursor: 'pointer' }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{m.name}</div>
                        <div style={{ fontSize: 11, color: '#8a8f98', marginTop: 2 }}>
                          版本 {m.version} · 阶段 {m.stage} · {m.sentence_count} 句 · {m.added_by} 灌入于 {fmtTime(m.added_at)}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 材料详情 ---- */}
            {tab === 'material' && materialView && (
              <div
                onCopy={(e) => {
                  if (materialView.review_mode) e.preventDefault()
                }}
                style={{ position: 'relative', userSelect: materialView.review_mode ? 'none' : 'auto' }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <button onClick={() => setMaterialView(null)} style={{ fontSize: 12, padding: '3px 10px' }}>← 材料列表</button>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{materialView.material.name}</span>
                  <span style={{ fontSize: 11, color: '#8a8f98' }}>
                    版本 {materialView.material.version} · 阶段 {materialView.material.stage} · {materialView.material.sentences.length} 句
                  </span>
                  {materialView.review_mode && (
                    <span style={{ fontSize: 11, color: '#8a5a00', background: '#fff4e0', padding: '2px 8px', borderRadius: 4 }}>
                      审查模式 · 禁复制 / 禁下载
                    </span>
                  )}
                </div>

                {materialView.review_mode && (
                  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', backgroundImage: watermark, zIndex: 0 }} />
                )}

                <div style={{ position: 'relative', zIndex: 1 }}>
                  {materialView.review_mode && (
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 8 }}>
                      仅显示阶段 2 之后的版本；历史共 {materialView.material.history.length} 条。
                    </div>
                  )}

                  {materialView.can_play && materialView.approval ? (
                    <div style={{ marginBottom: 12, border: '1px solid #dce6f2', background: '#f8fbff', borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 11, color: '#245c9c', marginBottom: 6 }}>
                        播放已批准（{materialView.approval.mode === 'burn' ? '听完即毁' : materialView.approval.mode === 'permanent' ? '长期有效' : `限时至 ${fmtTime(materialView.approval.expires_at || '')}`}）
                      </div>
                      <audio
                        controls
                        src={api.groupAudioUrl(selected.id, materialView.material.id, materialView.approval.id)}
                        onEnded={() => void onConsume(materialView.approval!.id)}
                        style={{ width: '100%', height: 36 }}
                      />
                    </div>
                  ) : (
                    <div style={{ marginBottom: 12, border: '1px dashed #e2e6ec', borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 6 }}>
                        {materialView.approval?.status === 'pending'
                          ? '播放申请待批准。批准后此处会出现播放器。'
                          : '只读材料不提供音频直链；申请获批后才能播放。'}
                      </div>
                      {has('view') && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <select value={playMode} onChange={(e) => setPlayMode(e.target.value as 'burn' | 'permanent' | 'timed')} style={{ fontSize: 11 }}>
                            <option value="burn">听完即毁（一次）</option>
                            <option value="permanent">长期有效</option>
                            <option value="timed">限时 7 天</option>
                          </select>
                          <button disabled={busy || !materialView.material.can_play} onClick={() => void onPlayback(playMode)} style={{ fontSize: 11, padding: '2px 10px' }}>
                            申请播放
                          </button>
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ border: '1px solid #eee', borderRadius: 8 }}>
                    {materialView.material.sentences.map((s) => {
                      const draft = localEdits[s.id]
                      return (
                      <div key={s.id} style={{ padding: '6px 10px', borderBottom: '1px solid #f3f4f6', display: 'flex', gap: 10 }}>
                        <span style={{ fontSize: 11, color: '#b0b6c0', width: 28, flexShrink: 0, paddingTop: 2 }}>{s.index + 1}</span>
                        <div style={{ flex: 1 }}>
                          {s.speaker && <span style={{ fontSize: 11, color: '#245c9c', marginRight: 6 }}>{s.speaker}</span>}
                          <span style={{ fontSize: 13, lineHeight: 1.7, color: draft !== undefined ? '#8a5a00' : undefined }}>{draft ?? s.text}</span>
                          {draft !== undefined && (
                            <span style={{ marginLeft: 6, fontSize: 10, color: '#8a5a00', background: '#fff4e0', padding: '1px 5px', borderRadius: 4 }}>本地草稿</span>
                          )}
                          {!materialView.review_mode && has('submit') && (
                            <button
                              onClick={() => { setEditSentence(s); setEditText(s.text); setLocalEditing(null); setError('') }}
                              style={{ marginLeft: 8, fontSize: 10, padding: '1px 6px', color: '#8a8f98' }}
                            >
                              建议修改
                            </button>
                          )}
                          {!materialView.review_mode && selected.mode === 'replica' && has('edit') && (
                            <button
                              onClick={() => { setLocalEditing(s); setLocalText(draft ?? s.text); setEditSentence(null); setError('') }}
                              style={{ marginLeft: 4, fontSize: 10, padding: '1px 6px', color: '#8a5a00' }}
                            >
                              本地改
                            </button>
                          )}
                          {editSentence?.id === s.id && (
                            <div style={{ marginTop: 6 }}>
                              <textarea
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={3}
                                style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                              />
                              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                <button disabled={busy || editText.trim() === s.text} onClick={() => void onSubmitProposal()} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  提交提案
                                </button>
                                <button onClick={() => { setEditSentence(null); setEditText('') }} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  取消
                                </button>
                              </div>
                            </div>
                          )}
                          {localEditing?.id === s.id && (
                            <div style={{ marginTop: 6 }}>
                              <textarea
                                value={localText}
                                onChange={(e) => setLocalText(e.target.value)}
                                rows={3}
                                style={{ width: '100%', boxSizing: 'border-box', fontSize: 12 }}
                              />
                              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                                <button disabled={localText.trim() === s.text} onClick={saveLocalEdit} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  存为本地草稿
                                </button>
                                {draft !== undefined && (
                                  <button
                                    onClick={() => {
                                      setLocalEdits((prev) => {
                                        const next = { ...prev }
                                        delete next[s.id]
                                        return next
                                      })
                                      setLocalEditing(null)
                                      setLocalText('')
                                    }}
                                    style={{ fontSize: 11, padding: '2px 10px' }}
                                  >
                                    恢复原文
                                  </button>
                                )}
                                <button onClick={() => { setLocalEditing(null); setLocalText('') }} style={{ fontSize: 11, padding: '2px 10px' }}>
                                  取消
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      )
                    })}
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>版本历史</div>
                    {materialView.material.history.map((h, i) => (
                      <div key={i} style={{ fontSize: 11, color: '#6b7280', lineHeight: 1.7 }}>
                        {h.version} · {h.message} · {h.by} · {fmtTime(h.at)}
                      </div>
                    ))}
                  </div>

                  {selected.mode === 'replica' && has('merge') && !materialView.review_mode && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>
                        有副本模式：先在本地改，再提交节点合并（三方合并，冲突人工判断）。
                      </div>
                      <button
                        disabled={busy || Object.keys(localEdits).length === 0}
                        onClick={() =>
                          void run(async () => {
                            setMergeConflicts(null)
                            const res = await api.mergeSnapshot(
                              selected.id,
                              materialView.material.id,
                              materialView.material.version,
                              localSentences(),
                            )
                            if (res.status === 'conflict') {
                              setMergeConflicts(res.conflicts || [])
                              setError(`存在 ${res.conflicts?.length || 0} 处冲突，需人工判断`)
                            } else {
                              setNotice(`节点合并完成，新版本 ${res.version}`)
                              setLocalEdits({})
                              setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
                              await loadGroup(selected.id)
                            }
                          })
                        }
                        style={{ fontSize: 11, padding: '2px 10px' }}
                      >
                        提交节点合并（{Object.keys(localEdits).length} 句本地修改）
                      </button>
                      {mergeConflicts && (
                        <div style={{ marginTop: 8, border: '1px solid #f0d6a8', background: '#fffaf0', borderRadius: 8, padding: 8 }}>
                          <div style={{ fontSize: 11, color: '#8a5a00', marginBottom: 6 }}>冲突句（同一句在群组与本地都被改过）</div>
                          {mergeConflicts.map((c) => (
                            <div key={c.sentence_id} style={{ fontSize: 11, lineHeight: 1.7, marginBottom: 6 }}>
                              <div>第 {c.index + 1} 句</div>
                              <div style={{ color: '#8a8f98' }}>共同基数：{c.base}</div>
                              <div style={{ color: '#245c9c' }}>群组当前：{c.current}</div>
                              <div style={{ color: '#8a5a00' }}>本地版本：{c.incoming}</div>
                            </div>
                          ))}
                          <button
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const res = await api.mergeSnapshot(
                                  selected.id,
                                  materialView.material.id,
                                  materialView.material.version,
                                  localSentences(),
                                  true,
                                )
                                if (res.status === 'conflict') {
                                  setError('仍有冲突未解决')
                                } else {
                                  setNotice(`已采用本地版本强制合并，新版本 ${res.version}`)
                                  setMergeConflicts(null)
                                  setLocalEdits({})
                                  setMaterialView(await api.groupMaterial(selected.id, materialView.material.id))
                                  await loadGroup(selected.id)
                                }
                              })
                            }
                            style={{ fontSize: 11, padding: '2px 10px' }}
                          >
                            采用本地版本强制合并
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ---- 成员与权限 ---- */}
            {tab === 'members' && (
              <div>
                <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 8 }}>
                  加入凭配对码，默认只读；审查者仅能看到阶段 2 之后的脱敏正文。管理员互任需群主通过。
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                  {members.map((m) => {
                    const editable =
                      has('members') &&
                      m.role !== 'owner' &&
                      (myRole === 'owner' || (m.role !== 'admin' && myRole === 'admin')) &&
                      m.device_code !== identity.device_code
                    return (
                      <div key={m.device_code} style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #eee', borderRadius: 6, padding: '6px 8px' }}>
                        <span style={{ fontSize: 12, minWidth: 90 }}>{m.nick || '未命名'}</span>
                        <span style={{ fontSize: 11, color: '#8a8f98', flex: 1 }}>{m.device_code}</span>
                        {editable ? (
                          <select
                            value={m.role}
                            onChange={(e) => void onRoleChange(m.device_code, e.target.value)}
                            style={{ fontSize: 11 }}
                          >
                            {ROLE_ORDER.filter((r) => r !== 'owner').map((r) => (
                              <option key={r} value={r}>{roles[r]?.name || r}</option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ fontSize: 11, color: '#245c9c' }}>{roles[m.role]?.name || m.role}</span>
                        )}
                        {has('members') && m.role !== 'owner' && m.device_code !== identity.device_code && (
                          <button onClick={() => void onRemoveMember(m.device_code)} style={{ fontSize: 10, padding: '1px 6px', color: '#b00020' }}>
                            移除
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>

                {has('roles') && requests.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>管理员任免</div>
                    {requests.map((r) => (
                      <div key={r.id} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        <span>{r.by_nick || '管理员'} 提议 {r.nick || r.device_code} 为管理员</span>
                        {r.status === 'pending' ? (
                          <>
                            <button onClick={() => void onDecideRequest(r.id, true)} style={{ fontSize: 10, padding: '1px 8px' }}>通过</button>
                            <button onClick={() => void onDecideRequest(r.id, false)} style={{ fontSize: 10, padding: '1px 8px' }}>拒绝</button>
                          </>
                        ) : (
                          <span>{r.status === 'approved' ? '已通过' : '已拒绝'}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {has('roles') && (
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>四级权限（可自定义）</div>
                    {ROLE_ORDER.map((role) => (
                      <RoleEditor
                        key={role}
                        roleKey={role}
                        role={roles[role]}
                        busy={busy}
                        onSave={(name, caps) => void onSaveRole(role, name, caps)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 提案 ---- */}
            {tab === 'proposals' && (
              <div>
                {proposals.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>还没有修改提案。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {proposals.map((p) => (
                      <div key={p.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 11, color: '#8a8f98', marginBottom: 4 }}>
                          第 {p.index + 1} 句 · {p.by || p.by_device} · {fmtTime(p.created_at)} ·{' '}
                          <span style={{ color: p.status === 'conflict' ? '#b00020' : p.status === 'accepted' ? '#1e7e34' : p.status === 'rejected' ? '#999' : '#8a5a00' }}>
                            {p.status === 'pending' ? '待合并' : p.status === 'accepted' ? '已合并' : p.status === 'rejected' ? '已拒绝' : '有冲突'}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: '#b00020', textDecoration: 'line-through', lineHeight: 1.6 }}>{p.before}</div>
                        <div style={{ fontSize: 12, color: '#1e7e34', lineHeight: 1.6 }}>{p.after}</div>
                        {p.conflict_text && (
                          <div style={{ fontSize: 11, color: '#8a5a00', marginTop: 3 }}>当前正文已变为：{p.conflict_text}</div>
                        )}
                        {(p.status === 'pending' || p.status === 'conflict') && has('merge') && (
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button onClick={() => void onDecideProposal(p.id, true)} style={{ fontSize: 11, padding: '2px 10px' }}>
                              合并
                            </button>
                            <button onClick={() => void onDecideProposal(p.id, false)} style={{ fontSize: 11, padding: '2px 10px' }}>
                              拒绝
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ---- 播放审批 ---- */}
            {tab === 'approvals' && (
              <div>
                <div style={{ fontSize: 12, color: '#8a8f98', marginBottom: 8 }}>
                  只读端不保存副本、看不到音频直链；申请获批后才能播放整段录音。
                </div>
                {approvals.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>还没有播放申请。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {approvals.map((a) => {
                      const material = materials.find((m) => m.id === a.material_id)
                      return (
                        <div key={a.id} style={{ border: '1px solid #eee', borderRadius: 8, padding: 8, fontSize: 11 }}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12 }}>{a.nick || a.device_code}</span>
                            <span style={{ color: '#8a8f98' }}>{material?.name || a.material_id}</span>
                            <span style={{ color: '#8a8f98' }}>
                              {a.mode === 'burn' ? '听完即毁' : a.mode === 'permanent' ? '长期' : `限时 ${a.days} 天`}
                            </span>
                            <span style={{ color: a.status === 'approved' ? '#1e7e34' : a.status === 'pending' ? '#8a5a00' : '#999' }}>
                              {a.status === 'approved' ? '已批准' : a.status === 'pending' ? '待批' : a.status === 'used' ? '已用完' : '已拒绝'}
                            </span>
                            <span style={{ marginLeft: 'auto', color: '#8a8f98' }}>{fmtTime(a.requested_at)}</span>
                            {a.status === 'pending' && has('approve') && (
                              <>
                                <button onClick={() => void onDecideApproval(a.id, true)} style={{ fontSize: 10, padding: '1px 8px' }}>批准</button>
                                <button onClick={() => void onDecideApproval(a.id, false)} style={{ fontSize: 10, padding: '1px 8px' }}>拒绝</button>
                              </>
                            )}
                          </div>
                          {a.expires_at && <div style={{ color: '#8a8f98', marginTop: 3 }}>有效期至 {fmtTime(a.expires_at)}</div>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ---- 访问留痕 ---- */}
            {tab === 'access' && (
              <div>
                {!has('members') ? (
                  <div style={{ fontSize: 12, color: '#999' }}>访问留痕仅群主/管理员可见。</div>
                ) : access.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#999' }}>暂无记录。</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {access
                      .slice()
                      .reverse()
                      .slice(0, 200)
                      .map((a) => (
                        <div key={a.id} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 8 }}>
                          <span style={{ width: 92, flexShrink: 0, color: '#9aa1ab' }}>{fmtTime(a.at)}</span>
                          <span style={{ width: 70, flexShrink: 0 }}>{a.nick || a.device_code}</span>
                          <span style={{ width: 110, flexShrink: 0, color: '#245c9c' }}>{a.action}</span>
                          <span style={{ flex: 1 }}>{a.detail}</span>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function RoleEditor({
  roleKey,
  role,
  busy,
  onSave,
}: {
  roleKey: string
  role?: CollabRole
  busy: boolean
  onSave: (name: string, caps: string[]) => void
}) {
  const [name, setName] = useState(role?.name || '')
  const [caps, setCaps] = useState<string[]>(role?.caps || [])

  useEffect(() => {
    setName(role?.name || '')
    setCaps(role?.caps || [])
  }, [role?.name, role?.caps])

  if (!role) return null
  const toggle = (cap: string) => {
    if (roleKey === 'owner' && (cap === 'roles' || cap === 'manage')) return
    setCaps((list) => (list.includes(cap) ? list.filter((c) => c !== cap) : [...list, cap]))
  }

  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 8, marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ fontSize: 12, width: 110 }}
          placeholder="角色名"
        />
        <span style={{ fontSize: 10, color: '#9aa1ab' }}>{roleKey}</span>
        <button disabled={busy} onClick={() => onSave(name, caps)} style={{ fontSize: 10, padding: '2px 8px', marginLeft: 'auto' }}>
          保存
        </button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
        {Object.keys(CAP_LABELS).map((cap) => (
          <label key={cap} style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 3, alignItems: 'center' }}>
            <input type="checkbox" checked={caps.includes(cap)} onChange={() => toggle(cap)} />
            {CAP_LABELS[cap]}
          </label>
        ))}
      </div>
    </div>
  )
}
