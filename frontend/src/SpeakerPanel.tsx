import { useState } from 'react'
import { speakerColor } from './speakerColors'
import { CloseIcon } from './icons'

/**
 * 发言人管理浮层：个人录音与协作材料共用同一份界面。
 * 差异只在操作落点：个人写本地录音 / 协作写本地分支（提交走 PR）；按音色识别由外部注入。
 */
export default function SpeakerPanel({
  speakers,
  order,
  onRename,
  onMerge,
  onCreate,
  onDetect,
  detecting,
  detectDisabled,
  onClose,
}: {
  speakers: string[]
  order: string[]
  onRename: (from: string, to: string) => void
  onMerge: (from: string, into: string) => void
  onCreate: (name: string) => void
  onDetect?: () => void
  detecting?: boolean
  detectDisabled?: boolean
  onClose: () => void
}) {
  const [edit, setEdit] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [newName, setNewName] = useState('')

  function saveRename(from: string) {
    const to = draft.trim()
    if (to) onRename(from, to)
    setEdit(null)
  }

  function create() {
    const name = newName.trim()
    if (!name) return
    onCreate(name)
    setNewName('')
    setNewOpen(false)
  }

  return (
    <div className="speaker-panel">
      <div className="speaker-panel-title">
        发言人管理
        <button className="icon-tool" onClick={onClose} title="关闭" aria-label="关闭"><CloseIcon size={12} /></button>
      </div>
      <div className="speaker-panel-body">
        {speakers.length === 0 && <div className="speaker-panel-empty">还没有发言人，可以新增或按音色自动识别。</div>}
        {speakers.map((sp) =>
          edit === sp ? (
            <div key={sp} className="speaker-edit-row">
              <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEdit(null)
                  if (e.key === 'Enter') saveRename(sp)
                }}
                style={{ fontSize: 12, width: 110, padding: '2px 5px' }} />
              <button className="text-tool" onClick={() => saveRename(sp)}>保存</button>
              <button className="text-tool" onClick={() => setEdit(null)}>取消</button>
              {speakers.length > 1 && (
                <select defaultValue="" onChange={(e) => {
                  const into = e.target.value
                  e.target.value = ''
                  if (into) onMerge(sp, into)
                }} style={{ fontSize: 11 }} title="把这个发言人的全部句子并入另一个">
                  <option value="">并入…</option>
                  {speakers.filter((x) => x !== sp).map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              )}
            </div>
          ) : (
            <button key={sp} className="speaker-chip" style={{
              background: speakerColor(sp, order).bg,
              color: speakerColor(sp, order).fg,
              borderColor: speakerColor(sp, order).border,
            }} onClick={() => { setEdit(sp); setDraft(sp) }} title="点击改名 / 并入">{sp}</button>
          ),
        )}
        <div className="speaker-panel-actions">
          {newOpen ? (
            <span className="speaker-edit-row">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setNewOpen(false); setNewName('') }
                  if (e.key === 'Enter') create()
                }} placeholder="如：受访者" style={{ fontSize: 12, width: 110, padding: '2px 5px' }} />
              <button className="text-tool" onClick={create}>添加</button>
              <button className="text-tool" onClick={() => { setNewOpen(false); setNewName('') }}>取消</button>
            </span>
          ) : (
            <button className="text-tool" onClick={() => setNewOpen(true)}>+ 新增</button>
          )}
          {onDetect && (
            <button className="text-tool" onClick={onDetect} disabled={detecting || detectDisabled}
              title="按音色重新分说话人；会覆盖当前标注">
              {detecting ? '识别中…' : speakers.length > 0 ? '重新识别' : '自动识别'}
            </button>
          )}
        </div>
        <div className="speaker-panel-hint">点正文里的发言人标签可换下一位（只改这一句）；Shift+点改整段。</div>
      </div>
    </div>
  )
}
