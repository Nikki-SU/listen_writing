/**
 * 发言人配色：同一条录音里，不同发言人必须一眼能分开。
 * 颜色按「出场顺序」分配（与花名册顺序一致），同一个人在所有句子/所有视图里同色。
 */
export type SpeakerColor = { bg: string; border: string; fg: string }

export const SPEAKER_PALETTE: SpeakerColor[] = [
  { bg: '#e8f0fe', border: '#c7dafc', fg: '#1a56c4' }, // 蓝
  { bg: '#fdeee3', border: '#f7d7bd', fg: '#b45309' }, // 橙
  { bg: '#f4e9ff', border: '#e2ccf7', fg: '#7e22ce' }, // 紫
  { bg: '#e6f6f4', border: '#c3e9e3', fg: '#0f766e' }, // 青
  { bg: '#fce7f0', border: '#f6cadb', fg: '#be185d' }, // 粉
  { bg: '#eaf7ee', border: '#c8e9d3', fg: '#15803d' }, // 绿
  { bg: '#f6efe6', border: '#e8d8c5', fg: '#8d5524' }, // 棕
  { bg: '#eff2f6', border: '#d6dde6', fg: '#475569' }, // 灰蓝
]

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 100000
  return h
}

/** `order` 传入当前录音的发言人顺序；不在里面的名字用稳定哈希兜底，刷新后不跳色。 */
export function speakerColor(name: string, order: string[]): SpeakerColor {
  const idx = order.indexOf(name)
  const slot = idx >= 0 ? idx : hash(name)
  return SPEAKER_PALETTE[slot % SPEAKER_PALETTE.length]
}
