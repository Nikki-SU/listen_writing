import { createContext, useContext } from 'react'
import type { RecordingDetail } from '../types'
import { useCodingSession } from './useCodingSession'

export type CodingContextValue = ReturnType<typeof useCodingSession> | null

export const CodingContext = createContext<CodingContextValue>(null)

/** 录音区内部调用：不在编码模式时返回 null，演唱会区保持纯转写行为。 */
export function useOptionalCoding(): CodingContextValue {
  return useContext(CodingContext)
}

export { useCodingSession }
export type { RecordingDetail }
