import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'

/**
 * 无痕卸载用的浏览器侧清理页：打开 <站点>/?uninstall=1 时，清掉本站的
 * localStorage / IndexedDB / Cache Storage / Service Worker，再显示完成提示。
 * 只影响当前站点（GitHub Pages 源），不碰其它网站。
 */
async function uninstallBrowserData(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search)
  if (!params.has('uninstall')) return false
  const root = document.getElementById('root')
  if (!root) return true
  root.innerHTML = '<div style="padding:40px;font:14px/1.8 system-ui;color:#333">正在清除浏览器本地数据…</div>'
  try { localStorage.clear() } catch { /* 忽略 */ }
  try { sessionStorage.clear() } catch { /* 忽略 */ }
  try {
    const dbs = await indexedDB.databases?.() ?? []
    await Promise.all(dbs.map((db) => new Promise<void>((resolve) => {
      if (!db.name) return resolve()
      const req = indexedDB.deleteDatabase(db.name)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    })))
  } catch { /* 忽略 */ }
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch { /* 忽略 */ }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.() ?? []
    await Promise.all(regs.map((r) => r.unregister()))
  } catch { /* 忽略 */ }
  root.innerHTML = '<div style="padding:40px;font:14px/1.8 system-ui;color:#333;max-width:520px">'
    + '<div style="font-size:18px;font-weight:600;margin-bottom:12px">浏览器本地数据已清除</div>'
    + '<div>可以关闭此页面了。程序与数据由启动器文件夹里的卸载脚本负责删除。</div></div>'
  return true
}

void uninstallBrowserData().then((handled) => {
  if (handled) return
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
