// 本地文件更新：把页面里的最新版本写回用户选定的文件夹。
//
// 目录句柄存在 IndexedDB 里：引导页写入时保存一次，之后页面检查到本地后端过期，
// 就能「一键更新」，不需要用户重新找文件夹。
// 浏览器规定「申请写入权限」必须由用户点击触发，所以自动检查只负责提示，
// 真正写入发生在按钮回调里。
//
// 安全边界：
// - 只写 BOOTSTRAP_FILES 里列出的固定路径，绝不碰用户的 data/、.runtime/ 或其它文件；
// - 不可变入口脚本（start-*.bat/.sh/.command）不覆盖，只报告「启动器有更新」；
// - 可更新启动主体（run-windows.bat / run.sh）写成 <name>.new，由入口脚本在下次
//   启动前换入，所以启动逻辑可以和普通代码一样自动更新，不需要用户重新引导。

import { BOOTSTRAP_FILES, BUNDLE_VERSION, type BootstrapFile } from './bootstrapFiles'

const DB_NAME = 'listen_writing'
const STORE = 'handles'
const DIR_KEY = 'bootstrap'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveDirHandle(dir: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(dir, DIR_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb()
    const value = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(DIR_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
      req.onerror = () => reject(req.error)
    })
    db.close()
    return value
  } catch {
    return null
  }
}

/** 页面内置版本比本地后端新 → 需要更新。frontend 段代表「整包嵌入文件」的版本。 */
export function isOutdated(local: { frontend: number }): boolean {
  return local.frontend < BUNDLE_VERSION.frontend
}

/**
 * 本地后端进程是否还是旧代码。
 *
 * `backend` 段只在后端代码改动时递增；启动脚本 / README 之类的嵌入文件更新
 * 不需要重启进程，所以不能用 frontend 段来判断。
 */
export function backendOutdated(local: { backend: number }): boolean {
  return local.backend < BUNDLE_VERSION.backend
}

const APPLIED_KEY = 'lw_bundle_applied_v1'

/** 记下「本浏览器已把整包文件更新到这个版本」。 */
export function markBundleApplied(): void {
  try {
    localStorage.setItem(APPLIED_KEY, String(BUNDLE_VERSION.frontend))
  } catch {
    // 隐私模式下 localStorage 可能不可写；只是少一个去重标记，不影响更新本身。
  }
}

/**
 * 这次整包更新是否已经在本浏览器完成过。
 *
 * 纯页面改版不需要重启后端，运行中的进程还会返回旧的 frontend 段；
 * 若只按版本比对，更新完提示会一直重复出现。用这个标记消掉重复提示，
 * 真正的后端升级仍由 `backend` 段不匹配来提示。
 */
export function bundleApplied(): boolean {
  try {
    return Number(localStorage.getItem(APPLIED_KEY) || 0) >= BUNDLE_VERSION.frontend
  } catch {
    return false
  }
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = window.showDirectoryPicker
  if (!picker) throw new Error('unsupported')
  return picker({ id: 'listen_writing', mode: 'readwrite' })
}

/**
 * 确认目录可写。浏览器的实现：已授权的会话内直接 granted；
 * 否则弹出一次权限确认（必须由用户点击触发），用户同意才 granted。
 */
export async function ensureWritePermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  const handle = dir as FileSystemDirectoryHandle & {
    queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  }
  const descriptor = { mode: 'readwrite' as const }
  try {
    if (handle.queryPermission && (await handle.queryPermission(descriptor)) === 'granted') return true
    if (handle.requestPermission && (await handle.requestPermission(descriptor)) === 'granted') return true
    return false
  } catch {
    return false
  }
}

async function resolveDir(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = path.split('/')
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create })
  }
  return { dir, name: parts[parts.length - 1] }
}

async function writeOne(root: FileSystemDirectoryHandle, f: BootstrapFile): Promise<void> {
  const { dir, name } = await resolveDir(root, f.path, true)
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(f.content)
  await w.close()
}

async function readOne(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  try {
    const { dir, name } = await resolveDir(root, path, false)
    const fh = await dir.getFileHandle(name)
    return await (await fh.getFile()).text()
  } catch {
    return null
  }
}

/** 引导页首次写入：全部文件无条件覆盖（可重复执行）。 */
export async function writeAll(
  root: FileSystemDirectoryHandle,
  onProgress?: (written: number) => void,
): Promise<void> {
  let written = 0
  for (const f of BOOTSTRAP_FILES) {
    await writeOne(root, f)
    written += 1
    onProgress?.(written)
  }
}

export type UpdateResult = {
  changed: number
  /** 内容有变化但没覆盖的启动器脚本（需要用户手动重新写入） */
  launcherStale: string[]
}

/** 只写内容有差异的文件；入口启动器只登记不覆盖，启动主体写 .new 等待换入。 */
export async function applyUpdate(
  root: FileSystemDirectoryHandle,
  onProgress?: (changed: number) => void,
): Promise<UpdateResult> {
  let changed = 0
  const launcherStale: string[] = []
  for (const f of BOOTSTRAP_FILES) {
    if (f.promote) {
      // 正式文件已是最新、且没有待换入的 .new → 无事可做。
      const current = await readOne(root, f.path)
      const pending = await readOne(root, `${f.path}.new`)
      if (current === f.content && pending === null) continue
      await writeOne(root, { ...f, path: `${f.path}.new` })
      changed += 1
      onProgress?.(changed)
      continue
    }
    if ((await readOne(root, f.path)) === f.content) continue
    if (f.launcher) {
      launcherStale.push(f.path)
      continue
    }
    await writeOne(root, f)
    changed += 1
    onProgress?.(changed)
  }
  return { changed, launcherStale }
}
