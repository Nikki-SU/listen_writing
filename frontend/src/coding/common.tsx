import type { CSSProperties, ReactNode } from 'react'
import type { CodingCode } from '../types'

export function fmtMs(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return `rgba(91, 75, 204, ${alpha})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 多码重叠时混合底色，避免只显示最上面一条、看不出重叠。 */
export function blendColors(colors: string[]): string {
  if (colors.length === 0) return 'transparent'
  const rgb = colors.reduce(
    (acc, hex) => {
      const value = hex.replace('#', '')
      const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
      const n = Number.parseInt(full, 16)
      if (Number.isNaN(n)) return acc
      return [acc[0] + ((n >> 16) & 255), acc[1] + ((n >> 8) & 255), acc[2] + (n & 255)]
    },
    [0, 0, 0],
  )
  const r = Math.round(rgb[0] / colors.length)
  const g = Math.round(rgb[1] / colors.length)
  const b = Math.round(rgb[2] / colors.length)
  return `rgb(${r}, ${g}, ${b})`
}

/** 编码密度：绿（低）→ 黄（中）→ 红（高），符合“红=信息量大”的视觉语言。 */
export function densityColor(ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio))
  const low = [46, 160, 67]
  const mid = [234, 179, 8]
  const high = [220, 38, 38]
  const from = t < 0.5 ? low : mid
  const to = t < 0.5 ? mid : high
  const k = t < 0.5 ? t * 2 : (t - 0.5) * 2
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * k))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

export function CodeChip({
  code,
  count,
  active,
  onClick,
  onRemove,
  title,
}: {
  code: CodingCode
  count?: number
  active?: boolean
  onClick?: () => void
  onRemove?: () => void
  title?: string
}) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '2px 7px',
    fontSize: 12,
    lineHeight: '18px',
    borderRadius: 6,
    border: `1px solid ${active ? code.color : '#e3e6ea'}`,
    background: active ? hexToRgba(code.color, 0.12) : '#fff',
    color: active ? code.color : '#3b4250',
    cursor: onClick ? 'pointer' : 'default',
    whiteSpace: 'nowrap',
  }
  return (
    <span style={style} onClick={onClick} title={title || code.definition || code.name}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: code.color, flexShrink: 0 }} />
      {code.name}
      {count != null && <span style={{ color: '#8a8f98', fontSize: 11 }}>{count}</span>}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          title="移除这条编码"
          style={{ border: 0, background: 'transparent', padding: 0, color: '#8a8f98', cursor: 'pointer', lineHeight: 1 }}
        >
          ×
        </button>
      )}
    </span>
  )
}

export function SideTitle({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="coding-title">
      <span>{children}</span>
      {extra && <span className="coding-title-extra">{extra}</span>}
    </div>
  )
}
