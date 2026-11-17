import type { Sentence } from '../types'
import IdeWorkspace, { type PanelDef } from '../ide/IdeWorkspace'
import { useGroupAnalysisData } from '../ide/useGroupAnalysisData'
import {
  MatrixQueryPanel, FrameworkMatrixPanel, SearchPanel, EvidencePanel, TextPanel, CasePropsPanel,
  CodingListPanel, AiPanel, ArtifactsPanel,
} from '../ide/IdePanels'
import StatsPanel from '../ide/StatsPanel'

/**
 * 协作分析页 = 同一套 IDE 工作台（与个人版共用面板）。
 * 数据源从本机 store 换成后端 GroupCoding；左栏「群组/材料导航」由外层 CollabPanel 提供。
 */
export default function GroupAnalysisPanel({
  groupId, materialId, sentences, materialVersion,   pendingMerges, deviceCode, onJump,
}: {
  groupId: string
  materialId: string
  sentences: Sentence[]
  materialVersion: string
  pendingMerges: number
  deviceCode: string
  onJump?: (sentenceId: string) => void
}) {
  const jump = (sentenceId: string) => onJump?.(sentenceId)
  const data = useGroupAnalysisData(groupId, materialId, sentences, deviceCode)

  const panels: PanelDef[] = [
    { key: 'matrix', label: '矩阵查询', render: () => <MatrixQueryPanel data={data} /> },
    { key: 'framework', label: '框架矩阵', render: () => <FrameworkMatrixPanel data={data} onJump={(_, sid) => jump(sid)} /> },
    { key: 'search', label: '检索', render: () => <SearchPanel data={data} onJump={(_, sid) => jump(sid)} /> },
    { key: 'evidence', label: '证据', render: () => <EvidencePanel data={data} onJump={(_, sid) => jump(sid)} /> },
    { key: 'stats', label: '编码统计', render: () => <StatsPanel groupId={groupId} materialId={materialId} sentences={sentences} mode={data.mode} /> },
    { key: 'text', label: '文本展示', render: () => <TextPanel data={data} /> },
    { key: 'coding', label: '辅助编码', render: () => <CodingListPanel data={data} /> },
    { key: 'props', label: '条目属性', render: () => <CasePropsPanel data={data} edit={{
      attributeSets: data.attributeSets, applySet: data.applySet, upsertSet: data.upsertSet,
      deleteSet: data.deleteSet, caseAttributes: data.caseAttributes, updateCaseAttrs: data.updateCaseAttrs,
    }} /> },
    { key: 'ai', label: 'AI 助手', render: () => <AiPanel /> },
    { key: 'artifacts', label: '产物', render: () => <ArtifactsPanel /> },
  ]

  return (
    <div style={{ gridColumn: 'span 5', minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 8px', flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>群组分析</span>
        <button className={`coding-ghost-btn${data.mode === 'personal' ? ' active' : ''}`} onClick={() => data.setMode('personal')}>个人码</button>
        <button className={`coding-ghost-btn${data.mode === 'shared' ? ' active' : ''}`} onClick={() => data.setMode('shared')}>共享码</button>
        <span style={{ fontSize: 11, color: '#8a8f98' }}>材料 v{materialVersion}{pendingMerges > 0 ? ` · ${pendingMerges} 条待合并` : ''}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <IdeWorkspace panels={panels} />
      </div>
    </div>
  )
}
