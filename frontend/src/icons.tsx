/** 通用小图标：按钮只放图标，靠 title / aria-label 说明含义，不占正文空间。 */
export function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5 5L20 6.5" />
    </svg>
  )
}

export function CrossIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function EditIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  )
}

/** 通用图标按钮尺寸：只放图标时用它保持一致的点击区域。 */
export const ICON_BTN = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 24,
  padding: 0,
  background: '#fff',
  border: '1px solid #dde3ea',
  borderRadius: 4,
  color: '#5b6472',
  cursor: 'pointer',
  flexShrink: 0,
} as const

function Glyph({ d, size = 14, fill = 'none' }: { d: string; size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function TrashIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6" />
}

export function UploadIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 16V4M7 9l5-5 5 5M4 20h16" />
}

export function DownloadIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 4v12M7 11l5 5 5-5M4 20h16" />
}

export function MicIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3" />
}

export function GearIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5L9 6a7 7 0 0 0-1.7 1L5 6 3 9.5 5 11a7 7 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7 7 0 0 0 1.7 1l.5 3h5l.5-3a7 7 0 0 0 1.7-1l2.4 1 2-3.5-2-1.5a7 7 0 0 0 .1-1z" />
}

export function HistoryIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 8v5l3 2M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4" />
}

export function PlayIcon({ size = 13 }: { size?: number }) {
  return <Glyph size={size} d="M8 5l11 7-11 7z" fill="currentColor" />
}

export function StopIcon({ size = 13 }: { size?: number }) {
  return <Glyph size={size} d="M7 7h10v10H7z" fill="currentColor" />
}

export function CloseIcon({ size = 13 }: { size?: number }) {
  return <Glyph size={size} d="M6 6l12 12M18 6L6 18" />
}

export function PlusIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M12 5v14M5 12h14" />
}

export function RefreshIcon({ size = 14 }: { size?: number }) {
  return <Glyph size={size} d="M20 11a8 8 0 1 0-2.3 5.6M20 5v6h-6" />
}
