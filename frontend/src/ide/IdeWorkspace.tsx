import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IdeProvider } from './IdeContext'

/**
 * IDE 工作台的中右两栏（左栏「项目/条目导航树」由外层 workspace-grid 提供，固定不动）。
 * - 两栏都是可插拔面板槽，同一个功能可放任意一侧；
 * - 拖中缝改比例，松手吸附到 3:1 / 2:2 / 1:3（对应三栏 1:3:1 / 1:2:2 / 1:1:3），档位存本地；
 * - 面板之间只通过 IdeContext 联动。
 */
export type PanelDef = { key: string; label: string; render: () => ReactNode }

const SNAPS = [1, 2, 3]
const STORE_KEY = 'lw:ide-right-fr'

function loadRightFr(): number {
  try {
    const v = Number(localStorage.getItem(STORE_KEY))
    return SNAPS.includes(v) ? v : 1
  } catch { return 1 }
}

export default function IdeWorkspace({ panels }: { panels: PanelDef[] }) {
  const [rightFr, setRightFr] = useState(loadRightFr)
  const [midKey, setMidKey] = useState(panels[0]?.key ?? '')
  const [rightKey, setRightKey] = useState(panels.find((p) => p.key !== panels[0]?.key)?.key ?? '')
  const [menu, setMenu] = useState<'mid' | 'right' | null>(null)
  const [dragging, setDragging] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const startX = useRef(0)
  const startFr = useRef(1)

  useEffect(() => {
    try { localStorage.setItem(STORE_KEY, String(rightFr)) } catch { /* 忽略存储失败 */ }
  }, [rightFr])

  useEffect(() => {
    if (!dragging) return
    const move = (e: MouseEvent) => {
      const el = rootRef.current
      if (!el) return
      const unit = el.clientWidth / 4
      setRightFr(Math.max(1, Math.min(3, startFr.current - (e.clientX - startX.current) / unit)))
    }
    const up = () => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setRightFr((cur) => SNAPS.reduce((best, v) => (Math.abs(v - cur) < Math.abs(best - cur) ? v : best)))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  }, [dragging])

  function Slot({ which, activeKey }: { which: 'mid' | 'right'; activeKey: string }) {
    const active = panels.find((p) => p.key === activeKey) ?? panels[0]
    return (
      <div style={{ position: 'relative', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid #e8ebf0', borderRadius: 12, background: '#fff', padding: 14, boxSizing: 'border-box', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 8, borderBottom: '1px solid #eef0f2', flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{active?.label ?? '空'}</span>
          <button onClick={() => setMenu((m) => (m === which ? null : which))} title="切换功能"
            style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #e3e6ea', background: '#fff', color: '#5b6472', cursor: 'pointer' }}>切换 ▾</button>
          {menu === which && (
            <div style={{ position: 'absolute', top: 34, right: 14, zIndex: 10, minWidth: 132, background: '#fff', border: '1px solid #e3e6ea', borderRadius: 8, padding: 4, boxShadow: '0 4px 16px rgba(0,0,0,.08)' }}>
              {panels.map((p) => (
                <button key={p.key}
                  onClick={() => { (which === 'mid' ? setMidKey : setRightKey)(p.key); setMenu(null) }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', borderRadius: 5, padding: '5px 8px', fontSize: 12, background: p.key === activeKey ? '#eef4ff' : 'transparent', color: p.key === activeKey ? '#245c9c' : '#3b4250', cursor: 'pointer' }}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', paddingTop: 10 }}>{active?.render()}</div>
      </div>
    )
  }

  return (
    <IdeProvider>
      <div ref={rootRef} style={{ display: 'grid', gridTemplateColumns: `minmax(0,${4 - rightFr}fr) minmax(0,${rightFr}fr)`, gap: 12, minWidth: 0, minHeight: 0, height: '100%' }}>
        <Slot which="mid" activeKey={midKey} />
        <div style={{ position: 'relative', minWidth: 0, minHeight: 0 }}>
          <Slot which="right" activeKey={rightKey} />
          <div role="separator"
            onMouseDown={(e) => { e.preventDefault(); setDragging(true); startX.current = e.clientX; startFr.current = rightFr; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none' }}
            style={{ position: 'absolute', left: -7, top: 0, bottom: 0, width: 14, cursor: 'col-resize', zIndex: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ width: 3, height: 28, borderRadius: 2, background: dragging ? '#8ab4f8' : '#c9d2dd' }} />
          </div>
        </div>
      </div>
    </IdeProvider>
  )
}
