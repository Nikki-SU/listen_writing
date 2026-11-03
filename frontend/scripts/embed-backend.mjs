// 把后端源码 + bootstrap 启动文件嵌入前端（生成 src/bootstrapFiles.ts）。
// 引导部署用：Pages 页面把这些文件一键写入用户选定的本地文件夹。
// 由 package.json 的 prebuild 自动执行；后端或 bootstrap 文件改动后重新 build 即同步。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(frontendDir, '..')

const files = []
for (const f of ['main.py', 'models.py', 'storage.py', 'transcriber.py', 'preload.py']) {
  files.push({ path: `backend/${f}`, content: readFileSync(join(repoDir, 'backend', f), 'utf8') })
}
// requirements.txt 写到用户文件夹根目录，启动器在根目录执行 pip install -r requirements.txt
files.push({ path: 'requirements.txt', content: readFileSync(join(repoDir, 'backend', 'requirements.txt'), 'utf8') })
for (const f of readdirSync(join(repoDir, 'bootstrap')).sort()) {
  files.push({ path: f, content: readFileSync(join(repoDir, 'bootstrap', f), 'utf8') })
}

const ts = `// 自动生成（scripts/embed-backend.mjs），勿手改；后端 / bootstrap 变更后重新 build。
export interface BootstrapFile {
  path: string
  content: string
}

export const BOOTSTRAP_FILES: BootstrapFile[] = ${JSON.stringify(files, null, 2)}
`

writeFileSync(join(frontendDir, 'src', 'bootstrapFiles.ts'), ts)
console.log(`embed-backend: ${files.length} files -> src/bootstrapFiles.ts`)
