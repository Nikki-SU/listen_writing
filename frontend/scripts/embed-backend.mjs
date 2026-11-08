// 把后端源码 + bootstrap 启动文件嵌入前端（生成 src/bootstrapFiles.ts）。
// 引导部署用：Pages 页面把这些文件一键写入用户选定的本地文件夹。
// 由 package.json 的 prebuild 自动执行；后端或 bootstrap 文件改动后重新 build 即同步。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(frontendDir, '..')

// 换行归一：Windows 批处理必须 CRLF；shell 脚本必须 LF（CRLF 会让 bash 报 "\r" 错误）。
// .bat 还必须是纯 ASCII：cmd 按字节读取批处理，UTF-8 中文会被按 GBK 拆成不同字符数，
// 导致文件偏移错位、从行中间开始执行（用户实测出现过 "untime"、"ownloads" 这类报错）。
function normalize(name, text) {
  const lf = text.replace(/\r\n/g, '\n')
  if (name.endsWith('.bat')) {
    const nonAscii = [...lf].filter((ch) => ch.charCodeAt(0) > 0x7f)
    if (nonAscii.length > 0) {
      throw new Error(
        `${name} 含非 ASCII 字符（${nonAscii.slice(0, 5).join(' ')} 等 ${nonAscii.length} 处）。` +
          'Windows 批处理只能写英文，否则 cmd 会错位执行。',
      )
    }
    return lf.replace(/\n/g, '\r\n')
  }
  return lf
}

const files = []
// 后端模块清单：main 依赖 storage / transcriber / diarize / llm / collab / peers / leaf / models，
// 转写引擎还依赖 audio.py。少嵌一个就会在用户机器上 ImportError（引导部署实测过），
// 加文件必须同步这里。
for (const f of ['main.py', 'models.py', 'storage.py', 'transcriber.py', 'audio.py', 'diarize.py', 'llm.py', 'collab.py', 'peers.py', 'leaf.py', 'preload.py']) {
  files.push({ path: `backend/${f}`, content: normalize(f, readFileSync(join(repoDir, 'backend', f), 'utf8')) })
}
// requirements.txt 写到用户文件夹根目录，启动器在根目录执行 pip install -r requirements.txt
files.push({ path: 'requirements.txt', content: normalize('requirements.txt', readFileSync(join(repoDir, 'backend', 'requirements.txt'), 'utf8')) })
// 启动器分两层：
// - start-* 是不可变入口（极小、稳定），负责在加载前把 *.new 换入；
// - run-* 是真正逻辑，网页更新写 run-*.new，下次启动自动替换，无需用户再点覆盖。
const LAUNCHER_ENTRIES = new Set(['start-windows.bat', 'start.sh', 'start-mac.command'])
const LAUNCHER_UPDATABLE = new Set(['run-windows.bat', 'run.sh'])
for (const f of readdirSync(join(repoDir, 'bootstrap')).sort()) {
  files.push({
    path: f,
    // 入口脚本不允许热覆盖（cmd/bash 边读边执行）；它们本身不再随版本变化。
    launcher: LAUNCHER_ENTRIES.has(f),
    // 可更新主体：写入 <name>.new，由入口脚本在下次启动时原子替换。
    promote: LAUNCHER_UPDATABLE.has(f),
    content: normalize(f, readFileSync(join(repoDir, 'bootstrap', f), 'utf8')),
  })
}

// 页面内置版本：用于「本地后端是否过期」判断。任何嵌入文件（含后端代码）有改动，
// 都必须 bump APP_VERSION 的 frontend 段，否则页面不会提示更新。
const modelsSrc = readFileSync(join(repoDir, 'backend', 'models.py'), 'utf8')
const vm = modelsSrc.match(
  /APP_VERSION\s*=\s*\{\s*"frontend":\s*(\d+),\s*"backend":\s*(\d+),\s*"model":\s*(\d+),\s*"data":\s*(\d+)/,
)
if (!vm) throw new Error('backend/models.py 里找不到 APP_VERSION，无法生成页面版本号')
const bundleVersion = { frontend: +vm[1], backend: +vm[2], model: +vm[3], data: +vm[4] }

const ts = `// 自动生成（scripts/embed-backend.mjs），勿手改；后端 / bootstrap 变更后重新 build。
export interface BootstrapFile {
  path: string
  content: string
  /** 不可变入口脚本：自动更新不覆盖，只提示用户重新写入一次。 */
  launcher?: boolean
  /** 可更新启动主体：写到 path + '.new'，由入口脚本下次启动时换入。 */
  promote?: boolean
}

export const BUNDLE_VERSION = ${JSON.stringify(bundleVersion)}

export const BOOTSTRAP_FILES: BootstrapFile[] = ${JSON.stringify(files, null, 2)}
`

writeFileSync(join(frontendDir, 'src', 'bootstrapFiles.ts'), ts)
console.log(`embed-backend: ${files.length} files -> src/bootstrapFiles.ts`)
