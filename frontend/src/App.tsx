import { useEffect, useState } from 'react'

const BACKEND = 'http://127.0.0.1:7850'

type Version = { frontend: number; backend: number; model: number; data: number }

export default function App() {
  const [health, setHealth] = useState<'ok' | 'down' | 'checking'>('checking')
  const [version, setVersion] = useState<Version | null>(null)

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const h = await fetch(`${BACKEND}/api/health`)
        if (h.ok) {
          const v = await fetch(`${BACKEND}/api/version`)
          if (!cancelled) {
            setHealth('ok')
            setVersion((await v.json()).version)
          }
          return
        }
      } catch {
        // 后端未启动
      }
      if (!cancelled) setHealth('down')
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main>
      <h1>listen_writing</h1>
      <p>后端状态：{health}</p>
      {version && (
        <p>
          软件版本：fr {version.frontend} · be {version.backend} · mo {version.model} · da{' '}
          {version.data}
        </p>
      )}
    </main>
  )
}