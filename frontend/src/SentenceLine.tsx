import type { MouseEvent, ReactNode } from 'react'
import type { Sentence } from './types'
import SpeakerTag from './SpeakerTag'

/**
 * 句子行内容：发言人标签 + 正文 + 尾部的排版骨架，只有这一份。
 * 个人转写、协作转写、协作编码都用它——同一句话在三处长得一样。
 * 差异只通过 props 注入：正文节点（脱敏/草稿/编码着色）、尾部按钮、正文上的 data 属性与事件。
 */
export default function SentenceLine({
  sentence,
  order,
  speakerOnClick,
  speakerTitle,
  textId,
  textAttrs,
  onTextMouseUp,
  textColor,
  children,
  tail,
  below,
}: {
  sentence: Sentence
  order: string[]
  speakerOnClick?: (e: MouseEvent<HTMLButtonElement>) => void
  speakerTitle?: string
  textId?: string
  textAttrs?: Record<string, string | undefined>
  onTextMouseUp?: (e: MouseEvent<HTMLSpanElement>) => void
  textColor?: string
  children: ReactNode
  /** 行内尾部（按钮、角标等），与正文同一行 */
  tail?: ReactNode
  /** 行下方的块级展开区（如编辑框），占整行 */
  below?: ReactNode
}) {
  return (
    <>
      <div className="transcript-line">
        <SpeakerTag speaker={sentence.speaker} order={order} onClick={speakerOnClick} title={speakerTitle} />
        <span
          id={textId}
          {...textAttrs}
          onMouseUp={onTextMouseUp}
          style={{ fontSize: 15, lineHeight: 1.6, flex: 1, whiteSpace: 'pre-wrap', color: textColor }}
        >
          {children}
        </span>
        {tail}
      </div>
      {below}
    </>
  )
}
