import type { Recording, RecordingDetail } from '../types'
import IdeWorkspace, { type PanelDef } from '../ide/IdeWorkspace'
import { useAnalysisData } from '../ide/useAnalysisData'
import {
  MatrixQueryPanel, FrameworkMatrixPanel, SearchPanel, EvidencePanel, TextPanel, CasePropsPanel,
  CodingListPanel, AiPanel, ArtifactsPanel,
} from '../ide/IdePanels'

/**
 * 分析页 = IDE 工作台：左栏「项目/条目导航树」由外层 workspace-grid 提供；
 * 这里占剩下 4 列，中右两栏是可插拔面板，拖中缝吸附，面板通过 IdeContext 联动。
 */
export default function AnalysisPanel({
  projectId,
  recordings,
  detail,
  onJump,
}: {
  projectId: string
  recordings: Recording[]
  detail: RecordingDetail | null
  onJump?: (recordingId: string, sentenceId: string) => void
}) {
  const data = useAnalysisData(projectId, recordings, detail)

  function jump(recordingId: string, sentenceId: string) {
    onJump?.(recordingId, sentenceId)
  }

  const panels: PanelDef[] = [
    { key: 'matrix', label: '矩阵查询', render: () => <MatrixQueryPanel data={data} /> },
    { key: 'framework', label: '框架矩阵', render: () => <FrameworkMatrixPanel data={data} onJump={jump} /> },
    { key: 'search', label: '检索', render: () => <SearchPanel data={data} onJump={jump} /> },
    { key: 'evidence', label: '证据', render: () => <EvidencePanel data={data} onJump={jump} /> },
    { key: 'text', label: '文本展示', render: () => <TextPanel data={data} /> },
    { key: 'props', label: '条目属性', render: () => <CasePropsPanel data={data} edit={{
      attributeSets: data.attributeSets, applySet: data.applySet, upsertSet: data.upsertSet,
      deleteSet: data.deleteSet, caseAttributes: data.caseAttributes, updateCaseAttrs: data.updateCaseAttrs,
    }} /> },
    { key: 'coding', label: '辅助编码', render: () => <CodingListPanel data={data} /> },
    { key: 'ai', label: 'AI 助手', render: () => <AiPanel /> },
    { key: 'artifacts', label: '产物', render: () => <ArtifactsPanel /> },
  ]

  return (
    <div style={{ gridColumn: 'span 4', minWidth: 0, minHeight: 0, height: '100%' }}>
      <IdeWorkspace panels={panels} />
    </div>
  )
}
