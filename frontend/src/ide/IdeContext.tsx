import { createContext, useContext, useState, type ReactNode } from 'react'

/**
 * IDE 工作台的共享上下文：面板之间不互相调用，只通过这里的状态联动。
 * 当前条目 / 选中句 / 选中码 —— 任一面板改了，其他面板跟着变（对应 AcademicFlow 的 pickEditor 思路）。
 */
export type IdeSelection = {
  documentId: string | null   // 当前条目（case）对应的文档 id
  sentenceId: string | null   // 当前句
  codeId: string | null       // 当前码
  highlight?: string          // 自由联动载荷（如检索词、证据片段）
}

type IdeContextValue = {
  selection: IdeSelection
  setSelection: (patch: Partial<IdeSelection>) => void
}

const IdeContext = createContext<IdeContextValue | null>(null)

export function IdeProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState<IdeSelection>({
    documentId: null, sentenceId: null, codeId: null,
  })
  function setSelection(patch: Partial<IdeSelection>) {
    setSelectionState((prev) => ({ ...prev, ...patch }))
  }
  return <IdeContext.Provider value={{ selection, setSelection }}>{children}</IdeContext.Provider>
}

export function useIde(): IdeContextValue {
  const ctx = useContext(IdeContext)
  if (!ctx) throw new Error('useIde 必须在 IdeProvider 内使用')
  return ctx
}
