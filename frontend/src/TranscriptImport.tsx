import { useRef, useState } from 'react'

/** 导入腾讯会议逐字稿 Markdown：姓名(时:分:秒): 正文。支持直接选 .md 文件，也可粘贴。 */
export default function TranscriptImport({
  onImport, onClose, busy,
}: {
  onImport: (name: string, text: string) => void
  onClose: () => void
  busy: boolean
}) {
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function pickFile(file: File) {
    const content = await file.text()
    setText(content)
    if (!name) setName(file.name.replace(/\.(md|markdown|txt)$/i, ''))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(680px, 92vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: '#fff', borderRadius: 12, padding: 18, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>导入逐字稿</span>
          <button onClick={onClose} title="关闭" style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6 }}>关闭</button>
        </div>
        <div style={{ fontSize: 11, color: '#8a8f98', lineHeight: 1.7, marginBottom: 10 }}>
          每行格式：姓名(00:00:04): 内容。没有音轨也能编码、做矩阵；只是不能播放录音。
        </div>
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); e.target.value = '' }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <button onClick={() => fileRef.current?.click()} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6 }}>选择 .md 文件</button>
          <span style={{ fontSize: 11, color: '#8a8f98' }}>或直接粘贴到下方</span>
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="条目名（留空自动生成）"
          style={{ fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #d5dae2', marginBottom: 8 }} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus
          placeholder={'发言人A(00:00:04): 他说已经开始转写了。\n发言人B(00:00:07): 现在已经开始转写了……'}
          style={{ flex: 1, minHeight: 220, resize: 'vertical', fontSize: 12, lineHeight: 1.7, padding: 10, border: '1px solid #d5dae2', borderRadius: 8, boxSizing: 'border-box', fontFamily: 'monospace' }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button onClick={onClose} style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6 }}>取消</button>
          <button disabled={busy || !text.trim()} onClick={() => onImport(name.trim(), text)}
            style={{ fontSize: 12, padding: '5px 14px', borderRadius: 6, background: '#245c9c', color: '#fff', border: 'none' }}>
            {busy ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  )
}
