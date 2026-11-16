import type {
  CaseAttribute,
  CodingCase,
  CodingCode,
  CodingDocument,
  CodingEntry,
  CodingSpan,
  CodingStore,
} from '../types'
import * as api from '../api'

const ME = 'me'
const STORAGE_PREFIX = 'lw_coding_store_v1_'

/** 顶层四色：紫 / 蓝 / 青 / 琥珀；子码继承父码颜色。 */
const CODE_COLORS = ['#5b4bcc', '#2f6fed', '#0f9d9d', '#c2760a']

const now = () => new Date().toISOString()

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

function key(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`
}

export function codebookId(projectId: string): string {
  return `cb_${projectId}`
}

export function documentId(recordingId: string): string {
  return `doc_${recordingId}`
}

/** 预置码本：让用户第一次进来就能直接框选贴码，不必先造一套码。 */
function seedCodes(projectId: string): CodingCode[] {
  const cb = codebookId(projectId)
  const at = now()
  const make = (
    id: string,
    name: string,
    definition: string,
    parentId: string | null,
    colorIndex: number,
  ): CodingCode => ({
    id,
    codebook_id: cb,
    parent_id: parentId,
    name,
    definition,
    color: CODE_COLORS[colorIndex % CODE_COLORS.length],
    status: 'active',
    created_at: at,
  })
  return [
    make('code_form', '形式化治理', '以可见的流程、材料与留痕替代实际效果。', null, 0),
    make('code_photo', '拍照留痕', '用照片证明活动发生过。', 'code_form', 0),
    make('code_table', '表格迎检', '以表格和记录应付检查。', 'code_form', 0),
    make('code_perf', '应付策略', '以最低成本完成参与，避免公开冲突。', 'code_form', 0),
    make('code_access', '参与资格', '谁有资格参与、以什么代价参与。', null, 1),
    make('code_must', '不得不参与', '因为制度或关系压力而参与。', 'code_access', 1),
    make('code_powerless', '无力感', '想做但觉得改变不了。', 'code_access', 1),
    make('code_boundary', '边界工作', '把某些话题处理成“非政治”的日常表达。', null, 2),
    make('code_depol', '去政治化表达', '用日常语言包装敏感话题。', 'code_boundary', 2),
    make('code_selfc', '自我审查', '主动收回或避免表达敏感内容。', 'code_boundary', 2),
    make('code_probe', '追问', '访谈者追问、澄清或挑战受访者说法。', null, 3),
  ]
}

function emptyStore(projectId: string): CodingStore {
  return {
    schema: 1,
    project_id: projectId,
    codebook: { id: codebookId(projectId), name: '主码本', updated_at: now() },
    documents: [],
    cases: [],
    codes: seedCodes(projectId),
    codings: [],
    resolutions: [],
  }
}

export function loadCodingStore(projectId: string): CodingStore {
  try {
    const raw = localStorage.getItem(key(projectId))
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CodingStore> | null
      if (parsed && parsed.schema === 1 && parsed.project_id === projectId) {
        return {
          schema: 1,
          project_id: projectId,
          codebook: parsed.codebook || emptyStore(projectId).codebook,
          documents: parsed.documents || [],
          cases: parsed.cases || [],
          codes: parsed.codes || [],
          codings: parsed.codings || [],
          resolutions: parsed.resolutions || [],
          saved_at: parsed.saved_at,
        }
      }
    }
  } catch {
    // localStorage 不可用（隐私模式）就退回内存初始值，不阻塞界面。
  }
  return emptyStore(projectId)
}

const pendingSaves: Record<string, number> = {}

/** 本机编码库同时写 localStorage 和后端：前者保证即时，后者保证换浏览器不丢。 */
export function saveCodingStore(store: CodingStore): void {
  const stamped: CodingStore = { ...store, saved_at: now() }
  try {
    localStorage.setItem(key(store.project_id), JSON.stringify(stamped))
  } catch {
    // 存不下时仍允许当前会话继续用，下一次改动会再试。
  }
  const pid = store.project_id
  if (pendingSaves[pid]) window.clearTimeout(pendingSaves[pid])
  pendingSaves[pid] = window.setTimeout(() => {
    delete pendingSaves[pid]
    // 后端暂时不可用（纯静态预览）时静默失败，界面仍以 localStorage 为准。
    void api.saveLocalCoding(pid, stamped).catch(() => undefined)
  }, 900)
}

/**
 * 启动时对齐后端：后端较新就用后端，反过来把本地已有编码一次性迁上去。
 * 返回非空表示拿到了更新的数据，调用方应替换当前 store。
 */
export async function hydrateCodingStore(projectId: string): Promise<CodingStore | null> {
  try {
    const remote = (await api.getLocalCoding(projectId)).store
    const local = loadCodingStore(projectId)
    const stamp = (s: CodingStore) => String(s.saved_at || '')
    if (!remote) {
      const hasData = local.codings.length > 0 || local.cases.some((c) => c.attributes.some((a) => a.value))
      if (hasData) await api.saveLocalCoding(projectId, local)
      return null
    }
    if (stamp(remote) > stamp(local)) {
      localStorage.setItem(key(projectId), JSON.stringify(remote))
      return remote
    }
    if (stamp(local) > stamp(remote)) {
      await api.saveLocalCoding(projectId, local)
    }
    return null
  } catch {
    return null
  }
}

/** 保证当前录音有一份文档与一个案例；同一 recording 永远只对应一份 document。 */
export function ensureDocument(
  store: CodingStore,
  recordingId: string,
  title: string,
  transcriptVersion: string,
): CodingStore {
  const id = documentId(recordingId)
  const found = store.documents.find((d) => d.id === id)
  let next = store
  if (found) {
    if (found.title !== title || found.transcript_version !== transcriptVersion) {
      next = {
        ...next,
        documents: next.documents.map((d) =>
          d.id === id ? { ...d, title, transcript_version: transcriptVersion } : d,
        ),
      }
    }
  } else {
    const document: CodingDocument = {
      id,
      project_id: store.project_id,
      recording_id: recordingId,
      title,
      transcript_version: transcriptVersion,
      created_at: now(),
    }
    next = { ...next, documents: [...next.documents, document] }
  }
  if (!next.cases.some((c) => c.document_id === id)) {
    next = { ...next, cases: [...next.cases, makeCase(recordingId, id, title)] }
  }
  return next
}

function makeCase(recordingId: string, docId: string, name: string): CodingCase {
  return {
    id: `case_${recordingId}`,
    document_id: docId,
    recording_id: recordingId,
    case_name: name,
    attributes: [
      { id: 'attr_role', label: '职级', value: '' },
      { id: 'attr_subject', label: '学科', value: '' },
    ],
  }
}

export function caseFor(store: CodingStore, docId: string): CodingCase | undefined {
  return store.cases.find((c) => c.document_id === docId)
}

export function updateCase(
  store: CodingStore,
  docId: string,
  patch: { case_name?: string; attributes?: CaseAttribute[] },
): CodingStore {
  return {
    ...store,
    cases: store.cases.map((c) => (c.document_id === docId ? { ...c, ...patch } : c)),
  }
}

/** 分析维度：所有案例里出现过的属性名（按出现顺序去重）。 */
export function caseAttributeLabels(store: CodingStore): string[] {
  const labels = new Set<string>()
  for (const item of store.cases) {
    for (const attr of item.attributes) {
      if (attr.label.trim()) labels.add(attr.label.trim())
    }
  }
  return Array.from(labels)
}

export function caseAttributeValue(
  store: CodingStore,
  docId: string,
  label: string,
): string {
  const item = store.cases.find((c) => c.document_id === docId)
  const attr = item?.attributes.find((a) => a.label.trim() === label)
  return (attr?.value || '').trim()
}

export function makeCode(
  store: CodingStore,
  name: string,
  parentId: string | null,
  definition = '',
): CodingCode {
  const parent = parentId ? store.codes.find((c) => c.id === parentId) : null
  const topCount = store.codes.filter((c) => !c.parent_id).length
  const color = parent
    ? topRoot(store, parent.id).color
    : CODE_COLORS[topCount % CODE_COLORS.length]
  return {
    id: uid('code'),
    codebook_id: store.codebook.id,
    parent_id: parentId,
    name,
    definition,
    color,
    status: 'active',
    created_at: now(),
  }
}

export function addCode(store: CodingStore, code: CodingCode): CodingStore {
  return {
    ...store,
    codebook: { ...store.codebook, updated_at: now() },
    codes: [...store.codes, code],
  }
}

export function updateCode(store: CodingStore, codeId: string, patch: Partial<CodingCode>): CodingStore {
  return {
    ...store,
    codebook: { ...store.codebook, updated_at: now() },
    codes: store.codes.map((c) => (c.id === codeId ? { ...c, ...patch } : c)),
  }
}

/** 删除一个码：连同它自己的编码一起删，子码上提到它原来的父级。 */
export function deleteCode(store: CodingStore, codeId: string): CodingStore {
  const code = store.codes.find((c) => c.id === codeId)
  if (!code) return store
  const parentId = code.parent_id
  return {
    ...store,
    codebook: { ...store.codebook, updated_at: now() },
    codes: store.codes
      .filter((c) => c.id !== codeId)
      .map((c) => (c.parent_id === codeId ? { ...c, parent_id: parentId } : c)),
    codings: store.codings.filter((c) => c.code_id !== codeId),
  }
}

/**
 * 批量删除多个码：连同它们名下的全部编码一起删。
 * 被删码的子码若未被选中，上提到被删码原来的父级（父码被删时保持树完整）。
 */
export function deleteCodes(store: CodingStore, codeIds: string[]): CodingStore {
  const doomed = new Set(codeIds)
  if (!doomed.size) return store
  const surviving = store.codes.filter((c) => !doomed.has(c.id))
  const survivingIds = new Set(surviving.map((c) => c.id))
  const codes = surviving.map((c) => {
    // 父码被删了但自己活着：上提到最近的存活祖先。
    let parent = c.parent_id
    while (parent && !survivingIds.has(parent)) {
      parent = store.codes.find((x) => x.id === parent)?.parent_id ?? null
    }
    return parent === c.parent_id ? c : { ...c, parent_id: parent }
  })
  return {
    ...store,
    codebook: { ...store.codebook, updated_at: now() },
    codes,
    codings: store.codings.filter((c) => !doomed.has(c.code_id)),
  }
}

/** 移动码到另一个父级；拒绝移到自己或自己的后代，避免树成环。 */
export function moveCode(store: CodingStore, codeId: string, parentId: string | null): CodingStore {
  const code = store.codes.find((c) => c.id === codeId)
  if (!code || code.parent_id === parentId) return store
  if (parentId && (parentId === codeId || subtreeIds(store, codeId).has(parentId))) return store
  return {
    ...store,
    codebook: { ...store.codebook, updated_at: now() },
    codes: store.codes.map((c) => (c.id === codeId ? { ...c, parent_id: parentId } : c)),
  }
}

/**
 * 撤销最后一条编码后清理空码：全项目都没有这个码的编码、且没有子码时才删。
 * 有子码的父级即使自己暂时没有直接编码，也保留结构。
 */
export function pruneCodeIfUnused(store: CodingStore, codeId: string): CodingStore {
  const used = store.codings.some((c) => c.code_id === codeId)
  const hasChildren = store.codes.some((c) => c.parent_id === codeId)
  if (used || hasChildren) return store
  return deleteCode(store, codeId)
}

export function topRoot(store: CodingStore, codeId: string): CodingCode {
  let code = store.codes.find((c) => c.id === codeId)
  let guard = 0
  while (code?.parent_id && guard < 20) {
    const parentId = code.parent_id
    const parent = store.codes.find((c) => c.id === parentId)
    if (!parent) break
    code = parent
    guard += 1
  }
  return code || {
    id: codeId,
    codebook_id: store.codebook.id,
    parent_id: null,
    name: '未知码',
    definition: '',
    color: CODE_COLORS[0],
    status: 'active',
    created_at: now(),
  }
}

export function codeById(store: CodingStore, codeId: string): CodingCode | undefined {
  return store.codes.find((c) => c.id === codeId)
}

export function subtreeIds(store: CodingStore, codeId: string): Set<string> {
  const ids = new Set<string>([codeId])
  let changed = true
  while (changed) {
    changed = false
    for (const code of store.codes) {
      if (code.parent_id && ids.has(code.parent_id) && !ids.has(code.id)) {
        ids.add(code.id)
        changed = true
      }
    }
  }
  return ids
}

export function countCodings(
  store: CodingStore,
  codeId: string,
  documentIdFilter?: string,
  includeChildren = true,
): number {
  const ids = includeChildren ? subtreeIds(store, codeId) : new Set([codeId])
  return store.codings.filter(
    (c) =>
      ids.has(c.code_id) &&
      c.coder_id === ME &&
      (!documentIdFilter || c.document_id === documentIdFilter),
  ).length
}

/** 直接（不含子码）计数，码本树每行显示自己挂了多少片段。 */
export function countDirect(store: CodingStore, codeId: string, documentIdFilter?: string): number {
  return countCodings(store, codeId, documentIdFilter, false)
}

export function addCodingEntry(store: CodingStore, entry: CodingEntry): CodingStore {
  const duplicate = store.codings.some(
    (c) =>
      c.document_id === entry.document_id &&
      c.code_id === entry.code_id &&
      c.coder_id === entry.coder_id &&
      sameSpans(c.spans, entry.spans),
  )
  if (duplicate) return store
  return { ...store, codings: [...store.codings, entry] }
}

export function removeCodingEntry(store: CodingStore, codingId: string): CodingStore {
  return { ...store, codings: store.codings.filter((c) => c.id !== codingId) }
}

export function makeCoding(
  documentIdValue: string,
  codeId: string,
  spans: CodingSpan[],
  quote: string,
  coderId = ME,
): CodingEntry {
  return {
    id: uid('cd'),
    document_id: documentIdValue,
    code_id: codeId,
    spans,
    quote,
    coder_id: coderId,
    source: 'human',
    created_at: now(),
  }
}

function sameSpans(a: CodingSpan[], b: CodingSpan[]): boolean {
  if (a.length !== b.length) return false
  return a.every(
    (s, i) =>
      s.sentence_id === b[i].sentence_id && s.start === b[i].start && s.end === b[i].end,
  )
}

export function codingsFor(
  store: CodingStore,
  documentIdValue: string,
  coderId = ME,
): CodingEntry[] {
  return store.codings.filter((c) => c.document_id === documentIdValue && c.coder_id === coderId)
}

export function recentCodes(store: CodingStore, documentIdValue: string, limit = 6): CodingCode[] {
  const seen = new Set<string>()
  const out: CodingCode[] = []
  const list = [...store.codings]
    .filter((c) => c.document_id === documentIdValue && c.coder_id === ME)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  for (const coding of list) {
    if (seen.has(coding.code_id)) continue
    const code = codeById(store, coding.code_id)
    if (!code) continue
    seen.add(coding.code_id)
    out.push(code)
    if (out.length >= limit) break
  }
  return out
}

