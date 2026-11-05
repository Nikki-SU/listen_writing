// 本地文件更新：把页面里的最新版本写回用户选定的文件夹。
//
// 目录句柄存在 IndexedDB 里：引导页写入时保存一次，之后页面检查到本地后端过期，
// 就能「一键更新」，不需要用户重新找文件夹。
// 浏览器规定「申请写入权限」必须由用户点击触发，所以自动检查只负责提示，
// 真正写入发生在按钮回调里。
//
// 安全边界：
// - 只写 BOOTSTRAP_FILES 里列出的固定路径，绝不碰用户的 data/、.runtime/ 或其它文件；
// - 正在运行的启动器脚本（.bat/.sh/.command）不覆盖，只报告「启动器有更新」，
//   因为 Windows 的 cmd 是边读边执行，覆盖正在使用的 bat 会导致命令错位。

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

/** 只写内容有差异的文件；正在运行的启动器只登记不覆盖。 */
export async function applyUpdate(
  root: FileSystemDirectoryHandle,
  onProgress?: (changed: number) => void,
): Promise<UpdateResult> {
  let changed = 0
  const launcherStale: string[] = []
  for (const f of BOOTSTRAP_FILES) {
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
