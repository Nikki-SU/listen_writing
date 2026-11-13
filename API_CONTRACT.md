# 接口契约

> 前后端分开写时，双端子 Agent 都要先读本文件，以它作为唯一的接口纪律。

## 通用约定

- **协议**：HTTP（本地回环），后端是纯标准库 `http.server`，无第三方框架。
- **地址**：`http://127.0.0.1:7850`（本机）。前端经浏览器 fetch；未来局域网协作用户 IP 替代。
- **数据格式**：请求 / 响应体一律 `application/json; charset=utf-8`，字段用 `snake_case`。
- **CORS**：后端返回 `Access-Control-Allow-Origin: *`、`Access-Control-Allow-Private-Network: true`（后者是 https 的 Pages 页面请求 http://127.0.0.1 时 Chrome 私有网络访问预检的要求；`OPTIONS` 预检返回 204 + 同样的头）。
- **错误约定**：非 JSON 或未知路径一律 `404`，返回 `{"error": "<可读原因>"}`；字段名字典化，不静默给空值 / 0（对应《工程纪律》「先约束，再容错」）。

## 接口清单

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| H-1 | 后端 | `GET /api/health` | 无 | `{"status":"ok"}` | 前端启动后用来确认后端在线 |
| V-1 | 后端 | `GET /api/version` | 无 | `{"version":{"frontend":1,"backend":1,"model":1,"data":1}}` | 软件四段版本号；`frontend` 段同时代表「嵌入文件整包」的版本，用于判断本地后端是否过期 |
| U-1 | 后端 | `POST /api/restart` | 无 | `{"status":"restarting"}` | 更新本地文件后重启后端：回包后进程以**退出码 86** 结束，启动器据此重装依赖并重启；不是 86 时启动器正常退出 |
| P-1 | 后端 | `POST /api/projects` | `{"name":"项目名","description":"说明"}` | `{"project":{...}}` | 创建项目（description 可空） |
| P-2 | 后端 | `GET /api/projects` | 无 | `{"projects":[{...}]}` | 列出全部项目（按创建倒序） |
| P-3 | 后端 | `DELETE /api/projects/{project_id}` | 无 | `{"status":"deleted"}` | 删除整个项目（目录下所有录音、音频、转写、历史版本一并删除）；项目不存在 404。删除前会先把该项目里仍在跑的 AI 任务置为取消 |
| R-1 | 后端 | `POST /api/projects/{project_id}/recordings?name=...&format=...` | **raw 音频字节**（非 JSON）+ **query 参数** `name`（原文件名，UTF-8 百分号编码）、`format`（取值见下方白名单） | `{"recording":{...}}` | 上传录音，落 `audio.{ext}` 后**异步启动转写** |
| R-3 | 后端 | `GET /api/projects/{project_id}/recordings` | 无 | `{"recordings":[{...}]}` | 列出项目下录音（仅元数据，按创建倒序） |
| R-2 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}` | 无 | `{"recording":{...},"transcribe":{...},"sentences":[...],"redactions":[...],"speakers":["发言人1"]}` | 录音详情 + 转写状态 + 分句列表 + 脱敏标记 + 发言人花名册；`recording.version` 为当前版本 `{stage,seq,current}`，`recording.asr_model` 为实际用过的转写档位 |
| R-4 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/audio` | 可选 `Range: bytes=...` | 音频字节流（`200` / `206`） | `<audio>` 播放与按句跳转；支持 Range 才能任意 seek |
| R-5 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/versions` | 无 | `{"versions":[{version,stage,seq,parent,author_nick,timestamp,message,changes}],"current":{...}}` | 版本历史（元数据，不含句子快照） |
| R-6 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/versions/{stage}.{seq}` | 无 | `{"version":{...version, diff, sentences:[...]}}` | 单个版本：完整句子快照 + 本次 diff，可复刻 |
| R-7 | 后端 | `PATCH /api/projects/{project_id}/recordings/{recording_id}/sentences/{sentence_id}` | `{"text":"修改后的单句","speaker":"可选，发言人","advance_to":"可选，0/1/2","source":"可选，仅 ai_polish"}` | `{"sentence":{...},"version":{...},"current":"1.2"}` | 单句文字/发言人修改；成功后自动提交新版本（阶段内序号 +1）。带 `advance_to` 时把版本推进到该阶段（只增不减）；`source=ai_polish` 时版本说明标注「AI 纠错采纳」。**转写中（transcribing）也可修改已出现的句子**：直接落盘、返回 `version:null`，不逐句生成版本，整段结束后统一提交 0.1；转写线程每 2 秒/每 3 句合并一次新句子，不会覆盖用户已改内容 |
| R-8 | 后端 | `PATCH /api/projects/{project_id}/recordings/{recording_id}/speakers` | `{"action":"create","name"}` 或 `{"action":"rename","from","to"}` 或 `{"action":"merge","from","into"}` 或 `{"action":"assign","sentence_ids":[...],"speaker"}` | `{"sentences":[...],"speakers":["发言人1","发言人2"],"version":{...},"current":"0.3"}` | 发言人花名册：`create` 先登记名字（不改句子、不提交版本），`rename` / `merge` / `assign` / 单句拆分各提交一个版本；名称重复 409 |
| R-9 | 后端 | `GET /api/projects/{project_id}/redaction` | 无 | `{"categories":[RedactionCategory…]}` | 项目级脱敏类别模板（首次访问写入 4 个建议起点标签） |
| R-10 | 后端 | `POST /api/projects/{project_id}/redaction` | `{"categories":[{id,name,placeholder,color,enabled}…]}` | `{"categories":[...]}` | 保存类别模板（增删/改名/占位符/颜色/启停）；类别名不能为空、id 不能重复 |
| R-11 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/redactions` | 无 | `{"marks":[RedactionMark…]}` | 录音的脱敏标记（坐标基于原句文字；另随 R-2 详情返回） |
| R-12 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/redactions` | `{"marks":[{sentence_id,start,end,category_id}…]}` | `{"marks":[...],"version":{...},"current":"2.1"}` | 新增标记；越界/与已有标记重叠/类别不存在返回 400；首次标记把版本推进到阶段 2 |
| R-8a | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/speakers/detect` | `{}` | `{"sentences":[...],"speakers":["Speaker 1","Speaker 2"],"version":{...},"current":"0.4","detected":2}` | 对已有录音**重新跑一次本地说话人聚类**（不重新转写）：历史录音没自动分人的可以补上；有变化才提交新版本；只识别出 1 人也可返回（`detected=1`），句子太少/音频丢失 409 |
| R-13 | 后端 | `DELETE /api/projects/{project_id}/recordings/{recording_id}/redactions/{mark_id}` | 无 | `{"marks":[...],"version":{...},"current":"2.2"}` | 移除标记，同样提交版本留痕 |
| R-14 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/polish` | `{"model":"可选，缺省取设置里的 llm_model"}` | `202 {"status":"running","processed":0,"total":480,"message":"…","suggestions":[…]}` | AI 语义纠错改为后台任务：**立即返回 202**，前端用 R-14a 轮询。只返回建议、**不改正文**；用户逐条用 R-7（`advance_to=1,source=ai_polish`）采纳。运行时未安装返回 503（正文为可读原因），转写未完成/无句子 409，模型非法 400；同一录音已在跑时重复 POST 返回当前进度（202） |
| R-14a | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/polish` | - | `{"status":"idle\|running\|done\|error\|cancelled","processed":120,"total":480,"message":"已检查 120/480 句…","suggestions":[…],"model":"qwen3-4b","error":""}` | 轮询 AI 纠错进度：每批结束 `suggestions` 追加、`processed` 前进，`done` 后即完整结果。任务在内存中，后端重启后返回 `idle` |
| R-14b | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/polish/cancel` | `{}` | `{"status":"running\|cancelled",…}` | 停止纠错：后台线程在下一个生成片段处退出（实测 1 秒内），已完成建议保留在 `suggestions` 里，任务状态变 `cancelled` |
| R-14c | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/polish/dismiss` | `{"sentence_id":"…"}` | `{"status":"running\|done",…}` | 用户已接受/忽略某条建议：从任务里移除该句建议，后续轮询不再返回，任务跑完也不会重现（支持边跑边改） |
| E-1 | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/export?format=md\|json&version={stage}.{seq}` | 无 | 文件流（`Content-Disposition: attachment`） | 默认导出当前版本；带 `version` 导出历史版本；MD 便于送审，JSON 保留发言人/时间戳/句子映射。**阶段 ≥2 且存在标记时，导出的句子已替换为占位符，JSON 不含 `original`** |
| S-1 | 后端 | `GET /api/settings` | 无 | `{"settings":{"identity":{"nick","device_code"},"asr_model","llm_model"},"options":{"asr":[ModelOption…],"llm":[ModelOption…]}}` | 本机身份与模型选择；首次调用生成设备码。`options` 在 `transcriber.ASR_MODELS` / `llm.LLM_MODELS` 唯一定义，前端只渲染 |
| S-2 | 后端 | `PATCH /api/settings` | 同 S-1 `settings` 的任意子集 | `{"settings":{...}}` | 修改昵称 / 设备码 / 模型选择；空昵称不生效；设备码需 4–64 位且只含 `A-Za-z0-9._:-`。`asr_model` 不在 `ASR_MODELS`、`llm_model` 不在 `LLM_MODELS` 时返回 400 |
| S-3 | 后端 | `GET /api/models` | 无 | `{"asr":[ModelStatus…],"llm":[ModelStatus…],"jobs":[ModelJob…],"runtime":{"llm":bool}}` | 模型清单：`downloaded` 是否已下到本机、`available` 运行时是否可构建、`jobs` 为最近 20 个下载任务（`running/done/error/cancelled`、`progress`、`message`；LLM 任务另带 `received/total` 字节） |
| S-4 | 后端 | `POST /api/models/download` | `{"kind":"asr\|llm","key":"whisper-small"}` | `{"job":ModelJob}`（202） | 后台线程下载模型；同 kind+key 已在跑时直接返回原任务。未知 key 返回 400。首启引导会自动为缺失的推荐模型调用本接口。LLM 下载任务带真实进度 `received/total`（字节）并把已下载量、速度、剩余分钟写进 `message` |
| S-4a | 后端 | `POST /api/models/jobs/{job_id}/cancel` | `{}` | `{"job":ModelJob}` | 停止 LLM 模型下载：已下载部分保留为 `.part`，再次下载走断点续传；任务状态 `cancelled`。ASR 下载由第三方库执行，不支持中途停止 |
| R-15 | 后端 | `POST /api/projects/{project_id}/live` | `{"name?":"实时录音"}` | `{"recording":{...},"asr_model":"sensevoice-small"}`（201） | 开始实时录音：优先 SenseVoice，其次 Whisper small；**所选档位模型必须已下载**，否则 503 并给出可读原因（不会创建空录音） |
| R-16 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/live/chunk` | **raw s16le 16kHz mono PCM 字节** | `{"sentences":[Sentence…],"duration_sec":12.3}` | 追加 PCM 并按静音切段增量识别。**每次返回整份句子列表**（不是只返回新增）：说话人标签会随句子增多重算，前端整体替换即可；`Sentence.speaker` 实时就有 `Speaker 1/2…`。会话不存在 404 |
| R-17 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/live/stop` | `{"force?":bool}` | `{"recording":{...},"sentences":[…]}` | 收尾：把剩余 PCM 落成 `audio.wav`、跑最后一段识别；一句都没识别到则 `transcribe.status=error`。若设置里选了比实时档更高的模型且已下载，停止后自动用该模型整段精转（覆盖草稿并生成新版本，状态先回到 `transcribing`）；精转失败保留实时草稿 |
| R-21 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/sentences/merge` | `{"sentence_ids":["s1","s2",…]}`；或批量 `{"groups":[["s1","s2"],["s5","s6"],…]}` | `{"sentences":[…],"redactions":[…],"version":{...},"current":"0.4"}` | 手动合并**相邻**句子：按中文书写习惯拼接（中间碎片无标点补「，」，已有标点原样保留；末句无句末标点补「。」，以逗号/分号收尾换成「。」）。`groups` 可一次提交多组（前端「间隔上色」合并）：组内必须相邻、组间不得重叠，每组至少两句，一次只提交一个版本；保留每组首句 id/起始时间与末句结束时间；跨句选择或组间重叠 `400`；被合并句的脱敏标记一并清除。响应与单组一致 |
| R-22 | 后端 | `DELETE /api/projects/{project_id}/recordings/{recording_id}` | 无 | `{"ok":true}` | 删除整条录音（音频、句子、全部版本、脱敏标记）；**只有本进程确实在转写时**返回 409。上次进程被杀留下的 `transcribing` 状态会在启动时自动改成 error，不再永久拦住删除 |
| R-18 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/transcribe` | 无 | `{"recording":{...}}`（202） | 重新转写（转写失败/换了模型后重试）；**覆盖旧句子并生成新版本**，不再追加；已在转写中直接返回当前状态 |
| R-19 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/redactions/suggest` | `{"model?":""}` | `{"suggestions":[{sentence_id,index,start,end,quote,category_id,placeholder}…],"model":"qwen3-4b"}` | AI 智能脱敏：只返回候选片段，**不落盘**；由用户逐条/全部确认后走 R-12。运行时未安装 503，无句子 409 |
| R-20 | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/resegment` | `{"apply":false,"model?":""}` | `apply=false：202 {"status":"running","processed":60,"total":480,"before":480,"after":0,"sentences":[…]}`；`apply=true：200 {"sentences":[…],"before":480,"after":320,"current":"1.1"}` | AI 整理断句：把按停顿切碎的片段合并成可读句子。`apply=false` 起后台任务并**立即返回 202**（前端用 R-20a 轮询，预览边整理边增长，每条结果带 `source_ids` 供左右对照，落盘前剔除）；`apply=true` 按正文签名复用已完成的预览结果（签名对不上或结果丢失才重算），写入阶段 1 新版本。模型只提议分组与标点，服务端校验 id 恰好用一次且不增删文字；转写未完成或有脱敏标记 409，运行时未安装 503 |
| R-20a | 后端 | `GET /api/projects/{project_id}/recordings/{recording_id}/resegment` | - | `{"status":"running\|done\|error\|cancelled","processed":120,"total":480,"before":480,"after":0,"sentences":[…],"message":"…"}` | 轮询整理断句进度：`sentences` 是当前已整理部分的预览，`done` 后为完整结果；`cancelled` 时是已处理部分，**不能 apply**（会丢掉未处理的句子） |
| R-20b | 后端 | `POST /api/projects/{project_id}/recordings/{recording_id}/resegment/cancel` | `{}` | `{"status":"cancelled",…}` | 停止整理断句；已完成部分保留在 `sentences` |
| G-27 | 后端 | `GET /api/groups/{gid}/materials/{mid}/versions/{stage}.{seq}` | `device_code?` | `{"version":{...sentences,diff}}` | 群组材料的历史版本快照；只读/审查者仅能看阶段 ≥2 的脱敏版本 |

### 局域网协作（G 系列）

所有 G 接口都可以用 `device_code` 指定调用者身份：POST/PATCH 放请求体，GET/DELETE 放 query；缺省取本机 `settings.identity.device_code`。前端同一后端下默认就是本机身份。权限不足统一 `403`，实体不存在 `404`，参数不合法 `400`。

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| G-1 | 后端 | `GET /api/groups` | 无 | `{"groups":[GroupSummary…],"identity":{nick,device_code}}` | 本机可见的全部群组 |
| G-2 | 后端 | `POST /api/groups` | `{"name","mode":"authoritative\|replica"}` | `{"group":GroupSummary}` | 建群，创建者为群主，返回 6 位配对码 |
| G-3 | 后端 | `POST /api/groups/join` | `{"code","role":"reader\|reviewer","nick?"}` | `{"group":GroupSummary}` | 凭配对码入群；角色只能只读/审查者，其他角色 400 |
| G-4 | 后端 | `GET /api/groups/{gid}` | 无 | `{"group":GroupSummary}` | 群组详情（含 `my_role/my_role_name/member_count`） |
| G-5 | 后端 | `DELETE /api/groups/{gid}` | 无 | `{"ok":true}` | 仅群主可解散 |
| G-6 | 后端 | `GET /api/groups/{gid}/members` | 无 | `{"members":[…], "roles":{role:Role}, "member_requests":[…], "owner_device":""}` | 成员、角色模板与待群主批准的管理员任免 |
| G-7 | 后端 | `PATCH /api/groups/{gid}/members/{device}` | `{"role"}` | `{"member":…}` 或 `{"pending":…}` | 管理员可任免下级；管理员提名管理员返回 `pending`，等群主 G-9 决定 |
| G-8 | 后端 | `DELETE /api/groups/{gid}/members/{device}` | 无 | `{"members":[…]}` | 不能移除群主；管理员不能移除管理员 |
| G-9 | 后端 | `POST /api/groups/{gid}/member_requests/{rid}/decide` | `{"approve":bool}` | `{"member_requests":[…]}` | 仅群主 |
| G-10 | 后端 | `POST /api/groups/{gid}/roles` | `{"role","name","caps":[…]}` | `{"roles":{role:Role}}` | 自定义五级权限；能力见下；群主必须保留 `roles` 与 `manage` |
| G-11 | 后端 | `GET /api/groups/{gid}/materials` | 无 | `{"materials":[MaterialMeta…]}` | 审查者只返回阶段 ≥2 的材料 |
| G-12 | 后端 | `POST /api/groups/{gid}/materials` | `{"project_id","recording_id"}` | `{"material":MaterialMeta}` | 管理员及以上灌入**当前版本**快照（句子/脱敏/音频路径/阶段/版本） |
| G-13 | 后端 | `GET /api/groups/{gid}/materials/{mid}` | 无 | `{"material":MaterialDetail,"review_mode":bool,"can_play":bool,"approval?":…}` | 审查者返回阶段 ≥2 的脱敏正文、历史截断到阶段 2 之前、`review_mode=true`。`material.has_audio` 表示材料确有可播放音频（≠ `can_play`，后者是已获批授权），申请按钮按 `has_audio` 启用 |
| G-14 | 后端 | `POST /api/groups/{gid}/materials/{mid}/proposals` | `{"sentence_id","after"}` | `{"proposal":…}` | 读写及以上提交逐句修改提案，不改正文 |
| G-15 | 后端 | `GET /api/groups/{gid}/proposals` | 无 | `{"proposals":[…]}` | 群组内全部提案 |
| G-16 | 后端 | `POST /api/groups/{gid}/proposals/{pid}/decide` | `{"accept":bool}` | `{"proposal":…,"material":…}` | 需 `merge` 能力；同一句已被覆盖时先标 `conflict` 并返回 409，再次调用即强制采用提案 |
| G-16B | 后端 | `POST /api/groups/{gid}/proposals/merge` | `{"proposal_ids?":[…],"mine_only?":bool,"force?":bool}` | `{"merged":[…],"conflicts":[…],"skipped":[…],"versions":{mid:"2.3"}}` | 需 `merge` 能力；批量合并。`proposal_ids` 省略即全部待处理，`mine_only` 只合并自己提交的；pending 且该句已被他人改动 → 标 `conflict` 跳过，不覆盖他人改动；同一材料的多条提案合成**一个**新版本 |
| G-17 | 后端 | `POST /api/groups/{gid}/materials/{mid}/merge` | `{"parent","sentences":[…],"force?":bool}` | `{"status":"merged\|conflict","conflicts?":[…],"version?"}` 或 `{"material":…}` 错误 | 有副本模式的节点三方合并（base/current/incoming）；冲突返回 `status=conflict` 并列出 `base/current/incoming`；`force=true` 时冲突句采用本地版本 |
| G-18 | 后端 | `POST /api/groups/{gid}/materials/{mid}/playback` | `{"mode":"burn\|permanent\|timed","days?":1~365}` | `{"approval":…}` | 申请播放。申请者**自己有 `approve` 能力**（群主 / 管理员）时直接返回 `status=approved`（`auto_approved=true`，仍然留痕），不必自己批自己；其他人返回 pending，同一设备已有 pending 时 409 |
| G-19 | 后端 | `GET /api/groups/{gid}/approvals` | 无 | `{"approvals":[…]}` | 有 `approve` 能力看全部，否则只看自己的申请 |
| G-20 | 后端 | `POST /api/groups/{gid}/approvals/{aid}/decide` | `{"approve":bool}` | `{"approval":…}` | 需 `approve` 能力；timed 批准时写入 `expires_at` |
| G-21 | 后端 | `POST /api/groups/{gid}/approvals/{aid}/consume` | 无 | `{"approval":…}` | 阅后即焚在 `<audio>` 播完后由前端上报；未上报前不会失效 |
| G-22 | 后端 | `GET /api/groups/{gid}/materials/{mid}/audio?approval_id={aid}` | 可选 `Range` | 音频字节流（`200`/`206`） | **门禁**：审批不存在/非申请设备/已用/已过期/材料无音频一律 403，页面拿不到直链；支持 Range |
| G-23 | 后端 | `GET /api/groups/{gid}/access` | 无 | `{"access":[…]}` | 访问留痕，需 `members` 能力；上限 500 条 |

### 单次 / 单材料授权（PRD 12.4，G 系列延伸）

长期角色模板之外的临时放权：`uses=1` 即单次，`scope=material` 即只对指定材料生效。过期 / 撤销 / 次数用完自动失效，不删记录。发放与撤销都需要 `approve` 能力。

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| G-24 | 后端 | `GET /api/groups/{gid}/grants` | 无 | `{"grants":[Grant…]}` | 有 `approve` 看全部，否则只看发给自己的 |
| G-25 | 后端 | `POST /api/groups/{gid}/grants` | `{"device_code?","target","caps":[…],"scope":"group\|material","material_ids?":[…],"uses?":1~999\|null,"days?":1~365\|null,"note?"}` | `{"grant":Grant}` | **`target` 是收授权的成员设备码**（不是调用者）；`caps` 只能取 `view/edit/submit/material`；`scope=material` 必须给存在的 `material_ids`；`uses=null` 表示不限次 |
| G-26 | 后端 | `DELETE /api/groups/{gid}/grants/{grant_id}` | `{"device_code?"}` | `{"grant":Grant}` | 软撤销：写 `revoked/revoked_by/revoked_at`，记录保留可审计 |

`Grant = {id,device_code,nick,caps,scope,material_ids,uses,used,expires_at,note,created_by,created_at,revoked,revoked_by?,revoked_at?,exhausted_at?}`。

### 局域网节点发现与跨机同步（N 系列）

无中心服务器、数据只在局域网内（PRD §5 / §12.2 / §12.3）。每个后端是一个节点：UDP 广播互相发现（默认端口 7851，可用 `LISTEN_WRITING_DISCOVERY_PORT` 覆盖；广播被交换机拦截时可手工登记 IP），默认 HTTP 端口 7850（`LISTEN_WRITING_PORT`）。

- **无副本群组**（`mode=authoritative`）：群主节点是唯一权威，其他节点的写请求由本机原样转发给群主；群主离线返回 `503 {"error":"…","code":"owner_offline"}`。
- **有副本群组**（`mode=replica`）：每个节点持有完整副本，改动后互推快照，按修订号（`rev` / `revs`）判断祖先、句子级三方合并；真冲突保留本地文本，并把对方文本写成 `status=conflict` 的群组提案交给人决定。
- **同人多设备**：昵称 + 设备码完全一致视为同一个人，自动同步项目、录音、音频（仅对这类设备开放）。
- 非回环地址只开放 `/api/peer/*`、`/api/groups*`、`/m`、`/api/leaf/verify` 与 `/api/health`、`/api/version`，以及已配对手机带 token 的 `/api/projects*`；其它接口返回 `403 {"code":"local_only"}`。

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| N-1 | 后端 | `GET /api/peer/info` | 无 | `{"instance","http_port","identity":{nick,device_code},"groups":[gid…]}` | 节点自述；手工登记时先拉这个 |
| N-2 | 后端 | `GET /api/peers` | 无 | `{"instance","http_port","discovery_port","identity",…,"peers":[PeerNode…]}` | 当前在线节点（15s 心跳 TTL）；`PeerNode.online / base_url / same_identity` 由后端计算 |
| N-3 | 后端 | `POST /api/peers` | `{"url":"192.168.1.8:7850","device_code?","nick?"}` | `{"peer":PeerNode,"peers":[…]}` | 手工登记：主动请求对方 `/api/peer/info`；连不上 `502` |
| N-4 | 后端 | `DELETE /api/peers/{key}` | 无 | `{"peers":[…]}` | `key` 可以是 `instance` 或 `device_code`（自动 URL 解码） |
| N-5 | 后端 | `GET /api/peer/groups/by-code/{code}` | 无 | `GroupDetail` | 凭配对码向节点要群组快照；不存在 `404` |
| N-6 | 后端 | `GET /api/peer/groups/{gid}/snapshot?device_code={device}` | 无 | `{"group":…}` | 拉取群组快照（`collab.CollabError.status` 透传） |
| N-7 | 后端 | `POST /api/peer/groups/{gid}/snapshot?device_code={device}` | 群组快照 JSON | `{"group":…,"changed":bool}` | 收到对方推送后本地合并；有副本模式回推一次 |
| N-8 | 后端 | `POST /api/peer/groups/{gid}/join` | `{"code","device_code","nick","role"}` | `{"group":…}` | 跨机入群；配对码不匹配 `403` |
| N-9 | 后端 | `GET /api/peer/projects?device_code={d}&nick={n}` | 无 | `{"projects":[{…,"recordings":[…]}]}` | **仅同人设备**；不一致 `403` |
| N-10 | 后端 | `GET /api/peer/projects/{pid}/recordings/{rid}/bundle?device_code={d}&nick={n}` | 无 | `{"project","recording","sentences","redactions","categories","versions"}` | 同人同步单条录音完整包 |
| N-11 | 后端 | `GET /api/peer/projects/{pid}/recordings/{rid}/audio?device_code={d}&nick={n}` | 可选 `Range` | 音频字节流（`200`/`206`） | 同人同步音频本体 |

`PeerNode = {key,device_code,nick,host,port,instance,groups,via,last_seen,online,base_url,same_identity}`；`via` 为 `udp` / `manual`。

### 手机 / 平板叶子节点（M 系列）

手机不跑模型、不存整库：与电脑连同一个 Wi‑Fi，用浏览器打开 hub 提供的 `/m`，输入电脑设置页显示的 6 位配对码换取 token。之后手机上的读写直接落到电脑端（同源 `/api/projects*`），电脑刷新即见最新稿。

| 编号 | 方向 | 路径 · 方法 | 请求 | 响应 | 备注 |
|---|---|---|---|---|---|
| M-1 | 后端 | `GET /api/leaf/info` | 无 | `{"code":"123456","urls":["http://192.168.1.8:7850/m"],"port":7850}` | 含配对码，**仅回环**可读，不能暴露给同网段设备 |
| M-2 | 后端 | `POST /api/leaf/verify` | `{"code":"123456"}` | `{"ok":true,"token":"…"}` | 配对码错误 `403`；同一后端 10 分钟内错 10 次 `429` |
| M-3 | 后端 | `GET /m` | 无 | `text/html`（自包含移动端页面） | 无需 token；页面内完成配对，供手机浏览器直接打开 |
| M-4 | 后端 | `/api/projects*`（GET / POST / PATCH / DELETE） | 同 R 系列 | 同 R 系列 | 需带 `X-Leaf-Token`（或 `?leaf_token=`）；token 不正确 `403`。设置、模型、群组等本机专属接口仍不对局域网开放 |
| M-5 | 后端 | `GET /api/projects/{pid}/recordings/{rid}/audio?leaf_token={token}` | 可选 `Range` | 音频字节流（`200` / `206`） | 手机端边听边改：`<audio>` 无法自定义请求头，token 走 query；支持 `Range`，点句可跳到该句起点 |

配对码与 token 持久化在 `data/leaf.json`：重启后端不必重新配对；删除该文件即吊销所有手机授权。手机页支持逐句编辑、改发言人、新增发言人、相邻多句合并、整段音频播放（点句跳转、上一句/下一句、拖动进度），并每 5 秒轮询同步电脑端改动（内容无变化不重绘，播放与滚动不被打断）。

`RoleCaps`：`view / edit / submit / merge / material / approve / members / roles / review / manage`。默认五角色 `owner/admin/editor/reader/reviewer` 可改名与增删能力（权限模板不硬编码）。

`ModelOption = {id,label,min_ram,speed,note,available}`；`available` 由 `transcriber.asr_options()` 用 `importlib.util.find_spec` 实时探测（sherpa-onnx / torch / transformers）。为 `false` 时前端置灰并显示「本机运行时未安装」，重新运行启动器会自动补装；仍可选择，但转写会返回明确错误，不假装成功。

`RedactionCategory = {id,name,placeholder,color,enabled}`；`RedactionMark = {id,sentence_id,start,end,original,category_id,category_name,placeholder,color,timestamp}`。`start/end` 以**原句文字**为坐标（渲染时不替换、只加彩色底纹，保证选区坐标不漂移）；`original` 只用于界面回退与 diff，导出物必须剥离。

> R-1 是唯一的非 JSON 请求：请求体是音频原始字节，`name` 带原文件名（如 `访谈1.mp3`）、`format` 取值见下方格式白名单。前端用 `fetch` 把 `File` 直接作为 body，参数走 `URLSearchParams`（自动 UTF-8 编码）。
>
> **文件名禁止放 HTTP 头**：头字段只能是 ISO-8859-1，中文文件名会让浏览器 `fetch` 直接抛 `TypeError: Failed to read the 'headers' property ... non ISO-8859-1 code point`（用户实测踩过）。后端仍兼容读取旧的 `X-Filename` / `X-Format` 头，仅为过渡，新代码不要再发。

**音频格式白名单**（`X-Format` / 扩展名，改任何一处必须同步其余三处）：
`wav / mp3 / m4a / wma / flac / ogg / opus / aac / aiff`
- 定义处：后端 `main.AUDIO_FORMATS`（唯一权威来源）
- 同步处：前端 `api.ts` 的 `AUDIO_FORMATS`、`App.tsx` 上传 `input` 的 `accept`、本文件 R-1
- 解码：全部由后端 PyAV（faster-whisper 内部解码层）原生解码，用户不需要自己转格式

## 数据目录结构（人可读文本）

```
data/
  models/
    whisper-{size}/                     # 可选：离线模型目录（存在则优先使用，不联网下载）
    hf-cache/                           # 联网下载的模型缓存（HF_HOME 指向这里，换机拷走文件夹即带走）
  projects/
    {project_id}/
      project.json                      # 嵌套 → JSON
      recordings/
        {recording_id}/
          recording.json                # 嵌套 → JSON（含时长 / 格式 / 转写状态）
          audio.{ext}                   # 音频二进制（唯一落目录的二进制）
          sentences.csv                 # 行式 → CSV（列：id,recording_id,index,text,start_ms,end_ms,speaker）
          transcript.md                 # 正文稿 → Markdown
          versions/
            {stage}.{seq}.json          # 嵌套 → JSON（版本：diff + 完整句子快照，可复刻）
  settings.json                         # 本机身份（昵称 + 设备码）与模型选择
  groups/
    {group_id}/
      group.json                        # 群组：配对码 / 模式 / 角色模板 / 成员 / 临时授权 grants / 材料快照（含 rev/revs）/ 提案 / 审批 / 留痕
```

- 模型查找顺序：`LISTEN_WRITING_MODEL` 环境变量 → `data/models/whisper-{size}/` 本地目录 → 联网下载（官方 HuggingFace，失败降级 hf-mirror.com），缓存落在项目文件夹 `data/models/hf-cache/`（不写系统盘的用户目录）。SenseVoice 在 `data/models/sensevoice/`（只留 int8），Qwen3-ASR 在 `data/models/qwen3-asr-0.6b/`。
- 项目版本号 `stage.seq`（阶段.阶段内序号）：阶段 0 初始转写落 `versions/0.1.json`；每次单句修改在同一阶段内 `seq+1`（如 `0.2`）；阶段升级时 `seq` 重置为 1（如 `1.1`）。
- 版本 JSON 必含：`version/stage/seq/parent/author_nick/timestamp/message/diff/sentences`。`diff` 形如 `[{sentence_id,index,op:"replace",before:{...},after:{...}}]`；`sentences` 为该版本完整快照，用于任意两版复刻。
- 转写状态对象 `transcribe`：`{"status":"pending|transcribing|done|error","progress":0~100,"error":""}`，随 `recording.json` 持久化；`transcribing` 期间进度实时更新，且**已识别的句子会持续写入 `sentences.csv` 并随 R-2 返回**：前端每秒轮询即可边转边看、边看边改，不必等整段结束。

## 字段与命名约定

- **命名**：一律 `snake_case`；`id` 为各实体主键（字符串，如录音 id）。前后端同名字段绝不改名，否则对不上。
- **软件版本号**：四段整数 `frontend / backend / model / data`，各自独立递增；提交时只 bump 对应段（定义见 `backend/models.py` 的 `APP_VERSION`）。
- **项目版本号**（与软件版本号是两码事）：每条录音一条版本线，版本 = `stage.seq`（阶段.阶段内序号），见 `backend/models.py` 的 `VersionRef`。

## 引导部署（bootstrap）

后端不在时，前端首屏渲染引导页（`BootstrapGuide.tsx`），三步把本地后端跑起来：

1. **写入启动文件**：用户点按钮选一个空文件夹，页面把嵌入的文件一键写进去（File System Access API；不支持的浏览器逐个下载兜底）。写入清单 = `frontend/src/bootstrapFiles.ts`，由 `frontend/scripts/embed-backend.mjs` 在 build 时从仓库生成：
   - `backend/{main,models,storage,transcriber,preload,llm,collab}.py`
   - `requirements.txt`（写到用户文件夹根目录，启动器在根目录执行 `pip install -r requirements.txt`）
   - `start-windows.bat` / `start-mac.command` / `start.sh` / `README.md`（来源：仓库 `bootstrap/`）
2. **运行启动器**：Windows 双击 bat；macOS 终端 `bash` + 拖入 `.command`；Linux `bash start.sh`。启动器**不要求系统已装 Python**：首次自动下载便携 CPython 到用户文件夹 `.runtime/` → 依赖装进这份运行时 → `python backend/preload.py` 预下载模型（失败不阻塞）→ 启动 `backend/main.py`。
3. **自动重连**：后端离线期间前端每 2 秒探测 `/api/health`，通了自动进入主界面。

### 自动检查更新（update）

已部署的用户不需要重新下载文件就能跟上新版本：

1. **检查**：构建时 `embed-backend.mjs` 从 `backend/models.py` 读出 `APP_VERSION` 写进 `bootstrapFiles.ts` 的 `BUNDLE_VERSION`；页面连上后端后比对 `/api/version` 的 `frontend` 段，落后就显示顶部横幅「本地后端还是旧版本」。检查只读，不改文件。
2. **写入**：用户点「更新本地文件」后，用 IndexedDB 里存过的目录句柄（引导页写入时保存）申请一次写权限；没有句柄或权限被拒时回退到「重新选文件夹」。只重写**内容有差异**的文件，绝不碰 `data/`、`.runtime/` 与用户其它文件。
3. **启动器不覆盖**：`.bat` / `.sh` / `.command` 即使有差异也不写回（Windows 的 cmd 边读边执行，覆盖正在运行的 bat 会让命令错位），横幅会提示用户重新写入一次。
4. **重启**：写完后 `POST /api/restart`，启动器收到退出码 86 后重新 `pip install` + 重启，页面轮询 `/api/health` 自动恢复。旧版后端没有该接口（404），此时横幅提示用户手动关闭窗口重开一次；之后即可自动重启。

> 版本纪律：任何嵌入文件（后端代码 / requirements / 启动器 / README）有改动，都必须 bump `APP_VERSION.frontend`，否则页面不会提示更新。

约束：
- 启动器假设目录结构为「用户文件夹根目录下有 `backend/` 与 `requirements.txt`」，改嵌入文件布局必须同步改启动器与 embed 脚本。
- 后端 / bootstrap 源码改动后重新 `npm run build` 即重新嵌入，无手工同步步骤。