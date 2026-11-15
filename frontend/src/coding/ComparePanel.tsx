import type { RecordingDetail } from '../types'
import { SideTitle } from './common'
import { documentId } from './store'

/**
 * 对比不是单人功能。它必须建立在“共享任务”里的同一份材料、两位以上编码者
 * 各自独立编码之上；没有协作就没有可对比的对象，所以这里不再伪造第二位编码者。
 */
export default function ComparePanel({
  projectId,
  detail,
  onOpenCollab,
}: {
  projectId: string
  detail: RecordingDetail | null
  onOpenCollab: () => void
}) {
  const docId = detail ? documentId(detail.recording.id) : '—'

  return (
    <>
      <section className="workspace-card coding-compare-cards" style={{ gridColumn: 'span 3' }}>
        <SideTitle extra={detail?.recording.name}>对比 · 需要共享任务</SideTitle>
        <div className="coding-compare-gate">
          <div className="coding-compare-gate-title">单人项目里没有“对比”</div>
          <div className="coding-empty">
            对比的对象不是另造一份编码，而是另一位编码者在<strong>同一份共享材料</strong>上独立留下的编码。
            因此它必须从「共享任务」进入：同一材料、不同成员、各自编码，再比较码、边界和漏编。
          </div>
          <div className="coding-compare-steps">
            <span>① 在共享任务里创建或加入群组</span>
            <span>② 把这条录音的转写材料加入共享材料</span>
            <span>③ 两位以上成员各自完成编码</span>
            <span>④ 回到这里按真实成员逐句裁决</span>
          </div>
          <button type="button" className="coding-primary-btn" onClick={onOpenCollab}>
            去共享任务
          </button>
        </div>
        <div className="coding-label">当前任务</div>
        <div className="coding-relation vertical">
          <span>项目 {projectId}</span>
          <span>└ 录音 {detail?.recording.id || '—'}</span>
          <span>　└ 文档 {docId}</span>
          <span>　　└ 句子 {detail?.sentences.length || 0}</span>
        </div>
      </section>

      <aside className="workspace-card coding-compare-summary" style={{ gridColumn: 'span 1' }}>
        <SideTitle>对比概览</SideTitle>
        <div className="coding-summary-row">
          共享材料 <b>0</b>
        </div>
        <div className="coding-summary-row">
          其他编码者 <b>0</b>
        </div>
        <div className="coding-summary-row">
          待裁决 <b>0</b>
        </div>
        <div className="coding-summary-row">
          已裁决 <b>0</b>
        </div>
        <div className="coding-label">规则</div>
        <div className="coding-empty">
          只比较真实的多人编码。没有共享任务、没有第二位编码者时，对比页保持为空，不生成演示数据。
        </div>
        <div className="coding-hint">
          协作编码接入后，这里会按成员列出：仅一人编码、码不同、边界不同，并支持逐条裁决与留痕。
        </div>
      </aside>
    </>
  )
}
