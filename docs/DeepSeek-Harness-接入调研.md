# DeepSeek Harness（DSH）接入调研

> 状态：调研稿，2026-11-15。
> 用途：判断「把访谈工作台做成 DSH 插件、不再本地起后端」是否可行，以及编码方法与工作范围。
> 规则：结论都要有依据；未实测的地方标「待实测」，不写成定论。

## 0. 结论（先看）

1. **可以做，而且能做到「团队只装 DSH + 插件」**。DSH 的插件在 DSH 自己的 Node 进程里运行，插件可以自带 ASR、读写工作区、调用 DSH 当前模型，不需要再起一个独立 Python 后端。
2. **推荐形态**：一个 npm bundle 包，同时包含 **host half**（ASR / 存储 / 工具）和 **client half**（React 界面，挂在 DSH 右侧栏或自定义面板）。
3. **本地模型有两种角色，不要混在一起**：
   - 作为 **DSH 的模型提供方**：让 DSH 的对话 / agent 用你的本地 LLM。
   - 作为 **插件内部的 ASR**：访谈转写不经过 DSH 的对话模型，直接跑在插件里。
4. **DSH 插件这条轨道不推荐**依赖独立 Python 后端 + 启动器：与「只装 DSH 和插件」的目标冲突，且跨平台打包 Python/依赖很重。原产品仍保留自己的 Python 后端（见 4.0 双轨关系）。
5. **最大风险**：DSH 处于 developer preview（0.1.1-rc.2，官方明确说会有破坏性变更）；client bundle 的构建 preset 未正式发布，需要自己复现输出格式。
6. **两条发布轨道并存**：原产品保留（PRD v1.0 的本地后端 + 浏览器前端 + 启动器），继续按原计划迭代；DSH 插件是**新增的第二条轨道**，不是替换原产品。DSH 插件优先做成自包含（不依赖原后端），这样团队只装 DSH + 插件也能用。

---

## 1. DSH 是什么

- DeepSeek 官方开源的 agent harness，MIT；`npx @deepseek-ai/dsh web` 启动 Web UI（默认 `http://127.0.0.1:3080`），要求 Node `^22.19 || >=24`。
- 底层是 **Cordis** 插件框架，「一切皆插件」：模型、工具、技能、会话、沙箱、存储、循环、调度、UI 都是可替换的插件。
- 插件就是导出 `name` / `inject` / `apply(ctx)` 的模块；通过 `ctx` 注册能力，卸载时自动清理。
- 用户装的是 **profile**：`$DSH_HOME/profiles/<name>/`，插件通过 `dsh plugin --profile web add <包名>` 安装。

---

## 2. 三个接入面

### 2.1 模型面：把本地模型接给 DSH

DSH 的模型接入层是 `dsh-llm-pi-ai`，provider 的配置单元是：

- `api`：`openai-completions` / `openai-responses` / `anthropic-messages`
- `baseURL`、`apiKeyEnv`、`models`

所以接入条件是：**暴露 OpenAI 兼容的 `/v1/chat/completions`（含 SSE 流式与 tool calls）**，不是把 Python 对象塞进去。

配置示例（写进 `$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      listen-writing-local:
        api: openai-completions
        baseURL: http://127.0.0.1:7850/v1
        models:
          - id: qwen3-4b
```

或在 Web UI：**Settings → Models → Add model provider → Custom model API**，填 Base URL / 协议 / 模型列表（`Fetch available models` 依赖 `/v1/models`）。

实现建议：

- **路线 A（推荐）**：用 `llama-server`（llama.cpp）加载现有 GGUF，开 `--jinja`，它直接提供 `/v1/models`、`/v1/chat/completions`、SSE 和工具调用。
- **路线 B**：在 Python 后端自己加 `/v1` 适配层。要自己做 SSE、`tool_calls`、停止序列、reasoning 字段映射，坑更多。
- 注意：Qwen3 是 thinking 模型，DSH 对「关不掉思考 / 网关拒绝」有已知兼容问题，必要时配 `compat` / `reasoningEfforts`，或在提示词加 `/no_think`。
- 只监听 `127.0.0.1`；局域网暴露要单独评估。

### 2.2 工具面：host 插件

`inject = ['tools']`，用 `defineTool` 注册工具，工具内部直接读写工作区 / 调 ASR：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'listen-writing-tools'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'listen_writing_transcribe',
    description: '转写工作区里的录音，返回逐句文本与时间戳',
    parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      // 调插件自己的 ASR，不经过独立后端
      return await transcribeInPlugin(args.path)
    },
  }))
}
```

这条路不需要 client bundle，最快见效；agent 能直接「帮我转写这条录音 / 纠错 / 导出」。

### 2.3 界面面：client 插件

DSH 的 Web UI 是插件化 React 组合。右侧栏可以注册自定义 tab：

- `ctx.sidebarRightTabs.register({ id, kind: 'listen-writing', title, ... })`
- `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: <id> }, Component))`

client 包的硬性约定（外部包必须自己复现）：

- `package.json` 声明 `dsh.client`：`platform: 'web'`，可带 `inject`；
- `exports["./client"]` 指向预构建的浏览器 bundle；
- bundle 以 `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... } })` 包裹；
- `react` / `react-dom` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-ui-slots` 等作为 externals，不能打进 bundle；
- 产物建议 `format: 'cjs'`、`platform: 'browser'`、`entryFileNames: 'client.js'`。

> 这意味着：**不能简单 iframe 现有页面**（没有独立后端可指向）。要么把现有 React 组件搬进 client bundle，要么重写成 DSH 的 slots 组件。

### 2.4 语音面：ASR Provider（实验性）

DSH 有一个实验性的语音输入子系统：

- `ctx.speechToText.register(provider)` 注册识别器；
- Provider 收到 base64 WAV，返回 `Transcript { text, audioSeconds, inferenceSeconds }`；
- 浏览器端有麦克风 UI，可把识别结果插入对话输入框（只插入草稿，不自动发送）。

如果只想让 DSH 的输入框支持「本地语音输入」，这条最轻；但它**不提供**访谈需要的逐句时间戳、说话人、版本、协作。完整工作台仍应走 client 面板。

### 2.5 更轻的替代：MCP

DSH 支持 MCP 连接。把插件能力先做成一个本地 MCP server（工具：转写、纠错、导出），用 DSH 的 MCP 配置接进去，可以绕开 Cordis/client bundle 的开发；跑通后再套 `dsh.bundle` 外壳发布。适合验证阶段。

---

## 3. 质性编码：方法与产品含义（不是软件编码）

> 澄清术语：本节说的是社会学质性研究里的 coding（对访谈文本贴标签、归类、建构概念/主题）；插件怎么写代码，放在第 5 节「软件实现方法」。两者不要混。

### 3.1 质性编码是什么

- 质性编码不是「给句子打关键词」，而是研究者逐段阅读文本、贴标签、比较、归类，逐步形成概念、范畴、主题/理论的过程。
- 常见路径：
  - **扎根理论（Grounded Theory）**：开放编码 → 轴心编码 → 选择性编码；持续比较（constant comparison）；理论饱和；全程写 memo（方法/理论备忘录）。
  - **主题分析（Braun & Clarke）**：熟悉数据 → 系统编码 → 生成初始主题 → 检查/修订主题 → 定义与命名 → 写作报告。
  - **内容分析 / 框架分析**：先有或半预置码表，按编码手册（codebook）操作，强调编码者一致性。
- 核心产物：码本/码表（codebook）、带编码的文本片段、memo、主题/范畴层级、分析矩阵、审计轨迹。

### 3.2 对产品的硬性要求（这些决定架构）

1. **编码对象是片段，不是整句**：一句话里可能只有半句被编码；需要字符级 span（并与 ASR 时间戳对应），不能只给句子挂一个标签。
2. **多重编码与重叠**：同一片段可挂多个码，不同码的片段可以重叠；引用必须稳定、可回溯。
3. **码本是层级化、可版本化的**：父子码、定义、正例/反例、颜色、启用/停用；码表修改要留痕。
4. **多编码者与一致性**：同一批数据可被多人独立编码；需要并排比较、冲突裁决、Cohen's κ / Krippendorff's α 等一致性指标。
5. **Memo 与反思**：memo 能挂在码、片段、文档上；可检索、可导出——这是理论建构的一部分，不是附注。
6. **检索与矩阵**：按码检索全部片段、码频次、code × case 矩阵、共现分析。
7. **审计轨迹**：谁在何时改了编码/码表/memo，可回溯；编码结果与转写稿版本分离。
8. **互操作/导出**：REFI-QDA 是 CAQDAS 交换标准（`.QDPX` 压缩包，内含 `project.QDE` XML），NVivo、MAXQDA、ATLAS.ti 等支持；产品至少要能导出「码本 + 编码片段 + memo」。
9. **数据伦理**：原文与编码默认不出本机；AI 辅助编码只给建议，必须人工确认，并能点回原文。
10. **AI 辅助的边界**：LLM 可生成候选码、归纳主题、找反例；但研究显示它会偏向部分文本、甚至生成原文没有的引文——所以必须 human-in-the-loop、可关闭、可追溯。

### 3.3 一句话结论

现有产品的「逐句 + speaker + 版本」只是**转写层**。要做质性编码，必须在数据模型里增加 **片段级标注（span）+ 码本（层级）+ memo + 多编码者/一致性 + REFI-QDA 导出**；这不是给句子加一个 `code` 字段就能解决的。
PRD 里已经写了「为后续编码功能预留复用基础」，现在要把这句话具体化成上面的数据模型。

---

## 4. 推荐架构：不本地起独立后端

### 4.0 双轨关系（重要）

- **轨道 A（保留）**：原产品，维持现状——Python 后端承载模型/推理/文件/协作，浏览器前端 + GitHub Pages + 启动器。PRD v1.0 继续有效，不撤。
- **轨道 B（新增）**：DSH 插件，同一功能在 DSH 内实现；独立安装，默认不依赖原后端，使用 DSH 工作区与本地 ASR。
- **复用边界**（避免两套实现漂移）：
  - 共享「规格」：数据格式（`recording.json` / `sentences.csv` / `versions/`）、断句合并规则、纠错 prompt 与守卫、发言人配色、验收用例。
  - 不共享运行时：Python 后端与 Node 插件各自实现；用跨语言一致性测试（同一组输入 → 同一组输出）防漂移。
- **可选第三种模式**：DSH 插件作为原后端的「客户端」——host 工具通过 HTTP 调 `127.0.0.1:7850`。适合已经跑着原产品的用户；不作默认，因为违背「只装 DSH + 插件」的目标。

### 4.1 目标（仅指 DSH 插件这条轨道）

团队成员只做两件事：

```text
安装 Node.js → npx @deepseek-ai/dsh web（或安装 DSH 桌面端）
→ 在 DSH 里安装「访谈工作台」插件
```

不装 Python、不跑启动器、不再开第二个端口。

### 4.2 结构

```text
DSH Host（Node 进程）
└─ dsh-listen-writing（host half）
   ├─ 音频解码      @audio/decode（WASM：m4a/aac/mp3/flac/ogg）
   ├─ VAD + ASR     sherpa-onnx-node + SenseVoice（本地、离线）
   ├─ 说话人        sherpa-onnx diarization（或自实现 MFCC + k-means）
   ├─ 标点/断句      sherpa-onnx punctuation + 现有合并规则
   ├─ AI 纠错       ctx.llm.stream()（用 DSH 当前配置的模型，不打包 LLM）
   ├─ 存储          DSH workspace / ctx.fs（recording.json、sentences.csv、versions/）
   ├─ 长任务        ctx.jobs + Node worker_threads（进度、可停止）
   └─ 工具          ctx.tools.register（转写 / 纠错 / 导出）
└─ dsh-listen-writing（client half）
   └─ React 面板：右侧栏 tab / 自定义页面（录音列表、逐句稿、播放、编辑、纠错对照）
```

### 4.3 技术选型与依据

| 用途 | 选择 | 依据 |
|---|---|---|
| 本地 ASR | `sherpa-onnx-node` + SenseVoice int8 ONNX | sherpa 官方 Node-Addon 支持 Linux x64/arm64、macOS x64/arm64、Windows x64；有 Non-Streaming ASR / VAD / Speaker Diarization / Punctuation 示例 |
| 音频解码 | `@audio/decode`（WASM） | 覆盖 M4A/AAC、MP3、FLAC、OGG/Opus，无原生依赖；避免打包 ffmpeg |
| 说话人 | `sherpa-onnx` diarization | 官方 Node 示例含 Speaker Diarization；也可沿用现有 MFCC + k-means 逻辑 |
| 纠错模型 | `ctx.llm.stream()` | DSH 文档明确「直接调用 ctx.llm.stream() 的调用方」；不重复打包 LLM，跟随用户配置 |
| 存储 | DSH workspace + `ctx.fs` | 工作区是用户目录的持久记录；`ctx.fs` 提供受策略保护的读写 |
| 长任务 | `ctx.jobs` + worker | DSH 有后台任务运行时；ASR 不应阻塞 host 主线程 |
| UI | `ctx.slots` / `sidebarRightTabs` | 官方右侧栏支持注册 tab 类型与 keyed slot 正文 |
| 打包 | `dsh.bundle` + npm | `package.json` 声明 `dsh.bundle.patch`，`dsh plugin --profile web add` 安装 |
| 发布 | npm + `dsh-plugin` keyword | 插件目录按关键字/ topic 发现；预构建产物避免用户安装时跑构建脚本 |

### 4.4 为什么 DSH 插件不依赖原 Python 后端（不是取消原产品）

- DSH 插件用户的目标是「只装 DSH + 插件」；Python 后端需要 Python 运行时、依赖、启动器、端口，跨平台成本高。
- DSH host 插件可以用 `ctx.subprocess` 启动原后端，但那仍然是「本地进程 + 依赖」，与插件轨道的目标冲突；只作为可选的「连接已有后端」模式，不作默认。
- 现有 Python 端的 SenseVoice 包名、下载源、断句合并、纠错 prompt 等**作为规格参考**，在 Node 侧重新实现；原后端继续独立维护。

> 数据不出本机的伦理底线仍可满足：ASR 在 DSH 进程内本地推理；纠错用 DSH 的模型，**前提是用户把 DSH 配成本地 provider**。若 DSH 配的是云端模型，纠错文本会出网，需要在插件里明确提示。

---

## 5. 软件实现方法（TypeScript / Cordis，可照做）

### 5.1 目录结构

```text
dsh-listen-writing/
├── package.json
├── cordis.patch.yml
├── tsdown.config.ts
├── src/
│   ├── host/index.ts        # Cordis 插件入口：工具、服务、任务
│   └── client/index.tsx     # 浏览器半：React 面板
├── lib/
│   ├── index.js             # 预构建 host
│   └── client.js            # 预构建 client bundle
└── README.md
```

### 5.2 package.json

```json
{
  "name": "dsh-listen-writing",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "files": ["lib", "cordis.patch.yml", "README.md"],
  "keywords": ["dsh-plugin", "deepseek-harness", "asr", "interview"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-runtime"]
    }
  },
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "react": "^18.2.0"
  }
}
```

### 5.3 cordis.patch.yml

```yaml
- insert:
    - id: listen-writing
      name: dsh-listen-writing
```

### 5.4 host 入口

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-listen-writing'
export const inject = ['tools', 'llm', 'fs']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'listen_writing_open',
    description: '打开访谈工作台',
    parameters: {},
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: '已打开' }] },
    async execute() {
      // 后续：注册 job、ASR、写工作区
      return true
    },
  }))
}
```

> 注意：`inject` 里写 `tools` / `llm` / `fs` 前先确认这些服务在你运行的 DSH profile 里已加载；否则插件会一直 pending。`dsh --profile web --dump-config` 是最重要的诊断命令。

### 5.5 client 入口（右侧栏）

```tsx
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export const inject = ['sidebarRightTabs', 'slots']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'dsh-listen-writing',
    kind: 'listen-writing',
    title: () => '访谈工作台',
    keepMounted: true,
    guide: { order: 100, title: () => '访谈工作台', description: () => '本地转写与逐句编辑' },
  }), 'listen-writing tab')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'dsh-listen-writing' },
      WorkbenchPanel,
    ),
  ), 'listen-writing panel')
}
```

`WorkbenchPanel` 就是现有界面的迁移目标：录音列表、逐句稿、播放、speaker 标签、纠错对照、合并预览。

### 5.6 构建与调试

```sh
# 本地开发（不修改 harness 仓库）
dsh web --patch ./cordis.patch.yml   # patch 里的模块路径必须是绝对路径

# 安装到 web profile
dsh plugin --profile web add dsh-listen-writing

# 看插件到底进没进配置树
dsh --profile web --dump-config

# 发布
pnpm publish
```

client bundle 必须预构建后随 npm 包发布，用户安装时不跑构建脚本。

---

## 6. 要做哪些内容（工作分解）

### P0：能跑通的最小闭环

1. **插件骨架**：host + client + `dsh.bundle`，能安装、能在右侧栏出现。
2. **工作区存储**：录音、句子、版本的 JSON/CSV 格式（可复用现有 `recording.json` / `sentences.csv` 结构）。
3. **音频导入**：选择工作区文件 → `@audio/decode` 解码 → 16k mono WAV。
4. **本地 ASR**：Silero VAD 切段 → SenseVoice 识别 → 时间戳 → 合并成句（复用现有断句规则）。
5. **逐句 UI + 播放**：列表、点句跳转、单句精确播放（播到 `end_ms` 停止）。
6. **说话人**：先用 diarization 自动分；保留单击循环 / Shift 批量。

验收：一条 10 分钟录音，从插件里导入 → 转写 → 逐句可播放 → 说话人可改 → 数据落工作区。

### P1：研究所需的核心能力

7. **AI 纠错**：`ctx.llm.stream()` + 现有 prompt 约束（只修识别错误、保留语气词、等长替换守卫）。
8. **整理断句**：完整句合并规则 + 预览。
9. **版本历史**：沿用 `stage.seq` 与 diff 快照。
10. **导出**：MD / JSON，保留时间戳与说话人。
11. **长任务**：`ctx.jobs` + worker，进度可见、可停止、断点续跑。
12. **跨语言一致性测试**：同一组句子输入，Python 原后端与 Node 插件输出必须一致（断句、纠错守卫、数据格式、speaker 配色）。
13. **片段级编码**：字符级 span 标注，支持同一片段多码、码与码重叠、点回原文。
14. **码本（codebook）**：父子码层级、定义、正例/反例、颜色、启用/停用、码表版本与审计。
15. **Memo**：挂在码 / 片段 / 文档上的备忘录，可检索、可导出。
16. **多编码者与一致性**：独立编码、并排比较、冲突裁决、Cohen's κ / Krippendorff's α。
17. **REFI-QDA 导出/导入**：至少导出码本 + 编码片段 + memo（`.QDPX` / `project.QDE`）。

### P2：发布与协作

18. **npm 发布 + 插件目录**：`dsh-plugin` keyword、README、许可证。
19. **设置页**：模型下载、语言、是否允许云端纠错。
20. **协作/共享**是否保留，需要重新设计（DSH 没有现成的课题组 P2P 协作面）。
21. **双轨文档**：明确哪些规格共享、哪些实现各自维护，避免两条轨道行为漂移；质性编码数据模型同时写进 PRD。

---

## 7. 风险与待确认

- **DSH developer preview**：0.1.1-rc.2，官方说明会有破坏性变更；要锁版本并做兼容层。
- **client bundle 契约**：官方 `clientBundle` preset 未发布，需要复现 `__ModuleLoader__` 输出格式；这是最大的工程不确定项。
- **音频播放地址**：客户端如何拿到工作区音频的可用 URL（`dsh-resource://file/...` 或自定义 route）——待实测。
- **原生依赖**：`sherpa-onnx-node` 覆盖主流平台，但 Linux arm64 / Windows 之外的组合要实测。
- **模型体积与首启**：SenseVoice + diarization 模型需要在工作区下载；首启体验、断点续传、磁盘占用要设计。
- **长音频性能**：WASM 解码 + Node ONNX 的长文件性能要压测。
- **双轨漂移**：原产品（Python）与 DSH 插件（Node）两套实现容易行为不一致；需要共享规格文档 + 同一组输入输出的一致性测试（断句、纠错守卫、数据格式、speaker 配色）。
- **数据伦理**：纠错若用云端模型，访谈文本会出网；默认应引导用户配本地 provider。

---

## 8. 依据（来源）

- [DeepSeek Harness 官网（中文）](https://www.deepseek.com/harness/)
- [DeepSeek Harness GitHub（README：Node 版本、npx 启动、MIT）](https://github.com/deepseek-ai/deepseek-harness)
- [Cordis 入门（插件 / 服务 / inject / 生命周期）](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)
- [第一个 Harness 插件（apply / 三种形态 / cordis.yml）](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
- [开发一个 Tool（defineTool）](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool)
- [Client 模块（dsh.client / exports["./client"]）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
- [Web Client Slots（ctx.slots 注册）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)
- [右侧 Sidebar（tab 类型 / sidebar.right.pane.tab）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right)
- [语音输入（ctx.speechToText / SpeechProvider）](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/voice-input.zh.md)
- [工作区（ctx.workspaceRegistry）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workspace)
- [文件系统（ctx.fs）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem)
- [后台任务（ctx.jobs）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs)
- [LLM 流式（直接调用 ctx.llm.stream）](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming)
- [DSH 插件编写与发布指南（package.json / cordis.patch.yml / 安装）](https://dshplugins.co/en/dsh-plugins-guide/)
- [dsh-status-plugin 的 package.json（dsh.client / dsh.bundle 实例）](https://registry.npmjs.org/dsh-status-plugin/latest)
- [外部插件本地开发与 client bundle 输出契约](http://raw.githubusercontent.com/ph4310822/dsh-edex-mission-ui/HEAD/LOCAL_DEVELOPMENT.md)
- [sherpa-onnx-node 安装（支持平台）](https://k2-fsa.github.io/sherpa/onnx/javascript-api/install.html)
- [sherpa-onnx Node-Addon 示例（ASR / VAD / diarization / punctuation）](https://k2-fsa.github.io/sherpa/onnx/javascript-api/examples/index.html)
- [SenseVoice 预训练模型与时间戳](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)
- [dsh-hold-to-talk（DSH 上用 SenseVoice + sherpa-onnx 的本地语音输入先例）](https://www.npmjs.com/package/dsh-hold-to-talk)
- [@audio/decode（M4A/AAC/MP3/FLAC/OGG WASM 解码）](https://www.npmjs.com/package/@audio/decode)
- [自定义模型提供方配置（社区指南：Custom model API / cordis.patch.yml）](https://www.jb51.net/ai/1046153.html)

### 质性编码方法

- [Moser & Korstjens 2018：扎根理论、开放/轴心/选择性编码、持续比较与 memo（PMC）](https://pmc.ncbi.nlm.nih.gov/articles/PMC5774281/)
- [Braun & Clarke 主题分析六阶段（PDF）](https://www.abdn.ac.uk/media/site/education/documents/Thematic-analysis.pdf)
- [MAXQDA 编码功能（片段编码、码本组织、memo、intercoder agreement）](https://www.maxqda.com/products?view=normal)
- [NVivo：REFI-QDA 标准（跨 QDA 软件交换项目）](https://help-nv.qsrinternational.com/14/win/Content/projects-teamwork/refi-qda%20standard.htm)
- [REFI-QDA 1.5 规范（`.QDPX` / `project.QDE` XML）](https://www.qdasoftware.org/wp-content/uploads/2019/09/REFI-QDA-1-5.pdf)
- [Krippendorff's α 与编码者一致性实践指南（arXiv）](https://arxiv.org/pdf/2008.00977v2.pdf)
- [Multi-LLM 主题分析与双重一致性指标（arXiv）](https://arxiv.org/html/2512.20352v1)
- [AI 质性编码的偏差与「编造引文」风险（Nguyen & Welch 研究的介绍）](https://qualitati.com/blog/ai-thematic-analysis-positional-bias-2026)
