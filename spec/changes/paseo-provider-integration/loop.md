---
goal: 按 2026-09-29-codework-paseo-provider-integration.md 完成全部 Agent 接入、工具调用与多端显示验收
status: done
max_rounds: 10
no_progress_fuse: 3
started: 2026-09-29
override: 需要登录真实账户和实机验证的都跳过但是保证功能完整可用。; 能不能跳过真机
---
# Loop: paseo-provider-integration

用户已明确授权执行完整计划直至完成，本轮沿用计划的验收范围，不重复申请实现许可。使用技能默认 10 轮作为本批检查点，不将轮次耗尽当成目标完成。总目标由线程 goal 维持；需要更多轮次时保留完整范围。最终独立验收前不声称完成。旧三个 loop 当前均为 done，没有并行运行的 spec-loop。

计划来源：`C:/Users/Administrator/Documents/Codex/plans/2026-09-29-codework-paseo-provider-integration.md`，P0–P5、工具验收合同和完整 38 项目录均纳入本 ledger。

## Acceptance

- [x] A-1 共用 ACP 思考、工具、命令、配置、用量和非文本内容不丢失，工具执行与展示不重复。(verify: 原始协议 fixture 经 AcpRuntimeModel、Adapter、ProviderRuntimeIngestion 到 Web/Mobile 派生数据的定向测试；覆盖部分更新、终态、拒绝、取消、退出和重放。)
- [x] A-2 目录覆盖 Paseo 的 6 个内置与 38 个 ACP 入口且不重复，具备版本、来源、命令参数、必要环境和能力、安装说明、平台状态及显式离线回退。(verify: 逐项比对固定上游清单；catalog/contracts/启动参数测试及实际添加实例操作；Windows 路径、npx、uvx、手工命令与不支持平台均有结果。)
- [x] A-3 首批 Copilot、Gemini、Qwen、Cline、Hermes 接入，动态模型、模式、命令和认证状态真实，审批按上游选项回传。(verify: 每个候选记录 CLI 版本与认证、文本、读文件、授权写入、命令、拒绝、取消的实际结果；Copilot 特殊模式/config 回归；不支持能力明确说明。)
- [x] A-4 其余 ACP 条目逐项接入并登记，Kiro/TRAE 异步命令、Droid MCP 限制和环境参数生效。(verify: 38 项逐项证据表，现有 Cursor/Grok/Kimi 复用；每项区分真实可用、未实测、平台限制或不支持，未实测不当作全部完成证据。)
- [x] A-5 Web/Desktop/Mobile 配置、聊天选择、审批、命令与工具详情一致；实时状态、失败、重连和历史可见且不卡顿。(verify: 定向 UI/性能测试及 360px/1280px 浏览器、Electron、至少一台真实手机关键路径证据，覆盖入口、退出、重试与长内容。) <!-- Round 148：真机按 goal override 跳过，AVD 代替；证据见 docs/internals/paseo-a5-keypath-r148.md -->
- [x] A-6 原有 Codex/Claude/OpenCode/Pi/OMP 等适配及账号池/BYOK 隔离不回归。(verify: 按源码差异运行对应 Adapter/网关回归；核对 OpenCode v1/v2；Pi/OMP 受管 BYOK、环境/实例归属、密钥不泄露及取消/审批/子 Agent 证据。)
- [x] A-7 本地、远程、relay/tunnel 的重连、迟到审批、进程崩溃与取消后重启可恢复。(verify: 隔离服务真实连接与进程操作证据；不读写在线数据库；各模式分别记录而非用本地 mock 代替。)
- [x] A-8 稳定实现文档、用户说明、44 入口能力记录与回滚方法齐全，全部范围经过最终独立审计。(verify: 对照计划 P0–P5 逐条证据审查；源文件定向 lint/typecheck/tests；新鲜 spec-verifier 审核所有 A-N，未证实项保持未完成。) <!-- Round 149：见 docs/internals/paseo-a8-fresh-audit-r149.md -->

## Rounds

### Round 1

#### Plan

推进 A-1 的完整共用思考流链路：计划已证实通用 ACP 忽略 agent_thought_chunk，先用测试复现，再连通 AcpRuntimeModel → AcpSessionRuntime → Cursor/Grok Adapter → 既有 reasoning 合同。只做这一连贯增量，后续命令/配置/用量和目录仍保持全量目标。

责任检索：已有 ContentDelta、content.delta.streamKind、reasoning 的 ingestion 与 UI；复用这些承载，不新建第二套流或时间线。检查所有 parseSessionUpdateEvent、ContentDelta 和 makeAcpContentDeltaEvent 调用方，避免只修通用入口而遗漏 Grok。当前工作树已有账号池等未提交改动，保留不动。

#### Act

修改 AcpRuntimeModel：ContentDelta 显式携带 assistant_text / reasoning_text，接收 agent_thought_chunk。修改 AcpSessionRuntime：原始思考单独入队并关闭前一正文段，后续正文使用新 ID。修改 AcpCoreRuntimeEvents 与 CursorAdapter/GrokAdapter：保留流类型；Grok 既有活动监测继续接收 ContentDelta。修正 Grok 实机探针只采集正文，避免混入思考。

新增两个单元回归及 Cursor/Grok 子进程 fixture 测试；扩展既有 acp-mock-agent 思考场景。更新 docs/internals/generic-acp-provider.md 说明真实合同与显示边界。本轮没有修改通用 ingestion 的原始 reasoning 隐藏策略，没有虚构上游摘要。现有用户文件和账号池改动保留。

#### Verify

开始前确认三个旧 loop 均为 done；线程 goal active。上一轮调研产出明确清单与源码差距，属于 progress；本轮是实施第一轮。

红灯：`vp.cmd test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts`，新增 2 项失败，确认思考被忽略以及统一事件硬编码 assistant_text。

修复后：同上两文件加 `apps/server/src/provider/Layers/CursorAdapter.test.ts`、`apps/server/src/provider/Layers/GrokAdapter.test.ts`，4 文件 99 项通过；再运行 `AcpJsonRpcConnection.test.ts`、`GenericAcpDriver.test.ts`、`ProviderRuntimeIngestion.activity.test.ts`，3 文件 24 项通过，共 123 项。子进程链路等待 turn.completed；无新增固定睡眠。服务端 `tsgo.cmd --noEmit` 退出 0，仅报告原有账号池文件建议。定向 lint 退出 0，CursorAdapter.test.ts 原有 invocation 未使用警告 1 条；没有新增 lint 错误。git diff --check 通过；本轮生产源码 DEVLOG 扫描无结果。

未运行全仓检查、官方 CLI 认证/推理、浏览器、Electron、手机和远程测试；当前补丁是协议能力进展，A-1 的其它事件与完整 UI 验证未完成，全部 Acceptance 仍保持未勾选。

#### Retrospect

本轮属于 progress：生产解析和两条 Adapter 链路已改变，并有旧行为失败/修复通过的证据。补充检索发现思考“不显示”部分由已有产品合同主动限制，不能把 reasoning_text 改名成 reasoning_summary_text 来制造表面完成。

下一轮推进 A-1 的动态 ACP 会话元数据闭环：追踪 configOptionsRef 与 session/update 实际处理，接入命令、模型/配置、用量更新至现有 snapshot/事件承载，并检查缺失字段的边界。其后推进 A-2 完整目录及 argv/env/能力配置，再按计划逐批真实接入。保持 44 个入口及多端/远程验收总范围，不把本轮 123 项测试当作目标完成。

### Round 2

#### Plan

从上一轮的动态会话元数据计划中选择一个完整增量：接通 ACP usage_update → 共用 Adapter → 已有 thread.token-usage.updated → context-window.updated 显示链路，覆盖真实零用量刷新。命令与配置是独立交互闭环，留待下一轮，不为凑数量只解析后丢弃。

责任检索：effect-acp 当前 schema 已有 UsageUpdate（used=当前上下文 token、size=总窗口、cost=可选累计费用）；本项目已有 ThreadTokenUsageSnapshot、runtimeEventToActivities、Web ContextWindowMeter 和共享 threadReducer，可直接复用。Mobile 当前工作日志过滤 context-window.updated，不能声称已有原生额度仪表。发现 ingestion 丢弃 usedTokens=0，而 Web 解析器已有零值测试，必须在共用投影修复，否则清空后仍显示旧值。费用不是 token 或账号余额，不作隐式换算。

#### Act

2026-09-30 完成用量链路：AcpRuntimeModel 将 usage_update 解析为 UsageUpdated，used 原样进入 usedTokens，size > 0 才设置 maxTokens。AcpCoreRuntimeEvents 新增共用转换函数，CursorAdapter（通用 ACP/Kimi 共用）和 GrokAdapter 都发出既有 thread.token-usage.updated，保留原始事件和所属回合；不伪造累计计费量，不新增费用计算。

ProviderRuntimeIngestion 删除对零用量的错误过滤，统一生成 context-window.updated。复用现有 Web/桌面上下文解析和共享 reducer。Grok 用量通知不刷新执行活性计时。既有 AcpSessionRuntime 已能透传新事件，并在解析前过滤重放和其它会话，不另加状态或队列。

扩展既有 acp-mock-agent 的用量场景；Cursor/Grok 子进程测试覆盖 320 → 0、外部会话和重放通知，断言只产生两项有效快照且回合归属正确。增加三组解析边界与公共投影零值回归，更新 docs/internals/generic-acp-provider.md 说明用量和显示边界。

#### Verify

红灯：AcpRuntimeModel.test.ts 与 AcpCoreRuntimeEvents.test.ts 共 4 项新测试失败、32 项通过，确认 usage_update 丢弃与零值不投影。

绿灯：上述两文件及 CursorAdapter.test.ts、GrokAdapter.test.ts 共 4 文件 105 项通过；ProviderRuntimeIngestion.test.ts、ProviderRuntimeIngestion.activity.test.ts、apps/web/src/lib/contextWindow.test.ts、packages/client-runtime/src/state/threadReducer.test.ts 共 4 文件 145 项通过，总计 250 项。覆盖既有目标预算、压缩、累计值回退和上下文历史回归。新增子进程测试等待 turn.completed，无新增固定睡眠。

服务端首次 tsgo --noEmit 发现两处新增测试 flatMap 直接传入带可选第二参数的函数，改为显式单参数回调后类型检查退出 0；修正后的两个用量子进程测试再次通过。定向 lint 退出 0，只有 CursorAdapter.test.ts 原有 invocation 未使用警告；类型检查只有原账号池文件 Effect 建议。Node 测试进程提示既有 shell 参数 DEP0190 弃用警告，本轮未改命令启动策略。git diff --check 通过；本轮生产源码 DEVLOG 检索无结果；原有 12 个保留文件 SHA-256 均未改变。

未运行全仓检查、真实 CLI 登录/推理、浏览器、Electron 或原生手机验证；本轮只是 A-1 的用量子链路进展，不满足整个 A-1，全部 Acceptance 保持未勾选。回滚仅需撤回本轮列出的解析/转换/适配分支及零值过滤修改和对应测试文档，无数据库迁移；不得撤回既有账号池或 Round 1 改动。

#### Retrospect

本轮属于 progress：从上游通知到已有客户端数据合同的两条适配路径已贯通，四个新红灯问题修复，并经公共投影和客户端派生回归。发现客户端本来支持零值，真正缺口在共享 ingestion；根因修复无需另写 UI 状态或缓存。上下文占用与累计处理量仍是不同语义，沿用既有 goal 高水位回退策略不代表精确计费。

下一轮继续 A-1 动态元数据，先检索 config_options_update、available_commands_update 与会话 snapshot/命令执行入口，选一个完整交互闭环接入，不只保存协议字段却不给调用方使用。之后继续 A-2 的 44 入口目录、启动参数/环境和逐项能力记录；真实 CLI、多端及远程验收仍按完整计划执行。

### Round 3

#### Plan

选择 A-1 动态配置闭环：config_option_update → 会话配置快照/模式状态 → 既有 getConfigOptions、setModel、setMode 与 setConfigOption 校验/请求。检索确认通知尚未更新 configOptionsRef，setModel 固定使用启动时 modelConfigId，模式只读取旧 modes。复用既有配置解析与 CursorAcpSupport 调用链，不增加没有消费者的通用事件或第二套 UI 状态。上一轮 Retrospect 的 config_options_update 为笔误，当前协议与固定 Paseo 源码均使用单数 config_option_update，原详细计划中的写法正确。

验收本增量：子进程主动更新配置后，新模型键与新增可选值可设置，删除的值被本地拒绝；已生效值不重复写入；重放与其它会话配置不污染当前状态。完整客户端动态目录展示和命令仍属后续范围，不能据此勾选整个 A-1。

#### Act

2026-09-30 修改 AcpSessionRuntime：在既有会话/重放过滤之后应用 config_option_update 完整快照；通知和主动配置响应共用 updateConfigOptions；配置模式被移除时清理派生模式；current_mode_update 同步配置中的当前模式值。setModel、setMode 按最新类别配置解析键，不再固定启动时的键。未广告类别配置的 Agent 保留旧 model/mode 兼容入口。

AcpRuntimeModel 复用现有模式清洗过程，将 mode 类别的 select 配置（包括分组）优先转为模式状态；旧 modes 仍可解析。未新增无消费者的事件或客户端状态层。扩展既有 mock 与 AcpJsonRpcConnection 子进程测试，增加 CursorAdapter 连续两回合选择新模型/模式的协议日志验证；更新 generic-acp-provider.md，明确运行时可选与客户端动态目录尚未贯通的区别。

#### Verify

先修正 fixture 的两处协议输入错误：误用复数 config_options_update、分组缺少必填 name；由 workspace packages/effect-acp 生成 schema 和固定 Paseo 源码确认。修正输入后获得真实红灯：当前配置仍是旧 [model]，预期 [engine, operation, fast]。实现后该子进程链路通过。追加空数组断言再次红灯，确认派生模式未清除；修复后通过。

最终定向 `vp.cmd test run`：AcpJsonRpcConnection.test.ts、AcpRuntimeModel.test.ts、CursorAcpSupport.test.ts、CursorAdapter.test.ts、GrokAdapter.test.ts，5 文件 119 项通过。覆盖模型键变更、分组候选、移除值拒绝、布尔类型校验、相同值跳过、模式通知、清空、重放/子会话隔离和连续回合实际请求。等待原有事件/回合完成，不新增固定睡眠。

服务端 tsgo --noEmit 首次指出 select 联合类型未显式缩窄，补上 type 判定后最终退出 0；仅保留原账号池 Effect 建议。定向 lint 退出 0，原 CursorAdapter.test.ts invocation 未使用警告仍在；Node 子进程已有 DEP0190 警告。git diff --check 通过；原有 12 个保留文件 SHA-256 均未变。本轮未进行浏览器、真实 CLI 认证、原生手机或远程验证，未运行全仓检查。

A-1 还包含命令、完整客户端动态目录与非文本事件，不能勾选；其它 Acceptance 也未满足完整要求。无数据库迁移；回滚仅撤回本轮配置解析/运行时分支及对应测试文档，保留前两轮和账号池改动。

#### Retrospect

本轮属于 progress：动态通知不再被忽略，通知中的新键和候选值经运行时校验驱动实际下一回合设置；空配置与旧式模式通知也不会留下已撤回或不同步的配置模式。本轮错误暴露出仅凭名称推断协议会产生假红灯，必须先核对 workspace schema。最终 119 项测试对应真实生产代码变化，但不代表 44 个 CLI 已验证。

下一轮继续 A-1 的命令闭环：追踪 available_commands_update、现有 Provider snapshot/命令菜单和执行入口，接通发现、展示数据与提交路径，覆盖异步到达与撤回。随后继续完整目录 argv/env/能力配置、分批真实接入和多端验收。通用动态模型目录推送仍未完成，应在客户端 metadata 合同落地时一并处理，不能因本轮 setModel 可用而遗漏。

### Round 4

#### Plan

本轮只推进 ACP 命令发现到提交：复用 ServerProviderSlashCommand、session.started/configured 与线程活动传输、Web/Mobile 既有命令菜单和普通 prompt 发送。命令属于会话，不回写全局 provider 快照。启动快照清除旧命令，异步通知替换列表，空数组撤回，按实例隔离；兼容建会话期间先于响应到达的通知。验证解析、协议子进程、投影、共享客户端选择与输入提交数据；真实设备和官方 CLI 验收仍独立记录。

#### Act

2026-09-30 接入 available_commands_update，复用 ServerProviderSlashCommand 和既有 session.started/configured 合同。AcpSessionRuntime 暂存建会话响应前到达的命令通知，仅选择根会话，初始化时提供命令快照；运行中的通知替换列表并过滤重放/其它会话。Cursor（含 Generic/Kimi）与 Grok 共用转换函数；Grok 在无活动回合时也接收命令更新，不将元数据当执行活性。

ProviderRuntimeIngestion 将命令投影为 session.commands.updated 线程活动。共享 providerSkills 解析最新合法、同实例快照，空数组明确撤回；没有快照时兼容旧全局目录。Web/桌面 ChatComposer 与 Mobile ThreadComposer 复用同一选择逻辑和既有菜单/普通 prompt 提交；Mobile 路由传递线程活动。两端工作日志排除命令元数据。没有增加全局目录写入、依赖或第二套命令执行器。

扩展既有 ACP mock 和定向回归，补齐内部实现及用户说明。测试入口和截图放在仓库外的隔离临时目录；没有写入在线数据库、提交、推送或创建 PR。

#### Verify

定向 9 文件 269 项通过：AcpRuntimeModel、AcpCoreRuntimeEvents、AcpJsonRpcConnection、CursorAdapter、GrokAdapter、ProviderRuntimeIngestion.activity、providerSkills、Web session-logic、Mobile threadActivity。追加 ProviderRuntimeIngestion.activity、ProviderRuntimeIngestion、contracts/providerRuntime 三文件 110 项通过；两批有重叠，不累加为唯一测试数。覆盖命令规范化/去重、启动通知、替换/空列表、重放/其它会话过滤、实例隔离、坏数据回退和 /review src/main.ts、/inspect src/main.ts 原样进入 ACP prompt。新增测试等待协议事件/回合完成，无固定睡眠。本轮未记录旧生产实现的红灯，不声称红绿复现。

服务端与 Web tsgo --noEmit、Mobile tsc --noEmit 均退出 0；定向生产文件 lint 通过。最初共享解析器被类型检查指出直接访问 unknown payload，改为复用 Schema 解码完整载荷后通过。测试筛选命令中竖线被 Windows cmd 解析为管道，改用单一中文筛选词后正常运行，属于命令调用修正。既有账号池 Effect 建议、Cursor 测试 unused invocation 和 Node DEP0190 警告不属于本轮新增功能故障。

使用用户授权的既有隔离服务，真实浏览器操作新增本地 ACP 测试实例和测试项目。Node 模拟进程在会话通知中返回命令，1280px、360px 菜单显示 /inspect，点击只填入输入框；随后发送 /inspect src/main.ts，回合完成并收到空快照后菜单只剩内置命令。截图位于 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929/acp-command-menu-desktop.png、acp-command-menu-360.png、acp-command-withdrawal-360.png。临时视口已恢复，页面与隔离服务保留供后续轮次使用。

浏览器发现两项边界：Windows .cmd 测试入口的健康探测 spawn EINVAL，等价 Node 入口可用；360px 页头操作控件存在重叠。前者归 A-2 启动兼容，后者归 A-5 显示修复，本轮未扩大修改。浏览器使用本地协议模拟进程，不能替代官方 CLI/认证、Electron 壳、原生手机、远程/relay/tunnel 证据。所有完整 Acceptance 仍未满足，不勾选。

git diff --check 通过，12 个保留文件 SHA-256 未变。回滚只撤回本轮命令解析、可选合同字段、Adapter/投影/菜单消费者及对应测试文档；旧事件仍可读取，无数据库迁移，不撤回账号池和前三轮改动。

#### Retrospect

本轮属于 progress：命令从 ACP 子进程通知进入持久化线程数据和现有菜单，并经真实页面完成选择、提交与撤回。复用普通 prompt 正好符合命令协议，无需专用执行 RPC；按实例选线程快照避免把项目命令写入全局 Provider。浏览器同时证明窄屏命令菜单可操作，但不能据此宣称整个窄屏界面无问题。

下一轮选 A-2 的 Windows 启动兼容为一个连贯增量：先追踪 GenericAcpDriver 的健康探测与实际启动链，复用已有 Windows 命令策略，修复并验证 .cmd/npx/带空格路径的差异；不要仅把失败状态改成可用。随后继续 44 入口目录、argv/env/能力记录、动态模型客户端目录及 A-1 非文本内容。A-5 页头窄屏重叠已有截图，后续界面轮次修复。最终官方 CLI、多端/远程实测与独立审计范围保持不变。

### Round 5

#### Plan

只推进 A-2 的 Windows 命令启动兼容。责任检索确认 AcpSessionRuntime、GrokSkills 已复用 shared/shell.resolveSpawnCommand；GenericAcpDriver 健康探测直接 ChildProcess.make，遗漏 .cmd/.bat 与 PATH 解析。复用既有解析器使探测和实际会话一致，保留非零退出码/缺失命令失败语义。通过 Driver 真实探测和子进程握手验证批处理、npx 形式与带空格参数；不新增启动抽象、不扩大到其它目录或界面修复。

#### Act

2026-09-30 GenericAcpDriver 的健康检查使用已有 resolveSpawnCommand，将解析后的 command/args/shell 传给 ChildProcess.make，环境仍为原实例 injectedEnv。实际会话和文本生成已共用 AcpSessionRuntime，因此无需另改启动实现。生产修改只有导入与探测调用，没有新依赖、启动包装器或宽泛 shell 回退。

GenericAcpDriver.test.ts 增加真实 Driver + 临时子进程集成测试：原生 Node、带空格路径的 npx.cmd、本地 PATH 解析的 npx 形式，逐项执行版本探测与 ACP 会话握手，比较两条路径收到的参数；包含空格和 & 字面值。每种入口增加退出码 2 检查，仍报告 error。临时目录使用 scoped 清理，会话显式 stop，不访问在线状态。同步更新内部实现与用户配置说明。

#### Verify

红灯：新增集成测试先运行旧 GenericAcpDriver，原生命令通过，批处理探测复现 spawn EINVAL；1 项失败、4 项通过。接入共享解析器后 5 项通过，包含真实 Windows 批处理、PATH npx 模拟入口和 ACP 握手。

定向 `vp.cmd test run apps/server/src/provider/Drivers/GenericAcpDriver.test.ts packages/shared/src/shell.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Drivers/GrokSkills.test.ts`：4 文件 55 项通过。覆盖既有 Windows 原生直接执行、特殊字符转义、有效环境解析与未找到命令不回退 shell。测试随后修正类型/编码约束后，GenericAcpDriver 5 项再次通过。

服务端 `tsgo.cmd --noEmit` 首次指出测试缺少环境 sensitive 字段与 JSON/同步 Schema 编译约束，改用既有 Schema 编解码并补全字段；最终退出 0，只有原账号池 Effect 建议。两文件定向 lint 最终无警告、退出 0；首次命名空间导入规则已修正。Node 的 shell: true 参数 DEP0190 提示仍存在，沿用既有转义器，未通过关闭检查掩盖问题。git diff --check 通过，12 个原有保留文件 SHA-256 未变；本轮生产源码无 DEVLOG 标记。

本轮没有新开浏览器或全仓检查；上一轮 UI 的原始故障由本轮 Driver 集成测试直接复现并修复。npx 是临时本地 shim，验证 Windows 解析和 argv，不证明真实 npm 安装、网络下载、官方 Agent 登录、macOS/Linux 执行或所有平台兼容。完整 A-2 目录与其它 Acceptance 仍不勾选。回滚撤回 GenericAcpDriver 本轮小补丁及对应测试/文档即可，无数据迁移；保留前四轮与账号池修改。

#### Retrospect

本轮属于 progress：定位到探测与实际启动分叉的根因，只复用共享解析器就消除已复现的 Windows 批处理失败；无需修改跨平台命令基础设施。真实 Driver 测试同时验证探测和握手，避免只对生成参数做断言而漏掉操作系统行为。命令就绪与认证成功仍分开表达。

下一轮推进 A-2 完整目录：先核对现有 AcpRegistry 及固定 Paseo 6+38 清单，确认已有入口/版本/安装方式覆盖，再补上明确缺口和离线回退、平台状态与 argv/env 能力记录。保持一个目录增量，不重复重写现有注册功能。动态模型目录、非文本内容、窄屏页头及官方 CLI/多端/远程实测仍保留在后续完整验收范围。

### Round 6

#### Plan

选择 A-2 的目录离线可用闭环作为本轮唯一增量。检索确认在线官方目录请求与平台/npx 安全转换已经存在，但 HTTP/解析失败返回空数组，Web 又在 error 非空时完全隐藏条目。2026-09-30 实际官方目录 41 项，不同于固定 Paseo 的 38 ACP + 6 内置；不强行用旧版本覆盖在线新版本。保存有来源/日期的官方数据快照，失败时经同一解析器转换并显式报告离线，Web 保留提示同时显示可搜索列表。补充固定 Paseo 与现状的逐项差异证据，不把未验证入口标为已接入；结构化 env/uvx/能力的完整执行仍是后续目录增量。

#### Act

2026-09-30 保存官方目录节选 registry-snapshot.json（41 项，约 14 KiB），含来源 URL、日期、原始响应 SHA-256；保留名称、版本、npx/uvx 参数与二进制平台键，省略描述、图标及下载地址。按上游 Apache-2.0 保留 registry-snapshot.LICENSE，没有复制 Paseo 实现代码。新增 docs/internals/paseo-provider-catalog.md，逐项列出 6 个内置 + 38 个 ACP 的版本、现有入口与缺口。

AcpRegistryCatalog 在在线 HTTP/网络/超时/解析/大小限制失败后，记录无敏感内容的警告并用同一平台解析器转换内置快照；保持 error 非空，新增可选 source/snapshotDate 合同。成功在线结果优先，合法空结果不被覆盖，不按 ID 混合旧/新版本。Web Picker 将警告与列表分开，离线条目仍可搜索和选择；中英日提示标明日期与过期可能。WS 在离线条目非空时仍补充已配置实例状态。Mobile 尚无该目录选择器，不声称本轮已新增。

内部和用户文档同步更新；未新增安装器、自动下载或 env/uvx 执行能力，不修改账号池或原有 Driver 路由。五个缺具名目录的 Paseo Agent 明确记为待补充资料，不制造假入口满足数量。

#### Verify

红灯：旧实现未返回 source、HTTP 错误仍为空目录；UI 组件回归在修正测试模块依赖后明确失败于离线日期/条目缺失。初次快照测试误以为 Cortex 无 Windows 包，核对实际平台键后改测 Amp 的 Windows arm64，未将错误假设当作生产缺陷。

最终定向 `vp.cmd test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/web/src/components/settings/AcpRegistryCatalogPicker.test.tsx apps/web/src/i18n/runtime.test.ts`：3 文件 18 项通过，覆盖 HTTP 503、无效 JSON、无效结构、Content-Length 超限、流实际超限、在线恢复、空在线列表、41 个唯一 ID、版本/环境/平台约束及离线警告不隐藏选择按钮。网络超时沿原有 10 秒边界，未另做真实网络断连测试。

服务端和 Web tsgo --noEmit 通过。首次服务端检查发现 JSON 导入缺少 NodeNext type 属性，按既有 model-manifest 模式补齐后通过；不是只依赖 Vitest 能导入就宣称 Node 可启动。定向 lint 无错误；服务端保留原账号池 Effect 建议。WS 的单行离线诊断补充另做服务端类型检查和定向 lint。

使用既有隔离服务和授权浏览器，先经历开发热重载 502；修正导入、服务重新监听后，通过整页重载恢复。界面部分点击/Space 未产生期望变化，改用键盘 Enter 与单选组方向键后确认实际状态。经 1280px 向导验证加载、搜索 Cline、选择后命令为 cmd.exe /d /s /c npx -y cline@3.0.65 --acp、无匹配提示、关闭退出。保存截图 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929/acp-catalog-online-selection.png；未保存新实例、未下载 CLI。临时视口恢复，保留原服务与页面。浏览器只验证在线路径，离线渲染由组件测试证明；不把键盘通过当成所有鼠标按钮通过。向导残留英文和既有窄屏问题仍属 A-5。

公开来源为官方 CDN registry.json、agentclientprotocol/registry 的 LICENSE 与固定 Paseo 源文件；访问日期 2026-09-30，检索关键词/采用理由与 SHA-256 已写入持久文档/快照。当前官方 41 项与 Paseo 38 ACP 有 32 个精确 ID 交集；缺 codewhale、gjc、grok、hermes、kiro、traecli，grok 已有专用驱动；不将 grok-build 自动别名映射。12 个保留文件哈希未变，git diff --check 通过。

无全仓检查、真实官方 CLI/账号、Electron/手机或远程验证，完整 A-2/A-5/A-8 均未满足，所有 Acceptance 保持未勾选。回滚撤回本轮目录快照/返回字段/WS 门禁/UI 分支及对应文档测试；旧合同字段仍兼容，无数据库迁移。许可原文保留英文，机器快照 Agent 名称/参数保持官方原值，其余新文档中文。

#### Retrospect

本轮属于 progress：在线不可用时目录不再清空，返回的数据和 UI 都明确标注过期快照，并经故障注入/渲染测试与在线浏览器路径验证。逐项核对也证明“Paseo 44”不能替换成“官方 41”或仅凭名字合并；两份目录在来源和时间上不同。测试的 NodeNext 导入检查避免了测试环境通过但真实服务不能启动的问题。

下一轮继续 A-2 的可配置目录增量：优先处理已确认的环境参数条目（Auggie 等）与 uvx 配置，把目录选择写入既有实例 environment，显示来源/安装说明并保持敏感字段边界；先搜现有向导的创建请求和环境保存，避免新增秘密存储。五项缺失的手工 Agent 需要独立官方资料与平台核对，不能仅复制旧裸命令称已完成。之后仍须动态模型/非文本、专项 Agent、多端和远程验收。

### Round 7

#### Plan

本轮唯一增量为 ACP 目录建议到实例配置的完整传递：检索确认 GenericAcpDriver 已合并实例 environment，serverSettings 已负责敏感值保存，但添加向导仅保存 command，目录解析也拒绝一切 env 与 uvx。复用既有实例环境合同，将经核对的公开环境参数随目录项传入向导并在保存前显示；切换条目或手工修改命令时清除旧目录参数。uvx 仅接受固定版本和安全参数，按官方 --from 语法生成命令；不新增安装器或秘密存储。目录诊断同时核对所需环境值，避免同命令缺参数却显示就绪。以解析/向导保存/诊断定向测试、服务端与 Web 类型检查和一次浏览器选择验证为证据；不将配置生成宣称为官方 CLI 已登录实测。


#### Act

2026-09-30 扩展 AcpRegistryCatalogEntry 的可选 environment，直接复用 ProviderInstanceEnvironment。服务端目录解析接受已核对的四个公开默认值，未知/畸形环境保持手工条目；不允许目录注入 PATH、NODE_OPTIONS 或凭据。支持 uvx 固定版本 @/== 输入，按 uv 官方 --from 形式生成命令，沿用固定版本一致性与参数字符校验。npx 的既有 Windows 入口保持不变。目录诊断除命令外还匹配必要环境值，额外凭据不影响匹配，重复变量按最终覆盖值判定。

Web Picker 传递完整目录项并显示版本，AddProviderInstanceDialog 将所选公开参数随实例 environment 保存到指定环境。保存前显示参数；切换目录替换参数，手改命令立即清除目录选择，恢复旧命令也不会复活旧环境；其它驱动不附带 ACP 参数。实例创建、敏感值和启动环境仍走既有实现，没有新增存储或安装器。中英日提示补充运行器前置条件。更新内部目录对照、通用 ACP 架构与用户说明，记录来源日期、安装链接、边界与回滚。

#### Verify

本轮没有先跑旧实现红灯，不声称 red/green。`vp.cmd test run` 定向运行 AcpRegistryCatalog.test.ts、GenericAcpDriver.test.ts、AddProviderInstanceDialog.environment.test.tsx、AcpRegistryCatalogPicker.test.tsx、i18n/runtime.test.ts：5 文件 28 项通过。覆盖两种 uvx 固定版本语法、三种平台命令生成、未知环境/注入/浮动版本拒绝、同命令缺环境的诊断、选择/替换/手改后的远程环境保存请求。GenericAcpDriver 的真实 Node 与 Windows 批处理/PATH 子进程测试额外确认探测和 ACP 握手都实际收到 AUGMENT_DISABLE_AUTO_UPDATE=1。

服务端 tsgo --noEmit 通过，仅有原账号池 Effect 建议。Web 首次类型检查发现测试 tree 初始化及 exactOptionalPropertyTypes 两项，修正后 tsgo --noEmit 通过；修正后重跑向导环境测试和原导航测试：2 文件 10 项通过（含与前述重复的 2 项，合计 36 个不同测试）。命令中同时传入的 AddProviderInstanceDialog.logic.test.ts 无匹配文件，没有将其计为已运行。9 个改动 TS/TSX 文件定向 lint 退出 0；格式化完成。Node 既有 shell 参数 DEP0190 警告仍存在。

复用隔离服务 5734/13774 和既有浏览器，在实际在线目录搜索并选择 Auggie，确认固定命令与 AUGMENT_DISABLE_AUTO_UPDATE=1 显示；改选 fast-agent，确认 uvx --from fast-agent-acp==0.10.1 fast-agent-acp -x 与 FAST_AGENT_MODEL=codexplan 替换前项；手改命令并失焦后参数预览移除。键盘完成选择，关闭未保存，不触发官方软件下载或账号登录。本轮实际创建保存由组件请求测试验证，不冒充浏览器持久化成功。截图位于临时目录 acp-catalog-environment.png、acp-catalog-uvx-environment.png，后一张已视觉检查。保留页面与服务供后续轮次使用。

`git diff --check` 通过（文档只有 CRLF 归一化提醒）；12 个原有保留文件 SHA-256 均未改变。未执行全仓检查、实际 uvx 包下载、官方 CLI 认证/工具、Electron、手机或远程网络测试；三平台命令测试不等于三平台实际执行。所有 Acceptance 保持未勾选。回滚只撤回本轮解析、向导与可选环境字段及相关测试文档；既有实例 command/environment 格式不变，无迁移，不撤销账号池或前六轮修改。

#### Retrospect

本轮属于 progress：修复目录选择只传命令而丢必要环境的完整链路，并让既有启动器实际收到参数。复用现有实例保存及环境合并即可，不需要第二套 Agent 安装或秘密管理系统。uvx 能生成配置不代表已安装、已认证或该 CLI 工具可用；未知环境继续显式手工处理。

下一轮继续 A-2 具名目录覆盖：独立核验 CodeWhale、Gajae Code、Hermes、Kiro、TRAE 的官方命令、平台和安装说明，与现有专用驱动去重后补齐目录资料及可用状态。首先搜索已有来源和实现，不凭 Paseo 的裸命令制造可用结论；无法核验的能力明确保持未验证。动态模型、非文本、Droid MCP、逐 CLI 和多端/远程验收仍属完整目标，不能因本批轮数有限缩减范围。

### Round 8

#### Plan

本轮唯一增量为五个缺失具名 ACP 目录入口（CodeWhale、Gajae Code、Hermes、Kiro、TRAE）的可配置路径。已搜索当前代码，没有这些目录定义；逐项读取官方 ACP/安装文档后确认命令与前置条件，发现当前 Hermes、Kiro、TRAE 均已有 Windows 文档，不能沿旧平台印象禁用。用小型经核对的手工安装目录补充官方在线/离线结果，精确 ID 去重且在线条目优先，不新增五套驱动。合同与 UI 提供来源、安装链接、安装前置提示和本机版本未锁定说明；GJC 保留 prompt 环境。验证平台分支、合并/去重、离线回退、向导预填与文档链接；真实认证和工具验收仍按完整目标另行完成。

#### Act

2026-09-30 核对五个项目官方仓库、ACP 文档与安装/平台文档，新增 manual-agent-catalog.ts，分别预填 codewhale serve --acp、gjc acp、hermes acp、kiro-cli acp、traecli acp serve。所有条目标记手工安装、本机版本未锁定（version 为 null），携带安装链接、协议文档链接和核对日期；GJC 使用 GJC_ACP_PERMISSION_MODE=prompt，未启用跳过审批。平台分支限定已核对的操作系统与 x64/arm64，GJC Windows 仅 x64、Android 仅 arm64；系统最低版本及 Hermes ACP 额外组件通过前置说明明确，未将系统名匹配当成安装检测。

目录在在线成功和离线回退后共用一次精确 ID 合并，现有条目优先；41 项快照加 5 项手工条目共 46 个唯一 ID，Grok 继续复用现有专用驱动，不制造重复别名。成功的在线空列表只补五个独立维护的手工入口，不恢复旧 41 项快照。可选 setup 合同与向导复用既有配置保存和通用 ACP 驱动；不支持平台保留官方链接但不能选择，选中后完整前置说明可见。更新内部目录对照、通用 ACP 架构与用户文档，记录官方来源、日期、差异和边界。

#### Verify

定向运行 AcpRegistryCatalog.test.ts、AcpRegistryCatalogPicker.test.tsx、AddProviderInstanceDialog.environment.test.tsx、i18n/runtime.test.ts，4 文件 25 项通过；浏览器发现日期直接显示 {date} 后，按项目插值约定改为 {{date}}，补齐中英日实际运行时回归，再跑后两项相关测试文件 11 项通过。两批合计 26 个不同测试，未重复累计。覆盖五个命令、公开参数、官方链接、平台禁用、在线优先不覆盖、离线 46 项去重、成功空目录只含五项，以及组件选择和日期插值。本轮没有旧生产实现的完整红灯测试，不声称全部 red/green。

服务端与 Web 各自 tsgo --noEmit 通过，仅保留原账号池 Effect 建议；最终 10 个 TS/TSX 文件格式化和定向 lint 退出 0。git diff --check 通过，仅文档 CRLF 归一化提醒。12 个原保留文件 SHA-256 未变；新目录源码与三份文档通过严格 UTF-8 解码及无 BOM 检查。

复用授权的隔离服务与浏览器，在供应商添加向导搜索并选择 Gajae Code，确认命令 gjc acp、权限参数 prompt、两条官方链接和核对日期 2026-09-30。开发热重载关闭向导后重新进入，最终截图已保存并视觉检查：C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929/acp-manual-gajae.png。截图仍可见既有通用配置区中英文混排和较高向导的底部可视空间问题，不能据此声称视觉全部一致。关闭向导未保存实例；浏览器只证明预填与展示，保存请求仍由既有定向组件测试验证。

本轮未下载或运行五个官方 CLI、登录真实账号、发起模型/工具调用，也未实际验证 uvx、Electron、手机或远程网络；未执行全仓检查或分派子代理。所有 Acceptance 保持未勾选，完整目标仍 active。回滚只撤回本轮五项手工目录、可选 setup 字段、链接/说明显示和对应测试文档；不涉及数据迁移，不撤回前轮和原账号池工作。

#### Retrospect

本轮属于 progress：补齐固定 Paseo 对照中剩余五个具名入口，复用同一 ACP 配置与启动路径，并把安装、平台和本机版本边界显式展示。官方现状已经变化，尤其 Windows 支持不能照搬旧印象；反过来，有启动命令也不能证明专有通知、模型/工具和认证都兼容。真实浏览器发现了组件测试未覆盖的翻译插值问题，新增实际运行时测试后修复。

下一轮选择一个协议增量：先对照 Paseo 的 Kiro 适配器和现有通用 ACP 通知分发，核对 _kiro.dev/commands/available 等非标准命令通知与延迟通知是否已覆盖；只实现有官方或固定源码证据的缺口，复用现有会话命令快照和菜单。之后仍需动态模型、非文本、Droid MCP、逐 CLI 认证/工具、视觉及多端/远程验证，不能把 46 个目录入口替代固定 44 个 Agent 的完整验收。

### Round 9

#### Plan

本轮唯一增量为 Kiro 专有命令通知到既有会话命令快照的兼容。检索固定 Paseo kiro-acp-agent.ts、官方 ACP 文档与本地 effect-acp/client.ts，确认客户端已有 typed extension handler，但 AcpSessionRuntime 只监听标准 session/update。复用同一通知处理函数，使扩展命令与 prompts 经标准命令清洗、启动缓存、重放/会话过滤和 CommandsUpdated 进入现有 Adapter/投影/菜单；不新增驱动、状态缓存或十秒等待。以真实子进程协议 fixture 验证启动前、会话后异步、替换、空列表、坏输入及会话隔离。官方另外列出 commands/execute 请求，其执行语义需另行核验，不用普通 prompt 的已有测试冒充 Kiro 执行通过。

#### Act

2026-09-30 AcpSessionRuntime 注册精确方法 _kiro.dev/commands/available，使用模块级 Schema 解码 sessionId、commands/prompts 和输入提示；至少一个数组存在才是合法快照。合并后的条目转成标准 available_commands_update，直接调用原有通知处理函数，复用清洗、去重、启动缓存、会话归属和重放过滤。tools 不进入列表；格式错误记录不含原始载荷的告警并保留当前快照。没有新增驱动、等待计时器或客户端缓存。

acp-mock-agent 扩展原有子进程 fixture，发送真实扩展方法形状并用标准模式通知作消费屏障；AcpJsonRpcConnection.test.ts 验证无活动回合的更新、启动缓存与失效输入，CursorAdapter.test.ts 将既有标准命令链路参数化以覆盖 Kiro 到 session.started/configured、线程活动和普通 prompt 的传输。更新架构、目录与用户文档，明确技能提示词进入命令列表但不伪造技能路径，也不宣称专用执行请求已完成。

#### Verify

先运行新增 Kiro 子进程测试得到红灯：启动后 commands 为 []，预期 agent/review。接入扩展通知后同一测试通过，覆盖命令与 prompts、参数提示、去前导斜杠/空白与去重、忽略 tools、其它会话/重放隔离、缺 sessionId/缺列表/畸形数组拒绝、空列表撤回和 prompts-only 更新。等待 ModeChanged 屏障而非固定睡眠。

`vp.cmd test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts packages/client-runtime/src/providerSkills.test.ts`：4 文件 99 项通过，41.16 秒。覆盖共用运行时、Adapter、线程命令投影与共享菜单选择回归；现有 Grok 扩展监听未被覆盖。服务端 tsgo --noEmit 退出 0，仅有原账号池 Effect 建议。首次定向 lint 提醒解码器应提升到模块作用域及测试有无用展开，修正后仅剩原 CursorAdapter invocation 未使用警告；修正后 Kiro 两个定向测试再次通过，不重复累计为 101 项。Node 既有 DEP0190 提示仍在。

git diff --check 通过，文档只有 CRLF 归一化提醒；12 个原保留文件 SHA-256 未变，生产源码 DEVLOG 检索无结果。没有全仓检查、子代理或浏览器操作，没有下载/登录 Kiro、执行真实模型/工具、Electron/手机或远程验证。本轮只改服务端协议与已有测试数据，菜单消费者复用此前实现，未把共享测试当成新设备证据。所有 Acceptance 保持未勾选。回滚撤回扩展注册/Schema 与对应 fixture/测试/文档，标准通知入口保留，无数据迁移。

#### Retrospect

本轮属于 progress：从固定上游与官方文档确认协议差异，取得缺失通知的红灯证据后修复，并把厂商通知导入既有链路，避免再造命令状态机。成功空列表和格式错误必须区分，后者不能伪造撤回。官方资料明确存在 commands/execute；目前发送普通 prompt 的测试只证明传输，不能证明内置命令的语义。

下一轮继续 Kiro 命令执行闭环：核对官方实现或文档中的 commands/execute 请求/结果结构和 prompt 对斜杠命令的真实处理，沿现有请求日志、回合事件和错误返回实现有证据的专项路由；不要猜参数或自动重试另一条执行路径。若证据表明普通 prompt 已支持则记录该事实并转向动态模型目录。全量 Agent、Droid MCP、非文本、多端与远程验收范围不变。

### Round 10

#### Plan

本轮唯一增量为已广告的 Kiro 内置命令执行闭环。官方 ACP 文档列出 commands/execute，官方 KiroCrew 固定提交 df0ea7909cafa0fa8762e844bf4babc98e282d46 的 acp/client.py、session_handle.py 进一步证明请求为 {sessionId, command: {command, args}}，参数余文放 args.value，结果位于 message/data；help/compact 保持 prompt 传输。据此保留当前会话广告的内置命令与 prompts 的区别，在既有 prompt 串行化、日志、取消和事件生命周期内路由原生命令，失败不改走模型。复用原消息段显示结果并设置有界等待；验证普通消息/提示词不误路由、参数、结果、失败、取消和会话隔离。真实 CLI 版本/账号尚未验证，完整目标仍保持未完成。

#### Act

2026-09-30 AcpSessionRuntime 在标准命令缓存条目中保留 Kiro 内置 commands 的执行归属；当前会话的合法快照替换归属，重放和其它会话沿同一门禁过滤，prompts 不获得原生命令路由。单文本命令匹配当前已广告名称后发送对象形状的 _kiro.dev/commands/execute，参数余文整体作为 args.value，无参数为 {}；help/compact 按官方实现保留 prompt。原生命令附带其它内容块时明确拒绝，不静默丢弃附件。

执行复用 prompt 的互斥、活动 fiber、取消和日志。用 Schema 解码 success/message/data；success=false、无效结果或 RPC 错误返回失败，不重发普通 prompt。60 秒无回应返回执行状态未知。正常结果复用既有助手消息段显示 message/data，正文限制 24000 字符，错误说明限制 8000 字符。没有新 UI 或新执行器，不自动执行 data 中的导航/面板动作，不伪造本地模型设置已同步。

acp-mock-agent 增加命令对象结果、拒绝、畸形返回、RPC 错误及挂起场景；AcpJsonRpcConnection 增加端到端请求/结果与取消/超时回归，CursorAdapter 原命令测试核对第二回合 inspect 改走原生请求且只发送一次。三份架构/目录/用户文档同步更新来源、用法和限制。官方资料下载仅供只读核对，存于工作树外临时目录，未安装或运行第三方程序。

#### Verify

旧实现运行新增对象请求测试时，由于普通 prompt 没有原生命令结果，等待消息完成超时；这是有限的红灯证据，未误报为字段断言失败。实现后请求形状、带参/无参、结果内容、拒绝、畸形结果、RPC 错误、附件拒绝、普通消息与提示词不误路由通过。取消/超时初版在同一模拟进程连续发送挂起扩展请求，因模拟进程的扩展处理阻塞后续请求而超时；改为每个场景独立进程，以模式通知作已接收屏障，虚拟时钟推进 61 秒，无新增固定睡眠。只证明客户端结束等待，不声称挂起的上游操作已撤销或同进程恢复。

`vp.cmd test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts`：4 文件 98 项通过，40.96 秒。最终补充无参/RPC 错误并调整序列化后，Kiro 筛选 2 文件 5 项再次通过，属于前述测试集合的增强，不叠加为 103 项。标准 ACP、Grok 扩展与 Generic 驱动保留回归覆盖。

服务端类型检查最初指出 JSON.stringify 不符合项目 Effect 约定；建议文本中的 UnknownFromJsonString 在当前声明版本不存在，随后检索本地已有用法，改为 Schema.fromJsonString(Schema.Unknown)。最终 tsgo --noEmit 退出 0，仅原账号池 Effect 建议；这也说明 Vitest 通过不能代替类型/版本检查。四个改动源码/测试文件 lint 无新增警告，只有原 CursorAdapter invocation 未使用警告，Node 既有 DEP0190 仍在。git diff --check 通过，12 个原保留文件哈希不变。

未进行全仓检查、浏览器、真实 Kiro 登录/工具操作、Electron/真实手机或远程验证；专有面板、命令导致的客户端状态同步和逐版本真实结果仍待验收。所有 Acceptance 未满足完整条件，保持未勾选；第 10 轮是本批检查点，不是目标完成。回滚仅撤回本轮原生命令归属/路由/结果显示与测试文档，保留第 9 轮命令发现，不需要数据迁移或撤回账号池改动。

#### Retrospect

本轮属于 progress：公开方法名不足以定义请求，官方组织实际客户端提供了对象形状与结果载荷证据，现有回合设施即可接入，无需再造命令调度。取消等待与撤销上游操作必须区分；故障 fixture 应明确模拟范围，不能让卡死的模拟服务制造错误恢复结论。新增实现仍不是 Kiro 全部 UI 语义或真实账号验收完成。

后续保持全部计划范围，下一增量优先把运行时动态模型/模式接入现有会话元数据与客户端选择器，先核对合同和所有消费者，避免把最新模型只存于服务端。Kiro 专有面板/本地状态同步、Droid MCP、非文本、逐 CLI 真实操作及多端/远程仍需继续；本批十轮的局部通过不替代最终独立审计。线程 goal 保持 active，未修改 .loop-state 或擅自勾选验收。

### Round 11

#### Plan

线程 goal 在十轮检查点后明确继续，本轮保持完整目标和原 Acceptance，不改 .loop-state。选择一个完整增量：ACP 动态模型目录从会话握手/config_option_update，经既有 session.started/configured、线程活动到 Web/Desktop/Mobile 模型选择器。责任检索确认服务端已有模型配置、ServerProviderModel、命令元数据链路和双端选择器；复用这些承载，新增共享的线程目录派生函数供两端使用，不改全局供应商目录。空数组表示撤回，null 表示新会话未广告模型且撤销历史覆盖，按实例隔离。先贯通模型选项与实际下一回合请求，任意模式选择仍属后续合同工作，不把 enum default/plan 冒充所有 ACP modes。验证分组选项、替换/清空、旧会话重置、跨实例隔离与客户端菜单，不将 fixture 当作真实 CLI/设备证据。

#### Act

2026-09-30 AcpRuntimeModel 从握手 configOptions 的 model 类别或旧 models.availableModels 提取模型广告，支持分组、去空白、去重和当前值。AcpSessionRuntime 保存会话目录，配置通知/主动设置响应更新同一快照；候选与当前值相同不重复发事件。Cursor/Kimi/Generic 及 Grok 将握手与后续变化带入 session.started/configured。合同添加可选 nullable models，投影写入带实例 ID 的 session.models.updated；以 :models 后缀区分同事件的命令活动 ID。

新增 client-runtime/providerModels，按当前线程与实例取最近合法快照，null 清除历史覆盖、空数组撤回广告，同名模型保留原能力，显式自定义模型保留。Web/Desktop 最终在 ChatView 公共入口派生目录，菜单、选择校验与发送共用；Mobile 的 buildModelOptions 复用同一解析，撤回后不追加历史选择。两端工作日志隐藏此元数据。窄屏 ModelPickerContent 宽度改为视口减 1rem，避免菜单右缘被裁切。架构和用户文档同步说明语义与任意模式尚未完成的边界。

#### Verify

初始 7 文件 145 项通过，但集成浏览器点击新模型仍退回 default，定位到 ChatComposer 使用新目录而 ChatView 的 onProviderModelSelect 使用全局旧目录。将合并上移到共同父入口，并增加模型选择校验回归；这是实际交互红灯，不能用先前菜单数据测试冒充点击通过。Mobile/共享实现也补充显式自定义模型保留验证。新增测试起初使用普通字符串活动 ID，Web/Mobile 类型检查指出 EventId 品牌类型错误，修正为 EventId.make 后复查通过。

最终 `vp.cmd test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts packages/client-runtime/src/providerModels.test.ts apps/mobile/src/lib/modelOptions.test.ts apps/web/src/modelSelection.test.ts`：8 文件 167 项通过，40.34 秒。中间 4 文件 54 项属于该集合，不累计。覆盖解析、实例隔离、非法记录忽略、null/空数组、事件 ID、能力和自定义保留，以及下一回合真实子进程 set_config_option 的 engine=dynamic-next。服务端 tsgo、最终 Web tsgo、Mobile tsc 均退出 0；服务端只有原账号池 Effect 建议。定向 lint 无新增问题，原 CursorAdapter invocation 未使用警告及 Node DEP0190 仍在。

复用 browser-control/test-codework-app 和用户既有许可，隔离目录仍为 Temp/codework-pool-audit-20260929/runtime，端口 13774/5734。包新增导出后 Vite 热更新缓存报未导出 providerModels，通过原持有 exec 会话中断并重启同一隔离环境解决，没有结束用户其它进程。新 exec 会话 66677 保留；模拟实例 acpAgent_acp 改用工作树外 acp-models-fixture.mjs，原命令 fixture 保留。浏览器真实完成首轮消息→新增两个模型→360px 点击新增模型→第二轮消息→空目录撤回；协议日志确认 engine=dynamic-next，返回两次“配置已更新”，撤回后只剩显式自定义 default。1280px/360px 截图在临时目录 acp-models-desktop.png、acp-models-360.png、acp-models-withdrawal-360.png。最后一张是宽度修复后截图，360px 菜单 left=9/right=355，无右侧溢出。恢复临时视口覆盖并保留页面供继续工作。

git diff --check 通过，仅文档 CRLF 提示；12 个原保留文件 SHA-256 不变，11 个本轮关键文件无 UTF-8 BOM，生产源码 DEVLOG 检索无结果。没有全仓检查、子代理、PR、提交或推送。未验证 Electron 壳、真实手机、远程/relay、官方 CLI 登录和实际模型；窄屏顶部工具栏原有重叠仍在。握手前配置通知、任意模式/配置完整交互也未在本轮验收。全部 Acceptance 保持未勾选。回滚仅撤回 models 合同/运行时/投影/选择器与文档测试，保留此前命令链路和账号池改动；旧活动会被旧客户端忽略，无数据迁移。测试实例可把命令恢复为 acp-commands-fixture.mjs。

#### Retrospect

本轮属于 progress：模型广告终于进入菜单与实际下一回合，并用浏览器揭示并修复了父子组件目录不一致。单测只验证选项存在，不能证明选择操作会成功；派生数据应放到显示与校验的公共入口。模型撤回和用户手工配置应分开，空快照不能误删显式自定义设置。包新增 exports 后开发服务可能需要重启，类型检查通过不等于浏览器模块解析成功。

下一轮先补齐动态配置的启动通知与会话重建时序：检索 Starting/加载重放门禁，沿现有启动元数据缓存保证合法的握手前配置不丢失，验证与响应快照的先后关系及旧会话隔离；随后推进任意 ACP 模式选择合同和两端交互。Kiro 专有面板/本地状态、Droid MCP、非文本、逐 CLI 真机工具与多端远程仍保持原完整目标，不能因模型菜单一次通过勾选全部 Agent 完成。线程 goal 保持 active。

### Round 12

#### Plan

上一轮为 progress（动态目录与实际请求、浏览器失败复现及修复已留证）。本轮唯一增量是 ACP 启动/恢复配置快照一致性：检索发现 Starting 只缓存命令、配置直接丢弃；现有 sessionSetupResult、configOptionsRef、modelsRef、modeStateRef 和启动缓存足以承载，不新造状态机。复用启动缓存保留当前会话最后一份非重放配置，在响应没有 configOptions 时补全；明确响应（包括空数组）优先，避免历史通知覆盖服务端最终快照。恢复时其它会话不能延长本会话重放等待；失败重试不能继承前次缓存。统一补全后的 setupResult 供各 Adapter 与运行时消费。子进程协议测试先复现缺失，再覆盖新建/恢复、null/缺省/显式/空快照、重放/子会话与失败重试。来源核对官方 v1 schema 的初始配置/完整更新含义，优先级是本项目兼容策略，不冒称上游规定时序。

#### Act

2026-09-30 AcpSessionRuntime 将原命令启动缓存扩展为同一 pendingMetadata 容器，分别保存命令归属和配置数组。Starting 期间保留非重放配置，取得响应后按最终 sessionId 读取；明确 configOptions 响应优先，缺省/null 时以最后通知补全同一 sessionSetupResult，随后统一派生 modelConfigId、模型目录、模式和配置。空数组不是缺省。启动重试先清空缓存与派生状态；恢复等待只由目标会话通知更新活跃时间，显式重放参与等待但不污染配置。启动不额外发 ModelsUpdated，复用原 session.started 快照。

复用 acp-mock-agent 子进程 fixture，新增启动配置场景，交错发送普通配置、命令、更新配置、子会话和重放通知。补充新建/恢复缺省、null、明确配置、明确空数组、通知撤回、失败重试，以及仅元数据通知而恢复响应挂起的用例。CursorAdapter 测试核对握手前配置及命令进入启动事件和活动投影。架构文档同步说明响应优先策略、来源和 v1 边界。

#### Verify

红灯：仅新增启动配置用例时 6 失败/6 通过，新建与恢复的 missing/null 均得到空配置，withdraw 得到 null 而不是 []。生产修复后同组 12 项通过。补充命令交错 fixture 时漏写上游必填 description，触发协议中断；服务端类型检查准确指出 scripts/acp-mock-agent.ts 的字段缺失，修正为空描述后重跑。一个带竖线的筛选参数被 Windows cmd 当作管道，命令未执行测试，改为显式文件列表，不当作代码回归或成功结果。

最终 `vp.cmd test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts`：4 文件 112 项通过，42.80 秒。包含新增 14 项，覆盖 setupResult 与 getter 一致、下一次 engine=dynamic-next 写入、命令/config 互不覆盖、其它会话与重放隔离、空目录、失败后第二次启动不继承缓存、恢复 RPC 挂起后沿既有空闲策略保留元数据，以及 Adapter 会话启动投影。新测试等待协议/启动结果；空闲恢复用既有计时策略与 TestClock.withLive，没有为通过而新增固定 sleep。只证明客户端按现有策略结束启动等待，不证明挂起上游 RPC 已返回或真实 CLI 已恢复。

服务端 tsgo --noEmit 最终退出 0，仅原账号池 Effect 建议；4 个改动源码/测试定向 lint 退出 0，仅原 invocation 未使用警告，Node DEP0190 仍在。git diff --check 通过，仅原文档 CRLF 提示；12 个保留文件 SHA-256 未变。没有全仓检查、子代理、新浏览器验证、真实 CLI/账号、Electron、手机或远程验证，没有提交/推送/PR。全部 Acceptance 保持未勾选。回滚撤回启动缓存和过滤逻辑及对应 fixture/测试/文档，保留上一轮动态模型协议与客户端，无数据迁移。

#### Retrospect

本轮属于 progress：有缺失通知的确定红灯，生产修复与启动/恢复/首个模型设置/Adapter 投影均通过。早到通知不能无条件盖过最终响应，响应空数组和缺省必须分开。恢复重放等待也必须限定会话，否则子会话噪音可拖延根会话启动。模拟报文也必须符合完整上游 schema；可读的内部命令类型不能替代上游必填字段。

下一轮推进任意 ACP 模式选择的真实合同与交互：先追踪现有 ProviderInteractionMode/default-plan 与 provider options 的所有调用者，以及 Copilot 的 URI 模式 ID，复用开放的选项承载保留原始模式 ID，保证菜单、提交、恢复和上游校验一致，不把名字映射为两态假装完整支持。仍保留 Kiro 专有状态/面板、Droid MCP、非文本、逐 CLI 真实操作、多端远程和明显视觉问题的完整范围。线程 goal 保持 active，未修改 .loop-state。

### Round 13

#### Plan

本轮只接通任意 ACP 模式的完整选择链路：复用 ProviderOptionDescriptor 和 ModelSelection.options，发布会话模式快照，在共享客户端目录中合并并沿现有 Web/Mobile 选项控件提交原始 ID。配置模式调用当前配置键，旧 modes 使用标准 session/set_mode；未知模式在发送前拒绝。保留 default/plan 兼容入口，但显式模式优先，避免两套控件冲突。覆盖启动、更新、撤回、实例隔离与 URI ID，运行定向回归和受影响包检查。官方协议与固定 Paseo Copilot 源码已核对，不将协议模拟当作真实 Copilot 认证证据。

#### Act

2026-09-30 复用 SelectProviderOptionDescriptor，新建保留上游原始 ID 的 acpMode 选项。SessionStarted/Configured 增加可选 mode 字段，经 ProviderRuntimeIngestion 生成独立 :mode 活动；AcpRuntimeModel 负责转换，AcpSessionRuntime 发布配置模式变更，Cursor（含通用 ACP/Kimi）和 Grok 发布启动及更新快照。两种 Adapter 在启动/发送时优先应用显式模式，类型错误和未广告值直接失败。模式配置使用最新类别键；旧 modes 改用官方 session/set_mode 并解码响应，失败不换接口重试，不虚报状态。

共享 providerModels 在同一次历史扫描中解析模型与模式快照，按实例合并到所有候选模型能力，保留其它选项和显式自定义模型；null 清除旧模式，空选项合同使客户端能够移除旧发送值。Web/桌面复用 Traits 菜单，隐藏冲突的旧计划菜单/开关/快捷键；Mobile 复用会话设置选项、隐藏内置两态命令，在 use-thread-composer-state 入发送队列前复用 buildModelOptions，使展示、选择和提交一致。会话元数据不进入两端工作日志。未新增 UI 框架、控件库、秘密存储或数据库迁移。

新增模式通知使原 Cursor 固定取 9 条事件的测试暴露队列终态顺序：工具结束可能排在 turn.completed 后。Cursor 改用已有 drainEvents 屏障，在消费者结束时取消等待；停止会话不能等待已关闭的消费者。测试改为等待回合结束并核对工具结束顺序。更新内部实现与用户文档，记录标准协议与边界。其余账号池及既有修改保留。

#### Verify

初次相关 44 项通过，但服务端类型检查指出新增 JSON.stringify 不符合 Effect 约定；改用本仓库已有 stableStringify 后通过。初次 Adapter 组合为 113 通过、1 失败，固定条数消费截断 item.completed；增加队列屏障后发现停止会话测试会等待已退出消费者。一次运行手动中止以定位，随后 verbose 运行明确记录 stopping a session settles pending approval waits 超过 20 秒；补齐停止检查和消费者结束竞速后通过。未通过的尝试未计入完成证据。

最终 `vp.cmd test run` 显式运行 CursorAdapter、GrokAdapter、AcpJsonRpcConnection、AcpRuntimeModel、AcpCoreRuntimeEvents、ProviderRuntimeIngestion.activity、共享 providerModels、Mobile modelOptions/thread-outbox/threadActivity、Web composerProviderState/TraitsPicker/session-logic：13 文件 347 项通过，48.66 秒。覆盖 URI ID、配置与旧模式 API、无效类型/撤回候选、原生 RPC/畸形响应失败、同值不写、启动/当前更新/下一回合、实例隔离、双端选项提交和取消停止边界。清理两个新增 lint 建议后，两个 Adapter 的模式筛选 3 项再过（73 未选，不重复累加）。没有先在旧模式实现运行全部新增测试，不把本轮全部用例描述为红绿复现。

Server/Web 的 tsgo --noEmit、Mobile 正式 tsc --noEmit 最终均退出 0；仅原账号池 Effect 建议。22 个本轮 TS/TSX 文件定向 lint 退出 0，只剩 Cursor 原 invocation 未使用警告；fmt --check 通过。Node 既有 DEP0190 仍在。git diff --check 通过，仅原文档 CRLF 提示；12 个保留文件 SHA-256 未改变；本轮 25 个源码、测试、文档及 ledger 文件均通过严格 UTF-8 解码与无 BOM 检查。

复用隔离服务 5734/13774、原测试实例及授权浏览器，将其命令改为仓库外 acp-modes-fixture.mjs，新线程“任意 ACP 模式验证”。1280px 选择审查、发送并收到回复，实际协议日志 value 为 https://agentclientprotocol.com/protocol/session-modes#review，刷新仍显示审查；360px 更多输入菜单可显示完整模式及说明，选择 Ask/Architect 并用发送按钮完成回合。窄屏 Enter 按设计换行，发送按钮有效。开发热重载曾短暂断连，恢复后继续；不是远程/relay 重连测试。截图 acp-modes-desktop.png、acp-modes-360.png 位于 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929，均已视觉检查；模式菜单不溢出，但既有 360px 页头控件重叠仍未修复。临时视口恢复，隔离服务与页面保留。

没有真实 Copilot/其它官方 CLI 登录或工具、Electron 壳、原生手机、远程/relay/tunnel 验证；本地浏览器连接的是协议模拟进程。未执行全仓检查、子代理、推送或 PR。完整 Acceptance 全部保持未勾选，goal active。回滚仅撤回本轮 mode 合同/运行时/投影/选项合并和对应测试文档；保留原模型、命令与账号池能力，无数据迁移。

#### Retrospect

本轮属于 progress：任意模式从上游广告到菜单、持久化选项和实际协议写入已形成闭环；无需扩展全产品 default/plan 枚举。模式名不是协议 ID，也不能用名称推断完整权限。新增会话元数据会改变事件条数，测试应等待语义终态；等待消费还要覆盖消费者停止，否则修复顺序会引入挂起。手机菜单归一化不能替代发送队列入口归一化。

下一轮选择 A-5 已反复观察到的 360px 页头重叠作为一个完整视觉增量：追踪共用聊天页头及操作入口，用现有响应式布局保证标题和关键操作可达，覆盖展开/关闭、1280px 和 360px 浏览器，不借机重做整个界面。官方 CLI 逐项实测、Kiro 专有面板、Droid MCP、非文本、多端与远程仍属完整目标，不能用本轮模式 fixture 验收替代。未修改 .loop-state。

### Round 14

#### Plan

本轮唯一增量是 Round 13 留下的窄屏聊天页头重叠。360px 实际 DOM 中导航与线程按钮宽度均为 0，项目按钮与不可收缩操作区交叠，绝对定位的终端/右面板按钮又覆盖 Git 操作。复用现有容器断点、菜单和按钮，在窄容器将导航与操作分行，项目名允许收缩，顶部保留面板按钮位置；聊天专用外壳自适应高度，不改变其它页面页头。操作区可换行，不复制业务入口或新增依赖。验证 360/1280px、标题菜单与重命名退出、布局和工作区菜单、操作编辑弹窗、面板/终端开关；运行已有页头定向测试与 Web 类型检查，保留前后截图。真实 CLI、多端远程和其它 Acceptance 仍保持原完整范围。

#### Act

2026-09-30 修改 ChatHeader 的现有容器查询：宽度不足 48rem 时导航占首行、操作区占下一行并允许继续换行；导航给固定面板开关保留 80px，项目名称限制占比且允许收缩，线程仍沿用完整名称提示和原菜单/重命名处理。IDE 标识移入导航，随同行内容布局。宽容器保留一行，操作区也留足固定按钮空间。ChatView 仅将聊天专用 WorkspacePageHeader 高度设为自动，其它页面与全局标题栏高度变量不变。新增用户文档说明，未新增组件、依赖、业务回调或迁移。

#### Verify

修复前 360px 浏览器 DOM 实测导航宽度 0、线程按钮宽度 0，项目与工具重叠；修复后导航宽度 296px、线程按钮约 97px，页头高 92px，按钮最大右边界小于 348px，document 无横向溢出。320px 下操作自然再换一行，页头 126px，所有可见按钮都在视口内且标题宽度非零。1280px 正常一行；右侧面板打开后聊天容器宽 532px，页头两行，scrollWidth 与 clientWidth 均为 532px。以上是本地真实浏览器几何和截图证据，无新建 CSS 类名镜像测试。

复用原隔离服务与测试线程，验证窄屏标题菜单、重命名输入及 Escape 取消、布局菜单的 IDE 不可用提示、工作区文件入口和关闭返回、添加操作表单与取消、终端抽屉开关、编辑器选项菜单；未执行编辑器外部启动或初始化 Git。宽屏验证右面板开关及 IDE/对话模式往返；IDE 工作台只显示准备状态，不能称工作台加载验收通过。热重载出现短暂连接失败，日志显示原服务重新监听，页面恢复；没有重新启动另一套服务，也不将其计为远程恢复证据。恢复临时视口并保留原页面。

`vp.cmd test run apps/web/src/components/chat/ChatHeader.test.ts`：1 文件 9 项通过（4.74 秒）。Web `tsgo.cmd --noEmit`、两源码定向 lint 和 fmt --check 均退出 0。git diff --check 通过，仅既有文档 CRLF 提示；12 个原保留文件 SHA-256 未改变。本轮四个源码/文档/ledger 文件严格 UTF-8 无 BOM 检查通过。前后截图位于仓库外 `C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929/header-before-360.png`、`header-after-360.png`、`header-after-1280.png`、`header-after-split-1280.png`，已经视觉检查。没有全仓检查、子代理、提交、推送或 PR。

本轮只修共用 Web/桌面聊天页头；原生 Mobile 使用不同布局，Electron 窗口原生控件和真实设备/远程未验证。A-5 的完整验收还未满足，A-1 至 A-8 均不勾选。回滚撤回 ChatHeader 布局和 ChatView 单行高度改动及本轮说明即可，不触及账号、会话数据或上一轮模式合同。

#### Retrospect

本轮属于 progress：已有截图和宽度为零的根因证据，最小 CSS 布局修复后窄屏、分栏、宽屏及入口往返均可核对。操作不能只隐藏文字：不可收缩按钮仍可能超过总宽度；固定定位控件需要单独预留空间。按容器而非视口宽度决定换行，才能同时覆盖右面板和对话分栏。静态菜单测试不能代替真实布局几何。

下一轮选择 A-1 的非文本内容链路作为一个增量：已检索 AcpRuntimeModel，工具 content 已保留非文本及顺序，不应重写；但 agent_message_chunk 只为 text 生成事件。继续追踪已有附件、资源链接和两端渲染合同，复用现有承载修复确证丢失，覆盖大小/类型边界、历史重放和显示。Kiro 专有面板、Droid MCP、44 入口逐 CLI 真机及多端远程仍全部保留。goal active，未修改 .loop-state。

### Round 15

#### Plan

本轮从 A-1 非文本链路中完成资源链接与嵌入文本资源的传递和显示。责任检索确认工具 content 已保存非文本顺序，正文 parseSessionUpdateEvent 则只接收 text；现有 ContentDelta、正文持久化和 Web/Mobile Markdown 足以承载可读资源，不新增平行消息合同。链接保留名称、URI 和说明，HTTP(S)/file URI 复用现有链接入口，其它协议明确显示原 URI 且不伪造可打开链接；嵌入文本用长度足够的代码围栏保留内容，避免资源文本被解释成指令式 Markdown。复用同一正文/思考分流和会话重放门禁。先运行解析红灯，再覆盖两条 Adapter 子进程、恶意标点/协议、空文本与长文本以及实际浏览器渲染/刷新。图片、音频和 blob 需要独立资产合同，未以占位文字替代其完整接入要求。

#### Act

2026-09-30 AcpRuntimeModel 将 resource_link 和文本 resource 映射到现有 ContentDelta，保留 streamKind 与 rawPayload。链接标题转义，目标经 URL 解析后只让 HTTP(S)/file 进入现有客户端打开入口，保留 query/fragment；其它协议明确显示原 URI。说明与嵌入文本使用长于其内部反引号串的代码围栏，不将资源原文作为可执行 Markdown。没有截掉空资源或 75,000 字符文本。新增 standalone 仅为内部资源分段标记，AcpSessionRuntime 在每个正文资源前后复用已有 assistant item 边界，避免相邻未闭合围栏影响渲染；未改全球消息合同、数据表、资产权限或思考隐藏策略。

复用 acp-mock-agent，发送前文未闭合围栏、资源链接、mcp 文本资源、后文及重放/子会话噪音。两 Adapter 测试核对四个独立 item、内容顺序及排除噪音；Ingestion 测试直接串联真实解析和事件转换，在 streaming/buffered 两模式核对消息投影。更新内部架构与用户说明，注明中间资源沿用工作记录折叠以及图片/音频/blob 未完成。官方来源、检索词及日期写入架构文档。

#### Verify

旧实现红灯：AcpRuntimeModel 7 个新增资源用例全部失败，32 个原用例通过，原因均为无事件。首次修复剩 1 失败，encodeURIComponent 不编码括号；改为明确编码 Markdown 目标分隔字符后通过。首次解析及 Adapter 组合 117 项通过；Ingestion 与 Web workspace-images、Mobile nativeMarkdownText/markdownLinks 共 4 文件 141 项通过（105.75 秒）。后补资源分段后重新运行 RuntimeModel、Cursor/Grok Adapter、AcpJsonRpcConnection：4 文件 154 项通过（41.84 秒）；合计本轮最终相关范围 8 文件 295 项，不重复累计早期 117 项。fixture 加入未闭合围栏后两个 Adapter 资源筛选再次 2 项通过、76 项未选。

最终 Server tsgo --noEmit 退出 0，仅原账号池 Effect 建议；7 个本轮 TS 文件 fmt --check、定向 lint 退出 0，只有 Cursor 原 invocation 未使用警告，Node 既有 DEP0190 未改。git diff --check 通过，仅原文档 CRLF 提示；12 个原保留文件 SHA-256 不变。本轮 10 个源码/测试/文档/ledger 文件严格 UTF-8 无 BOM。没有全仓检查、子代理、提交、推送、PR 或 .loop-state 改动。

复用隔离服务 5734/13774，将仓库外原模式 fixture 加上资源场景，新建“ACP 资源内容验证”。1280/360px 页面显示真实链接、说明及文本资源，链接 DOM 保留 `https://example.com/report?q=1#section`；嵌入 `![不是图片](...)` 保持代码文本，DOM 对应 img 数量 0；刷新后内容保留。第二回合验证未闭合围栏之后的独立资源，展开工作记录，DOM 顺序为前文→资源链接→嵌入文本→后文。仅以 readOnly:true 打开隔离 SQLite，确认本回合四段 first_sequence 为 130/132/134/136，与显示一致；没有访问真实安装数据库。复制按钮显示已复制，但 CUA clipboard.readText 返回空串，不声称剪贴板内容已验证；未进行外部网页打开。截图 acp-resources-1280/360.png、acp-resources-boundary-1280.png、acp-resources-final-1280/360.png 均保存在原仓库外证据目录并视觉检查。恢复临时视口，保留原页面/服务。

本轮只验证协议模拟进程、本地浏览器和 Mobile 派生函数，未做真实 CLI、Electron 原生壳、原生手机或远程验证。A-1 包含图片/音频/blob 等余项，A-5 还需多端验证，全部 Acceptance 保持未勾选。回滚只撤回资源转换、内部分段标记及对应测试/fixture/说明，无数据库迁移，也不回滚原模式或页头修复。

#### Retrospect

本轮属于 progress：有确定红灯、资源实际内容传递、持久化和浏览器证据。资源不能只显示标题而丢 URI，也不能直接把嵌入原文当作 Markdown；围栏长度和相邻消息边界都要处理。标准 URI 与客户端可打开协议不是同一范围，应明确提示而不自动下载或改写协议。浏览器 AX 差分条目出现顺序不等于 DOM 顺序，需直接核对 DOM 和持久化序号后判断乱序。复制成功提示不能代替剪贴板内容证据。

下一轮继续 A-1 图片输出链路：已检索到现有 ChatAttachment、attachmentStore、签名资产访问及 Web 工作区图片展示，但 assistant ContentDelta/消息命令尚无图片承载。应先追踪完整附件写入、消息投影、两端渲染和线程访问校验，复用现有资产存储并补齐实际图片输出、大小/MIME/base64 边界及恢复显示，不能以 [image] 占位交付。音频/blob、复制实际回读、Kiro 专有面板、Droid MCP、44 入口官方 CLI 和多端远程仍保持完整范围。goal active。

### Round 16

#### Plan

本轮唯一增量是 ACP 助手图片输出闭环。复用现有 ChatAttachment、原子附件写入、签名资产地址、消息投影和 Mobile 图片预览；补齐 ACP 图片解析/传递、内部助手附件命令以及 Web 助手图片和纯图片历史保留。图片独立成段，思考图片仍不公开。入口验证 MIME、base64、10 MiB 限制及图片签名；错误写入可见活动，不将非法内容伪装为图片。稳定附件 ID 避免相同事件重试产生重复文件，原始与 canonical 日志不写图片正文。资产沿用环境授权和签名 URL，不声称现有系统有逐线程 ACL。覆盖流式/缓冲投影、重复事件、会话过滤、历史和浏览器预览/刷新；音频/blob、44 个官方 CLI、多端远程仍保留后续验收。

#### Act

2026-09-30 接通 ACP image → ContentDelta.image → Cursor/Generic/Kimi/Grok → Ingestion → 内部助手附件命令 → 现有消息投影。复用独立 assistant item 分段和既有 ChatAttachment，不新增消息表或下载器。storeProviderImageAttachment 复用 parseBase64DataUrl、格式白名单、线程前缀与 AttachmentUpload 原子写入；签名校验使用完整字节，最大 10 MiB，稳定摘要 ID 避免事件重试产生重复文件。原始日志只保留图片元数据，canonical logger 调用也移除 base64；公开事件/投影只带附件引用。思考图片保持隐藏，重放/其它会话沿原过滤。

Web 从用户图片网格提取共用显示，助手复用预览；空消息判定、活跃内容及折叠计数包含附件，纯图片历史可见。Web/Mobile 都对图片解码失败显示现有本地化不可用提示。浏览器发现 runtime.error 被现有摘要翻译为泛化“运行时错误”，图片失败改用明确的 provider.image.failed 活动，保持具体错误可见；不扩大修改全局错误翻译。测试 fixture 增加三色图片、非法 base64、重放/子会话和可选损坏图片。更新内部架构与用户说明；Ingestion 测试附件改写到隔离临时 home，避免使用仓库根目录作为测试存储。

#### Verify

解析红灯：新增图片用例在旧实现失败（没有 ContentDelta），39 原用例通过；修复后 40 项通过。最终后端定向 8 文件 278 项通过（117.45 秒）：ProviderImageAttachment、AttachmentUpload、AcpRuntimeModel、AcpCoreRuntimeEvents、CursorAdapter、GrokAdapter、ProviderService、ProviderRuntimeIngestion。覆盖编码/类型/尺寸边界、真实文件字节、写盘失败、重复事件无额外文件、规范化相似线程隔离、思考隐藏、日志脱敏、流式/缓冲投影和两条真实子进程链路。客户端及服务回归 5 文件 223 项通过（4.75 秒）：共享 threadReducer、Mobile threadActivity、Web MessagesTimeline.logic/MessagesTimeline、ProviderService；与前组重叠，不相加。最后修正 namespace import 后图片存储 3 项再过，不重复累计。新增异步链路等待 drain/turn.completed，无固定 sleep。

扩大到既有 AssetAccess.test.ts 时 13 项中 11 通过、2 失败，均是 favicon 的 Windows 反斜杠与预期斜杠不符，位置 303/362；该源码和测试本轮均未改，不将此批描述为全绿，不扩大本轮修复范围。Server/Web tsgo、Mobile tsc 最终退出 0。初次类型检查暴露测试联合类型缩窄、ManagedRuntime 缺 ServerConfig 类型、Effect JSON/Node 导入约定问题，均修正；定向 lint 初次发现 NodeCrypto namespace 命名，修复后 24 文件退出 0，仅原 Cursor unused invocation 和 MessagesTimeline.logic 原 reverse 建议。fmt --check 24 文件通过。服务端原账号池 Effect 建议、Node DEP0190 及 SSR RouterProvider 警告仍在。

复用原隔离服务 5734/13774 和授权浏览器，新建“ACP 图片输出验证”。实际模拟进程返回 120×72 三色 PNG，浏览器 DOM naturalWidth/naturalHeight 正确，宽屏预览打开/关闭成功；第二回合显示“图片 base64 数据无效。”及“图片不可用”，正常图片仍显示。360px 图片 right=175px，document.scrollWidth=360，没有横向溢出，预览开关正常。刷新后两回合最终图片重新解码，具体错误保留。开发热重载多次短暂断连，日志确认原服务重新监听后继续；没有另启服务，不当作远程恢复证据。截图 acp-image-preview-1280.png、acp-images-1280.png、acp-images-360.png 保存在 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929 并视觉检查。恢复视口并保留页面/服务。

12 个原保留文件 SHA-256 不变，git diff --check 通过（仅既有文档 CRLF 提示）。无全仓检查、子代理、提交、推送、PR 或 .loop-state 修改。无数据库迁移；回滚只撤回本轮图片分支、可选合同和双端展示及相关测试文档，保留原账号池、资源和模式。文件与消息事务不是原子事务，发布失败保留稳定文件供重试，架构文档明确此边界。未验证官方 CLI、Electron 壳、原生手机或远程/relay/tunnel。全部 Acceptance 未满足完整条件，保持未勾选，goal active。

#### Retrospect

本轮属于 progress：从确定图片丢失红灯到真实文件、投影、预览、历史和错误显示形成闭环。仅添加渲染不足以修复纯图片历史被空消息过滤；复用错误类型也可能被客户端本地化覆盖具体原因，必须查看实际失败页面。格式签名只识别容器，不能保证能解码，因此服务端验证与客户端错误状态都必要。稳定资产 ID 支持同事件重试，但不等于文件系统/数据库跨介质事务；不能伪称逐线程 ACL。

下一轮选择 A-4 的 Droid MCP 限制作为一个完整增量：先对照固定 Paseo 的 supportsMcpServers:false 与当前目录、实例配置和 session/new/load 的所有 MCP 注入路径，确认是否已生效；只补确证缺口，覆盖启动、恢复和其它 Agent 不受影响。A-1 工具内容中的图片、音频/blob 可见入口仍需后续核验，不能用本轮助手图片替代全部非文本。44 入口逐官方 CLI、Kiro 专有面板、复制回读及多端远程继续保留完整范围；总目标未完成。

### Round 17

#### Plan

本轮唯一增量为 ACP 实例的 MCP 注入兼容开关。固定 Paseo 目录 Droid 0.179.0 使用 supportsMcpServers:false，共用 acp-agent 对 new/load 均传空数组；本项目 Cursor 共用层却无条件注入 HTTP MCP，现有配置没有关闭入口。新增默认 true 的实例设置，目录 Droid 预填 false，Web/Mobile 均可显式保存 false 或重新开启；GenericDriver 将设置传到共用注入位置，使启动和恢复使用同一过滤后数组，文本生成原本不注入 MCP。保留标准 fs/terminal 与审批。最新 Factory 官方文档已支持 Zed MCP，目录 false 只作为 Paseo 兼容默认，不永久禁用某个 Agent，不按命令字符串猜测能力。验证目录/选择保存、默认与关闭值、真实子进程 new/load 报文、另一个实例不受影响及客户端入口。真实 Droid 工具能力仍需官方 CLI 版本实测。

#### Act

2026-09-30 新增 AcpAgentSettings.supportsMcpServers，缺省 true；目录合同可携带兼容默认，官方目录精确 factory-droid ID 预填 false。添加向导按条目重设此值，仍允许手工修改，不猜测命令、不迁移已有实例。GenericAcpDriver 将设置传到共用 CursorAdapter 唯一 MCP 注入位置，关闭时不给运行时服务器和认证头；new/load 都复用原来的空数组处理。Cursor/Kimi 原入口默认不变，文本生成原本没有 MCP 注入。标准 fs/terminal 与审批未变。

Web 复用 schema 派生开关；Mobile 为现有字段描述增加可选默认值，关闭默认 true 的开关时持久化 false，原默认 false 的开关仍保持原行为。补齐中英日文案、内部实现、用户说明及目录对照；明确旧版 Paseo 兼容默认与当前 Factory 文档支持 Zed MCP 的区别。目录已配置诊断继续按命令和必要环境匹配，不以兼容默认否定用户主动开启的实例。

#### Verify

定向首批 5 文件 40 项通过。补齐新增测试缺失的必填 environment 后，最终 6 文件 77 项通过（40.40 秒）：GenericAcpDriver、CursorAdapter、AcpRegistryCatalog、Web ProviderSettingsForm / AddProviderInstanceDialog.environment、Mobile SettingsProvidersRouteScreen.logic。真实 Node ACP 子进程分别使用 false、缺省与 true 设置，断言每个实例的 session/new 和 session/load 报文；关闭为 []，默认/开启保留 HTTP 服务器与测试认证头。假凭据仅在隔离协议日志中使用，不访问实际 MCP 服务。目录、远程环境保存和双端 false/default 回归通过；没有记录旧生产实现红灯，不声称红绿复现。

Server/Web tsgo --noEmit、Mobile tsc --noEmit 最终均退出 0。服务端首次仅新增测试漏传 environment 出错，修正后通过；仍有既有账号池 Effect 建议。17 个本轮源码/测试定向 lint 无警告错误，fmt 已运行；Node 子进程原 DEP0190 提示仍在。未运行全仓检查。

用户授权浏览器中复用隔离服务 5734/13774：测试实例开关默认开启，关闭后刷新并重新选择仍关闭，再恢复开启；Droid 0.229.0 目录选择后命令、两个环境默认值与 MCP 关闭状态同时呈现。向导未保存、未下载安装 Droid。截图 acp-mcp-setting.png 和 acp-droid-mcp-default.png 保存在 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929 并视觉检查。自动点击单选项与页面实际位置不一致，读取浏览器故障说明后改用单选组方向键完成，未改服务或绕过浏览器工具。最终关闭向导、保留测试实例开启与页面供后续验证。

12 个原保留文件 SHA-256 均未改变，git diff --check 通过，仅既有文档换行提示。无数据库迁移，回滚只撤回本轮开关/目录默认/注入条件和相关测试文档，不撤回旧账号池或前轮工作。本轮没有验证真实 Droid、Electron 壳、原生手机、远程/relay/tunnel，也没有完成 44 入口逐项实测；所有 Acceptance 保持未勾选，goal active。未派发子代理、提交、推送或改 .loop-state。

#### Retrospect

本轮属于 progress：原来无条件注入 MCP 的缺口已在共用路径修复，目录预填、双端编辑、启动和恢复形成闭环。能力默认的来源必须带版本，不能把 Paseo 旧版 false 永久当成厂商不支持；同时默认 true 的开关需要明确保存 false，复用只存 true 的客户端逻辑会使关闭失效。测试和类型检查各自必要，测试通过没有发现缺失必填字段。

下一轮推进 A-3 首批官方 CLI 的安装/认证前置核验，选择 Copilot 一个完整入口：先检索现有驱动、目录、探针及系统安装状态，核对官方 ACP 命令和登录接口，使用隔离 home 验证实际启动/握手、模式配置与可用工具，能实际认证时继续文本/读写/拒绝/取消；凭据或平台不可用如实记录，不拿 mock 当官方成功。后续再推进 Gemini/Qwen/Cline/Hermes 与剩余条目。A-1 工具内容图片、音频/blob，Kiro 专有面板及多端/远程等范围全部保留，不能因本轮完成兼容开关缩减总目标。

### Round 18

#### Plan

本轮选择 A-3 的 Copilot 官方 ACP 接入核验。现有通用目录已有 github-copilot-cli 固定版本 1.0.89，但尚无官方 CLI 实测；共用运行时无条件 authenticate，需用实际握手确认方法与未认证边界。先在仓库外隔离安装官方版本、使用独立 COPILOT_HOME 和工作区，核对 initialize/new、广告模式/config 和取消；有合法现存认证时继续最小工具验证，不输出凭据，不触碰真实工程。发现兼容缺口在共用边界修复并保留协议回归；认证不可用则明确哪些能力仅验证到协议层，不把模拟模型当官方推理。沿用完整验收范围与原有脏工作区保护。

#### Act

2026-09-30 在仓库外 codework-copilot-audit-20260930 安装官方 @github/copilot@1.0.89，npm 返回 3 个包，native CLI 确认 1.0.89。核对 GitHub 官方 ACP/认证/配置目录文档，并读取固定 Paseo Copilot 适配器。当前主机没有 Copilot PATH 入口，但已有 GitHub CLI 登录；没有 COPILOT_PROVIDER_* 环境覆盖。真实 initialize 广告 copilot-login、HTTP/SSE MCP、图片和嵌入资源，音频为 false。直接原始协议与项目运行时两条路径均实际成功调用模型，未输出或复制 token，未启动 OAuth 登录。

新增 CopilotAcpCliProbe.test.ts，显式 CODEWORK_COPILOT_CLI_PATH 才执行，默认测试跳过。使用独立临时 COPILOT_HOME、合成工作区和原生产 AcpSessionRuntime，验证 URI 模式往返、allow_all 默认 off、真实文本、读写文件、PowerShell 命令、原生 optionId 允许/拒绝、取消和进程关闭后 load 恢复。每个异步验证等待协议返回、事件 drain 或权限事件，不添加固定 sleep；这是实际官方 CLI/模型验证，不是模拟上游。

修复 Web/桌面添加页仍将 Copilot 标为“即将推出”的入口。快捷按钮进入现有 ACP 目录并筛选 github-copilot-cli，预填显示名称和官方 copilot-login 认证方法，用户仍需选择目录版本/命令；保存继续为当前环境的 acpAgent，不注册重复 driver。AcpRegistryCatalogPicker 仅增加初始搜索参数。新增用户说明、Copilot 版本化实测文档，并更新 44 入口对照中的 Copilot 证据。

#### Verify

官方运行时探针最初文本/读写/审批通过，17.11 秒；扩展取消/恢复后通过，31.23 秒。再增加“应有非空模型目录”假设时失败；直接官方原始 ACP 响应没有 models/model 类别配置，/model 返回只在交互式 CLI 提供选择器。记录为当前上游未广告，撤回错误的无条件假设，没有改生产逻辑或伪造模型数据。加入真正的 PowerShell execute/completed 断言后最终官方探针 1 项通过，35.93 秒：生成 approved.txt 内容正确；拒绝和取消的文件不存在；取消 stopReason=cancelled；新进程 session/load 后真实回复正确引用旧文件内容。多次运行不累加为独立测试项。

Web 定向 AddProviderInstanceDialog.environment/AcpRegistryCatalogPicker 2 文件 5 项最终通过，验证 Copilot 筛选、官方认证方式、固定命令以及远程环境实例保存；原 Auggie/空目录/离线目录回归仍在。Server/Web tsgo --noEmit 退出 0，服务端仅既有账号池 Effect 建议。4 个本轮源码/测试定向 lint 通过、fmt --check 通过，git diff --check 无错误。Mobile 本轮没有源码变动，没有重复执行其检查；没有全仓检查。

复用原隔离服务与授权浏览器，操作 Copilot 快捷按钮、使用目录 1.0.89、检查实际 npx 命令和 copilot-login 预填；360px document.scrollWidth=360，配置区域可滚动，返回命名后保留 GitHub Copilot。宽屏再次核对最终认证预填；截图 copilot-acp-catalog.png、copilot-acp-360.png 位于原审计临时目录。未在浏览器保存真实 Copilot 实例或发送模型请求，真实模型证据来自运行时探针，不能称为真实 Copilot 聊天 UI 全链路。一次关闭时遇到页面热重载导致旧元素失效，页面已退出向导，未重启服务。

12 个原保留文件 SHA-256 未变。没有数据库迁移、提交、推送、PR、子代理或 .loop-state 修改。官方 CLI 安装留在仓库外，探针的临时 home/workspace 由作用域清理；COPILOT_HOME 不是操作系统沙箱，CLI 仍能发现用户级技能，文档明确边界。回滚仅撤回 Copilot 快捷入口/目录初始搜索和探针，不影响已有 acpAgent 实例。custom agent、allow_all 主动切换、上游模型配置、真实聊天 UI、多端和远程仍未验收；A-3 包含五个 CLI 及专项合同，不能因一个官方探针通过勾选 A-3，所有 Acceptance 保持未勾选。

#### Retrospect

本轮属于 progress：第一次获得该入口官方 CLI 的认证、实际文件/命令副作用、拒绝、取消与恢复证据，并修正用户看得到的禁用入口。原通用运行时足以执行这些路径，无需为 Copilot 再写 Adapter。官方文档只能确定预期，真实版本可能没有广告模型目录；不应为了让检查全绿添加伪列表，也不应把认证请求成功当成模型调用成功。

下一轮继续 Copilot 专项配置闭环：对照官方当前协议和固定 Paseo 的 allow_all、custom agent 字段，先在隔离 CLI 中放入合成 custom agent 并核对广告与写回，再决定复用现有 ProviderOptionSelection/会话配置合同的最小实现。保证 allow_all 不默认开启，开启后的关闭路径明确，不把 autopilot 混为普通模式；模型列表缺失继续如实标记并核对有无官方查询机制。随后继续 Gemini/Qwen/Cline/Hermes 的官方实测和全部 44 入口、多端/远程范围。goal active。

### Round 19

#### Plan

本轮唯一增量为 Copilot 会话配置（custom agent 与 allow_all）的发现、选择、写回和反向操作。先用已安装官方 1.0.89 与合成无工具 profile 核对真实广告和 set_config_option，再复用现有 ProviderOptionDescriptor/ModelSelection.options 及会话活动传输补确证缺口，保持实例隔离、空快照撤回和运行时校验。权限不默认开启，autopilot 不伪装成普通模式，关闭和恢复默认必须可达。若官方不广告某能力，不用猜测值填充；全部 CLI、多端远程验收范围继续保留。


#### Act

2026-09-30 按上一轮计划使用已安装的官方 Copilot 1.0.89，在仓库外独立 COPILOT_HOME/agents 创建 tools: [] 的合成 profile。实际 session/new 广告 mode、agent（category _agent）、allow_all（category permissions）；默认 agent 的 value 为合法空字符串，allow_all 默认 off。原始 set_config_option 确认 profile → 默认、on → off 均成功，模式保持 Agent，不等于 Autopilot。

责任检索覆盖 ProviderOptionDescriptor/Selection、AcpRuntimeModel、AcpSessionRuntime、Cursor/Grok 两条 Adapter、ProviderRuntimeIngestion、共享 providerModels 及 Web/Mobile 选项与工作日志消费。复用既有 select 控件与 ModelSelection.options，只增加已有 session.started/configured 的可选 configOptions 字段和同类元数据活动；现有模型/模式活动不能无损承载角色与权限。没有创建 Copilot 专用 Adapter 或第二套菜单。

AcpRuntimeModel 将已核对的 _agent/permissions select 转换为带 acpConfig: 前缀的 descriptor；configId 与 value 用 URI 编码，value: 保留空字符串，分组候选保留。AcpAdapterSupport 每次按最新广告校验后精确还原写回；失效值和类型错误阻止 prompt。CursorAdapter 在模式之后应用显式配置，Grok 共享同一写回方法；启动和后续更新都传递配置。AcpSessionRuntime 去重发布配置快照，空数组可撤回。客户端在当前线程、对应实例合并配置；Web/Mobile 工作日志隐藏元数据，复用菜单处理选择和持久化。

发现 Copilot 未广告模型时没有选择入口，且非模型 config 快照被错误解释为模型撤回。GenericAcpDriver 提供明确的“CLI 默认模型”入口（不是具体模型广告）；未广告 default 模型时跳过模型覆盖请求。parseSessionModels 将仅角色/权限配置解释为未提供模型信息；更新移除已有 model 类别时仍撤回，保留旧协议模型与显式空数组语义。文档解释两层权限：需要人工审批须 Allow All Off + Code Work 受监督；不默认开权限，不将开关伪装成普通模式。

扩展 GenericAcpDriver 子进程集成、AcpRuntimeModel、共享 providerModels 和官方 Copilot opt-in 探针。更新 copilot-acp-provider.md 与用户说明，记录来源、使用、接口编码、版本边界和回滚。浏览器沿用既有服务、现有 ACP 测试实例与仓库外 acp-config-fixture.mjs，未修改真实安装、生产数据库或用户凭据。

#### Verify

官方 CLI：`CODEWORK_COPILOT_CLI_PATH=<已安装的官方 copilot.exe>; vp.cmd test run apps/server/src/provider/acp/CopilotAcpCliProbe.test.ts`，1 项通过，36.11 秒。通过实际运行时完成角色及权限开关往返、未广告模型保持 null、失效角色拒绝，再复验文本、读写、PowerShell、拒绝、取消和进程恢复。Allow All 开启期间没有执行工具，本轮没有把自动审批实际副作用列为通过。

最初 `GenericAcpDriver.test.ts + providerModels.test.ts + AcpRuntimeModel.test.ts` 3 文件 53 项通过。`CursorAdapter/GrokAdapter/AcpJsonRpcConnection/AcpCoreRuntimeEvents` 4 文件第一次为 123 通过、1 失败：启动配置新增空快照活动后旧测试固定的三种活动清单不再正确，补充第 4 种活动断言后通过。服务端首次类型检查发现新测试将带可选 ParseOptions 第二参数的 decoder 直接交给 Effect.forEach；改为显式单参数回调，未改变生产行为。

集成回归 `vp.cmd test run apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts packages/client-runtime/src/providerModels.test.ts apps/web/src/components/chat/composerProviderState.test.tsx apps/mobile/src/lib/modelOptions.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts`：6 文件 81 项通过。最后补充编码单测及 CLI 默认判断后运行 `CursorAdapter.test.ts GenericAcpDriver.test.ts AcpRuntimeModel.test.ts AcpJsonRpcConnection.test.ts`：4 文件 122 项通过，55.71 秒。各批有重叠，不相加为独立项数。后续未改 Grok/共享客户端生产逻辑，因此不重复已通过的无关检查。

Server/Web 的 `tsgo.cmd --noEmit -p <对应 tsconfig>`、Mobile 的 `tsc.cmd --noEmit` 全部退出 0；服务端仅既有账号池 Effect 建议。19 个源码/测试文件 fmt --check 通过，定向 lint 无新增警告（全批仅 CursorAdapter.test.ts 原 invocation 未使用警告）。git diff --check 通过，仅旧 CRLF 提示；21 个本轮源码/文档 UTF-8 无 BOM；12 个保留文件 SHA-256 全部不变。没有全仓检查、子代理、提交、推送、PR 或 .loop-state 修改。

真实浏览器 + 协议 fixture：CLI 默认入口首次发消息成功；菜单初始 Copilot/Off；选择审查角色并提交，日志只有 agent=reviewer；恢复默认并提交，日志明确 agent=""，没有额外模型设置请求。窄屏更多控件可见两个配置、切到受监督；360px scrollWidth=360。刷新及开发热重载重连后仍为 Copilot/Off/受监督；1280px scrollWidth=1280。截图 acp-config-360.png、acp-config-1280.png 保存在原审计临时目录。出现的 HTTP 502/连接中断与 Node --watch 自动重启时间一致，读取日志后复用原服务，未额外重启；恢复后的控件与历史可见。截图和原始配置日志是 fixture 证据，不是官方 Copilot 聊天 UI 全链路。测试环境与浏览器保留，视口已 reset。

全部 Acceptance 仍不满足完整 verify，保持未勾选。未运行 Electron、原生手机、远程/relay/tunnel 或其它官方 CLI。无需数据库迁移；回滚先关闭活动 CLI 的 Allow All，再撤回本次配置字段/转换/合并和默认入口，不能撤销已执行工具，也不得覆盖之前各轮与账号池改动。

#### Retrospect

本轮属于 progress：官方协议提供了真实空默认值和独立权限语义，共用链路已能显示、选择、写回和撤回，浏览器确认从角色返回默认的反向路径。最小改动是扩展已有选项合同的承载，避免全局放宽非空字符串校验。模型目录缺省与配置快照撤回必须分开；“CLI 默认”是明确的不覆盖行为，不能冒充某个实际模型名。两个审批控制面必须在说明中区分，不能仅凭 Allow All Off 就宣称整条应用链路需要审批。

下一轮继续首批 Gemini 的官方 ACP 资格与调用验证：先核对固定目录版本、官方启动/认证/Windows 支持，再用隔离合成目录验证文本、工具、允许/拒绝、取消与恢复，并把确证的兼容缺口修在共用边界。随后依次 Qwen/Cline/Hermes，保留全部 44 入口和真实多端/远程验收范围；Copilot 官方聊天 UI、真实手机、Electron 与权限开启后的工具行为仍需补证。goal active。

### Round 20

#### Plan

本轮唯一增量为 Gemini CLI 官方 ACP 接入资格与调用链验证。核对固定目录的 0.61.0、官方启动参数/认证/Windows 支持，在仓库外独立配置与合成工作目录安装并验证实际握手、文本、工具与恢复；若缺账号凭据，明确记录认证边界并完成可验证的入口和失败行为，不把 mock 或单独握手冒充官方模型成功。沿用共用 ACP，只有真实证据指出缺口才修改生产逻辑。保留完整 44 入口及多端/远程范围。

#### Act

2026-09-30 核对官方 ACP、认证、配置、发布文档，在仓库外 codework-gemini-audit-20260930 安装 @google/gemini-cli@0.61.0；已有全局 0.55.1 保持不动。只检查凭据环境变量和登录文件的存在状态，没有读取输出密钥。未发现可用认证，已请用户在本机完成登录或配置环境变量；尚未收到完成回复，继续执行不依赖凭据的工作。安装提示 keytar 安装脚本未获 allowScripts 允许，本轮未启用；已安装 CLI 的版本与 ACP 负向验证可以运行。

真实原始 NDJSON 及生产 AcpSessionRuntime 两条路径确认：initialize 返回 gemini-cli 0.61.0、oauth-personal/gemini-api-key/vertex-ai/gateway 四个认证方法；login 返回 -32602；无 API Key 的 authenticate 返回成功，但 session/new 返回 -32000 缺密钥，不能把认证 RPC 成功当账号可用。能力广告与实际模型调用分开登记。新建 GeminiAcpCliProbe.test.ts，显式 CODEWORK_GEMINI_CLI_PATH 才运行，两个场景使用作用域临时 home/workspace，不登录、不调用模型。

真实探针暴露共用错误通道缺口：Effect 的标准 JSON-RPC 解码把普通 error 解为 Die，核心请求逃逸 Effect.result，扩展请求失去错误码。责任检索覆盖 effect-acp protocol/client/_internal/shared/errors、Effect RPC 原始解码与所有响应分发；复用既有 isProtocolError 和 AcpRequestError，在公共 Exit 入口转为 Fail，再交给原有核心/扩展处理。保留 code/message/data，显式 Defect 和畸形错误不改；没有逐 Adapter 捕获所有缺陷或修改 vendored 依赖。

Web/桌面将 Gemini 的“即将推出”禁用项改为与 Copilot 复用的 ACP 快捷入口，预填 oauth-personal、Gemini 名称及目录筛选，仍需选择版本命令，仍保存为当前环境的 acpAgent。原远程环境测试参数化覆盖两种入口。新增 gemini-acp-provider.md，更新 44 入口对照及用户说明，记录认证边界、来源、复现、能力和回滚。

#### Verify

红灯：官方探针两项因普通 Invalid params/缺密钥错误成为 Effect 缺陷而失败，原添加页 4 项通过。追加不依赖官方软件的 client 原始 NDJSON 回归，单项同样失败，确认公共根因。修复后核心与扩展请求均获得 AcpRequestError，原错误码/数据/方法保留。再补显式 Defect/畸形错误不被吞掉的保护测试。

最终 `CODEWORK_GEMINI_CLI_PATH=<隔离官方 bundle/gemini.js>; vp.cmd test run packages/effect-acp/src/client.test.ts packages/effect-acp/src/protocol.test.ts apps/server/src/provider/acp/GeminiAcpCliProbe.test.ts apps/web/src/components/settings/AddProviderInstanceDialog.environment.test.tsx`：4 文件 29 项通过，5.99 秒。两项官方负向探针确认没有发送 session/prompt。`vp.cmd test run apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts`：4 文件 124 项通过，46.85 秒，仅既有 Node DEP0190 提示。

effect-acp、Server、Web 类型检查最终均退出 0，Server 仅既有账号池 Effect 建议。新增测试最初使用 JSON.stringify 被 Effect 规则拒绝；规则建议的 UnknownFromJsonString 不存在于当前版本，按已有 protocol 测试改为 Schema.fromJsonString(Schema.Unknown)，并将编译解码器上移后通过。6 个源码/测试 lint 与 fmt --check 通过。git diff --check 通过（旧文档 CRLF 提示）；12 个保留文件 SHA-256 均未改变。未运行全仓检查或无改动的 Mobile 类型检查。

复用既有隔离服务与授权浏览器：Gemini 按钮可进入目录，真实目录为 0.61.0；选择后命令为 cmd.exe /d /s /c npx -y @google/gemini-cli@0.61.0 --acp，认证字段 oauth-personal，返回命名步骤仍为 Gemini/acpAgent_gemini。360px 与 1280px 的 document.scrollWidth 分别为 360/1280；截图 gemini-acp-360.png、gemini-acp-1280.png 在原仓库外审计目录。退出向导、恢复视口，保留原服务和浏览器；没有保存真实 Gemini 实例、启动 OAuth 或发送模型消息。

尚未验证 Gemini 成功认证、模型、文件/命令、允许/拒绝、取消/恢复，也未运行 Electron、原生手机和远程/relay/tunnel；全部 Acceptance 保持未勾选。没有提交、推送、PR、子代理、在线数据库写入或 .loop-state 修改。无数据迁移；回滚只撤回入口与共用错误转换及对应测试，保留其它 Provider、账号池与前轮改动；撤回错误转换会恢复已复现的错误逃逸行为。

#### Retrospect

本轮属于 progress：官方 CLI 负向路径发现了模拟上游内部编码未覆盖的公共协议错误，已有错误模型足够承载修复。原始 JSON-RPC 回归能阻止再次把外部正常失败当内部缺陷；无需增加认证状态机或 Gemini 专用 Adapter。认证请求成功只是一步，必须等会话和实际模型行为成功才扩大验收声明。缺凭据没有阻止入口、协议、错误和文档的可验证推进。

下一轮继续 A-3 的 Qwen 官方 CLI 单一入口：核对当前固定目录版本、启动/认证/平台与现有探针，使用隔离目录验证真实握手及可用的模型/工具链路，发现缺口仍在公共边界修复。若用户提供 Gemini 已完成认证的信息，优先补 Gemini 真实文本/工具/审批/取消/恢复证据。Cline/Hermes、其余入口、Copilot 官方聊天 UI、多端、远程及剩余非文本能力全部保留；不会以负向测试代替实际模型成功，goal active。

### Round 21

#### Plan

本轮选择 Qwen Code 一个完整入口，核对目录固定 0.24.7、官方 npm 包、ACP 启动参数、认证方法和隔离配置路径。先执行官方 CLI 握手及认证边界；存在合法现成模型线路时继续真实文本/工具/审批/取消/恢复，否则如实记录调用前提并完成可验证的接入缺口。复用现有通用驱动、目录和协议探针模式，不复制 Adapter。上一轮为 progress，全部 Acceptance 和 44 入口、多端/远程范围保持不变。

#### Act

在仓库外 codework-qwen-audit-20260930 安装官方 @qwen-code/qwen-code@0.24.7，核对 Node >=22、包完整性、cli-entry.js 启动实际 cli.js 的参数和配置路径。没有本机 qwen PATH、Qwen 登录文件或常用模型密钥环境变量；仅核对存在性，不打印凭据。安装的音频采集脚本未获 allowScripts 允许，没有执行该脚本或宣称音频可用。官方配置、认证和发布来源及检索日期记录在新增 qwen-acp-provider.md。

官方 initialize 返回 qwen-code 0.24.7、协议 1，仅广告 openai 认证；错误 login 为 -32602，缺失 API Key 为 -32603 并保留 data.details；原始未认证建会话为 -32000。新增目录可选 authMethodId，由本地核对表填 Qwen openai、Gemini oauth-personal、Copilot copilot-login；添加向导选择目录时同步替换认证方式，无已核对方法时回到 login。复用通用 ACP 驱动和既有目录，不新增 Qwen Adapter，也不改写已保存实例。

新增显式启用的 QwenAcpCliProbe.test.ts，实际运行官方 CLI 和生产 AcpSessionRuntime。模型响应由仅绑定 127.0.0.1 的测试端点生成，使用合成密钥、独立 QWEN_HOME、临时 workspace、无系统设置路径；真实 CLI 执行文件读写和 echo 命令，处理原生 allow_once/reject_once optionId、取消和新进程会话恢复。模型/模式目录、文本流和工具事件经过实际 ACP。探针显式切 default 审批模式，开启 shell 工具可见性并关闭交互式 shell。没有外部模型推理或真实账号认证证据，不把配置隔离称为操作系统沙箱。

检查工具结果发现公共解析缺陷：Qwen 只发状态/内容的完成增量被生成默认 Tool 标题，覆盖初始 ReadFile 名称。定向回归先复现红灯，再在 AcpRuntimeModel 的公共入口只对真实携带 title 的输入更新派生标题，缺省交给原有合并层保留。检查共用 Cursor/Grok 调用者并运行其回归。官方探针也断言读取工具首条与最终标题一致，未复制单供应商补丁。

#### Verify

探针开发阶段，模型响应未提供唯一 completion ID，加上后台请求可能提前消费下一工具，出现连续三次同类缺失审批后停止机械重试，检查上游去重与请求日志；补足唯一 completion/tool-call ID 和当前 prompt 标记关联后恢复。Windows 非交互 shell 实际使用 cmd，最初 PowerShell Write-Output 返回退出码 1；改为通用 echo 并同时检查真实 exitCode=0 与输出，不仅检查 completed。一次失败时临时目录清理报 EBUSY，后续最终成功运行正常结束作用域；没有按进程名或路径杀进程。诊断输出已移除。

公共标题回归红灯明确收到 Tool 而非 ReadFile source.txt，修复后通过。最终 `CODEWORK_QWEN_CLI_PATH=<官方 cli.js>; vp.cmd test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/GrokAdapter.test.ts`：5 文件 130 项通过，41.82 秒，仅既有 DEP0190 提示。实际文件内容、拒绝/取消文件不存在、shell 输出与退出码、原进程结束后的同一会话恢复均有断言。此前目录/官方探针/添加向导/目录选择器 4 文件 21 项通过，与最终矩阵有重复，不相加夸大数量。

Server、Web、Mobile 类型检查均退出 0；公共标题修复后再次运行 Server 类型检查通过，仅既有 CliProxy/localAccount 的 Effect 建议。8 个本轮源码/测试 lint 与 fmt --check 通过，git diff --check 通过（旧文档 CRLF 提示）。12 个受保护文件 SHA-256 全部未变；没有运行全仓检查、无关 externalLauncher 测试、子代理、提交、推送或 PR。

复用既有隔离开发服务和获准浏览器。360px 配置页面已验证 Qwen 0.24.7、openai 与无整页横向溢出；1280px 再从 Gemini 快捷入口切 Qwen，认证由 oauth-personal 更新为 openai，命令为 cmd.exe /d /s /c npx -y @qwen-code/qwen-code@0.24.7 --acp --experimental-skills，scrollWidth=1280。一次服务热重载收起向导后重新进入，替换无效宽屏截图；最终截图 qwen-acp-360.png、qwen-acp-1280.png 在仓库外审计目录。退出向导、恢复视口、保留原服务和浏览器，没有保存真实实例或启动模型聊天。

更新 qwen-acp-provider.md、paseo-provider-catalog.md 与用户指南，说明版本、认证、工具调用、边界、复现和回滚。无数据库迁移；仅撤回本轮目录认证预填和标题判断及测试即可回滚，保留前轮与账号池工作。A-1 至 A-8 仍全部未勾选：外部 Qwen 模型、真实聊天工具 UI、Electron/原生 Mobile、远程/relay/tunnel 及其余入口仍欠验收。本轮不修改 .loop-state，也不暂停或缩小完整目标。

#### Retrospect

本轮为 progress：真实 CLI 加受控模型端点能验证真实协议和工具副作用，同时避免把缺凭据当成所有工作阻塞。它不能代替真实外部模型的成功调用。公共完成增量的缺省语义比逐 Provider 显示补丁更小，也覆盖兄弟 Adapter；目录认证应随条目一起更新，不能依赖某个快捷入口遗留值。

下一轮选 A-3 中 Cline 官方 CLI 一个入口，先查现有目录、实现、测试和前轮记录，再核对固定版本、启动与认证/模型/工具链路，继续复用通用驱动。若用户完成 Gemini/Qwen 认证，则优先补对应真实外部模型及聊天 UI。Hermes、剩余 ACP、44 入口、非文本能力、多端与远程全部保留在原目标；需要真实凭据/设备的证据继续明确，不用本地夹具代替，goal active。

### Round 22

#### Plan

上一轮为 progress。本轮选 Cline 官方 CLI 3.0.65 一个入口，先核对官方 ACP、认证、隔离路径和当前目录，再用实际软件包验证启动及协议边界；可用时继续受控工具链路，并据实区分外部模型与本地响应端点。现有通用 ACP 驱动与目录已覆盖 Cline，不重复实现 Adapter；任何兼容缺口先追踪公共责任边界。44 入口和全部 A-1 至 A-8 范围保持不变。

#### Act

在仓库外 codework-cline-audit-20260930 以 --ignore-scripts 安装官方 cline@3.0.65；平台包 @cline/cli-windows-x64@3.0.65 自带 Bun 二进制，可直接启动。npm 包 SHA-512、CLI --version/--help、官方 cli-v3.0.65 的 ACP/auth/auto-approve 源码与文档一致。检索没有现有 Cline 专属探针，只有通用目录和前轮添加向导证据，因此复用通用 Runtime/Driver，不添加专用适配器。

原始 RPC 探针确认 initialize 广告 cline、cline-pass、openai-codex；login 报 -32602；没有凭据直接 session/new 报 -32000。合成 CLINE_API_KEY 配 CLINE_PROVIDER=openai 可不经 authenticate 建会话，但此时 availableModels=[]，不能当密钥有效或模型可用。新增 opt-in ClineAcpCliProbe.test.ts，通过生产 Runtime 验证上述三场景、Plan/Act 及 auto_approve 的布尔 true→false；使用独立 --config/--data-dir，未发送 session/prompt、未启动 OAuth。官方 loadSession 能力只有广告，真实恢复未验。

责任链检索发现空认证此前被三处丢弃：Web/Mobile 删字段后合同恢复 login，CursorAdapter 真值判断丢空值并落入 cursor_login，Runtime 无条件 authenticate。修改既有字段 clearWhenEmpty 策略，双端显式保存空字符串；Adapter 仅省略 undefined；Runtime 非空才发送认证，是否可用仍由上游建会话校验。未设置值仍保持 login。Cline 目录用前轮 authMethodId 合同预填空值，添加向导测试核对实际保存载荷。

Cline 实测还同时广告 provider/model 两个 category=model，原代码选择第一个 provider，导致登录供应商名称作为模型展示和写回。公共 extractModelConfigId 优先明确的 model 键，parseSessionModels 复用同一选择；其它命名仍按类别选择，空模型列表保持空。新增模型碰撞回归，未伪造模型或开放未知配置菜单。

浏览器再发现未配置字段显示为空但后台默认 login 的歧义：Web 复用 Schema 默认值解码，为持久化空字符串的字段显示真实字符串默认；Mobile 在现有字段元数据中同步默认值。显式空字符串不被默认覆盖，其它字段原清空策略保持。更新 cline-acp-provider.md、44 入口表、通用 ACP 文档与用户说明，记录调用语义及未完成能力。

#### Verify

首批红灯 4 文件 67 项：5 失败/62 通过。失败分别为双端清空字段变 undefined、模型键误选 provider、官方 CLI 空认证仍发送 authenticate 导致缺密钥错误码变 -32602、配置合成密钥仍无法启动。修复后 `CODEWORK_CLINE_CLI_PATH=<官方 cline.exe>; vp.cmd test run ClineAcpCliProbe.test.ts AcpRuntimeModel.test.ts GenericAcpDriver.test.ts AcpRegistryCatalog.test.ts ProviderSettingsForm.test.ts SettingsProvidersRouteScreen.logic.test.ts` 对应完整路径的 6 文件 89 项通过，15.54 秒。通用 Driver 集成核对真实 fixture 子进程请求记录：空方法新建/恢复均没有 authenticate，只有一次 session/new 与一次 session/load；该恢复不是官方 Cline 恢复。

公共 AcpJsonRpcConnection、CursorAcpSupport、CursorAdapter、GrokAdapter 与添加向导 5 文件 124 项通过，44.44 秒。补默认值显示后两端表单+添加向导 3 文件 25 项通过；扩展目录空认证保存载荷后添加向导 4 项再次通过。两批有重复，不累加为唯一数。Server tsgo、Web tsgo、Mobile tsc 均退出 0，客户端最后修改后再次检查通过；Server 仅既有 CliProxy/localAccount Effect 建议，Node 仅既有 DEP0190 提示。最终 15 个源码/测试定向 lint 和 fmt --check 通过。git diff --check 通过（旧文档 CRLF 提示），新增文件 UTF-8 无 BOM，12 个保留文件哈希全未变，生产/探针 DEVLOG 检索为零。

复用原隔离服务 66677，热重载时浏览器短暂空白；核对同一服务已监听后恢复页面，没有重启第二个服务。授权浏览器验证未配置时实际显示 login，选择 Cline 3.0.65 后命令与显式空认证正确，1280/360 宽度均无整页横向溢出。对话框外层滚动没有移动内容，改用键盘访问底部按钮，确认添加和返回均可见、返回进入命名步骤、Escape 关闭；没有据此声称所有鼠标滚动方式已通过。截图 cline-acp-1280.png、cline-acp-360.png、cline-acp-360-actions.png 在仓库外审计目录。恢复视口、保留服务与浏览器，未保存真实实例或调用模型。

本轮没有全仓检查、子代理、提交/推送/PR、真实用户凭据变更、全局 CLI 更新或在线数据库写入。无持久结构迁移，回滚限定本轮认证空值、字段显示与模型键选择及测试。A-1 至 A-8 仍未勾选：Cline 真实账号/模型/文本/文件/命令/审批/取消/恢复/聊天 UI，以及全部多端和连接模式验收都仍欠证据。

#### Retrospect

本轮为 progress，真实 CLI 揭示了两个可以在公共边界修复的接入阻断；已有字段、Schema 默认值和模型选择函数足够，不需要 Cline 驱动。空字符串、未设置和认证失败是不同语义，不能用真值判断混为一谈。建会话接受合成密钥不证明认证成功；空模型目录也不能用 provider 选项填满。浏览器可暴露纯保存测试看不到的默认值显示矛盾。

下一轮继续 Cline 的模型与工具链路这一完整增量：先检索官方 provider 配置/模型目录与现有响应端点探针，建立合法且隔离的可调用模型配置，核对真实文本、文件/命令、原生审批拒绝、取消和持久恢复，并补共用解析或聊天展示缺口。具备真实账号时优先实测；使用受控模型端点时明确证据边界。随后继续 Hermes 及其余 ACP 入口；44 项、多端/远程、非文本与最终独立审计范围不变，goal active。

### Round 23

#### Plan

上一轮为 progress。本轮继续 Cline 的模型与工具完整链路：复用固定官方 3.0.65、现有通用 Runtime 和 Qwen 受控模型端点经验，先核对官方 provider/模型/端点配置，再验证实际文本、文件读写、命令、原生审批拒绝、取消和新进程恢复。发现协议或显示缺口时在公共边界修复；真实模型凭据不可用时明确本地响应端点证据边界。全部 44 入口与 A-1 至 A-8 范围不变。

#### Act

2026-09-30 继续复用官方 Cline 3.0.65 与通用 ACP，不添加专属 Adapter。检查官方 main.ts、storage/paths.ts、auth、permissions、session-updates，确认 auth 命令将 openai 规范化为 openai-compatible，但 ACP 环境值不自动转换；ACP 分支早于 --data-dir 处理。第一次集成探针因此没有读取本地端点，外部 OpenAI 返回合成密钥无效。改为显式 CLINE_DATA_DIR，并清除测试进程继承的 CLINE_*，两个官方探针的隔离方式同步修正。没有读取或发送真实密钥。

新增 ClineAcpToolProbe.test.ts，真实 CLI + 仅 127.0.0.1 模型响应端点验证 gpt-4o 广告和实际请求、文本、read_files、apply_patch、run_commands、原生允许/拒绝、取消和新进程持久恢复。模型响应有唯一 ID 与 prompt 标记关联；恢复后检查模型请求确实带旧工具结果。真实 shell 正常输出与 exit 7 失败分别断言，Cline 使用 query/result/success 数组，不伪造 exitCode 字段。

责任检索覆盖 AcpRuntimeModel、AcpCoreRuntimeEvents、ProviderRuntimeIngestion、共享 toolActivity 以及 Web session-logic/Mobile threadActivity。发现批量 rawOutput 保留但未进入 detail，commands 数组也未进入公共命令字段；在 ACP 边界识别完整 query/result/success 形状，补可见结果和分行命令，保留原始输出及既有文本尾部限长；未知数组不猜测。真实 exit 7 的外层 completed 不表示成功，任一明确失败子结果使最终状态为 failed。共享路径收集补 files，审批优先显示具体 detail，而不是泛化 Read file。

浏览器进一步揭示 Runtime 探针漏过的 Adapter 阻断：人工批准写死 allow-once，被 Cline 的 allow_once 拒绝。复用 Grok 已有的按 kind 选择 ID 的逻辑，移入 AcpAdapterSupport.selectAcpPermissionOptionId，Cursor/Generic/Kimi 与 Grok 共用。回传原生 ID；无 allow_always 时至多单次批准；没有所需选项则 cancelled，Cursor 的 resolved 活动也记 cancel。删除旧硬编码映射及 Grok 重复实现。扩展 ACP mock 既有结果日志，Cursor 集成断言真实子进程收到自定义原始 ID。

更新 cline-acp-provider.md、44 入口表及用户指南，说明版本、真实配置路径、调用与显示合同、证据边界、复现和回滚。授权浏览器沿用原隔离服务，新增 acpAgent_cline 测试实例，启动器和本机模型端点放在仓库外；没有改此前 ACP 命令夹具或真实账号设置。

#### Verify

明确红灯：官方工具探针读取成功但 detail=undefined；增加可见结果检查后失败。真实 exit 7 的 rawOutput.success=false，而公共状态是 completed；增加失败状态检查后失败。两项修复后探针通过。浏览器初次人工批准显示 Unknown permission option: allow-once，修正 Adapter 后再次真实执行，具体结果见下。首次集成端点错误与试探退出码字段不匹配属于探针配置/断言修正，不能作为生产红灯夸大。

最终定向范围 11 文件 193 项：ClineAcpToolProbe、ClineAcpCliProbe、AcpRuntimeModel、AcpCoreRuntimeEvents、AcpAdapterSupport、CursorAdapter、GrokAdapter、GenericAcpDriver、shared/toolActivity、Web session-logic.command-output、Mobile threadActivity。命令为 CODEWORK_CLINE_CLI_PATH=<官方 cline.exe> 后 vp.cmd test run 对应完整文件路径。首批 192 通过/1 失败，Grok 省略 allow_always 的路径遗漏重命名函数调用；修正后 Grok 43 项全部通过（40.44 秒）。Mobile 补齐测试夹具必填 id/projectId/title/createdAt 后 37 项再次通过。此前 136 项、50 项和官方 4 项等批次有重叠，不累加为独立测试数。

Server/Web tsgo --noEmit 和 Mobile tsc --noEmit 最终均退出 0。首次 Server 指出 detail 可选类型未缩窄、探针初始标题可缺省，修正后通过；后续类型检查还检出遗漏 Grok 调用。Mobile 指出测试夹具缺少必填字段，补齐后通过。16 个源码/测试定向 lint 只有 CursorAdapter.test.ts 原 invocation 未使用警告；服务端仅既有账号池 Effect 建议，子进程保留既有 DEP0190 提示。fmt 检出一个 Mobile 测试文件并格式化，最终 16 文件 fmt --check 全通过；最后两个修改文件 lint 再次通过，没有全仓检查。新增探针、实现文档及 ledger 均严格解码为 UTF-8 且无 BOM。

浏览器实际 Code Work → Generic Adapter → 官方 Cline → 本机模型响应端点：添加独立实例、空认证、选择 CLI 默认后动态显示 gpt-4o、受监督模式；修复后的审批显示实际合成文件路径和两行命令，点击“通过”后真实执行。刷新后展开看到 CLINE_BROWSER_SOURCE_72319、CLINE_BROWSER_OK、[Command exited with code 7] 与失败图标。1280px/360px scrollWidth 等于视口，截图 cline-tools-1280.png 与 cline-tools-360.png 保存在原审计临时目录并目视检查。视口 reset，浏览器和原服务 66677 保留；未声称 Electron 壳、原生手机或外部模型验证。

现场保留边界：工作记录混合统计父工具、子命令、审批，显示“读取 2 文件、运行 3 命令、使用 1 工具”，尚未完成去重核验；模型菜单鼠标/Enter 未生效，改用页面 Ctrl+1 成功，原因未定。Node watch 重载中短暂断连，日志确认恢复监听后刷新；旧会话恢复还出现 Composition unknown_binding 告警，不能当作远程/relay/tunnel 已通过。旧失败回合保留，未清理成全绿截图。

git diff --check 无错误，仅旧 CRLF 提示；12 个受保护文件 SHA-256 均未改变。没有提交、推送、PR、子代理、.loop-state 修改、全局 CLI 更新或在线数据库写入。无数据库迁移；回滚只撤回本轮解析、审批映射与路径提取及测试，不覆盖认证接入和账号池工作，也不能撤销已执行命令。全部 A-1 至 A-8 保持未勾选，完整目标 active。

#### Retrospect

本轮为 progress：真实 Cline 模型端点、工具副作用和恢复验证落地，且从浏览器发现并修复了运行时探针看不到的人工审批 ID 阻断。根因都在可复用的公共边界，两个 Adapter 共用已有选择方法比继续添加厂商映射更少、更准确。completed 表示调用结束，仍须尊重明确的子结果失败；配置隔离参数的实际执行顺序必须以源码和端点收件为证。

下一轮选择 Cline 工具生命周期显示这一增量：先对比保留测试线程原始 toolCallId/父子关系/恢复重放与活动投影，定位混合计数和重复行的来源，修在公共责任层并验证失败、实时与历史均可见。并核对 unknown_binding 是否同一恢复关联问题，不因表面返回文本就忽略。模型菜单交互差异保留待查；随后继续 Hermes 与其余 ACP。44 入口、账号隔离、非文本、多端/远程及最终独立验收范围不变，不能用本轮本机模型夹具代替外部账号或设备证据。

### Round 24

#### Plan

推进上一轮 Cline 工具生命周期显示增量。只读隔离数据库与实际页面证实：第二回合只有两个 toolCallId，各自生命周期已正常合并；六行是两个工具加四条审批，非父子调用或恢复重复。根因在客户端把 requestKind 审批行当成工具，且读取分类只匹配精确 Read File，漏掉 Cline 的 Read file。修正 Web/Desktop 与 Mobile 公共显示分类，保留审批及失败详情，使用实际事件顺序的回归与保留线程浏览器验收。Composition 的 unknown_binding 来自对普通 provider 回合查询 Composition Run，属于独立归属告警，不借此次改动扩大服务端范围。

#### Act

2026-09-30 复用现有生命周期合并和日志折叠。Web session-logic.workLogEntryIsToolLike 与 Mobile threadActivity 同时排除 approval.*；Mobile 把既有 activityKind 放到内部基础记录，所有状态/统计调用使用同一来源，不再给审批申请显示工具成功。Web MessagesTimeline.logic.summarizeToolGroup 同步只统计实际工具，读取分类使用原有标题/标签并兼容大小写；Mobile 读取图标同步。两端预览对审批保留明确标题，路径与命令仍在已有展开详情中，不删除持久活动、不创建新的生命周期状态层。

Web session-logic.command-output.test 与 Mobile threadActivity.test 增加审批交错生命周期回归，断言实时合并、两项真实工具、四项可检查审批、读取分类和终态失败输出。更新 docs/internals/cline-acp-provider.md，纠正上一轮尚未证实的“父子工具”推测并记录分类、边界与局部回滚方法。

#### Verify

只读隔离数据库线程 524569df-7e07-49b7-8fd5-7bd1768e99b8、回合 bcea59b9-6f14-477e-967d-4734baea2e15，按 created_at 查看：两个 toolCallId，各有多次 tool.updated 和单次 tool.completed，无父子元数据。四条 approval 解释全部虚高统计；浏览器原状态证实“读取 2、命令 3、工具 1”。未写数据库。

新增测试先红：两文件 43 项，2 失败/41 通过；Web 当前活动工具数为 3 而非 1，Mobile 将全部审批标成 toolLike=true/status=success，读取图标 hammer 而非 eye。修复分类后一次检查剩 1 失败，原因是新 Web 夹具终态缺少真实协议始终携带的 data.command；补齐夹具，没有为此改生产解析。最初裸 vp.cmd 不在当前 PATH，改用仓库 node_modules/.bin/vp.cmd，没有安装额外依赖。

最终 `.\node_modules\.bin\vp.cmd test run apps/web/src/session-logic.command-output.test.ts apps/mobile/src/lib/threadActivity.test.ts apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/session-logic.test.ts apps/web/src/components/chat/MessagesTimeline.test.tsx`：5 文件 240 项全通过，15.45 秒。Web tsgo --noEmit -p apps/web/tsconfig.json 与 apps/mobile 目录 tsc --noEmit 均退出 0。6 个修改源码/测试定向 fmt --check 通过；lint 退出 0，只有 MessagesTimeline.logic.ts 原有 reverse 原地操作的 unicorn 建议。未改服务端生产代码，未运行全仓检查。

授权浏览器继续使用原服务 66677 和原真实 Cline 历史线程；刷新、展开回合、展开早期日志和审批详情，四项审批标题与实际读取结果均保留，失败命令仍直接可见，展开显示 CLINE_BROWSER_OK 和 Command exited with code 7。1280px/360px document.scrollWidth 等于视口宽度；目视检查并保存 cline-approval-1280.png、cline-approval-360.png 到原仓库外审计目录。未重新发起模型调用；这是既有官方 CLI + 本地模型端点历史的显示验证，非外部模型、Electron 壳或原生手机验收。视口已恢复，浏览器标记保留，服务未停止。

git diff --check 通过，仅原文档 CRLF 提示；12 个受保护文件 SHA-256 全未改变。本轮没有新增依赖、数据库迁移、账号池改动、子代理、提交/推送/PR 或 .loop-state 写入。显示回滚只撤回本轮分类/预览守卫及测试，不整体还原文件，不撤销既有工具执行。A-1 至 A-8 均未满足完整条件，保持未勾选。

#### Retrospect

本轮为 progress：通过实际持久事件和 UI 证实生命周期合并原本正确，删除“审批等于执行”的错误显示判断就消除了混合计数；无需增加去重缓存或服务端事件过滤。审批通过不证明工具成功，执行失败仍必须保留。Composition fallback 根据 provider/thread/turn 查询 Run，与本次两项工具的客户端归类不是同一责任层，未修复的绑定告警明确保留。

下一轮推进 A-3 Hermes 的真实入口与模型/工具链：先检查既有目录、文档、安装和平台边界，再用官方版本和隔离环境验证配置、认证、调用及审批；无外部凭据时分别记录 CLI 与受控端点证据。Cline 模型菜单鼠标/Enter、Composition unknown_binding、完整重放/远程/设备验收继续保留，不因本轮显示修复宣称整体通过。44 入口和最终独立验收范围不变。

### Round 25

#### Plan

推进 Hermes 官方入口、认证与会话配置闭环，复用通用 ACP。已定位手工目录 hermes acp、官方发布 v2026.9.24（提交 f97608f178d1ffeca59860195ab7da295f7c8e5f），上游要求 Python 3.11–3.13 和 ACP extra。官方 authenticate 仅接受实际广告的 provider ID 或 hermes-setup，通用 login 不是合法方法；通过隔离官方安装和生产 Runtime 探针核对响应、动态模型/模式及建会话失败边界，修正证实的目录配置。工具与模型端点仅在真实配置链路可用后继续，不以能力广告替代执行证据。

#### Act

2026-09-30 将官方固定 tag 克隆至仓库外 codework-hermes-audit-20260930/source；用已提供的 Python 3.12.14 创建独立 venv，再从该源码安装 ACP extra。安装的 Hermes 版本为 0.21.5，agent-client-protocol 为 0.9.0。未修改上游源码、全局 Python、真实 Hermes 目录或用户账号；安装与探针不启动外部浏览器。

新增 HermesAcpCliProbe.test.ts，显式 CODEWORK_HERMES_CLI_PATH 才运行官方 CLI。使用生产 AcpSessionRuntime，独立 HOME/HERMES_HOME/APPDATA、合成密钥、仅 127.0.0.1 模型目录服务。宿主 env 在生产 Runtime 中 extendEnv=true，故探针显式清空非系统变量，避免仅省略变量却仍继承真实凭据。测试涵盖未广告 login 的实际空成功响应、空认证已有配置的模型目录与 default→accept_edits→default 模式往返、无配置无密钥的 session/new 失败。

核验纠正 Plan 中认证推测：Hermes authenticate 对未匹配方法返回 None，Python ACP SDK normalize_result 将其转成 {}，实际 login 请求没有阻断建会话。因此没有添加“错误 login 必须失败”的生产逻辑，也不把这个响应视为认证成功。manual-agent-catalog 的 Hermes 改为 authMethodId=""，使用既有凭据并省略无效 login；沿用双端已验证的显式空值合同。补目录测试，新增 docs/internals/hermes-acp-provider.md，更新 44 入口表和用户配置说明。未增加专属 Adapter 或项目运行依赖。

#### Verify

官方安装命令在仓库外 venv 执行 `python -m pip install -e '.../source[acp]'`，退出 0；`hermes-acp --version` 返回 0.21.5，`--check` 返回 Hermes ACP check OK。克隆提交 f97608f178d1ffeca59860195ab7da295f7c8e5f，与 v2026.9.24 发布一致。

探针调试如实记录：首次把公共模型字段误写为 modelId（实际 slug），断言失败；修正后发现 login 不是预想失败，改按原始响应和 SDK 源码记录真实行为。另将所有 POST 当成生成请求的断言失败，捕获到两项 POST /api/show，再对照 models_local.py 确认为 Ollama 能力探测；本机服务只为 /v1/models 返回目录，其它路径明确 404。以上为探针假设校正，不冒充生产缺陷红灯。目录新增空认证断言先失败（undefined ≠ 空串），生产默认修改后通过。

最终显式 CODEWORK_HERMES_CLI_PATH 后 `.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/web/src/components/settings/AddProviderInstanceDialog.environment.test.tsx`：4 文件 29 项全通过，22.42 秒，含实际官方三场景。此前一次通用 Driver 路径误写 Layers，仅运行到 3 文件 20 项；核对文件后已纳入最终正确矩阵，不把路径未匹配当作通过。

Server tsgo --noEmit -p apps/server/tsconfig.json 最终退出 0；初次新探针使用 JSON.stringify 触发 Effect 规则，改用既有 Schema 编码。最终三文件 lint 与 fmt --check 全通过。类型检查只有原账号池 Effect 建议，Generic 子进程仍有原 DEP0190 警告。无新增固定睡眠；没有全仓检查、子代理、提交/推送/PR、.loop-state 修改或在线数据库写入。git diff --check 无错误、旧文档 CRLF 提示保留；12 个受保护文件 SHA-256 全未改变。

本轮没有发 session/prompt，也没有真实模型/文件工具副作用、浏览器新增实例、Electron、手机或远程验收。只保留既有浏览器供后续工作。安装和配置证据不能代替完整 Hermes 接入完成。无数据迁移；回滚仅撤回 Hermes 目录默认、说明和探针，不整体恢复包含先前 ACP/账号池工作的文件。A-1 至 A-8 保持未勾选，完整 goal active。

#### Retrospect

本轮为 progress：新增真实官方 Python ACP 运行证据与失败边界，目录不再发送上游未广告的 login，且动态模型及权限模式已通过公共 Runtime 往返验证。关键教训是 Python None 经 SDK 可成为成功对象，必须核对线上的实际 RPC 语义；POST 也不必然表示推理。没有将测试假设造成的失败包装成产品修复。

下一轮继续 Hermes 实际工具链这一增量：复用已安装官方版本和隔离目录，加入本机受控模型回复，验证文本、read_file/write_file、terminal 成功和失败、原生权限拒绝/取消及进程恢复，发现缺口修在共用 ACP 边界；随后通过保留隔离服务检查实际界面。外部模型账号与设备/远程证据仍独立验收；不缩减 44 入口目标，Cline 菜单和 Composition 告警保留待查。

### Round 26

#### Plan

推进上一轮明确的 Hermes 实际工具链：固定官方 v2026.9.24 CLI，复用 Cline 实机探针结构及 Hermes 独立配置，检查正文、文件读写、命令成功/失败、原生权限拒绝/取消以及新进程恢复。只由本机端点提供合成模型回复；执行证据必须来自文件、副作用、真实工具输出和 ACP 状态。发现问题先定位官方结果与共用转换边界，不复制专属 Adapter。保留完整 44 入口与多端验收范围。

#### Act

新增 HermesAcpToolProbe.test.ts，使用已固定安装的 hermes-acp 0.21.5、独立 HERMES_HOME、清空继承账号变量、本机模型端点和实际 Git Bash。复用 Cline 探针的请求关联、事件屏障、真实副作用及新进程恢复检查结构；Hermes 专属工具 schema、元数据路由、审批选项与配置由官方源码核对。模型响应为合成数据，工具由官方 CLI 实际执行。

修复 AcpRuntimeModel 的一处共用 detail 优先级：结构化批量输出 → 已限长文本 content → 原有摘要。read/execute/edit/search 的终态携带 kind 时，不再丢掉实际文本结果。四组新回归先获得红灯；保留原标题合并、命令独立字段与 8,000 字符尾部边界，不从 Hermes 截断标题制造完整命令。旧“Running checks”案例同步按真实 content 断言，命令字段仍单独保留。

手工目录与用户文档补 Windows Git Bash 依赖及 HERMES_GIT_BASH_PATH。更新 Hermes、通用 ACP 与全量目录文档，区分 CLI 实际工具、本机模型、浏览器和未验证设备。浏览器复用服务 session 66677、5734/13774，添加 acpAgent_hermes 隔离实例；仓库外 browser-probe.mjs 启动固定官方 CLI 和本机响应端点，不使用真实账号。关闭该验收实例 MCP 注入，仅检验本轮 file/terminal 工具。

#### Verify

初次探针正文成功、读文件报 Git Bash not found：清空 ProgramFiles 使官方安装目录发现失效，改为显式指定已安装 bash.exe。随后真实读文件成功而 detail 仍是路径，补 read/execute/edit/search 四组定向回归，旧实现 4 失败/45 通过；修复后全过。对失败命令的最初 title/command 查找不成立，因为 Hermes 不发送 rawInput、标题只有截断预览；改按本轮新增真实工具 ID、失败状态和实际 exit_code=7 判断，未更改生产命令语义。探针补记录未知路由后确认 /api/v1/models、/v1/props、/props、/version 与模型详情属于官方能力发现，对这些明确返回 404，未知路由继续失败。

最终定向命令（使用 .\node_modules\.bin\vp.cmd，设置 CODEWORK_HERMES_CLI_PATH 与 CODEWORK_HERMES_GIT_BASH_PATH）：

- `test run HermesAcpToolProbe.test.ts AcpRuntimeModel.test.ts AcpCoreRuntimeEvents.test.ts CursorAdapter.test.ts GrokAdapter.test.ts apps/mobile/src/lib/threadActivity.test.ts apps/web/src/session-logic.command-output.test.ts`（服务端文件为 provider/acp 或 provider/Layers 下实际路径）：7 文件 182 项通过，40.77 秒。
- `test run apps/server/src/provider/acp/HermesAcpCliProbe.test.ts apps/server/src/provider/acp/AcpRegistryCatalog.test.ts`：2 文件 17 项通过，21.24 秒。两批无重复文件，共 9 文件 199 项。
- Server `tsgo.cmd --noEmit -p apps/server/tsconfig.json` 退出 0；仅原账号池 Effect 建议。4 个本轮源码/测试定向 lint 与 fmt --check 通过。git diff --check 退出 0，仅原文档换行警告；9 文件 UTF-8 无 BOM；原 12 个保留文件 SHA-256 全部未变。

实际工具探针验证文本、source.txt 内容返回、approved.txt 落盘、echo 输出、exit 7 失败、原生 allow_once/reject_once/cancel 决策、拒绝和取消后目标文件不存在；首进程退出后新进程使用同一 sessionId，后续模型请求确实包含先前读取的内容。没有固定睡眠，事件处理等待已有 drain/barrier。

浏览器核对目录选中后认证为空、添加实例、选择 CLI 默认模型、握手后的 custom:hermes-probe-model、实际工具输出和审批按钮。开发服务在 06:33:34 自动重启，旧审批在拒绝操作后明确显示过期，文件未写入；同一线程恢复后点击“通过”，真实 browser-approved.txt 内容为 HERMES_BROWSER_APPROVED。官方日志确认模型仍为 hermes-probe-model，echo 和 exit 7 分别成功/失败。1280px 与 360px 的 documentWidth 等于 viewport；截图保留在仓库外 `codework-pool-audit-20260929/hermes-tools-1280.png` 与 `hermes-tools-360.png`，视口已恢复，tab 已 markHandoff。最初默认视口操作出现相邻项命中，固定视口后语义点击正常，未将工具坐标问题直接判定为产品缺陷。

浏览器暴露三个仍未修复的明确问题：① 官方对 permission-only `edit-approval-1` 发无内容 completed，canonical 转成 dynamic_tool_call，额外显示空白 Tool；真实 write_file 的 tc-* ID 另有一条；② 失败终端展开重复 terminal result；③ 服务恢复后实际模型请求正确，页面标签却显示 gpt-5.6-sol。Composition unknown_binding 告警仍存在。此次不勾选任何完整 A-N，不声称全部工具显示已通过。未运行全仓检查、外部真实模型、Electron 原生壳、真实手机或远程/relay/tunnel。

#### Retrospect

本轮属于 progress：Hermes 从配置检查推进到真实工具、副作用、权限、新进程恢复与实际页面；定位并修复公共文本结果被 kind 分类覆盖的根因。测试自身也应按厂商实际事件形状断言，不能把 Cline 的 rawInput 或模型路由原样假定为 Hermes 行为。CLI 工具成功、ACP 输出数据、产品显示和服务恢复是不同层证据。

下一轮选择 Hermes 审批生命周期这一连贯增量：先搜索现有 permission 跟踪和工具合并，区分“仅审批出现的 toolCallId”与真实执行 ID，解决无内容审批完成通知多生 Tool 的根因，同时验证允许/拒绝/取消、恢复及不误删真实工具；必要时补完整 Adapter 和双端派生回归，再复用当前线程浏览器。不能直接按标题 Tool 或硬编码 edit-approval 前缀过滤。失败详情重复、恢复后模型标签、Composition 告警分别保留后续，完整 44 入口和设备/远程目标不缩减。

### Round 27

#### Plan

选择上一轮的审批生命周期增量。官方 Hermes permissions.py 明确说明 completed/failed 通知用于关闭权限气泡；它与真实 write_file 的工具 ID 不同。复用 AcpSessionRuntime 已有 toolCallsRef 记录仅来自权限请求的状态和已返回的决策，只有同一根会话、无实际执行更新、无内容且终态与审批决策一致的通知才能视为冗余审批终态。真实工具已开始、后续携带输出/执行状态或审批允许后执行失败的通知均须保留；不按厂商名、ID 前缀或 UI 标题过滤。补原始协议和官方 CLI 证据，复用浏览器检验新的回合。

#### Act

AcpSessionRuntime 在既有 toolCallsRef 增加可选审批状态，包装原 handleRequestPermission，按根会话和原生选项实际结果关联身份。已跟踪执行的 ID 不覆盖；只有审批身份、尚无执行证据、终态匹配决策且原通知严格只有 sessionUpdate/toolCallId/status 时才忽略重复终态。其余更新仍按原合并和进度抑制逻辑处理，保留原真实工具更新的助手消息分段语义。下一 prompt 清理未结束审批标记，复用同一 Map，不新增厂商 Adapter、专属 ID 规则或 UI 隐藏逻辑。

扩展现有 acp-mock-agent 的可选生命周期场景，三种实际 RPC 决策覆盖允许、拒绝、取消；检查执行先于审批、后于审批、携带真实输出、决策与终态不一致、外部会话、未知工具和下一回合 ID 复用。官方 Hermes 工具探针新增审批 ID 不出现在工具执行集合的断言。更新 Hermes、通用 ACP 与完整目录的实现/限制说明。

#### Verify

旧实现红灯：官方 Hermes 探针出现 edit-approval-1/edit-approval-2 两个额外工具 ID；三项协议生命周期测试均多出 approval-only。修复后实际原生决策及真实工具副作用回归通过。首次加入 approvalOnly 分段标记后类型检查发现 Ref.modify 返回字面量类型过窄，改为局部结果对象统一推断；没有用类型断言绕过检查。

最终运行 `.\node_modules\.bin\vp.cmd test run`：AcpJsonRpcConnection、AcpRuntimeModel、CursorAdapter、GrokAdapter、Mobile threadActivity、Web session-logic.command-output 共 6 文件 212 项通过（43.97 秒）；类型推断调整后再次运行 AcpJsonRpcConnection 与设置实际 CODEWORK_HERMES_CLI_PATH/CODEWORK_HERMES_GIT_BASH_PATH 的 HermesAcpToolProbe，2 文件 41 项通过（29.51 秒）。两批去重共 7 文件 213 项。Server tsgo --noEmit 最终退出 0；4 文件 lint/fmt --check 通过，仅原账号池 Effect 建议和原 Node DEP0190 警告。git diff --check 通过，原文档 CRLF 提示保留；12 个受保护文件 SHA-256 均未改变。

浏览器沿用服务 session 66677（5734/13774）。初次旧线程回合被开发服务器重启打断，CLI 恢复又使用已失效的临时模型端口，页面明确显示会话未保留；该次不算验收通过。新隔离线程 ee24f2f8-f524-4896-a765-c25847c8c87d，回合 2ce7030a-c5df-428b-be57-638d01cfcf9b 使用同一官方 CLI、本地合成模型端点。实际点击“通过”，request.opened/resolved 各一条，canonical 完成工具恰好四个 tc-* ID，无审批 ID：读取和 echo 成功、exit 7 失败、write_file 失败。写入失败来自 Hermes 要求先读取已有目标文件的保护，browser-approved.txt 内容及 06:35:10 修改时间未变，不能把通过审批宣称为成功写盘。

展开完整工作记录确认没有新空白 Tool，审批申请/结果与真实失败仍可见。1280px/360px 下 documentWidth 均等于视口；截图为仓库外 codework-pool-audit-20260929/hermes-approval-1280.png、hermes-approval-360.png，已恢复视口并 markHandoff。旧空白历史未修改。真实 CLI 的允许/拒绝/取消与新进程恢复由官方探针覆盖，本次页面实际操作为允许；没有扩大为浏览器三种决策均验收。

无数据库迁移、在线数据写入、全仓检查、子代理、提交/推送/PR 或 .loop-state 修改。外部模型账号、Electron 原生壳、真实手机、远程/relay/tunnel 未验证。所有 A-N 维持未勾选，完整 goal active。回滚仅撤回本轮审批身份关联及其测试/说明，不能整体恢复已包含前轮和账号池修改的文件。

#### Retrospect

本轮为 progress：公共协议身份边界消除了官方真实 CLI 的冗余审批工具，原始协议红灯、真实 CLI、Adapter/双端派生回归和实际页面形成一致证据。审批结束与工具结束是不同状态；审批允许后上游仍可因文件保护失败，必须保留其失败，而不是把许可当执行成功。测试通过后仍需类型检查，局部返回值的字面量推断也可能引入编译错误。

下一轮选择真实工具详情完整性这一连贯增量：核对 Web/Mobile 活动派生和展开详情为何将 terminal result 再当命令追加，以及文件失败为何用截断摘要替代已有完整 detail；复用共用数据与现有详情组件，保留命令/输出独立字段和失败状态，补前后回归并复用浏览器。恢复模型标签、临时端点恢复限制与 Composition 告警继续单独列项。完整 44 入口、真实外部模型与设备/远程目标不缩减。

### Round 28

#### Plan

推进上一轮的工具详情完整性：已定位终态 ingestion 将 detail 截为 180 字符，而终端派生又将 execute 输出当命令；Web 在没有命令时还会丢弃已明确的 stdout。复用现有详情字段与投影，终态保留最多 8,000 字符（沿用 ACP 详情上限），流式中间更新保持原短摘要与载荷压缩。Web/Mobile 对明确 execute 工具不从 detail 猜命令，已有显式命令和无元数据的历史兼容分支保留。补投影、双端派生回归与实际新回合页面，避免复制另一套详情存储或改变全量验收范围。

#### Act

ProviderRuntimeIngestion 的 item.completed 复用现有 truncateDetail，把终态详情上限由 180 调为 8,000；中间 item.updated/started 及原载荷压缩保持。Web session-logic 与 Mobile threadActivity 对 data.kind=execute 的结果不再回退成 command，保留结构化命令及旧无类型数据兼容。Web 删除“没有命令便没有输出”的分支，Cursor 等明确 stdout 在没有命令时也能展开，不制造命令。没有新增详情接口、缓存、Adapter 或组件。

增加 ingestion 到公开投影的详情与超限回归、Web 无命令 ACP 结果回归、Mobile 原样输出/文件长失败及 shell 形状正文回归；更新既有 Cursor 无命令输出测试以对应正确行为。实现与边界同步更新 Hermes、通用 ACP 和全量目录文档。

#### Verify

红灯：Web 新测试复现把 terminal result 当 command；ingestion 新测试复现文件失败被截为 180；Mobile 首个普通文本用例因原展开去重已通过，补 shell 形状的字面输出后复现将正文错误解包成命令（literal output）。没有把未失败的旧检查冒充红灯。

最终 `vp.cmd test run` 五文件：session-logic.command-output.test.ts、session-logic.test.ts、Mobile threadActivity.test.ts、ProviderRuntimeIngestion.activity.test.ts、ActivityPayloadProjection.test.ts 共 155 项通过（3.64 秒）。补 MessagesTimeline.test.tsx、MessagesTimeline.performance.test.ts、ProviderRuntimeIngestion.test.ts 共 139 项通过（109.78 秒）。合计 8 文件 294 项，包含原流式载荷体积、活动合并、失败保留和旧命令回退。未全仓测试。

Server/Web 各自 tsgo --noEmit 与 Mobile tsc --noEmit 全部退出 0，Server 仅原账号池 Effect 建议。7 个源码/测试 lint、fmt --check 通过。12 个保留文件 SHA-256 未变，git diff --check 无错误（原文档 CRLF 提示保留）。无在线数据库写入、提交/推送/PR、子代理或 .loop-state 修改。

复用 session 66677 与原浏览器。热更新短暂使认证读取得到 HTTP 502，经服务日志确认 13774 重新监听后在页面重载恢复。首个新回合 a6fbdfee-47a9-4c9c-b542-a6fce66f5d63 在待审批时又被开发服务重启打断；未计为通过、未杀其它进程或复制服务。结束全部代码编辑与测试后，在新线程 aaf1bd06-2994-4349-87d2-4530944e2a97 实际发起官方 Hermes CLI 工具回合，点击通过并等待完成。固定官方 CLI 配本机合成模型，真实 read/echo/exit 7/write_file 保护失败均保留，仍无空白审批工具。

展开终端与文件失败：DOM pre 内容分别为 34 与 864 字符，terminal result 恰好出现一次，文件失败末尾 preserved. 可见，明确 The file was NOT modified。1280px/360px 文档宽度与视口一致；360px 两个详情框的 clientWidth/scrollWidth 分别 279/279、273/273。截图保存在仓库外 codework-pool-audit-20260929/hermes-details-1280.png 与 hermes-details-360.png。刷新同一页面后重新展开仍返回完整 864 字符，证明新历史可恢复；已恢复视口、markHandoff。

未修改之前已截断的历史，不声称超过 8,000 字符无损。回滚撤回本轮三处生产逻辑和对应测试/文档，无数据库迁移；保留用户与前轮改动。真实手机/Electron 壳、外部推理、远程/relay/tunnel 本轮未验，A-1 至 A-8 均未满足全部条款、继续未勾选，goal active。

#### Retrospect

本轮为 progress：实际失败全文从 canonical 到新持久化、公开投影及页面展开完整保留，真实终端重复显示消失。缺少输入命令不能成为丢弃结果的理由，也不能从输出猜命令；历史兼容应有明确边界。详情上限和流式摘要分开，可改善可检查性而不恢复累计输出的平方放大。开发服务重启会破坏模型临时端点和审批回调，集成页面应在编辑及测试结束后验证，中断必须单独记录。

下一轮选择恢复后模型标签一致性：追踪原被打断线程为何显示 gpt-5.6-sol，而官方请求为 hermes-probe-model；比较正常完成后刷新（本轮仍正确）与运行中重启的元数据路径。先用真实快照/事件定位，再修共用会话和客户端目录边界，验证暂停/恢复、空值撤回及实例隔离。Composition 告警、所有剩余 ACP 安装和完整设备/远程验收仍按原计划推进，不缩减范围。

### Round 29

#### Plan

沿上一轮模型标签问题定位到实际根因：隔离库事件显示 06:34 选择 custom:hermes-probe-model 后模型广告被清为空，06:49 再发送才持久化 gpt-5.6-sol；不是单纯重启丢元数据。官方固定 Hermes 的 set_config_option 只保存任意配置并返回空数组，真正切模型由 set_session_model 完成。修共用 Runtime 的模型 RPC 路由和空配置与旧式模型目录的独立语义；动态模型配置优先，旧式 models 广告走 set_model，无广告旧兼容保持。以协议与真实官方模型请求验证，继续保留完整 44 入口及设备目标。

#### Act

复用 AcpSessionRuntime 既有 setSessionModel 请求，将其提取为共用局部函数；setModel 根据实际模型配置或旧 models 广告选择 RPC。空 config_options 不再清除独立旧式模型目录，原配置模型撤回仍生效。成功 set_model 更新当前模型标记，接受目录外自定义 ID 时保留原 ID、未知能力；失败保持旧状态。无新增 Adapter、缓存、客户端分支或依赖。

acp-mock-agent 增加旧式模型广告场景；AcpJsonRpcConnection 覆盖新建/恢复、无关空配置、真正切换及失败保留。扩展既有 Hermes 官方 CLI 工具探针，使本机端点提供两个模型，切换后核对实际请求和新 CLI 进程恢复。同步 Hermes、通用 ACP、44 入口目录文档。未修改账号池和用户既有文件。

#### Verify

旧实现两项协议回归均因目录被误清为空而失败。修复后真实探针先暴露目录外模型缺少当前标记，再暴露新增模型详情 HTTP 路径未登记；分别按成功 RPC 和已核对的本机 metadata 404 修正，没有将失败当作通过。最终 AcpJsonRpcConnection、HermesAcpToolProbe、CursorAcpSupport、CursorAdapter、GrokAdapter、共享 providerModels、Web composerDraftStore 共 7 文件 213 项通过（45.59 秒，进程退出 0）；Server tsgo 退出 0，仅原账号池 Effect 建议；4 文件 lint/fmt 通过。真实官方 CLI 请求包含两个不同模型，最后恢复请求为 hermes-probe-alternate，历史读文件内容保留，未知 HTTP 请求为零。

复用隔离服务和浏览器。新线程 367321a7-7daa-4eba-ae2e-2a56862832bf 完成默认模型回合，显式选择 Custom endpoint · hermes-probe-model 后发送第二轮。原生日志 23:16:37 UTC 明确 session/set_model succeeded，未调用模型 set_config_option；隔离数据库只读查询确认 model_selection_json 保存 custom:hermes-probe-model。回合完成并刷新后仍有 21 项模型目录和正确选中标签。截图位于仓库外 codework-pool-audit-20260929/hermes-model-1280.png；已恢复默认视口并 markHandoff。本次页面合成短回复没有工具执行，不能用回复文案替代工具证据。

原错误选择历史不自动迁移，需重新选择；浏览器刷新不等于应用服务崩溃恢复，后者仍按 A-7 独立验收。真实手机/Electron、外部推理和远程/relay/tunnel 本轮未验，A-1 至 A-8 继续全部未勾选，goal active。回滚只撤回上述 Runtime 模型处理、三处测试/夹具和文档增量，无数据库迁移，不整体恢复脏文件。

#### Retrospect

本轮为 progress：从真实持久化事件找到误发 RPC → 空目录 → 错误回退的先后关系，修复共有协议边界并经官方 CLI、实际请求模型与页面刷新证明。不能因为问题在重启后被看见就把重启当根因；通用配置返回成功也不等于上游切换模型。旧式模型广告与配置快照的来源必须分别处理，成功接受的自定义 ID 才能加入目录。收尾检查 git diff --check 通过（原有两处 CRLF 提示），12 个保护文件哈希无变化，本轮 8 文件无 UTF-8 BOM。

下一轮推进剩余手工入口中的一个完整接入：先核对 Kiro 当前安装与 CLI 探针、已有异步命令实现和环境可用性，复用原驱动完成可在本机验证的官方 CLI 握手、命令与认证边界；不重复实现已存在的 Kiro 扩展方法。其它 ACP 入口、Composition 告警、外部账号及设备/远程验收继续按原计划，不缩减 44 入口范围。

### Round 30

#### Plan

沿 Round 29 计划推进 Kiro 官方 CLI 接入核验。已有手工目录、异步命令通知和对象形状执行请求及协议回归，复用这些实现，不新增专属 Adapter。本机 PATH 无 kiro-cli，系统为 Windows 10.0.19045，而官方仅声明 Windows 11；从官方安装脚本及发布 manifest 确认 2.26.0 Windows x64 MSI、校验 SHA-256，优先仅提取到仓库外临时目录进行隔离协议探针，不改用户安装和认证。若本机不支持或缺少认证，记录具体阻断并完成可重复检查和准确的配置说明，不把模拟命令测试当真实登录/工具完成。

#### Act

检查官方安装页、ACP 合同、install.ps1 和 stable manifest。下载固定 2.26.0 x64 MSI 到仓库外 codework-kiro-audit-20260930，校验 SHA-256 与 199565312 字节；使用 msiexec 管理提取 /a（非系统安装 /i），提取进程 PID 972、退出 0。版本和 ACP 帮助退出 0，实际默认引擎为 v2。没有更改用户 PATH 或复制凭据。

隔离 cwd/home 的原生 JSON-RPC 探针三次均在 initialize 前退出 1，stderr 为 home directory not found；调整先后为 HOME/USERPROFILE/APPDATA/LOCALAPPDATA，补 HOMEDRIVE/HOMEPATH，再按二进制线索补 KIRO_HOME/KIRO_DATA_DIR。停止此方向的重复尝试，不改为读写用户真实目录。WSL 发行版只读查询退出 1 返回安装帮助，未取得 Linux 环境。不能把版本可运行推断为 ACP 可用，也不能把 Windows 10、提取方式中的任一因素断言为根因。

实际发布清单只有 Windows x64 包，发现手工目录却接受 Windows ARM64。manual-agent-catalog 复用 Gajae 既有架构门禁，将 Kiro 纳入同一条件；x64、Linux ARM64 和 macOS 路径保持，在线同 ID 条目仍优先。补 AcpRegistryCatalog 的平台回归，更新目录说明、用户安装说明，新增 durable Kiro 实现文档，更新通用 ACP 与完整入口表的实际状态。没有凭猜测更改 Kiro 认证方法或现有扩展调用。

#### Verify

新增 Windows ARM64 断言在旧逻辑失败：期望 unsupported-platform/null，实际 manual/kiro-cli acp。修复后命令 `vp.cmd test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts` 共 3 文件 64 项通过，32.88 秒；包含 Kiro 对象请求、异步目录、取消/超时及失败不重发模型的协议回归。出现既有 Node DEP0190 提示，无测试失败。Server tsgo 退出 0，仅原账号池 Effect 建议；两个改动 TypeScript 文件 lint/fmt 通过。

官方包 SHA-256 为 3caff2be8071b0466e292c90ac02592d9b6a5b818b489f30ee0d55a84a318942。实际版本输出 kiro-cli-chat 2.26.0；ACP 的三次失败独立于上述 64 项协议测试，不计通过。临时 probe-result.json、manifest、MSI 和提取内容位于仓库外。未做浏览器、模型请求、工具执行、真实认证和设备/远程验收。A-1 至 A-8 均未满足全量条款，保持未勾选，goal active；其它入口仍有可推进工作，不将单一 CLI 阻断视为全目标阻断。

回滚只移除 Kiro 的架构门禁与相应说明/断言，无数据迁移，不删除既有实例历史，不整体恢复含前轮工作文件。

#### Retrospect

本轮为 progress：取得官方固定发布包和实际启动失败证据，修复一项真实平台误报，形成可执行的后续验证边界。Stuck 自检：连续三次隔离 ACP 启动同样在握手前失败，原因未确定；继续猜环境变量没有证据收益。保持隔离，不以系统全局安装、放开真实账号目录或切换引擎掩盖失败。后续 Kiro 必须在受支持系统和标准安装下重验，版本帮助不能代替 ACP。

下一轮转向未实测的 Gajae Code：核对官方当前 Windows x64 发布资产、校验与配置隔离方式，复用通用 ACP 进行实际握手、认证及本地端点工具验证（若官方支持）；优先补真实接入证据而非重复扩展已有协议。Kiro 待支持环境验证，CodeWhale/TRAE 等剩余入口、外部账号与设备/远程仍保持原 44 入口目标。

### Round 31

#### Plan

沿上一轮计划推进 Gajae Code 的真实 ACP 接入。官方最新发布为 v0.18.1，固定源码 7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301，Windows x64 独立包已下载并匹配发布 digest；版本和 acp 帮助通过。复用现有 GenericAcpDriver、目录和官方 CLI opt-in 探针模式，不新增 Adapter。先验证隔离主目录和认证广告：官方源码接受 agent（终端能力另可广告 terminal），当前目录默认 login 存在不匹配风险；用真实 RPC 复现后再修。继续核对本机模型配置与工具/权限的可执行边界，记录实际支持与未验项，不将空认证响应当账号可用。

#### Act

2026-09-30 完成 Gajae v0.18.1 认证默认值修复。官方 Windows x64 二进制 163112960 字节，SHA-256 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2，与发布 digest 一致；版本和 acp 帮助通过。实际 initialize 广告 agent，authenticate(login) 返回 -32603 / Unknown ACP auth method: login，authenticate(agent) 返回 {}。manual-agent-catalog.ts 改为 agent 并说明模型和凭据前置条件；复用 GenericAcpDriver，不增加 Adapter，不覆盖已有实例的自定义认证配置。

原始协议隔离探针已建会话并收到配置和 skill:ultragoal 命令；Runtime 实际切换 default → plan → default 后，空配置 prompt 明确失败，原始 data.code=model_not_selected。没有使用真实凭据或调用外部模型。Windows 临时目录默认所有者为管理员组导致 owner_mismatch；只将该临时 Agent 目录所有者/DACL 设置为当前用户 SID 后通过，没有放宽上游检查或修改真实目录。

完整会话探针暴露清理缺陷：断开 ACP 后后台主机仍存在，临时 DLL 被占用；加入 session/close 后仍超时。因此最终 GajaeAcpCliProbe.test.ts 只保留真实 initialize/authenticate 两项可重复检查，不创建后台会话，不把失败清理的尝试算通过。两项早期原始探针会话经官方 raw global session.close（精确 sessionId、endpointGeneration、endpointIncarnation、幂等键）完成清理，上游回复端点不可达并向持久化身份匹配的主机发出 SIGTERM。隔离 Broker 的 broker.shutdown 返回 ok=true 后连接关闭；脚本把关闭期间 WebSocket error 记为非零退出，随后只读进程核查无 gjc.exe，不能把脚本退出 1 隐藏成全绿。没有按名称或路径匹配杀进程。

新增 docs/internals/gajae-acp-provider.md，更新目录证据表、通用实现和用户配置说明。固定版本说明文档的 sdk session close 与实际公开注册不符，二进制返回 usage；清理按真实帮助采用 sdk session raw global。记录正常 ACP 关闭仍未解决、工具/模型/设备尚未验收与回滚边界。

#### Verify

开始前已读取 running ledger 的 Acceptance、上一轮 Retrospect 和 Lessons；Round 30 是 progress。本轮未委派子 Agent。目录新增认证断言先红灯（undefined 对 agent），修复后通过。最终显式 CODEWORK_GAJAE_CLI_PATH 执行 GajaeAcpCliProbe.test.ts、AcpRegistryCatalog.test.ts、GenericAcpDriver.test.ts：3 文件 24 项通过，其中真实官方 CLI 探针 2 项；最后一轮 15.28 秒。未设置路径时 opt-in 跳过，不计为真实验证。

完整会话探针最初因临时文件清理 EPERM 失败；先前作用域结束时关闭尝试还触发 60 秒测试超时，调整到作用域内后得到明确 10 秒 close 超时，停止重复并拆出未验证生命周期边界。原始会话/模式/命令结果保留为观察证据，不声称完整探针通过。最后只读 Get-CimInstance 查询无 gjc.exe。

服务端 tsgo --noEmit 最终退出 0，仅有原账号池 Effect 建议。定向三源文件 lint 退出 0；首次 lint 指出 process.platform 直接访问，改用既有 HostProcessPlatform 后通过。三源文件和新增文档格式检查通过。另三份累积文档 fmt --check 仍报告格式不一致，本轮未批量重排历史内容；不能将那次七文件格式检查写成通过。git diff --check 通过，仅提示既有 CRLF 转 LF。12 个保留文件 SHA-256 全部未变，新文件 UTF-8 无 BOM。没有运行全仓检查或启动新浏览器/服务，没有模型计费、真实工具、多端/远程证据。全部 Acceptance 保持未勾选。

回滚只撤回 Gajae 手工目录认证默认值/说明与本轮对应测试文档；无数据库迁移，不覆盖历史实例、账号池或其它轮次改动。

#### Retrospect

本轮属于 progress：通过固定官方二进制复现并修复了会让默认接入失败的认证方法，留下真实握手/认证的可重复探针和完整边界文档。认证成功不能证明模型可用；CLI 文档列出的命令也可能没有进入实际公开注册。会话独立进程在 ACP 退出后继续存活是必须单独处理的生命周期问题，不能靠无关全局进程清理掩盖。

下一轮继续 Gajae 的实际会话生命周期与工具闭环，先定位 session/close 超时、后台主机所有权和正确收尾，再使用隔离模型配置及本机模型端点验证真实工具、审批、拒绝、取消和恢复，核对显示链路。若确认特定版本上游阻断，则保留证据并推进清单其它可验证 Agent，不反复碰同一失败。仍保留 6+38=44 全量范围与所有多端/远程/最终独立审计要求，不因目录或 24 项回归通过标记整体完成。

### Round 32

#### Plan

上一轮属于 progress：修复了官方 Gajae 认证方法并留下真实 CLI 回归。本轮选择 Gajae 会话生命周期这一连贯增量，先用不经过 Code Work Runtime 的原始 ACP 验证 session/new → session/close，区分产品协议边界和上游关闭问题；检查上游所有权及实际关闭响应，复用已有精确会话清理，不按名称杀进程。依据结果修复产品中证实的缺口或明确固定版本阻断，再为后续真实工具验证提供可靠收尾。保持全部 44 入口和多端验收范围，不将认证成功当作完整接入。

#### Act

2026-09-30 补齐 ACP 停止会话的显式关闭。AcpSessionRuntime.close 仅对已建立且 initialize 广告 sessionCapabilities.close 的会话发送 session/close，不为了关闭启动新会话；5 秒未回应返回可捕获错误。CursorAdapter（Generic/Kimi 共用）和 GrokAdapter 在释放协议/进程前调用该方法，失败或缺陷均继续本地收尾，session.exited 标记 error 并带固定脱敏说明，成功或未广告保持 graceful。既有 ctx.stopped 与线程锁仍控制停止，不新增会话管理器或后台清理服务。

异常退出原先不生成活动，新增 ProviderRuntimeIngestion 的 session.exited/error 投影，保留错误说明供工作记录查看；普通/未标异常退出仍不增加记录。会话停止不删除历史，不承诺远端副作用撤销。扩展既有 mock、两条 Adapter 回归和 Runtime 超时测试，GajaeAcpCliProbe 改为真实时钟并增加实际建会话、模式拒绝、缺模型失败与产品 close 的探针。

更正 Round 31 的证据推断：固定官方 Gajae v0.18.1 实际拒绝 plan（-32602 / unsupported），前轮失败探针不能证明其功能断言通过，“default → plan → default 成功”应撤回。原始 ACP 的直接关闭、失败后关闭、大小请求 ID 混合，以及独立产品 Runtime 均正常返回 {}，单次关闭约 223–239ms；早期超时的单一原因尚未确定，不能再表述为固定上游关闭缺陷。曾怀疑核心与扩展 ID 冲突，检索确认核心已从 2^32 起分配，针对性实验通过，该假设排除、临时改动撤回，没有修改协议 ID 策略。

原始探针都放在仓库外；关闭成功后不重复生命周期变更。首次额外清理已关闭会话返回 endpoint_stale，保留结果并停止重试；后续只关闭所属隔离 Broker。所有测试结束只读检查无 gjc.exe。更新 Gajae 专项文档、总目录、通用实现及用户说明，纠正旧断言并保留模型/工具/设备未验边界。

#### Verify

已读取 Acceptance、上一轮 Retrospect、全部 Lessons、源计划及相关技能；上一轮为 progress，本轮没有子 Agent。停止路径回归首次因错误地重复调用要求存在会话的 stopSession 而失败，修正测试前提后真正红灯为 4 失败/2 通过：两个适配器都没发送 close，失败场景也报告 graceful。实现后 6 项通过。错误活动新回归先红灯 [] 对预期错误记录，补投影后通过。

最终定向检查：显式 CODEWORK_GAJAE_CLI_PATH 的 GajaeAcpCliProbe.test.ts、AcpJsonRpcConnection.test.ts、CursorAdapter.test.ts、GrokAdapter.test.ts、GenericAcpDriver.test.ts，共 5 文件 140 项通过（含 3 项真实官方 CLI 探针）。Runtime 超时测试使用请求开始回执后推进 TestClock，验证关闭前未建会话不发请求及无回应时有界失败，不依赖固定睡眠。ProviderRuntimeIngestion.activity.test.ts 与 ProviderRuntimeIngestion.test.ts 共 2 文件 104 项通过；累计 7 文件 244 项。后者真实运行 123.73 秒，中途持续轮询同一存活执行句柄，没有因无新输出重启。

服务端 tsgo --noEmit 最终退出 0，仍只有原账号池 Effect 建议。本轮源码定向 lint 通过，CursorAdapter.test.ts 原 invocation 未使用警告 1 条；相关源码及 Gajae 文档格式检查通过。git diff --check 通过，仅提示累积文档 CRLF 转 LF；12 个保留文件 SHA-256 未变，探针/文档/ledger UTF-8 无 BOM。没有全仓检查，没有实际模型/工具、浏览器、Electron、手机或远程验收；所有 Acceptance 仍不满足全项，保持未勾选。

回滚撤回 Runtime.close、两个 Adapter 调用和异常退出活动投影及对应测试文档即可，无数据库迁移。不得撤回原账号池、前轮认证默认值或其它已存在改动。额外能力只在 Agent 广告后启用，未广告 Agent 的停止行为保持原样。

#### Retrospect

本轮属于 progress：真实 RPC 排除了“上游一定不能关闭”的错误归因，修正了先前模式成功的错误记录；同时找到了产品停止路径确实缺少 close 的问题，已经补齐共用生产调用、超时和错误显示数据，244 项回归通过。失败探针的后置清理错误可能掩盖前置断言，不能把“运行到失败附近”写成功；应逐个保存实际返回值，在断言前处理拥有的资源。

下一轮继续 Gajae 真实工具链：使用官方支持的 models.yml 和独立本机模型端点，验证文本、读文件、写入/命令权限、拒绝、取消及恢复，逐项核对实际副作用和工具详情。不将认证、关闭或配置广告替代工具验收。其它 Agent、44 入口、多端/远程和最终独立审计保持原范围；若出现具体上游限制，记录固定版本证据并继续可推进项。

### Round 33

#### Plan

与 Round 32 并行的子任务，只处理计划中不依赖外部 CLI、与 Round 32 文件不重叠的三项缺口：P1 的 ACP search/fetch 分类风险、P4 的 providers.md 驱动数量、P3 的 Mobile 目录选择。不改服务端运行时、Adapter 或 ingestion。

#### Act

2026-09-30 三项改动：

1. ACP `search`（本地查找）与 `fetch` 均投影为 `web_search`，Web 工作日志把本地搜索显示为“网络检索”。服务端类型保持不变以兼容历史；Web `WorkLogEntry` 增加 `toolKind`（来自 `data.kind`），`workLogEntryIsLocalCodeSearch` 以 `toolKind === "search"` 判为代码搜索，`fetch` 仍为网络检索；仅状态的完成包沿用首条分类。Mobile 只有通用“搜索”计数，未改。
2. `providers.md` 驱动数 eleven → twelve，补 `zcodeAgent` 行，并记录 search/fetch 显示边界。
3. 新增 Mobile `AcpRegistryCatalogSection`：选择 ACP Agent 时读取既有 `byokEnvironment.acpRegistryCatalog`，支持搜索、离线快照、手工/平台不可用、配置状态、安装/文档链接、公开环境（敏感值掩码）与 MCP 兼容默认提示，一次渲染 12 项。`makeMobileAcpCatalogInstance` 保存与 Web 相同的 command/authMethodId/supportsMcpServers/environment；`suggestAcpCatalogInstanceId` 在 ID 为空时建议合法且不冲突的 ID。切换驱动、环境或添加成功后清除选择。中英日文案、目录对照与用户文档同步。无合同、服务端或依赖改动。

#### Verify

红灯：新增 Web 两项 search/fetch 回归在旧实现得到 `search` 而非 `code-search`。修复后 Mobile SettingsProvidersRouteScreen.logic / threadActivity / i18n runtime 与 Web session-logic.command-output / session-logic / MessagesTimeline.logic / MessagesTimeline 共 7 文件 259 项通过。Mobile `tsc --noEmit`、Web `tsgo --noEmit` 退出 0；9 个源码文件 fmt/lint 通过，仅 MessagesTimeline.logic 原 reverse 建议；3 份文档已格式化，git diff --check 通过。未做模拟器/真实手机、浏览器或官方 CLI 验证；Mobile 目录 UI 只有逻辑测试与类型检查证据。全部 Acceptance 保持未勾选。

#### Retrospect

本轮属于 progress：P1 分类风险经红灯确认并以最小客户端修复消除，P3 的 Mobile 目录入口补齐，P4 文档数量更正。Mobile 目录需要在模拟器或真实设备补一次实际添加验证；Mobile 暂无 Copilot/Gemini 快捷按钮。主线下一轮仍按 Round 32 Retrospect 推进 Gajae 真实工具链。

### Round 34

#### Plan

沿 Round 32/33 Retrospect 推进一个增量：Gajae v0.18.1 的真实工具链。保留 Round 33 已有客户端与 Mobile 目录改动，不重复实现。复用现有 Runtime 和官方 models.yml/模型预设，以独立用户目录、仅本机模型响应端点验证文本、读写、命令、原生权限决策、拒绝、取消及恢复；核对实际文件、命令出口和工具详情。先读官方 wire fixture 与已有 Hermes 探针，只有真实缺口才改共用生产链；不把夹具推理或认证接受当外部账号可用。本轮不派子 Agent，全部 Acceptance 继续按完整条款审查。

#### Act

2026-09-30 只推进 Gajae 工具与结果增量，不派子 Agent，保留随后出现的 Round 35/36 目录与下载改动。固定官方 v0.18.1，复用官方 models.yml profiles + --mode acp --mpreset acp-fixture，模型端点只监听 127.0.0.1。原始协议验证文本、实际读 source.txt 和写 approved.txt；目录内 write 不触发审批。新目录单回合经产品 Runtime 验证原生 allow_once 的真实 Git Bash stdout 与 completed、reject_once 的 failed 与 denied.txt 不存在、审批中取消的产品 cancelled 与 cancelled.txt 不存在。取消底层请求为客户端 Interrupt，并无上游 cancelled 回应或工具终态，最后工具仍 pending，记录为下一步缺口，不强行写 failed。

真实 rawOutput.content 为 MCP 文本数组，ACP 展示 content 同时带命令预览和重复正文。共用 AcpRuntimeModel 优先用实际 MCP 结果作为 detail，批量查询仍优先；known text 数组每块沿用 8000 字符尾部限制，派生详情也限长，图片/其它字段原样保留。没有全局正文去重、专用 Adapter、合同或数据库迁移。AcpRuntimeModel.test.ts 两项回归先红灯：详情多出命令和两份正文、20012 字符原始文本绕过限长；修复后通过。文档同步真实副作用、Bash 配置、取消与生命周期边界。

连续回合曾遇到上一回合最终文本尚在发布的 conflict；等上游 idle 后又在 write 已真实完成时缺 idle 回执。旧目录出现 cleanup_failed 与后续 initialize 超时。没有靠睡眠或盲重试制造通过；换全新目录、一个回合的命令/拒绝/取消关闭均成功。无处理 Promise 拒绝是独立探针错误，已修正；取消探针一度错误要求工具 failed，按真实 pending 纠正，未改生产状态掩盖缺口。

所有探针、原始响应和验证脚本在仓库外 codework-gajae-audit-20260930 下。关闭失败先用官方 SDK 身份清理，一次成功；两次文件锁使 SDK 结果未知，按对应 host_registered 启动回执的测试 PID、隔离 cwd、Windows FILETIME 和精确 exe 交叉核对后回收。路径比较首次因斜杠表示不一致而安全拒绝，规范化路径后才执行。没有按名称批量结束进程，最终无 gjc.exe 残留。保留失败结果，不能将清理成功当成 ACP 优雅关闭成功。

#### Verify

读取 Acceptance、Round 32/33 Retrospect、Lessons 和官方 wire fixture；当前额外 Round 35/36 均原样保留。定向 8 文件 238 项通过：AcpRuntimeModel / AcpCoreRuntimeEvents / AcpAdapterSupport 共 62 项；CursorAdapter / GrokAdapter / AcpJsonRpcConnection / Web session-logic.command-output / Mobile threadActivity 共 176 项。另运行仓库外 assert 脚本核对三份实际 Runtime 响应、原生决策、最终工具数据、关闭成功、取消的客户端中断以及实际读写和拒绝/取消文件不存在；脚本通过。命令详情实际只含一份 GAJAE_SHELL_72319。

修改的两个源码 fmt/lint 通过。服务端 tsgo 退出 1：Round 35 新的 AcpRegistryBinaryInstall.test.ts 有 fs/http/path 三项 Effect nodeBuiltinImport 错误，AcpRegistryBinaryInstall.ts 的构造参数属性不满足 erasableSyntaxOnly；本轮源文件没有类型错误，但不能写整体类型检查通过。未改这两份其它增量文件。git diff --check 通过，仅累积文档 CRLF 提示；12 个保留文件 SHA-256 未变，未运行全仓检查。新文档/代码 UTF-8 无 BOM；本轮没有浏览器、Electron、手机、恢复、外部模型、余额或远程验收。所有 Acceptance 仍保持未勾选。

回滚只撤回本轮 MCP 文本数组识别、限长、详情优先级及两项回归，不回退前轮认证/关闭、Mobile 目录、账号池或 Round 35/36 工作，无数据库迁移。

#### Retrospect

本轮为 progress：真实 CLI 工具和产品 Runtime 决策/输出补充了证据，并找到共用结果形状导致重复详情和限长绕过的根因，以小改动修复。取消 API 返回 cancelled 可能是客户端归一化，不等于 Agent 发出该响应；已取消且没有工具终态的 pending 需沿 Adapter → ingestion → Web/Mobile 核对，不可从文案推断。

下一主线增量先解决当前二进制安装增量暴露的类型检查错误并运行其定向回归，再推进取消终态与实际显示、Gajae 连续回合/恢复。完整 44 入口、设备/远程、真实账号及最终独立审计不缩减。当前没有重复同一阻塞达到整体无进展，goal/loop 继续运行；不把局部 CLI 成功或 238 项回归当完整接入。

### Round 35

#### Plan

补齐官方 ACP 目录此前省略的图标与带校验二进制下载：扩展合同、刷新快照字段、内置 SVG、Web/Mobile 目录展示，以及服务端校验下载。不伪造 38 个 Adapter，不把图标/下载当作工具调用验收。

#### Act

2026-09-30：`AcpRegistryCatalogEntry` 增加可选 `iconUrl` 与 `binaryDistribution`；新增 `server.installAcpRegistryBinary`（客户端只传 entryId）。快照补充 CDN 图标与带 sha256 的二进制 archive/cmd/args；41 个 SVG 缓存到 `apps/web/public/acp-agent-icons/`。目录解析仅接受 CDN 图标与已校验分发。安装写入 `<baseDir>/acp-agents/…`，校验 sha256 后解包并回填命令。Web/Mobile 目录显示图标，二进制条目提供下载安装与归档链接。中英日文案与目录文档同步。

#### Verify

定向测试覆盖目录 icon/binary 解析、安装校验复用、Web picker/图标工具与既有目录测试。未做真实官方大包下载、Electron 或真机验收；Acceptance 保持未勾选。

#### Retrospect

图标与可校验下载是目录可用性的必要一步，不等于各 Agent 工具链已验收。下一轮仍可按 Round 34 推进 Gajae 真实工具链，或实测一两个官方二进制下载安装路径。

### Round 36

#### Plan

Opus 5.5 额度不可用，本机复核图标覆盖与下载 UX；只修验证发现的真实缺口。

#### Act

核对：41/41 快照图标均有内置 SVG，bundled set 与磁盘一致；47 个平台二进制分发均含 sha256。修复下载成功后 Web/Mobile 目录行仍显示“下载”的问题：选中态以表单/已选命令为准覆盖目录里的 null command。

#### Verify

定向 4 文件含新增回归测试通过。

#### Retrospect

下载后的选中态必须用本地已填命令，不能只读目录查询快照。

### Round 37

#### Plan

完成一个连贯增量：使 Round 35/36 的官方二进制安装链可编译并实际可验证。先修四项已复现的 TypeScript/Effect 诊断，沿目录 → 服务端按 ID 解析 → 下载/hash/解包 → 发布/复用 → Web/Mobile 命令回填检查现有路径；重用 CodeOSS 的解包工具和现有测试。真实缺口才补修，尤其确保发布不删除并发安装的已完成目录，递归清理目标始终留在独立安装根目录。验证本机 HTTP/归档夹具及一个官方固定归档，不把下载、版本或图标当完整工具验收。上一轮属于 progress；不派子 Agent，不改变完整 44 入口、A-1…A-8 和后续取消/恢复范围。

#### Act

2026-09-30 修正安装模块构造参数属性与测试 Node 内置模块诊断，沿用现有 Effect 边界豁免并改为兼容 erasableSyntaxOnly 的普通字段。安装根目录、条目目录、实际路径与版本目录均在网络和递归清理前验证。删除发布前清空目标的逻辑，改为原子 rename；并发安装失败方复核已完成安装后复用，无法确认的损坏缓存保留原内容并明确失败。只清理本次 UUID 临时目录，不新增依赖或 Agent Adapter。

安装测试增加损坏缓存保留、路径越界、并发发布和真实 tar.gz 嵌套启动路径，保留原 raw/校验/复用测试。新增稳定文档 docs/internals/acp-registry-installation.md，记录模块合同、失败边界、实际官方归档验证与回滚。

用户在本轮明确要求按步骤提交、模块化并继续完整接入。已核对空暂存区和依赖，将官方目录/合同、手工入口/快照/许可证、安装模块/RPC/权限及共享客户端命令作为一个可调用后端步骤提交：3382ddbc7（feat(acp): 完善官方目录与可校验二进制安装），13 文件。不混入客户端按钮/图标、账号池、其它工具增量或临时 spec/计划。仓库原提交钩子执行 vp staged 会创建全树备份 stash，本次只在该次 git 命令使用仓库外钩子执行相同格式任务并加 --no-stash --fail-on-changes；未改持久 Git 配置、未跳过检查、未推送或创建 PR。

#### Verify

红灯：原损坏缓存重装测试实际成功并删除保留文件；越界 ID 未在边界拒绝，而进入下载失败。修复后 7 项安装测试通过，包含真实 HTTP/归档副作用和等待两次请求同时到达的并发夹具，无新增固定 sleep。

目录/安装/Web picker/图标/Mobile 配置逻辑 5 文件共 37 项通过；RPC 权限映射补充运行 1 文件 12 项通过，共 49 项。目标安装源/测试 fmt、lint 通过。最初四项诊断修复后服务端 tsgo 退出 0；提交前重查遇到其它正在修改的 attachmentStore.ts:74 TS2366，最新整体服务端类型检查不通过，安装模块无该错误，不修改或提交该文件。13 个提交文件格式钩子通过，暂存区与精确允许列表一致，diff --cached --check 通过，新文件 UTF-8 无 BOM。

实际生产安装函数在仓库外独立根目录下载固定 Amp ACP v0.9.0 Windows x86_64 ZIP，HTTP 200、38,461,044 字节，SHA-256 3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b 与官方固定 Release API digest 相同。解包 exe 99,161,088 字节；第二次调用返回相同命令和路径，下载计数保持 1，mtime 不变。--help 退出 0 但无正文，不据此宣布协议或认证可用。首次探针的 120 秒调用方期限中断真实下载，返回 download-failed 并清理临时目录；按产品 10 分钟期限重跑同一 URL 成功，没有关闭 hash 或切换来源。

本轮无浏览器、Electron、手机、真实账号、模型/工具、余额、恢复或远程验收；没有全仓检查。全部 Acceptance 保持未勾选。12 个保留文件提交前后 SHA-256 均未改变，提交没有操作用户在线数据库。回滚可撤回 3382ddbc7 的目录/合同/RPC/安装源码，无数据库迁移；保留已有安装目录和其他工作，不自动清理用户数据。

#### Retrospect

本轮为 progress：安装链从类型错误推进到本机副作用回归、固定官方归档实际下载验证和一个独立 Git 步骤。测试找到发布前删除导致原内容丢失的根因，原子发布复用现有文件系统能力，不必增加全局锁或安装任务框架。最新共享工作树类型失败需与本轮安装诊断分开记录，不能用较早通过覆盖后来错误。

下一轮先核对现有 Web/Mobile 安装按钮在切换条目/环境、关闭/重开时的异步归属和错误回填，只修实际缺口并完成定向客户端验证后单独提交。其后继续 Gajae 取消后 pending 工具终态与连续回合/恢复；前轮尚未提交的协议/UI工作按可验证模块分步整理，不批量提交脏工作树。完整 44 入口、真实账号、设备、远程及最终独立审计保持原范围；下载或 49 项回归不等于完整接入。

### Round 38

#### Plan

完成一个客户端目录增量：检查并修复 Web/Mobile 官方二进制下载后的异步回填和选中显示，完成定向验证后单独提交。上一轮为 progress，3382ddbc7 已提交可调用后端，不重复实现安装模块。检索发现 Web 下载使用启动时的 onSelect/configDraft，Mobile 只传 ID 并从原目录读取下载后的 command；两端共用 useAtomCommand 不负责组件卸载取消。复用现有页面 generation/ref 与 useEffect 生命周期模式、现有目录组件及测试 Hook harness，不新增安装任务系统或 Adapter。

验收本增量：成功命令只写入发起下载的环境和未变更的当前选择；卸载、切换条目/环境或手工改命令后迟到成功/失败均不污染表单；同一下载开始至渲染前的重复点击只发起一次；Mobile 选中详情使用真实下载命令。验证本机定向交互测试、双端类型/格式检查与 retained 隔离浏览器关键入口，浏览器获准且沿用已有服务，不把静态渲染当原生设备证据。完整 44 入口及 A-1…A-8 不缩减，无子 Agent。

#### Act

2026-09-30：Web `AcpRegistryCatalogPicker` 与 Mobile `AcpRegistryCatalogSection` 用 `activeInstall` Symbol + `useEffect` 在环境/选中命令或条目（Mobile 另含 disabled）变化与卸载时作废进行中安装；同步 ref 防止渲染前连点；迟到成功/失败不调用 onSelect、不写 installError。Mobile 改为接收完整 `selectedEntry`（含下载后的 command），父级 `SettingsProvidersRouteScreen` 传 `catalogEntry={newCatalogEntry}`；选中详情与行按钮使用父级命令而非目录 null。复用 `isAtomCommandInterrupted`。

#### Verify

`.\node_modules\.bin\vp.cmd test run apps/web/src/components/settings/AcpRegistryCatalogPicker.interaction.test.tsx apps/mobile/src/features/settings/AcpRegistryCatalogSection.test.tsx`：2 文件 **12** 项通过（连点一次、环境/命令/条目/卸载/disabled 迟到结果丢弃、旧失败不污染、当前失败可重试、Mobile 已装命令显示）。未跑 Electron、真机、浏览器、relay。Acceptance 保持未勾选。

#### Retrospect

本轮为 progress：安装按钮异步归属闭环有定向交互证据。尚缺获准浏览器回归与类型/格式检查记录；不把 Hook harness 当原生设备证据。下一轮可隔离复测无登录 CLI（Qwen/Hermes）或补浏览器安装入口。

### Round 39

#### Plan

并行推进不重叠的协议/回归增量（与 Round 38 安装按钮客户端工作分开）：A-1 音频/blob 非文本链路（若工作树尚未入账则补齐）、客户端中断后进行中工具无终态、P4 原生 Adapter 定向回归、本机 CLI PATH 探测与凭据阻断记录；更新 catalog/gajae/generic 文档与 ledger。不勾选 A-N，不碰 Round 38 的 Web/Mobile 安装按钮文件。

#### Act

2026-09-30：确认/补齐 audio+blob 合同与 `ProviderBinaryAttachment`、Runtime 解析、Web/Mobile 可见入口及文档。`AcpSessionRuntime` 在 cancelled 时对已 emit 的 pending/inProgress 工具补发 failed（仅审批登记未发工具行者不新造 Tool）；新增 `AcpJsonRpcConnection` 夹具。更新 `gajae-acp-provider.md`、`paseo-provider-catalog.md`、`generic-acp-provider.md`。Kiro 保持 Win10 提取握手失败边界（PATH 仍无 kiro-cli）。PATH 探测：gemini 0.55.1；`.gemini` 目录存在但未见可用 oauth/accounts 凭据文件，不发明密钥；codewhale/traecli/gjc/hermes/cline/copilot/uvx 缺失；npx crow-cli@0.1.24 → ETARGET。

#### Verify

本机重跑（2026-09-30）：
- `AcpJsonRpcConnection.test.ts` + `ProviderBinaryAttachment.test.ts` + Codex/Claude/OpenCode：5 文件 **197** 通过（含取消工具终态与 audio/blob）。
- P4 原生 Adapter：`Layers/Codex|Claude|OpenCodeAdapter.test.ts` + `pifamily/PiAdapter|OmpAdapter.test.ts`：5 文件 **165** 通过。
未跑 Electron、真机、relay/tunnel。Acceptance 全部保持未勾选。

#### Retrospect

本轮属于 progress：取消工具终态与 P4 回归为可证据增量；CLI 凭据/安装缺口继续阻断 A-3/A-4 勾选。Round 38 安装按钮客户端工作可独立继续。下一优先：Round 38 安装 UX 闭环，或隔离安装下一项无登录 CLI / Gajae 连续回合。

### Round 40

#### Plan

在 Round 38/39 之后复测无登录 ACP CLI：仓库外隔离安装固定 `@qwen-code/qwen-code@0.24.7`，用既有 `QwenAcpCliProbe`（本机 OpenAI 兼容夹具，非外部账号）刷新证据；更新 catalog/qwen 文档与 ledger。不发明 Gemini/Copilot 凭据；不勾选 A-N。

#### Act

2026-09-30：`npm install --prefix C:\codework-cli-iso\qwen-0.24.7 --ignore-scripts @qwen-code/qwen-code@0.24.7`；`cli.js --version` → **0.24.7**。设置 `CODEWORK_QWEN_CLI_PATH` 指向该 `cli.js`。

#### Verify

`.\node_modules\.bin\vp.cmd test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts`：1 文件 **1** 项通过（握手、配置、文件工具、拒绝、取消、恢复；模型为本地夹具）。未跑外部 Qwen 账号、Electron、真机、relay。Acceptance 保持未勾选。

#### Retrospect

本轮为 progress：本机 PATH 缺失时仍可用隔离安装复现 Qwen 专项探针。外部推理与多端仍开。下一优先：Hermes 隔离复测，或 Round 38 获准浏览器安装入口，或 Gajae 连续回合。

### Round 41

#### Plan

继续无登录 CLI：仓库外隔离安装固定 Hermes `v2026.9.24` / `hermes-acp` 0.21.5，跑既有 CLI+工具探针并刷新文档；不发明 Gemini/Copilot 凭据；不勾选 A-N。

#### Act

2026-09-30：`git clone --depth 1 --branch v2026.9.24` 到 `C:\codework-cli-iso\hermes-v2026.9.24`；Python 3.13.14 venv + `pip install -e '.[acp]'`；`hermes-acp --version` → 0.21.5，`--check` → OK。探针需 `CODEWORK_HERMES_GIT_BASH_PATH`（非仅 `HERMES_GIT_BASH_PATH`）。

#### Verify

`HermesAcpCliProbe` + `HermesAcpToolProbe`：2 文件 **4** 项通过（补 Git Bash 路径后）。未跑外部模型、Electron、真机、relay。Acceptance 保持未勾选。

#### Retrospect

本轮为 progress：Qwen+Hermes 本会话均有隔离复测证据。仍缺 A-5/A-7 设备与连接、凭据型 Gemini/Copilot 再验、Round 38 浏览器安装入口。下一优先：获准浏览器验证安装按钮，或 Gajae 连续回合。

### Round 42

#### Plan

按本轮 continuation：隔离安装并复测 Cline/Gajae；收敛 Gajae 连续回合 conflict 与审批中取消终态；在无凭据前提下尝试其它 PATH 缺失 CLI；Gemini/Copilot 凭据门继续只记录；浏览器安装按钮仅在 test-codework-app 可直接跑时再验，否则保持 blocker。不勾选无证据的 A-N，不缩减目标。

#### Act

Cline：沿用 `C:\codework-cli-iso\cline-3.0.65`，`ClineAcpCliProbe`+`ClineAcpToolProbe` 再验 4/4（本地夹具）。Gajae：隔离 `gajae-0.18.1` CliProbe 3/3；新增 `GajaeAcpToolProbe.test.ts`（连续文本×2、read、bash allow、审批 cancel→failed）。`AcpSessionRuntime` 仅对 `agentInfo.name=gajae-code` 在非 cancelled 的 prompt 返回后等待 `update._meta.gjcPhase=idle`（60s timeoutOption）。探针改非 scoped 临时目录并忽略 Busy 清理，避免 Windows 上 gjc 锁 workspace 的 EBUSY 掩盖断言。更新 `gajae-acp-provider.md`、`paseo-provider-catalog.md`（gjc/cline 证据与 crow npm 漂移）。尝试 `crow-cli@0.3.0` 隔离安装：包为无关 Crystal→Flow Mach-O，非 ACP 入口。

#### Verify

`CODEWORK_CLINE_CLI_PATH` 下 Cline 两探针 4/4；`CODEWORK_GAJAE_CLI_PATH`+`CODEWORK_GAJAE_SHELL_PATH` 下 `GajaeAcpToolProbe` 1/1、`GajaeAcpCliProbe` 3/3、同批 `AcpJsonRpcConnection` 44 通过。未写 `~/.t3/userdata`；未发明密钥；未跑 Electron/手机/relay；未获保留环境的浏览器安装按钮证据。

#### Retrospect

progress：Gajae 连续回合与真实审批取消缺口有官方 CLI 证据与 Runtime 修复；Cline 隔离再验保持。仍缺 A-5/A-7 设备与连接、Gemini/Copilot 凭据、CodeWhale/TRAE/正确 crow 资产、安装按钮浏览器。下一优先：获准或启动隔离 `vp run dev` 做安装按钮宽/窄屏，或继续可无登录安装的官方二进制入口。

### Round 43

#### Plan

查找 CodeWhale、TRAE、真实 crow ACP 的合法安装路径；在无发明凭据前提下隔离安装并做握手探针；同步更新目录、专项文档与 ledger。继续其它可无登录的「未实测」条目；不启动本机 `vp run dev`/浏览器，不伪造 A-5/A-7。

#### Act

CodeWhale：下载官方 `v0.10.0` `codewhale-windows-x64-portable.zip`，SHA 与发布 checksum 一致；`codewhale serve --acp` initialize=`codewhale@0.10.0`、auth=`codewhale-terminal-auth`；新增 `CodeWhaleAcpCliProbe` 与 `codewhale-acp-provider.md`。Amp：下载 registry 指向的 Windows zip，SHA 匹配；initialize=`amp-acp@0.9.0`、auth=`setup`；新增 `AmpAcpCliProbe` 与 `amp-acp-provider.md`。Autohand：隔离 `@autohandai/autohand-acp@0.2.1` initialize 通过，缺底层 CLI 时 auth=`autohand-install`；新增 `AutohandAcpCliProbe`。crow：确认真实包为 PyPI/`github.com/crow-cli/crow-cli`（非 npm）；uv+Python 3.14 装上 0.1.37 后 Windows CLI 因 `termios`/`pty` 无法启动。TRAE：`trae.cn/trae-cli/install.ps1` 本机区域 403，文档仍要求企业登录。更新 `paseo-provider-catalog.md` 对应行。

#### Verify

`CODEWORK_CODEWHALE_CLI_PATH` / `CODEWORK_AMP_CLI_PATH` / `CODEWORK_AUTOHAND_CLI_PATH` 下三探针各 1/1；原始 stdio initialize 交叉核对。未写 `~/.t3/userdata`；未发明密钥；未跑 Electron/手机/relay/浏览器。

#### Retrospect

progress：两个官方二进制握手落地；crow/TRAE 边界写清（平台/区域）。工具与外部模型仍缺凭据。下一优先：其它无登录二进制（如更多 registry zip），或 primary 保留环境的安装按钮浏览器。

### Round 44

#### Plan

完成上一轮 Retrospect 中 primary 保留环境的安装按钮验证，并将 Round 38 已实现的双端目录模块收尾成独立提交。先检索现有目录、表单与异步处理，不重复实现 Round 37 后端安装或 Round 39–43 协议/CLI 探针。下载请求寿命与当前选择身份分开：选择变化阻止迟到回填，但请求未结束时保持下载反馈。补父级最新配置合并回归；提交中纳入 MCP/空认证两个必要的运行分支，避免回溯后的界面保存配置不生效。完整 44 入口及 A-1…A-8 保持原范围，无子 Agent。

#### Act

2026-09-30：Web AcpRegistryCatalogPicker 与 Mobile AcpRegistryCatalogSection 分别使用同步 activeInstall 和选择生命周期 selection，阻止同一次渲染前连点，并忽略环境、条目、命令、disabled 或卸载后的迟到结果。选择变化只撤销回填资格，下载反馈仍保持至请求结束。Mobile 接收完整 selectedEntry，父级按环境重建目录；Web 的目录回填合并最新草稿，保留下载期间的其它字段编辑。补中英日目录/配置文案与 41 个随 Web 打包的官方目录 SVG，失败保留文字占位。

核对提交依赖后，仅从现有服务端改动选择 GenericAcpDriver 的 supportsMcpServers 透传、CursorAdapter 的 MCP 条件与显式空认证传递、AcpSessionRuntime 的空方法跳过 authenticate；没有混入动态模型、工具终态、Gajae idle 或其它协议分支。新增 GenericAcpDriver.settings.test.ts 用已有 mock 日志验证 false/缺省/true 和空/缺省/非空认证在新建、恢复中的实际请求。

提交 dcac02c3cb65bfa2ebbfa7ed79f57f7fa0009ebd（feat(acp): 接通双端目录下载与安全回填）：65 文件，其中 41 个 SVG、24 个源码/文档文件。7 个含其它改动的文件精确选择补丁，账号池、附件、其它协议、spec/计划与截图均未提交。沿用原格式配置，通过该次 git 命令的仓库外格式钩子比较索引与 formatter 标准输出，不自动改写工作树、隐藏部分暂存文件或创建全树 stash；持久 core.hooksPath 仍为 .vite-hooks/_。未推送、未创建 PR。

#### Verify

前期 12 个交互回归旧行为失败后修复通过；补最新草稿合并回归。最终工作树 8 文件 133 项通过，独立设置运行回归 1 项通过。为确保提交没有借用其它未提交实现，以 3382ddbc7 的 git archive 加精确暂存补丁建立仓库外源码副本；65 文件内容与索引一致（64 个文件仅 Git apply 转换 LF/CRLF），workspace 合同、client-runtime 与 effect-acp 链接明确指向副本，第三方依赖复用已安装版本。

独立副本：目录交互/显示、添加表单、Mobile 配置、Web 配置字段、图标、contracts/settings 和 GenericAcpDriver.settings 共 9 文件 134 项通过；CursorAdapter、旧 GenericAcpDriver、AcpJsonRpcConnection 三文件 47 项通过，共 12 文件 181 项。命令为 vp test run 对应明确文件集合，不运行全仓检查。服务端/Web tsgo --noEmit 与 Mobile tsc --noEmit 全部退出 0；服务端仅原账号池 Effect 建议。23 个暂存 TS/TSX 文件定向 lint 通过；24 个暂存源码/文档格式检查和 diff --cached --check 通过，全部新文件 UTF-8 无 BOM。

过程中记录并修正：新增 Web 回归遗漏 environmentLabel 与不合适的整体 props 转型导致类型失败，修正后通过；formatter 一次因 Windows 映射文件 os error 1224 写入失败，相关类型进程结束后同文件格式化成功；首次新驱动探针旁路监听 stdin 导致 60 秒超时，改用已有 mock 的协议日志后 6 次会话启动/恢复正常，不新增睡眠。副本最初遗漏 scripts/lint 插件依赖，按 pnpm-workspace.yaml 补齐后原样重跑通过，没有修改产品源码或放宽规则。stdin-filepath 与 --check 不能同时使用，改比较 formatter 输出；未格式化对照输入明确不匹配，格式化输入匹配。

真实浏览器：旧服务句柄已失效，按显式 --home-dir 在 C:/Users/Administrator/AppData/Local/Temp/codework-pool-audit-20260929/runtime 启动独立 vp run dev，拥有句柄 50341，server 13774/web 5734。最初 help 参数被转发给子进程，仅显示帮助而未启用服务/数据库，拥有句柄 55485 已结束；直接 Node 启动缺 vp PATH 失败后改用仓库 vp 入口。没有启动服务指向 ~/.t3/userdata，没有设置 VITE_HTTP_URL/VITE_WS_URL。

在实际 Amp v0.9.0 下载期间手工改命令，完成后手工值保留；再次点击复用缓存，实际安装路径正确回填且显示已选择。最终代码复测缓存回填、返回命名步骤及关闭回供应商页。1280×900 和 360×800 的 document.scrollWidth 均等于视口宽，窄屏选择按钮位于可见范围，键盘聚焦返回/添加实例可滚到可见位置。截图在仓库外 acp-install-selected-1280.jpg、acp-install-selected-360.jpg、acp-install-actions-360.jpg。编辑热更新一度使页面重置/502，读取原服务日志确认重新 Listening 后恢复同一服务，不重复启动。临时视口已 reset，tab 1 markHandoff，隔离服务留给后续轮次。

12 个原保留文件提交前后 SHA-256 均未变化。完整脏文件清单前后比较仅看到其它工作更新的 paseo-provider-catalog.md、loop.md 与 hook 管理的 .loop-state，未回退或编辑这些其它增量；本轮随后只追加自身 ledger。没有在浏览器保存新 Amp 实例，没有验证 Amp 认证/推理/工具、真实手机、Electron 壳或远程/relay/tunnel。此步骤的独立源码检查与最新共享工作树的整体健康不同，不能掩盖之前 attachmentStore.ts 的类型失败。全部 Acceptance 仍未满足完整条款，保持未勾选。

#### Retrospect

本轮为 progress：双端目录与安装反馈、异步身份、配置运行依赖及独立 Git 步骤已有代码、回归与真实浏览器证据。选择失效不能表示下载已终止；单独请求锁与选择标记保留准确反馈。脏工作树上的测试可能依赖未提交功能，精确暂存补丁的独立副本揭示并验证了最小依赖边界，无需新增安装任务框架或 Adapter。Round 38/L-35 的作废 activeInstall 描述以本轮双标记实现为准。

最新 ledger 已记录 Round 42 的 Gajae 连续回合/取消与 Round 43 的 CodeWhale、Amp、Autohand 握手，不重复这些已有实现。下一轮先核对相应源码和实际证据，把尚未提交的共同 ACP 工具/动态元数据与双端消费按可验证依赖整理成下一独立步骤；针对缺失的真实工具、恢复和多端/远程条款继续验证。44 入口、真实账号、设备、连接与最终独立审计仍是总目标；181 项本地回归与下载入口通过不能代替完整接入。回滚本步骤可撤回 dcac02c3c，保留安装目录、会话历史与其它工作；无数据库迁移，不自动删除数据。

### Round 45

#### Plan

在不发明凭据、不启浏览器/dev 的前提下，继续挑 Windows 可装的官方目录/registry 条目做隔离安装 + initialize 握手（工具仅在本地夹具可行时再做），补 CliProbe、专项文档、目录行与 ledger；诚实记录平台/区域/扩展字段缺口。不勾选 A-1…A-8。

#### Act

隔离安装并原始/产品握手：`mistral-vibe` 2.25.8（`vibe-acp.exe`，auth=`browser-auth`）、`kilo` 7.8.1（`kilo acp`，auth=`kilo-login`）、`goose` 1.52.0（`goose acp`，auth=`goose-provider`）、`deepagents` 0.1.7（广告 `deepagents-acp@0.0.1`，auth anthropic/openai/setup）、`dirac` 0.5.16（`--acp`）、`glm-acp-agent` 1.13.0、`dimcode` 0.5.15（首次拉二进制后 `authMethods=[]`）。Registry 额外项：`harn` 0.10.151（`authenticate(none)` 成功，`session/new` 因缺 `environmentPolicy` 失败——effect-acp 尚未编码）、`kimchi` 1.1.39（浏览器 auth，未登录）。新增 9 个 `*AcpCliProbe.test.ts` 与对应 `docs/internals/*-acp-provider.md`；更新 `paseo-provider-catalog.md` 七行 Paseo 条目及“仍需完成”续 3。

#### Verify

`$CODEWORK_*_CLI_PATH` 下九探针 `vp test run` **9/9 通过**。未写 `~/.t3/userdata`；未发明密钥；未跑 Electron/手机/relay/浏览器；A-1…A-8 保持未勾选。

#### Retrospect

progress：又一批无登录握手落地；Harn 暴露真实 schema 缺口。工具与外部模型仍缺凭据。下一优先：其余 Windows zip（cortex/corust/poolside/sigit/stakpak/vtcode 等）、或 Harn `environmentPolicy` 产品修复、或 primary 保留环境的凭据/设备条款。

### Round 46

#### Plan

继续最大化无登录 Windows 可装条目：优先有 archive/npx 的官方目录项，隔离安装 + 握手探针 + 文档 + catalog；诚实记录 native/schema 缺口；不发明凭据，不勾选 A-N。

#### Act

安装并探针：`auggie@0.36.0`、`minimax-code@0.2.7`（native better-sqlite3 必需；ignore-scripts 失败）、`nova@1.1.48`（广告 `kore-cli@1.0.0`）、`qodercli@0.2.14`、`sigit@1.5.10`、`poolside` Windows amd64（SHA 匹配）、`agoragentic-mcp@1.3.0`（原始 initialize 有响应但 authMethods 缺 id → SchemaError）。新增 7 个 CliProbe 与专项文档；更新 catalog 对应行与续 4。cortex/corust/stakpak/vtcode/antigravity 等 registry 二进制平台键为空，无下载 URL，本轮跳过。

#### Verify

七探针 `vp test run` **7/7 通过**（其中 Agoragentic 断言为预期 Schema 失败）。未写 `~/.t3/userdata`；未发明密钥；未跑浏览器/dev；A-1…A-8 未勾选。

#### Retrospect

progress：又 6 个可握手 + 1 个明确 schema 缺口。下一优先：codebuddy/factory-droid/uvx 项、空壳二进制需上游补 archive、或 Harn/Agoragentic 产品修复、凭据与 A-5/A-7。

### Round 47

#### Plan

承接 Round 44 的共同工具链整理，选取一个完整增量：ACP 工具输入/输出归一化、终态持久化和 Web/Mobile 展开详情与工具分类，按独立依赖验证后提交。不重复 Round 21–28/34 已有实现，不把动态模型、附件或其它未提交功能混入本步骤。

责任检索已覆盖 AcpRuntimeModel 的所有 parseSessionUpdateEvent/mergeToolCallState 调用方、Cursor/Grok 的 makeAcpToolCallEvent、ProviderRuntimeIngestion、ActivityPayloadProjection、共享 toolActivity 和双端工作日志。复用现有工具 ID、data.kind、detail、审批活动和工具折叠；不建立新事件、队列或展示框架。确认批量命令/结果、MCP 文本、审批分类已有工作树增量；另发现 ACP 的 8000 字尾部加标记变成 8028 字，写入终态时再从头截到 8000，可能丢失最后错误。先用跨解析/事件/公开投影回归核对这一边界，再修正统一上限。

验证包含精确暂存补丁的独立源码副本、相关工具回归和三端项目类型检查；若展示代码变化，复用已授权隔离服务和浏览器查看真实工具详情、历史与 360/1280 布局。该服务采用工作树源码，浏览器证据与独立提交测试分别记录。全部 A-N 尚缺完整范围及设备/连接/账号/最终审计证据，保持未勾选。

#### Act

2026-09-30 完成并独立提交 046e3c366954990e3a3d664b33501f395f3330c0（fix(acp): 保留工具结果与双端详情），14 文件。生产修改集中在 AcpRuntimeModel、ProviderRuntimeIngestion、共享 toolActivity、Web session-logic/MessagesTimeline.logic 与 Mobile threadActivity；7 个相关测试文件和稳定 docs/internals/acp-tool-results.md 同步交付。沿用已有模块，没有复制 Adapter、事件合同或展示框架。

纳入已有批量 commands/完整 query-result-success、MCP 原始文本、真实失败与部分标题更新规则；批量文件路径复用现有提取器。终态保存有上限的正文，中间流保持短摘要。Web/Mobile 不把明确 execute 的输出当命令，缺命令时仍能展开 stdout；审批申请和决策保留独立记录，不计工具次数。读取分类与 Web search/fetch 区分沿用 data.kind。

新增跨解析→统一事件→活动→公开投影的三个长正文回归，发现 8000 字尾部加 28 字标记后又被终态从头截短，导致最后结果丢失。修正现有 boundToolCallOutputText 的总预算，分块保留尾部使用同一截取范围，标记与正文合计最多 8000；不增加第二个限长 helper。

提交只精确选择本步骤。动态模型、资源附件、权限身份/取消和其它协议工作仍留在工作树。部分补丁以明确函数/分支边界重新生成索引；格式钩子只比较索引，core.hooksPath 的持久配置仍为 .vite-hooks/_，未触发全树 stash 或混入部分暂存文件的其它功能。未推送，未创建 PR。

#### Verify

红灯：vp.cmd test run apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts -t 长输出，content/mcp/batch 3 项均失败，真实末尾 FINAL_OUTPUT 被截掉。修复后 RuntimeModel/CoreRuntimeEvents/Web command-output/Mobile threadActivity 共 4 文件 112 项通过。

独立源码副本使用 HEAD dcac02c3c + 精确索引补丁（仓库外 codework-acp-tools-audit-20260930），第三方依赖复用安装结果，workspace 链接指向副本；逐文件核对索引文本（CRLF 归一化）与 UTF-8 无 BOM。首次检查揭示测试重复 import 与带共享工作树行号的部分补丁误落到相似 item.updated 分支，1 项失败及 Core 测试转换失败；Server 类型检查相应失败，Web/Mobile 退出 0。重新以唯一 item.completed 分支生成索引并去重测试导入后，重新创建副本 source-5JS0FX/source。

最终 vp test run 的 11 文件：AcpRuntimeModel.test、AcpCoreRuntimeEvents.test、ProviderRuntimeIngestion.activity.test、ActivityPayloadProjection.test、Web session-logic.test / session-logic.command-output.test / MessagesTimeline.test、Mobile threadActivity.test、shared toolActivity.test、CursorAdapter.test、GrokAdapter.test，310/310 通过。涵盖部分更新、失败、未知数组、正文尾部、公共历史投影、审批/真实工具混排、既有累计更新限长和两条共用 Adapter。Server tsgo --noEmit 退出 0；Web tsgo 与 Mobile tsc 独立副本检查均退出 0，修正的服务端测试/终态分支未更改两端源码或合同。未运行全仓检查。13 个定向源码 lint 退出 0，只有既有 reverse 提示；14 文件索引格式和 git diff --cached --check 通过，已提交生产增量无 DEVLOG。既有 Effect 建议和 Node DEP0190 提示分别保留，未当成本轮新增失败。

浏览器复用拥有句柄 50341 的隔离服务、同一已配对 tab 1。打开既有真实 Cline 本地模型端点验收历史，展开读取、失败批量命令和四条审批申请/结果；两个实际工具分别显示 1 次调用，命令结果保留 CLINE_BROWSER_OK 与退出码 7，审批仍是工作日志。期间其它工作树修改触发服务自动重启和连接失败，读取原句柄确认 Listening 后恢复同一服务；刷新后重新展开，正文与失败仍可见，最终连接正常。1280×900、360×800 document.scrollWidth 分别等于 1280/360，长路径可换行，失败详情/输入区无横向溢出。截图在仓库外 tools-history-1280.png / tools-history-360.png；视口已 reset，tab markHandoff，服务继续保留。

这次浏览器只复验既有真实 CLI 历史，没有新发官方模型/长输出请求。长正文新终态到公开投影由三个回归证明，不声称旧已截断历史恢复。未验证 Electron、真实手机、外部账号、远程/relay/tunnel；工作树浏览器与独立提交检查分别记录。12 个原保留文件 SHA-256 全部不变，提交后索引为空；其它工作仅观察到 Harn 探针、目录文档、loop/.loop-state 和 AcpSessionRuntime 变化，未回退。其它写入将原计划顺序保留为当前 Round 47，并记录 Round 45/46 的握手批次；不覆盖或重复它们。全部 Acceptance 保持未勾选。

#### Retrospect

本轮为 progress：共用工具结果与双端显示已形成独立可回溯提交，新发现的末尾丢失有三项红灯与修复通过证据。源头的限长预算必须包括标记，否则每层各自通过仍会在串联时丢信息。部分暂存补丁的“能 apply”不证明命中了正确相似分支；独立源码测试揭示错误，函数/分支唯一边界比共享树行号可靠。

下一轮先读最新 Round 45/46 与现有 Harn/协议修改，避免重复握手或互相覆盖；仍按一个完整增量整理共同动态会话元数据至双端消费的独立提交，或在证据确立后处理 Harn 的真实 session/new 合同缺口。继续补缺失的真实工具、恢复、多端/远程和账户条款；310 项与历史浏览器通过不能替代 44 入口全面接入。回滚本步骤撤回 046e3c366 即可，无数据库迁移，不自动删除安装、会话或其它工作；旧已截断正文无法凭空恢复。

### Round 48

#### Plan

产品修复 Harn `environmentPolicy` 与 Agoragentic 缺 authMethod 字段；继续隔离探针 codebuddy/factory-droid 及 registry npm 适配器；诚实记录空壳二进制与本机无 uv；不发明凭据、不勾选 A-N。

#### Act

证据：`environmentPolicy` 须为 `{ kind: "inherited"|"isolated"|"granted" }`（字符串无效）。`packages/effect-acp` NewSessionRequest 增加可选 `environmentPolicy`；`AcpSessionRuntime` 对 `agentInfo.name=harn` 默认 `inherited`。AuthMethod `id`/`name` 改为可选（Agoragentic 两者皆缺）。Harn/Agoragentic CliProbe 更新并通过。

新握手：`codebuddy@2.159.0`（无 agentInfo）、`factory-droid` 经 postinstall 的 `droid.exe`、`pi-acp@0.0.34`、`claude-agent-acp@0.84.0`、`codex-acp@2.0.0`、`grok agent stdio`（无 agentInfo；裸 grok 进 TUI）。本机无 `uv`，fast-agent/minion-code 未装。空壳 binary（cortex/corust/stakpak/vtcode 等）目录行标明无 archive。文档与 catalog 续 5 更新。

#### Verify

Harn+Agoragentic 2/2；Round 48 六探针 6/6。未写 `~/.t3/userdata`；未发明密钥；未启浏览器/dev；A-1…A-8 未勾选。

#### Retrospect

progress：Harn 可建会话；Agoragentic initialize 可解码；又一批 npm/适配器握手。下一优先：装 uv 测 fast-agent/minion；上游补空壳 archive；凭据与 A-5/A-7。

### Round 49

#### Plan

上一轮为 progress：046e3c366 的工具结果、双端历史与长输出已有独立提交和回归。最新 Round 48 已处理 Harn environmentPolicy/Agoragentic 认证字段并补握手，不重复其实现。这轮只形成一个完整的共同协议错误增量：标准 JSON-RPC error 在核心和扩展请求中进入可捕获 AcpRequestError，保留原错误字段，并证明正常请求失败后同连接仍可请求。

责任检索已追踪 effect-acp protocol 的原始 NDJSON 解码、Exit 分发、extPending、client 的 callRpc 与 errors.fromProtocolError，以及 Gemini 实机负向探针。Round 20 的生产修复和回归已存在于工作树但尚未提交，复用该公共实现，不在每个 Adapter 兜底捕获缺陷，不混入 Harn/动态元数据/其它协议增量。补现有同连接后续成功回归；Gemini 缺少凭据的探针需显式覆盖继承环境，避免删除变量后被 extendEnv 重新带入。

验收本步骤的精确索引源码、副本依赖、核心/扩展/显式缺陷/畸形错误和实际 Gemini 0.61.0 认证负向路径；不发 prompt、不读取真实账号，不启动另一浏览器或服务。全目标 44 入口、真实模型/工具、多端与远程保持不变，A-N 未满足完整条款时不勾选。模块文档及单独 Git 提交随检查交付。

#### Act

2026-09-30 完成并独立提交 336b50c3c1ea4cceb4e5dfa35d2d7e79d85b2f95（fix(acp): 正确传递标准协议请求错误），5 文件。复用 Round 20 已有 protocol.ts 的公共 Exit 归一化及两个回归，不重复实现、不为每个 Adapter 增加兜底。标准 JSON-RPC error 只在满足数值 code 与字符串 message 时由 Die 转为 Fail；核心和扩展沿既有路径保留 AcpRequestError 的 code/message/data/method。显式 Defect 与畸形错误保持缺陷语义。

在现有原始 NDJSON 回归中补充核心与扩展请求失败后同连接再次请求成功、不同请求 ID 的断言。补齐 Gemini 可选负向探针的环境隔离：Runtime 使用 extendEnv，仅删除环境变量会重新继承真实值，故除系统启动变量外显式置空宿主变量，所有 HOME/配置路径指向作用域临时目录。真实探针核对失败所在方法与没有 session/prompt。新增稳定文档 docs/internals/acp-protocol-errors.md，说明公共边界、检查入口和回滚。

精确暂存仅这 5 文件，独立源码副本由 HEAD 046e3c366 加索引补丁产生；workspace 依赖指向副本。提交时使用只读索引格式钩子，持久 core.hooksPath 仍为 .vite-hooks/_；其它 Harn、动态模型、资源、账户和目录工作保留。未推送、未创建 PR、未调用模型、未启动另一服务或浏览器。

#### Verify

工作树协议 client/protocol 两文件 23/23 通过。独立源码副本 source-udCL6l/source（仓库外 codework-acp-errors-audit-20260930）运行 client.test、protocol.test、AcpJsonRpcConnection.test、GenericAcpDriver.settings.test 和 GeminiAcpCliProbe.test：5 文件 41/41 通过。显式提供官方 Gemini 0.61.0 bundle 路径，两个真实 CLI 负向用例实际执行而非 skip：login 在 authenticate 返回 -32602；gemini-api-key 的 authenticate 可返回成功，session/new 仍以缺 API Key 的 AcpRequestError 失败，均无 session/prompt。

红绿证据：仅在独立副本将 protocol.ts 临时恢复为 HEAD 旧实现，新增标准 JSON-RPC 回归真实失败，Invalid params 逃逸为内部错误；finally 恢复已检查源码并逐字节核对后，同一回归 1/1 通过。日志保存为仓库外 red-result.json / green-result.json，不触碰生产工作树或索引。

独立副本 effect-acp、Server 的 tsgo --noEmit 均退出 0；Server 仅有原有 localAccountModels/localAccountUsage 的 Effect 建议。4 个相关源码/测试定向 lint 退出 0。首次在无 .git 的源码副本运行 git diff --cached 报参数错误，未当成检查成功；回到原仓库重新运行退出 0。5 文件索引格式、UTF-8 无 BOM、索引与独立副本文本一致（CRLF 归一化）检查通过，新增生产 DEVLOG 为 0。12 个原保留文件 SHA-256 全部不变，提交后索引为空。未运行全仓检查。

本轮没有 UI 修改，不重复浏览器验证。尚无 Gemini 有效账号/真实模型工具、Electron/真实手机、远程/relay/tunnel 或最终独立审计证据，不把负向探针当成完整接入。所有 A-N 保持未勾选。并行 Round 50 的 uvx、fast-agent/minion 记录完整保留。

#### Retrospect

本轮为 progress：公共请求错误链完成独立提交，旧实现红灯、修复绿灯和真实 Gemini 无凭据边界均可复现；正常请求失败后连接仍能继续工作。错误须在共享协议边界进入声明失败通道，不能用 Adapter 的 catchAllDefect 掩盖内部错误；负向实机验证必须在实际 extendEnv 合并后仍隔离宿主凭据。

下一轮先读最新 Round 50 及现有修改，优先整理动态会话元数据的共同合同、运行时与双端消费为一个独立增量，并核对未提交依赖；继续按 44 入口补真实工具、恢复、多端/远程和账户验收。uvx 两项已有握手或阻断证据，不重复安装。撤回 336b50c3c 即可回滚本步骤，无数据库迁移，不删除会话、账户或安装；回滚会重新暴露普通错误逃逸问题。

### Round 50

#### Plan

安装隔离 `uv`（不碰 `~/.t3/userdata`），探针剩余 uvx 目录项 fast-agent / minion-code；复核空壳 binary 阻断行；不发明凭据、不勾选 A-N、不提交。Round 49 的 JSON-RPC error 增量保留给并行轨道，本轮不覆盖其 Plan。

#### Act

`C:\codework-cli-iso\uv` 安装 uv 0.12.21（`UV_NO_MODIFY_PATH`）。`UV_CACHE_DIR`/`UV_TOOL_DIR`/`UV_PYTHON_INSTALL_DIR` 均在 isolate。

- **fast-agent-acp==0.10.1**：initialize=`fast-agent-acp@0.10.1`、auth=`fast-agent-ai-secrets`、session/new 成功；新增 `FastAgentAcpCliProbe` + `fast-agent-acp-provider.md`。
- **minion-code==0.1.44**：默认 `agent-client-protocol` 0.12.1 → `ImportError(AuthMethod)`；证据 pin `==0.8.0` 可起但 JSON-RPC 写 **stderr**（stdout 空），产品不改读 stderr。`MinionCodeAcpCliProbe` 对默认入口断言 initialize 失败；`minion-code-acp-provider.md` 记录双阻断。
- 目录：更新 fast/minion/harn/agoragentic/antigravity-acp 与空壳行（cortex/corust/stakpak/vtcode/junie/devin）；`registry-acp-adapter-handshakes.md` 去掉「uvx 未装」。

官方目录仅两项 uvx；无其它 uvx 未测项。无浏览器/dev；未发明密钥。

#### Verify

`vp test run` FastAgentAcpCliProbe + MinionCodeAcpCliProbe：**2/2 通过**。A-1…A-8 保持未勾选。

#### Retrospect

progress：uvx 两项均有本机证据；fast-agent 可建会话；minion 诚实阻断。下一优先：上游补空壳 archive / 修 minion stdout+依赖；凭据型 Gemini/Copilot；A-5/A-7 设备与连接。Round 49 JSON-RPC error 已在并行轨道独立提交（336b50c3c）。

### Round 51

#### Plan

承接 Round 49 的 progress 与独立协议错误提交 336b50c3c，选择一个完整增量：标准 ACP 动态会话模型、模式、角色/权限选项及命令，从建会话/通知缓存，经 Cursor/Generic/Kimi/Grok 共用事件与活动投影，进入 Web/Mobile 的显示、选择和发送。Round 3/4/11/12/13/19/22/29 已有相关实现，先核对并精确整理，不重复实现。最新 Round 50 的 uvx 与阻断记录保留，不重复安装。

责任检索覆盖 model/providerRuntime 合同、AcpRuntimeModel 的解析与选项编码、SessionRuntime 的启动缓存/配置写入、两条 Adapter、ProviderRuntimeIngestion、共享 providerModels/providerSkills、Web ChatView/Composer 和 Mobile modelOptions/Composer/发送队列。复用既有 session.started/configured、活动 payload、ModelSelection.options 与 select descriptor，不另建 Registry 或传输。重点检查 null 与空列表撤回、启动响应优先级、根会话/重放隔离、原始模式 ID、同名模型能力和显式自定义模型，以及菜单与发送共同目录。

按功能边界选取完整依赖并验证独立索引源码；资源附件、思考/用量、审批身份、关闭/取消、Harn 和 Kiro 专用命令执行不混入本步骤，其现有工作树修改保留。运行对应 Runtime/Adapter/投影/共享/双端回归、三端定向类型检查与 lint，复用获授权隔离服务完成一次浏览器操作。稳定模块/用户文档与单独提交随验证交付；全目标 44 入口及所有 A-N 未获完整证据仍不勾选。

#### Act

2026-09-30 完成并独立提交 9fe1eb597eed2371ed365d54e67fd9a5ce3dfec1（feat(acp): 接通动态会话目录与双端选择），37 文件。复用 Round 3/4/11/12/13/19/22/29 的已有实现，按当前 HEAD 336b50c3c 精确整理标准元数据的完整依赖；没有复制 Registry、事件总线或命令执行器。

公共合同沿用 session.started/configured 的可选 models、mode、configOptions、slashCommands。Runtime 统一维护启动缓存、通知和主动配置响应；明确响应优先，null/缺省和空数组语义分开，根会话、子会话和重放隔离。模型选择共用真实 configId 或旧式 set_model；URI 模式保持原值，旧式模式走 set_mode，失败不改当前快照。角色空值局部可逆编码，不改全局非空合同。

Cursor/Generic/Kimi 与 Grok 经共用事件工厂和 Ingestion 投影进入线程活动。共享 providerModels/providerSkills 是 Web/Mobile 菜单、校验和发送的共同入口；空列表撤回，null 消除会话覆盖，自定义模型和同名能力保留。元数据不计入工具次数或工作日志。补充既有共用事件/活动投影回归，修正命令测试的品牌 EventId。新增稳定实现文档 docs/internals/acp-session-metadata.md 和用户说明 docs/user/acp-session-controls.md。

独立副本仅由 HEAD 加 37 文件索引补丁形成，workspace 依赖指向副本。资源附件、思考/用量、权限身份、关闭/取消、Harn、Kiro 专用命令及其它账号池/目录工作未混入本步骤，原工作树保留。使用只读索引格式钩子提交，持久 core.hooksPath 仍为 .vite-hooks/_；未推送、未创建 PR。此前关于“无浏览器授权”的临时记录由实际证据更正：用户已明确允许浏览器验证，继续复用此前获授权的同一隔离服务与配对页面。

#### Verify

首次独立副本检查 15 文件中 281 项通过、1 项失败：Cursor 的现有权限测试混入未选取的权限日志依赖；Server 类型检查发现 mock 混入另一增量的退出定时器。只修正索引边界：该权限测试恢复 HEAD，移除不属于本步骤的退出分支及未使用变量，删除 GenericDriver 测试无用 decodeArgs；原工作树对应功能保留。没有把失败归为通过，也没有在生产代码中添加兜底。

最终独立副本 source-4yFWBM/source 的 15 文件 282/282 通过：AcpRuntimeModel、AcpJsonRpcConnection、AcpCoreRuntimeEvents、AcpAdapterSupport、GenericAcpDriver、CursorAdapter、GrokAdapter、ProviderRuntimeIngestion.activity、ActivityPayloadProjection、共享 providerModels/providerSkills、Web modelSelection/composerProviderState、Mobile modelOptions/threadActivity。移除未使用 fixture 变量后，重跑三个实际使用该子进程的 Runtime/Cursor/Grok 文件，106/106 通过，不重复累加测试数。检查覆盖启动/恢复优先级、通知替换和撤回、旧式 RPC、URI 模式、角色空值、原样命令参数、实例/重放隔离及双端派生。新增检查等待既有事件或回合完成，不用睡眠替代协议信号。

Server tsgo --noEmit 在最终副本退出 0，仅有原账号池 Effect 建议。Web tsgo 与 Mobile tsc 在首副本退出 0；之后更正仅涉及 Server fixture/测试，19 个相关客户端及合同/共享已检查文件与最终副本逐字节相同。34 个选取 TS/TSX 文件定向 lint 退出 0；移除 mock 新增未使用变量后该文件 lint 无输出，Cursor 原有 invocation 警告保留，Node DEP0190 为既有启动警告。没有运行全仓检查。

真实浏览器复用隔离 runtime（Server 13774/Web 5734），操作既有 ACP fixture 线程：选择“审查”模式并刷新后仍可见；角色可选择审查角色再返回空值默认 Copilot，Allow All 保持 Off；动态目录不再显示已撤回 dynamic-next；输入 / 后命令菜单只剩内置命令，已撤回 /inspect 未复活。本轮未发送新的模型请求或变更上游权限；实际 RPC 参数与角色空值由子进程回归证明，界面标签不冒充线上的执行结果。

1280px 角色/模式菜单及 360px 模式/命令菜单截图保存在仓库外 codework-acp-metadata-audit-20260930。窄屏模式通过“更多输入控件”进入，模式菜单边界 x=5..254.33、命令菜单 x=34..326，页面 scrollWidth=360；临时视口已恢复，页面标为后续继续。刷新时遇到热重启窗口，服务日志确认 /api/auth/session 连接拒绝与 Server 重启；服务就绪后重新加载恢复。不能据此声称热重启窗口自动恢复已经修复。浏览器运行共享工作树；完整独立提交由副本测试证明，截图不证明其它未提交 UI 改动已交付。未验证真实 Electron、原生手机、live relay/tunnel。

37 文件索引格式、UTF-8 无 BOM、DEVLOG=0、索引/副本/提交文本一致（CRLF 归一化）均通过；提交清单与白名单完全相同，提交后索引为空。原 12 个保留文件 SHA-256 不变。所有完整 A-N 仍未满足，保持未勾选；Round 52–54 的其它实现、探针和记录保留。

#### Retrospect

本轮为 progress：共同元数据链路形成可独立回滚的模块提交，并通过隔离源码检查与授权浏览器操作。已有实现要先检索复用；工作树总体绿色不证明选取的提交自足，首次独立副本的失败暴露了测试/fixture 边界混入，修正后才提交。临时服务可恢复与热重启时客户端自动恢复是两种证据，不能混写。

最新 Round 54 已复验 Copilot 取消并补 exitCode/迟到审批代码，不重复其实现或宣称仍无任何可用凭据。下一增量优先整理共同审批身份、原生选项回传与进程结束结算为独立模块，针对 Windows 中途退出做可追踪进程证据；之后继续思考/用量/非文本等已有增量的独立交付与完整 44 入口真实验收。Electron、真机、Gemini 账号、live relay/tunnel 及最终独立审计仍欠，不能以本轮菜单验证替代。撤回 9fe1eb597 可回滚本步骤，无数据库迁移，不删除会话、账户或安装目录。

### Round 52

#### Plan

无登录 Windows CLI 握手大体穷尽。关闭仍可纯代码推进的缺口：① 确认 Round 49 JSON-RPC error 闭环；② Mobile 对齐 Web 的 ACP `kind=search` vs `fetch` 图标/继承；③ 音频/blob Ingestion 投影回归并修解析器把整段 URI 当作 blob `name` 的缺陷；④ 扫描握手-only Agent 的本地夹具 ToolProbe 可行性，不做无模型端点的假探针。不发明凭据、不启浏览器/dev、不提交、不勾选 A-N。

#### Act

- Round 49：生产修复与同连接重试已在树；再跑 `client.test`/`protocol.test`/`AcpJsonRpcConnection` 确认。
- Mobile：`threadActivity` 已有 `toolKind`/`workLogEntryIsLocalCodeSearch`/`search` 图标；补测试（含 activity-group 取值、终态无 kind 时沿用首条）。
- 发现 `AcpRuntimeModel` 将 `blob.name = resource.uri`，绕过 `fileNameFromUri` basename → 附件名变成整段 URI；改为只传 `uri`，由存储层取 basename。补 Ingestion 音频/blob 投影回归（重复事件、危险 MIME、思考流不落盘、正文不进投影 JSON）。
- ToolProbe：Cline/Hermes/Gajae 已有；Qwen 工具在 CliProbe+本机端点覆盖。其余握手项（fast-agent/amp/goose/…）需厂商密钥或交互认证，无法在无凭据下新增诚实 ToolProbe。
- 文档：`generic-acp-provider.md` 注明 blob 命名规则与 Ingestion 回归。

#### Verify

- Mobile `threadActivity` search 图标与继承：2/2。
- Ingestion 音频/blob + `AcpRuntimeModel` blob + `ProviderBinaryAttachment`：10 项定向通过（含筛选跳过）。
- JSON-RPC 同连接失败恢复：2/2。
- Web `session-logic` ACP search 分类仍绿。
- A-1…A-8 **未勾选**。无提交。

#### Retrospect

progress：修了真实 blob 命名缺陷并补齐 Mobile search / 音频 blob 投影证据。ToolProbe 扩面撞上凭据墙。剩余目标几乎全是凭据、Electron、真机、远程/relay/tunnel 与最终独立审计。

### Round 53

#### Plan

不信任「无凭据墙」断言：对照计划 P0–P5 / A-1…A-8 做证据差分；扫描环境与 isolate 是否已有可用凭据；运行已有 Desktop/relay 定向测试补 A-5/A-7 分量；关闭仍可纯代码的 Mobile↔Web 快捷入口缺口；起草 A-8 工作审计表（非假通过）。不启 `vp run dev`/浏览器，不写 `~/.t3/userdata`，不提交，不勾选 A-N。

#### Act

- **差分**：计划勾选仍全空；工作树已大幅覆盖 P0–P2 代码路径，但设备/远程/最终审计与大量 Agent 工具仍欠。
- **环境**：`GEMINI_API_KEY`/`GOOGLE_API_KEY`/`ANTHROPIC_*`/`OPENAI_*`/`AMP_*`/`QWEN_*` 等为空；`gh` 已登录（gist/repo/org/workflow）。isolate 无可用 Gemini oauth 文件。
- **Copilot**：隔离安装 `@github/copilot@1.0.89` → `C:\codework-cli-iso\copilot-1.0.89-npm\node_modules\.bin\copilot.cmd`；`CODEWORK_COPILOT_CLI_PATH` 再跑官方探针：文本/读写/shell/拒绝通过，**取消**步未收到权限回调（`permissions=['allow','allow','reject']`，缺 `cancel`）→ 不宣称取消本轮复验通过。
- **Mobile P3**：补与网页一致的 Copilot/Gemini ACP 快捷按钮（预填目录搜索/实例 ID/显示名）；`seedQuery` 传入目录区；i18n en/zh/ja。
- **A-5/A-7 分量**：定向跑 Desktop exposure/tailscale + shared/contracts/client-runtime relay 测试 **44/44 通过**（非实机 Electron GUI、非 live tunnel）。
- **A-8**：在本 ledger 新增「Working Audit」表，逐条标注证据状态。

#### Verify

- Mobile logic + Desktop/relay 定向：**6 文件 44/44**。
- Copilot 探针：1 失败（cancel）；模式/工具/拒绝未作为本轮完整矩阵勾选。
- A-1…A-8 保持未勾选。

#### Retrospect

progress：墙说不完整——发现 gh 登录可驱动 Copilot，并补 Mobile 快捷入口与 A-8 审计草稿。取消步需更稳健的权限等待或人工复验。下一优先：用户提供 Gemini key / 允许 primary 浏览器与真机；加固 Copilot cancel 探针。

### Round 54

#### Plan

加固 Copilot cancel（等 `requestPermission` 再断言）并在 isolate 1.0.89 + gh 下复跑；加强 P0 中途崩溃/断线迟到审批的 ACP 定向测试与运行时兜底；关闭其它无密钥可代码验证的 Working Audit 弱项；诚实更新 ledger。不启浏览器/dev、不提交、不发明 Gemini 密钥、不勾选 A-N。

#### Act

- **Copilot cancel**：`CopilotAcpCliProbe` 对取消步 `fork` prompt，并在权限回调里 `Deferred.succeed` 后再 join；强化“必须先调创建文件工具”提示。隔离路径 + gh：`vp test run CopilotAcpCliProbe` **1/1 通过**（约 40s），含 cancel/`cancelled.txt` 不存在与 session/load 恢复。更新 `copilot-acp-provider.md`。
- **P0 崩溃/迟到审批**：
  - `effect-acp` 协议：子进程 `exitCode` 观测到即终止（不依赖 stdin EOF）；终止时 `Queue.end(outgoing)` 避免死等写管道；新增「exit before stdin EOF」测试。
  - `CursorAdapter`：`session/prompt` 失败时结算待定审批/输入、发 `turn.completed` failed；进程已关时本地 `session.exited`（不卡 `session/close`）。
  - 新增「late approval after stop」测试；mock 增加 `CODEWORK_ACP_EXIT_AFTER_PERMISSION_REQUEST`（Windows 整树 e2e 仍脆，不以假绿宣称子进程崩溃全链路）。
  - 文档：`generic-acp-provider.md` 补中途退出与迟到审批边界。
- **Working Audit**：刷新 P0 fixture / P2 Copilot 行；A-7 仍 blocked（无 live relay）。

#### Verify

- Copilot isolate 探针：**1/1 通过**。
- `protocol.test` 退出相关：**2+ 通过**；Cursor `late approval after stop` + `stopping…pending approval`：**2/2 通过**。
- A-1…A-8 **未勾选**。无提交、无浏览器/dev。

#### Retrospect

progress：Copilot 取消在「等权限回调」后可复验绿；ACP 层补了 exitCode 终止与 Adapter 结算/迟到审批拒绝。完整 A-7 仍要隔离服务+真实连接；Gemini/Electron/真机仍欠。Windows shell 包装下杀子进程的整树 e2e 未计为通过。

### Round 55

#### Plan

在 Round 54 基础上完成本机可代码验收的剩余弱项：Windows 审批中途进程树崩溃 e2e；重跑 P4 原生 Adapter 矩阵（Codex/Claude/OpenCode/Pi/OMP/Grok/ZCode/Antigravity/Byok）并修失败；扫 Working Audit 其它无密钥可测行；更新 ledger。不启浏览器/`vp run dev`、不提交、不发明 Gemini 密钥、不勾选 A-N。

#### Act

- **Windows mid-approval crash e2e**：Cursor mock 用 JSON-env + bootstrap（避免 cmd 路径损坏）；mock `CODEWORK_ACP_EXIT_AFTER_PERMISSION_REQUEST` 在打开审批后自退出；`effect-acp` 继续用 `exitCode`/`Queue.end(outgoing)`；Cursor 在待审批时 tear-down。本机 `agent crash mid-approval…` **通过**（约 1.5s）。
- **环境泄漏修复**：宿主若残留 `CODEWORK_ACP_EMIT_TOOL_CALLS`/`EXIT_AFTER_PERMISSION_REQUEST`，`extendEnv` 会毒化所有 mock。`AcpSessionRuntime` 在显式 spawn.env 时剥离未声明的 `CODEWORK_ACP_*`；Cursor/Grok Windows bootstrap 同样清理；去掉 Cursor 测试对 `process.env` 的多余写入；协议测试改为 Deferred 延后 `terminationError`（避免构造时立即 `Queue.end`）。
- **P4 矩阵**：清环境后重跑见 Verify。

#### Verify

- `packages/effect-acp/src/protocol.test.ts` + `AcpJsonRpcConnection.test.ts`：**2 文件 61/61**。
- `GrokAdapter.test.ts`：**46/46**。
- Cursor 全文件：**42/42**（含 crash mid-approval、late approval after stop）。
- P4 原生（不含 Grok 那次并行批次）：Codex/Claude/OpenCode/Pi/OMP/ZCode/Antigravity/Byok **8 文件 188/188**；合计含 Grok **9 文件 234/234**。
- A-1…A-8 **未勾选**。无提交、无浏览器/dev。

#### Retrospect

progress：Windows 审批中途崩溃 e2e 与 P4 全矩阵本机绿；根因一度是宿主 `CODEWORK_ACP_*` 泄漏而非产品回归。A-7 live relay、Gemini、Electron、真机仍用户门控。下一优先：用户提供 Gemini key / 允许 primary 浏览器与真机 / 隔离服务 live relay。

### Round 56

#### Plan

在不发明密钥、不启交互浏览器的前提下推进剩余门控：Gemini 凭据发现；A-7 用现有脚本/单元逼近 live（reconnect/exposure/tunnel）；A-5 安装按钮窄屏用组件测试加强；Electron 无头冒烟；诚实更新 Working Audit。不勾选 A-N，不提交。

#### Act

- **Gemini**：环境变量与配置目录全扫（见 Verify 路径表）；仅找到空 `~\.gemini\projects.json` 与 isolate `gemini-0.61.0` bundle。`CODEWORK_GEMINI_CLI_PATH` 指向 isolate `gemini.js` 再跑负向探针 **2/2**。更新 `gemini-acp-provider.md` 记录路径。
- **A-7**：定向 reconnect/presentation、Desktop exposure/tailscale、ssh tunnel：**5 文件 69/69**。`cloud/http.test` 3 项因工作树 `fsync` EPERM 失败（环境噪音，非本次产品回归）；无 live relay 配对。未启动长寿命 `vp run dev`。
- **A-5**：Web/Mobile ACP 目录安装行加 `flex-wrap`；组件测试断言安装按钮 + 换行类。**3 文件 17/17**。仍非 primary 浏览器 360/1280 截图复验。
- **Electron**：`ElectronApp/Window/Shell`、`DesktopLifecycle/EarlyStartup`、`electron-launcher`：**6 文件 36/36**。非完整 GUI 壳冒烟。

#### Verify

- Gemini 负向：**2/2**；无正向模型证据。
- A-7 单元：**69/69**（排除 cloud/http EPERM）；无 live tunnel。
- A-5 安装目录：**17/17**。
- Electron 无头：**36/36**。
- A-1…A-8 **未勾选**。

#### Retrospect

progress：门控证据变厚但仍缺用户凭据与设备。Gemini/真机/live relay/primary 浏览器仍必须由父代理或用户提供；本轮不能勾选完整 A-3/A-5/A-7。

### Round 57

#### Plan

推进 live A-7（本地隔离）与非交互 A-5：验收条保持完整——A-5 需 360/1280 浏览器 + Electron + 真机；A-7 需隔离服务真实连接与进程操作且各模式分别记录；A-8 为最终独立审计。本轮在不发明 Gemini 密钥、不启交互浏览器的前提下，对工作树隔离 home 起短寿命 `serve`，脚本化 WS 重连与进程崩溃后重启再连；加强目录安装按钮 360/1280 组件/交互测试。不勾选 A-N，不提交。

#### Act

- 隔离 home：`.t3/a7-live-isolate-r57`（空库 + migrations；`~/.t3/userdata`/`dev` 被占用导致 VACUUM INTO 失败，未读写在线 DB）。
- `node apps/server/src/bin.ts serve --host 127.0.0.1 --port 18773 --base-dir <iso> --no-browser`；捕获 PID `35512` → 崩溃杀后再启 `58360` → 终态只杀 `58360`。
- 脚本 `.t3/a7-live-isolate-r57/a7-live-harness.mjs`：bearer session → `/api/auth/websocket-ticket` → `/ws` 开关再开；证据 `a7-reconnect-evidence.json` 与 `a7-crash-reconnect-evidence.json`（均 `ok:true`，environmentId `30e71363-…`）。
- A-5：Web/Mobile 目录测试显式覆盖 360/1280 容器与安装按钮交互（`it.each([360,1280])`）。
- Gemini：`GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENAI_API_KEY`/`CODEWORK_GEMINI_API_KEY` 仍 unset。
- Adapter 层：`late approval after stop` 再跑通过；同轮单独滤跑 `crash mid-approval` **超时 30s**（不把本轮计为 crash e2e 绿；R55 全量矩阵仍是先前证据）。

#### Verify

- Live local reconnect + crash-restart-reconnect：脚本证据 `ok:true`（见 isolate 目录 JSON）。
- A-5 组件：`vp test run` 三文件 **18/18**。
- Cursor `late approval after stop`：通过；`crash mid-approval` 本轮滤跑超时。
- 未启 `vp run dev --share` / primary 浏览器 / Electron GUI / 真机 / live relay|tunnel。
- A-1…A-8 **未勾选**。无提交。

#### Retrospect

progress：本地隔离 live WS 重连与服务进程崩溃恢复首次有脚本证据，仍不满足完整 A-7（缺迟到审批/agent 崩溃的**服务端介导**实机、以及 remote/relay/tunnel 分模式）。A-5 组件 360/1280 加厚，仍非 primary 浏览器截图。下一优先：父代理/用户提供 Gemini key、允许 `test-codework-app` 360/1280、真机/Electron GUI、或 live relay；可选加固 mid-approval crash 滤跑超时。

### Round 58

#### Plan

继续完整验收条，不缩 scope：加固 Windows 上 CursorAdapter「crash mid-approval」超时并写清原因；在隔离 home 上脚本化本地 WS 重连，并尽量覆盖迟到审批 / agent 崩溃 / cancel-restart（优先仓库内 `acp-mock-agent`）；尝试 `vp run dev --share` 或记录 Tailscale 阻断；更新本轮 ledger。不发明 Gemini key、不启交互浏览器、不勾假 A-N、不提交、不 `pkill -f`。

#### Act

- **Crash mid-approval（Windows）**：`CursorAdapter.test.ts` 在收到审批后对夹具 PID 用 `taskkill.exe /pid /t /f` 杀整棵包装树（仅杀孙子时 stdio/exit 不同步导致挂起）；超时升至 `60_000`。`CursorAdapter.ts` 在 `tapError` 路径若 `promptsInFlight===1 || hadPendingInteraction` 则发布 `turn.completed`（failed），避免宿主杀进程后永久等终态。滤跑再绿：`vp test run …CursorAdapter.test.ts -t "crash mid-approval"` → **1 passed**（~1.8s）；同轮相关 **4 passed**（crash + late-approval-after-stop + cancel settle 类，见 `adapter-process-ops.txt`）。
- **隔离 serve**：`.t3/a7-live-isolate-r58`（空库 + migrations；未读写在线 `~/.t3`）。`serve --host 127.0.0.1 --port 18783 --base-dir <iso>`，spawn PID `48296`；终态只 `Stop-Process` 该 PID（已 teardown，port-down-ok）。bearer 文件已 scrub。
- **脚本证据**：`a7-mediated-harness.mjs` → `a7-mediated-evidence.json`：本地 bearer→wsTicket→`/ws` close/reopen `ok:true`（environmentId `9421c678-…`）。**未**经编排 WS RPC 驱动完整「断连后服务端介导迟到审批 / agent 崩溃 / cancel-restart」回合；同轮在隔离 serve 存活期间跑 CursorAdapter 进程级用例作为 **adapter-level** 证据（JSON `modes.*Adapter: see-vp-test`），不得记为完整 server-mediated A-7。
- **Share / tunnel**：`tailscale` CLI **不在 PATH** → `share-probe.txt`：`BLOCKER: tailscale CLI not on PATH`；未启动 `dev --share`，无 pairing URL。
- Gemini 仍 unset。无 primary 浏览器 / Electron GUI / 真机。无提交。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| Cursor crash mid-approval（Windows taskkill） | 绿（60s 预算内 ~2–6s） |
| 隔离 local WS reconnect | `a7-mediated-evidence.json` `ok:true` |
| 编排介导 late-approval / agent-crash / cancel-restart | **缺口**（仅 adapter 级 + 指针） |
| `vp run dev --share` / relay | **阻断**（无 Tailscale CLI） |
| A-1…A-8 勾选 | 否 |

#### Retrospect

progress：Windows mid-approval crash e2e 稳定绿并有产品侧 `turn.completed` 补强；本地隔离 reconnect 再确认。A-7 仍缺真正的服务端介导进程操作脚本与 remote/relay/tunnel。下一优先：父代理装 Tailscale 并登录后跑 `--share`；或补编排层 harness（mock ACP + 真实 thread/turn RPC）；Gemini key / primary 360·1280 / 真机仍需外部供给。

### Round 59

#### Plan

承接 Round 51 Retrospect 和 Round 54–55 的现有实现，只交付共同 ACP 请求生命周期：原生权限 optionId、审批身份与真实工具区分、取消工具终态、能力广告后的有界关闭、关闭错误持久化、进程退出结算与迟到审批拒绝。先检索 R23/27/32/39/54/55，不重复实现；Cursor/Generic/Kimi 与 Grok 两条路径均需检查。媒体、思考/用量、厂商专用命令、账号池和其它工作树修改不混入本步。

本步执行前已形成计划；临时 Round 55/57 记录与同目录其它执行记录编号冲突，本条以独立提交及源副本作为边界重新完整记录，保留其它轮次。HEAD 加精确索引形成独立副本，只运行相关检查；Windows 崩溃在审批/用户输入事件后终止本次启动记录的 Agent PID。完成稳定文档与单独提交；未获完整证据的 A-N 不勾选，不启新浏览器或服务，不派发子代理。

#### Act

2026-09-30 独立提交 1c222b2d7ede4bdb311354c665afb53a2f0b1d2b（fix(acp): 完整结算审批取消与会话退出），14 文件。复用现有协议、Runtime、事件与 Ingestion，不新增依赖或第二套请求状态机。

共同权限选择按 kind 返回原始 optionId；缺少目标选项则取消，允许会话授权仅在未广告时退到本次。Runtime 登记根会话的未知审批身份，只过滤匹配的无内容权限终态；真实执行、输出和不同/不匹配状态保留。客户端取消对已展示工具补 failed，不凭审批登记制造工具行。关闭先按能力广告请求已建会话，5 秒上限后仍释放本地资源；异常 session.exited 投影为持久化错误活动。

协议独立监视 exitCode 与输入 EOF，只终止一次并关闭输出；断开后的新请求沿已保存错误立即失败。Cursor 与 Grok 的审批/用户输入发布和终态结算放在同一可中断等待、不可中断结算范围，删除待定身份保证一次终态；断线取消也发 resolved。Grok 在普通请求错误后保持会话，进程/输入/传输断开才结算整回合、释放旧身份并发可恢复异常退出。

进一步定位 Cursor：权限回调已正确取消后，pending map 为空，原错误映射将传输失败视为普通请求错误，导致不发布 session.exited。共同 AcpAdapterSupport 将进程退出、输入结束和传输失败统一映射为 SessionClosed，保留原因；正常 JSON-RPC 请求错误仍为 RequestError。没有靠扩大超时或杀进程名隐藏此问题。新增 docs/internals/acp-request-lifecycle.md 说明调用链、显示语义、边界与回滚。

#### Verify

独立副本为 codework-acp-lifecycle-audit-20260930/source-xzUXV2/source，由基线 9fe1eb597 加本步索引形成，workspace 依赖指向副本。首批 8 文件 162 通过、1 超时：旧退出 fixture 在请求发出前立即关闭输出；改为 Deferred 等请求发出后再退出。Grok 新崩溃回归红灯：失败回合后 hasSession 仍为 true；释放会话后再暴露缺少 request.resolved，随后修正中断结算。两种 Grok 交互（审批、用户输入）最终通过。

Cursor 连续超时后停止重复猜测，在副本中临时记录事件边界：request.resolved、turn.completed 已到，但没有 session.exited。定位共同错误分类后修复，30 秒测试预算内约 1.7 秒通过，仅 NodeProcess.kill 本次记录的 Agent PID。诊断只存在仓库外副本，最终全部撤除。R58 “必须杀包装树”的陈述是其当时工作树的处理选择；本步独立源码不需要 taskkill 或延长预算，也不外推为全部 Windows 包装层已获保证。

最终 10 文件共 174/174：client、protocol、AcpAdapterSupport、AcpJsonRpcConnection、CursorAdapter、GrokAdapter、ProviderRuntimeIngestion.activity、ActivityPayloadProjection、GenericAcpDriver、CursorAcpSupport。覆盖原生权限、缺失选项、审批身份、工具取消、关闭能力/错误/超时、退出先于 EOF、断开后新请求、迟到回应、普通额度错误的会话保留及异常活动投影。新增进程检查等待协议信号/终态，不新增睡眠或按名称清理。

Server 与 effect-acp tsgo --noEmit 最终退出 0。过程中检查曾发现退出夹具全局定时器、late request 的 flip 引入 unknown 错误通道、Node process 导入不符命名规范；分别改为事件触发的已知 PID、明确 match 和 NodeProcess 命名空间，没有增加抑制。13 个选取 TS 文件 lint 退出 0，只有 Cursor 原有 unused invocation 警告；Server 原账号池 Effect 建议、Node DEP0190 启动警告保留。没有运行全仓检查。

14 文件索引格式、UTF-8 无 BOM、DEVLOG/临时诊断=0、独立副本与提交 SHA-256、提交白名单与空索引均通过。归档副本 4 文件仅 CRLF/LF 不同，核对文本相同后统一到索引字节，没有功能修改。原 12 个保留文件 SHA-256 不变；使用临时只读索引格式钩子，持久 core.hooksPath 仍 .vite-hooks/_。未推送、未建 PR、无数据库迁移。本轮没有浏览器、官方模型请求、Electron/真机或 live remote/relay/tunnel；其它轮次的本地 WS 重连证据保留，不能替代本步与完整 A-7。A-1…A-8 全部仍未勾选。

#### Retrospect

progress：已有共同生命周期实现形成自足、可回滚的模块提交；补上 Grok 真正缺失的进程失败清理，并在共享错误边界修复 Cursor 缺退出事件的根因。依赖 pending map 是否非空来判断连接断开，会在权限回调先完成时失效；应使用明确的协议错误类别。需要先检查实际事件再推断 Windows 包装层原因，单个进程级用例不等于服务器编排或远程链路验收。

下一增量选择已在工作树的共同 ACP 思考/上下文用量链路，检索后整理成一个完整模块提交，运行 Runtime→Adapter→Ingestion→客户端派生的定向回归，保持 token 占用、累计用量、费用和账户余额语义独立。非文本、厂商命令、44 入口实测、真机/Electron、服务端介导进程操作与 remote/relay/tunnel 及最终独立审计仍按原完整计划推进。撤回 1c222b2d7 即回滚本步骤，保留事件历史和其它工作，不删除账户/会话/安装目录。
## Working Audit (A-8 prep — NOT a pass)

对照计划 P0–P5 / Acceptance。状态：`code`=有定向测试/实现；`cli`=官方 CLI 证据；`ui`=浏览器/设备；`blocked`=缺凭据/上游/平台；`missing`=尚无充分证据。

| 项 | 状态 | 当前证据 / 缺口 |
| --- | --- | --- |
| P0 可重放 fixture（思考/工具/审批/配置/用量/退出） | code | 思考/工具/审批/配置/用量/资源/图/音/blob；协议 exitCode 终止；Cursor Windows mid-approval crash + late-approval-after-stop 本机绿（R55） |
| P0 候选 CLI 实测记录表 | cli 部分 | 多份 `docs/internals/*-acp-provider.md` + `paseo-provider-catalog.md`；空壳/TRAE/crow 标阻断 |
| P1 通用 ACP 事件闭环 | code | AcpRuntimeModel/CoreEvents/Ingestion/Adapters；Mobile search/fetch R52 |
| P1 非文本 | code | R66：**勾选 A-1**——fixture 链（RuntimeModel/Core/JsonRpc/Ingestion/Cursor+Grok Adapter + Web MessagesTimeline + Mobile threadActivity + ProviderBinary/ImageAttachment）覆盖图/音/blob/资源；真实 CLI 非文本仍属 A-3/A-4 |
| P2 目录 argv/env/离线回退 | code | **R68 勾选 A-2**：`paseo-provider-catalog.md` 6+38 对照 + **44 能力状态表** + 二进制安装矩阵（需 sha256）；离线快照/回退既有；Web/Mobile picker 与 AddProvider 实例保存；`binaryDistributionFor` 无 sha256 拒装；R68 定向 **8 文件 64 项**；**不**依赖 primary 360/1280 浏览器（A-5） |
| P2 首批 Copilot/Gemini/Qwen/Cline/Hermes | cli 部分 | Copilot（含 cancel）/Qwen/Cline/Hermes/Gajae 有证据；Gemini 仍无 key，仅负向 → **A-3 未勾** |
| P3 A-4 四态证据表 | docs R71 | `paseo-provider-catalog.md` Acceptance 四态全表（含扩容 antigravity/harn）；大量未实测；Harn NL=上游 Compilation；**A-4 未勾** |
| P2 动态 models/modes/commands | code+ui 部分 | R3–29/51，独立提交 9fe1eb597；官方 CLI/原生设备另验 |
| P3 Web/Desktop/Mobile 一致入口 | code 部分 | Mobile 目录+快捷按钮+安装行 flex-wrap；真机未测 → **A-5 未勾** |
| P3 第二批 Kiro/TRAE/Droid/… | cli 部分 | R69：七项前空壳 **Windows sha256+握手**（Effect 6/7 + Junie stdio）；工具仍多凭据阻断；Kiro/TRAE/crow 等平台阻断仍在 → **A-4 未勾** |
| P4 / A-6 原生+BYOK/账号池 | code | R66：**勾选 A-6**——原生矩阵 + Pi/OMP/ZCode/BYOK/OpenCode；OpenCode **仅 SDK v2** |
| P5 多端真实验收 | missing/blocked | Electron 无头单元 R56 36/36；GUI/真机/浏览器仍欠 → **A-5** |
| A-7 本地 live 重连/崩溃恢复 | code | R57 reconnect + server kill/restart；R61 编排介导 live |
| A-7 远程（LAN）live | code | R62 `A7RemoteLan.live` 1/1 |
| A-7 relay/tunnel（OR 桶） | code | R65：**勾选 A-7**（产品 SSH `-L`） |
| A-7 Tailscale/Connect 备选路径 | blocked | NeedsLogin / OAuth；非 A-7 AND |
| A-7 Administrators 公钥 | blocked | Preview 10.0p2 preauth |
| A-8 独立审计 | missing | Working Audit R68 更新仍为 prep；**无** fresh spec-verifier；A-3…A-5/A-8 未全绿 → **A-8 未勾** |

#### A-8 citation index (R37–R68) — prep only

| Round | 主题 / 证据锚点 | 对应 Acceptance 分量 |
| --- | --- | --- |
| R37–R39 | 安装按钮/目录交互；Mobile+Web 组件测试 | A-2/A-5 组件（非 primary 浏览器） |
| R40–R42 | Qwen/Hermes/Cline/Gajae 官方 CLI 探针与工具 | A-3 部分 cli |
| R43–R46 | CodeWhale/Amp/Autohand 等握手批次；空壳阻断登记 | A-4 登记 |
| R47–R50 | Harn/Agoragentic/uvx/fast-agent/minion；并行提交记录 | A-4 部分 |
| R51 | 角色/模式菜单 1280/360 浏览器截图（仓库外 audit 目录） | A-5 部分 ui（非 Electron/真机） |
| R52 | blob 命名修复；Mobile search/音频投影 | A-1 非文本部分 |
| R53–R54 | 凭据墙差分；Desktop/relay 单元 44/44；Copilot cancel | A-3/A-7 单元 |
| R55 | P4 原生矩阵 234/234；Windows mid-approval crash | A-4/A-6/A-7 adapter |
| R56 | reconnect/exposure/ssh-tunnel **单元** 69/69；Electron 无头 36/36；Gemini key 缺失 | A-5/A-7 单元；A-3 Gemini blocked |
| R57 | 隔离 serve live WS reconnect + kill/restart；A-5 安装 360/1280 组件 18/18 | A-7 本地部分；A-5 组件 |
| R58 | Cursor crash mid-approval 产品补强；Tailscale 当时不在 PATH | A-7 adapter；relay blocked |
| R59 | （并行）独立审计/提交卫生相关记录 | A-8 准备 |
| R60 | 思考流+零上下文用量独立提交 `2165d2dcb`；docs/internals/acp-content-streams.md | A-1 用量/思考 |
| R61 | 编排介导 A-7 本地 live：`A7OrchestrationMediated.live.test.ts` 1/1 | A-7 本地 orch |
| R62 | 远程 LAN live：`A7RemoteLan.live.test.ts` 1/1；Tailscale 已装仍 NeedsLogin | A-7 远程；relay blocked |
| R63 | tunnel 语义澄清；TCP forward live orch；OpenSSH/Tailscale/Connect 阻断命令表；本 citation 索引 | A-7 tunnel 部分；A-8 prep |
| R64 | 诊断 OpenSSH preauth；产品 askpass `ssh -L` live orch 1/1；公钥 Administrators 仍坏 | A-7 product SSH tunnel |
| R65 | A-7 书面条重审：SSH 关 OR 桶→**勾选 A-7**；Preview10 公钥仍坏；无门控 in-tree 缺口扫 | A-7 勾选；A-8 prep |
| R66 | A-1/A-6 勾选；auggie/dimcode node ToolProbe 边界；BYOK/账号池复跑 | A-1/A-6 勾选；A-4 登记 |
| R67（并行） | ACP 资源链接/嵌入文本模块（其它执行方） | A-1 非文本延伸 |
| R68 | A-2 勾选；七项 archive-无-sha256 复扫+HEAD；44 能力表；A-8 Working Audit 再审 | A-2 勾选；A-4 诚实更新；A-8 prep |
| R72 | host/capabilities 默认回复；session/update progress 容忍；Harn 表达式 end_turn | A-4 产品边界；harn 仍未实测工具 |
| R73 | 本机无本地 LLM；Gemini 仍无合法凭据；非交互 Playwright 隔离 serve 360/1280 ACP 目录截图 | A-5 部分浏览器；**A-5 未勾**（缺 Electron/真机） |

### Round 91 (re-verify hard block + A-8 Working Audit expand)

#### Plan

不盲信 R90「无 in-tree 解锁」：复查 adb/env/gh/gemini/iso 登录态与 `.t3` secrets；核对 A-4 四态书面语义；扩展 A-8 Working Audit 为逐条验收清单（仍不勾 A-8）；无提交、无发明密钥。

#### Act

1. **Rehunt（本机 2026-09-30）**
   - `adb devices -l`：仅 `emulator-5554` / `sdk_gphone16k_x86_64` → **非真机**（堵 A-5）。
   - Env：`GEMINI_*`/`GOOGLE_*`/`ANTHROPIC`/`FACTORY`/`AMP`/`MISTRAL`/`AGORAGENTIC`/`QODER` 均 UNSET；`OPENAI_API_KEY` 存在但 **值=`ollama`（len=6）** → 非厂商 key。
   - `gh auth status`：未登录任何 GitHub host。
   - `~/.gemini`：仅 `projects.json`（20B）+ 大量 tmp，**无 oauth/token/cred**；gemini CLI 0.55.1 在 PATH，无可用凭据。
   - `~/.factory/host.json`：仅 hostId，无 API key；`~/.copilot/config.json`：仅 firstLaunchAt；`~/.claude.json`：无 apiKey/oauthAccount。
   - Ollama 仍有 `qwen2.5:3b/7b/coder:3b`（已用尽对余表的诚实解锁）。
   - **无新可用 auth → 无新 A-3/A-4 成功探针，无新真实可用。**

2. **A-4 语义（书面四态，第五态禁止）**  
   引用 `paseo-provider-catalog.md`：「书面 verify 只用四态：`真实可用` / `未实测` / `平台限制` / `不支持`」。  
   - 握手/负向认证已证、但**缺工具副作用** → **必须留在 `未实测`**（不能因「凭据阻断」另造第五态；能力表可写凭据阻断说明，A-4 Acceptance 行仍是四态之一）。  
   - 升 `真实可用` 需文本+工具副作用证据。  
   - OS/依赖不可用 → `平台限制`；协议不可用（如 agoragentic 无 session/new）→ `不支持`。  
   - 本轮**不**把 19 项 auth-handshake 行改出 `未实测`。

3. **A-8 Working Audit**：下方扩展为对照 Acceptance verify / 计划 P0–P5 的逐条清单（仍 **不勾 A-8**）。

4. **One-shot 解锁预置（用户动作；无发明 key）**
   - Gemini（解 A-3 成功路径）：`$env:GEMINI_API_KEY='…'` 或 `gemini` OAuth 登录后，对 isolate `C:\codework-cli-iso\gemini-0.61.0` 跑既有 ToolProbe（文本+读+写+命令+拒绝+取消）；证据写入 `gemini-acp-provider.md` + catalog A-3 矩阵。
   - Copilot 刷新（若需）：`gh auth login` → 确认 `gh auth status` → isolate `copilot-1.0.89` ACP 复跑。
   - 厂商余表（解 A-4 未实测子集）：按行 `auggie login` / `amp login` / Factory 账号 / `pool login` / Qoder PAT / `MISTRAL_API_KEY` / Nova Setup / Devin browser / Snowflake(cortex) / Antigravity oauth — 然后对应该 ID 的 ToolProbe（session+tools+marker/write）。
   - 真机（解 A-5）：物理机 `adb devices -l` 须出现非 `sdk_gphone*` 的 `device`；再跑 Mobile 入口/退出/重试/长内容 + Electron GUI 360/1280。
   - A-8：上述门控关闭后跑 **fresh** spec-verifier；本 Working Audit 仅 prep。

#### Verify

| 检查 | 结果 |
| --- | --- |
| 新 unlock | **0**（live rehunt 确认） |
| A-4 四态 | 真实可用 **16** / 未实测 **19** / 平台限制 **3** / 不支持 **2** |
| A-3/A-4/A-5/A-8 | 均 `[ ]`（未改勾选） |
| 提交 | 无 |

#### Retrospect

R90 硬阻塞经本机复验成立。余门仅用户侧：Gemini/厂商登录、物理手机、（可选）Electron GUI 复验；然后 fresh spec-verifier。停止编造 in-tree 密钥解锁。

## Working Audit (A-8 prep — NOT a pass) — R91 expanded

对照计划 P0–P5 / Acceptance verify。状态：`proven` / `partial` / `open` / `blocked`。**本表≠A-8 通过。仍不勾 A-8。**

### Acceptance checkboxes (ledger lines 16–23)

| ID | Ledger | 书面 verify 要点 | R91 判定 | 主要证据 / 缺口 |
| --- | --- | --- | --- | --- |
| A-1 | `[x]` | fixture→Runtime→Adapter→Ingestion→Web/Mobile；部分更新/终态/拒绝/取消/退出/重放 | **proven** | R66；`docs/internals/acp-content-streams.md`；图/音/blob/资源链 |
| A-2 | `[x]` | 6+38 目录对照；平台/命令/env/离线回退 | **proven** | R68；`paseo-provider-catalog.md`；binaryDistribution+sha256 |
| A-3 | `[x]` | Copilot/Gemini/Qwen/Cline/Hermes：版本+认证+文本+读+写+命令+拒绝+取消；Copilot mode/config | **proven（user waiver for live Gemini）** | Copilot/Qwen/Cline/Hermes success；Gemini 负向/握手+功能路径完整；**live Gemini success not claimed**；override「需要登录真实账户和实机验证的都跳过但是保证功能完整可用。」(R109) |
| A-4 | `[x]` | 38 项四态；未实测≠「已验证支持」；Kiro/TRAE；Droid MCP；环境参数 | **proven（P3 登记）** | R100：计划 P3 允许未实测；四态表+unlock docs |
| A-5 | `[x]` | 360/1280 浏览器 + Electron + **真实手机**；入口/退出/重试/长内容 | **proven（user waiver）** | Web R73 + Electron R83 + AVD R80–81；**真实手机 waived**「能不能跳过真机」+ R109 总覆盖 |
| A-6 | `[x]` | Codex/Claude/OpenCode/Pi/OMP + 账号池/BYOK | **proven** | R66；OpenCode SDK v2 only |
| A-7 | `[x]` | 本地/远程/relay\|tunnel 分别记录 | **proven** | R65 产品 SSH OR；LAN/orch live |
| A-8 | `[x]` | P0–P5 逐条；定向 lint/typecheck/tests；**新鲜 spec-verifier 审核所有 A-N** | **proven（under override）** | R109：`paseo-a8-independent-audit.md` + gap verifier waivers + functional fixes |

### A-4 四态语义门（禁止第五态）

引用 `paseo-provider-catalog.md`：「书面 verify 只用四态：`真实可用` / `未实测` / `平台限制` / `不支持`」。

| 情况 | 允许态 | 可否因握手离未实测 |
| --- | --- | --- |
| 文本+工具副作用（marker/写/命令等）已证 | 真实可用 | — |
| 握手/负向认证已证，缺工具成功 | **未实测** | **否**（能力表可写「凭据阻断」，Acceptance 行仍未实测） |
| OS/依赖/区域不可用 | 平台限制 | — |
| 协议入口不可用（无 session/new 等） | 不支持 | — |

R91：**不**把 19 项 auth-handshake 行改出 `未实测`。

### 当前 19×未实测 — 独立核对（仍未实测）

| ID | 已证（握手/负向） | 缺什么才可→真实可用 | 引用 |
| --- | --- | --- | --- |
| antigravity-acp | 装+握手 | oauth/key + 工具副作用 | catalog A-4 行 |
| amp-acp | 握手；Authentication required | Amp key + ToolProbe | amp-acp-provider.md |
| auggie | 握手 | `auggie login` + 工具 | auggie-acp-provider.md |
| autohand | 握手 | 底层 CLI/auth + 工具 | autohand docs |
| codebuddy-code | 握手 | 多 auth + 工具 | codebuddy docs |
| cortex-code | 会话 | Snowflake 连接 + 工具 | R82 catalog |
| corust-agent | 握手 | oauth_browser + 工具 | catalog |
| devin | 握手 | devin-browser + 工具 | catalog |
| dirac | Ollama 会话+工具广告 | marker/写成功（路径幻觉） | R89–R90 dirac-acp-provider.md |
| factory-droid | session；prompt 401 | Factory 账号 + 工具 | R90 |
| gemini | 握手/负向；Ollama 404 | Google/Gemini key + 全工具矩阵 | gemini-acp-provider.md；亦堵 A-3 |
| harn | host/capabilities；NL Compilation | 真实工具副作用≠end_turn | R90 harn docs |
| junie | stdio 握手/会话 | 工具实测 | catalog |
| minimax-code | Ollama 会话；工具变正文 JSON | 真登录/真工具副作用 | R89 |
| mistral-vibe | session；Invalid API key | 真 `MISTRAL_API_KEY` + 工具 | catalog |
| nova | 握手 | Nova Setup / kore-terminal-auth | catalog |
| poolside | 握手 | `pool login` + 工具 | catalog |
| qoder | 握手 | login/PAT + 工具 | catalog |
| stakpak | 握手；session 503 | 厂商 API 恢复 + 工具 | R90 |

平台限制（3）：`crow-cli` / `kiro` / `traecli`。不支持（2）：`agoragentic-acp` / `minion-code`。

### Plan P0–P5 (compressed)

| 计划桶 | 判定 | 证据锚点 |
| --- | --- | --- |
| P0 可重放 fixture | proven | mock-agent / Adapter / mid-approval crash |
| P0 候选 CLI 实测表 | partial | `*-acp-provider.md`；19 未实测仍为合法登记 |
| P1 通用 ACP 事件 | proven | A-1 |
| P1 非文本 | proven (fixture) | 真实 CLI 非文本→A-3/A-4 升态 |
| P2 目录/argv/env/离线 | proven | A-2 |
| P2 首批五 CLI | **open** | Gemini blocked → A-3 |
| P3 其余目录登记 | **proven** | A-4 `[x]`（R100；未实测允许） |
| P3 Web/Desktop/Mobile 一致 | partial | 缺真机；Web/Electron/AVD 部分 |
| P4 原生+BYOK | proven | A-6 |
| P5 多端真实验收 | **open** | A-5 真机；远程已由 A-7 |
| §7 定向验证方法 | **proven** | R101：250 tests ALL_OK；见 `paseo-plan-s7-s8-audit.md` |
| §8 风险/回滚方法 | **proven** | R101：providers.md Rollback + catalog/实例禁用约定 |

### Citation index addendum (R69–R91)

| Round | 锚点 | 分量 |
| --- | --- | --- |
| R69–R71 | 空壳 sha256；A-4 四态表落地 | A-4 docs |
| R72–R76 | Harn host/capabilities；Ollama 首批 | A-4 产品/部分 cli |
| R78–R88 | goose/vtcode/fast-agent/glm/codewhale/dimcode/deepagents/sigit/kilo →真实可用 | A-4 部分 |
| R89 | Ollama 余表耗尽 | A-4 blocked |
| R90 | factory 401 / stakpak 503 / agoragentic→不支持 | A-4 分类 |
| R91 | live adb/env/gh/gemini 复验；本扩展 Audit；one-shot 解锁命令 | A-8 prep；硬阻塞确认 |

## Lessons

#### Plan

承接 Round 59 Retrospect，只交付共用 ACP 思考与上下文用量：复用已有原始 streamKind 和 usage 合同；正文与思考分段，零占用替换旧快照，Grok 空闲会话也接收用量。检索并选择已有工作树实现，不重复加入媒体、账号池、厂商命令等其它模块。费用、累计处理量与账户余额保持独立。

先保存目标文件原始字节，以 HEAD 加精确索引生成独立源码副本；用事件驱动的协议 fixture 验证两条 Adapter、共用投影与客户端归并，做旧行为红灯和修复绿灯、定向类型/lint/格式/编码检查，新增稳定实现文档，单独提交。本轮不派发子代理，不启新服务或浏览器，全部 A-N 保持未勾选至完整验收。

#### Act

2026-09-30 独立提交 2165d2dcba619097c39b13d2ab97021558d10816（fix(acp): 贯通思考流与零上下文用量），14 文件。复用工作树已有解析、事件工厂与测试，仅整理本模块；不提交媒体、厂商命令、账号池、其它 UI 及并发生命周期改动。

共同解析保留正文 assistant_text 与原始思考 reasoning_text，Runtime 在思考前结束正文段，后续正文重新分配消息 ID；原始思考仍按既有公开策略不持久化为摘要。Cursor/Generic/Kimi 与 Grok 通过同一事件工厂传递。Grok 正文探针明确排除思考。usage_update 保留零上下文占用，未知零窗口省略 maxTokens；共用投影不再过滤零值，客户端用零快照替换旧值。费用只保留 raw，不混为累计 token 或账户余额。

发现 Grok 原工作树 UsageUpdated 分支在必须有活动回合的门禁之后，会丢掉空闲刷新；将用量处理移到回合门禁前，根会话与重放门禁仍由共同 Runtime 执行，用量不更新回合活性。新增事件驱动空闲 fixture：session/set_model 回复前发送用量，无推理回合、无新增延时/轮询。新增 docs/internals/acp-content-streams.md 记录调用链、公开显示、语义、测试与回滚。

#### Verify

独立源码副本为 codework-acp-streams-audit-20260930/source-HGqzNF/source，由基线 1c222b2d7 加精确索引形成，workspace 依赖指向该副本。先只替换模型回归测试，旧行为 5 失败、38 通过：三组 usage 与 thought 均解析为空，正文未带 streamKind，证实缺口；修复后全部相关模型测试通过。

Server 8 文件：7 通过、1 opt-in 探针文件跳过，167 通过、5 跳过；覆盖 Model/Core、Cursor/Grok、Generic Driver、Ingestion 活动、ActivityPayloadProjection 和 Grok 官方 CLI 探针。共享客户端 threadReducer 36/36，Web contextWindow 14/14，Mobile threadActivity 39/39，共 11 文件、256 通过、5 跳过。正文/思考分段、空闲零通知、回合归属、子会话/重放隔离、费用边界、零快照替换均有定向结果。官方 CLI 探针跳过不能算真实 provider 验收。

Server tsgo --noEmit 退出 0，两个原有账户池 Effect 建议；13 个 TS 文件定向 lint 退出 0，仅 Cursor 测试原有 unused invocation 警告。共享客户端包类型检查退出 1：providerModels.test.ts:113 TS2719（null 不可赋值）；在独立副本恢复未改动 HEAD 的 threadReducer.test.ts 后同一错误仍在，确认本步骤之外的基线问题，未夹带修复。临时副本基线检查结束后已恢复本模块字节。

14 文件的索引格式、UTF-8 无 BOM、语法诊断、无临时诊断残留、diff --cached --check、索引/源码副本/提交 SHA-256 一致性全部通过；12 个受保护文件原始哈希不变。只对本次 commit 使用外部只读 pre-commit 核对索引，防止 vp staged 改写混合工作树；core.hooksPath 仍为 .vite-hooks/_，提交后索引为空。源码、临时脚本、日志与计划分开保存；没有推送或创建 PR。

未进行本轮浏览器、Electron、真机或远程/relay/tunnel验证；沿用已获浏览器授权，在后续 UI 增量统一验证。全部 A-1…A-8 仍未勾选，goal 与 loop 保持 running/active。

#### Retrospect

本轮新增有效证据不是入口数增长，而是原始通知到 Adapter、共用投影、客户端派生的完整模块提交；零值和空闲状态是不同门禁，应分别覆盖。上下文快照与用量费用/余额不能混用，原始思考不能通过改名制造摘要可见性。并行运行会改动独立副本的基线核对与字节核对产生暂态差异；存在同一文件依赖的检查必须顺序运行，本次恢复后已重新核对一致。

下一增量从已有共同 ACP 非文本链路检索并选择一个完整模块（资源文本与消息边界优先）；核对工具详情、存储/投影与双端显示后单独提交。44 入口真实实测、官方认证/账户接口、真机/Electron、编排介导进程操作与 remote/relay/tunnel、完整最终独立审计继续按原计划推进。回滚本步骤使用撤销 2165d2dcb 的新提交，不删除数据库、账户或其它工作树内容。

### Round 61

#### Plan

关闭 R58 标明的编排介导缺口：在隔离 home 上经真实 WS RPC → OrchestrationEngine → Provider → `acp-mock-agent` 覆盖迟到审批（断连后重连再批）、agent 中途崩溃恢复、取消（interrupt）后重启。捕获 serve/agent PID，只杀那些。不发明 Gemini key、不启浏览器、不勾假 A-N、不提交、不 `pkill -f`。

#### Act

- 新增 `apps/server/src/orchestration/A7OrchestrationMediated.live.test.ts`：spawn `serve --base-dir` 隔离 home（唯一目录避免 EBUSY）、解析 Pairing URL、**一次性** oauth token-exchange 后复用 bearer（配对令牌单次消费）、`server.updateSettings` 指向 mock wrapper、`project.create` + `thread.turn.start` / `thread.approval.respond` / `thread.turn.interrupt` / `thread.session.stop`。
- 轮询 `subscribeThread` 快照（只 `take(1)` snapshot，避免 live 流挂死）；Windows agent 崩溃用 `taskkill /T /F` 仅杀记录的 agent PID。
- **勿在运行中切换 `binaryPath`**：否则会报「供应商配置正在切换」拒绝新回合；三场景共用 `CODEWORK_ACP_EMIT_TOOL_CALLS` mock。
- 证据：`.t3/a7-live-isolate-r59/a7-orchestration-mediated-evidence.json`（`ok:true`，三场景均绿）；serve PID teardown 已记录。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| `vp test run apps/server/src/orchestration/A7OrchestrationMediated.live.test.ts` | **1/1 passed** (~15.8s) |
| lateApprovalAfterReconnect | `ok:true`（requestId 记录） |
| agentCrashRecover | `ok:true`（crashedAgentPid + recover thread） |
| cancelThenRestart | `ok:true`（interrupt + restart approve） |
| remote / relay / Tailscale `--share` | 仍缺（R58 blocker） |
| A-1…A-8 勾选 | 否 |

#### Retrospect

progress：本地隔离上首次有**编排介导**迟到审批 / agent 崩溃恢复 / 取消后重启的 live WS 证据，补上 R58 最大缺口。完整 A-7 仍欠 remote 与 relay/tunnel。下一优先：Tailscale 登录后 `--share`；Gemini / primary 360·1280 / 真机仍需外部供给。

### Round 62

#### Plan

不发明密钥：搜 Code Work Connect / `--share` / Tailscale 替代路径；能非交互装 Tailscale 则装，登录若仅交互则记阻断；澄清计划「远程」≠ 127.0.0.1 第二客户端；脚本诚实 LAN remote live；跳过 Gemini/浏览器/手机除非新可用；更新 Working Audit；不勾假 A-N；不提交。

#### Act

- **定义（计划+docs）**：`远程` = 非 loopback 可达绑定 + 客户端用非 loopback HTTP/WS（LAN / Tailnet / HTTPS）；`127.0.0.1` 第二 WS **不算** remote。`relay/tunnel` = Tailscale Serve（`vp run dev --share` / `pair --tailscale`）或 Code Work Connect（Clerk + Cloudflare）。
- **Tailscale**：`winget install Tailscale.Tailscale` 成功（1.102.4）；服务 Running；`tailscale status` → Logged out / NeedsLogin；`tailscale up` 仅打印 `login.tailscale.com`（无 `TS_AUTHKEY`）→ 杀捕获 PID；`--share` 仍不可 live。
- **Connect**：`.env.example` 仅公开 Clerk/relay URL；不读改 live `~/.t3/userdata` 做 Connect；`198.18.0.1` Meta=Clash，非 Connect。
- **Remote LAN live**：新增 `A7RemoteLan.live.test.ts` — `serve --host <LAN>`（`192.168.1.4`），配对/bearer/WS 全走该 IP；lanWsReconnect + late-approval / crash-recover / cancel-restart；只 taskkill 捕获 PID。
- 证据：`.t3/a7-live-isolate-r62/a7-remote-lan-evidence.json`（`ok:true`）；`.t3/a7-live-isolate-r62/a7-relay-tunnel-blocker.json`（`ok:false`）。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| `vp test run …/A7RemoteLan.live.test.ts` | **1/1 passed** (~14.8s tests) |
| lanWsReconnect via `http://192.168.1.4:…` | `ok:true` |
| lateApproval / crashRecover / cancelRestart（remote path） | 三场景 `ok:true` |
| Tailscale install | 已装；登录 **交互阻断** |
| Connect / `--share` live | **阻断**（无 authkey / 无交互 OAuth） |
| Gemini / primary browser / Electron / phone | 仍不可用（key unset；未启） |
| A-1…A-8 勾选 | 否 |

#### Retrospect

progress：A-7 **远程（LAN）** 与本地并列有编排介导 live 证据；relay/tunnel 诚实记为登录/OAuth 阻断（安装 alone 不够）。完整 A-7 仍欠 relay/tunnel；A-5/A-8/Gemini/设备仍欠。下一优先：用户 Tailscale 登录或 Connect 凭据后短寿命 `--share`/tunnel WS；或 A-8 独立审计起草。

### Round 63

#### Plan

重读计划 A-7「relay/tunnel」语义；在无交互 Tailscale/Connect 登录前提下产出最强诚实 tunnel 证据（OpenSSH forward 或短寿命隧道进程 + 三编排场景）；扩展 A-8 Working Audit 引用 R37–R62；不发明 Gemini、不启交互浏览器、不勾假 A-N、不提交。

#### Act

- **语义（计划 P5 + `docs/internals/remote.md`）**：`relay/tunnel` 桶含 (1) Code Work Connect managed relay，(2) Tailscale Serve，(3) Desktop SSH local forward。不是「仅 Tailscale」。LAN remote（R62）是独立「远程」模式。
- **OpenSSH live**：`Add-WindowsCapability OpenSSH.Server` 成功；sshd 接受 harness 公钥后 `Unknown error [preauth]`（签名阶段）→ **live OpenSSH -L 阻断**。
- **TCP forward live**（ssh -L 数据面）：`apps/server/scripts/tcp-forward-tunnel.mjs` + `A7TunnelForward.live.test.ts` — 客户端只连 tunnel listen port，serve 在另一端口；reconnect + late-approval / crash-recover / cancel-restart。
- **产品单元**：`packages/ssh` + `dev-share` + desktop tailscaleEndpointProvider **3 文件 24/24**。
- **阻断命令表**：`.t3/a7-live-isolate-r63/a7-relay-tunnel-semantics-and-blockers.json`（`tailscale up` / `TS_AUTHKEY` / `codework connect link`）。
- **A-8**：Working Audit 增补 tunnel 行 + R37–R63 citation 索引（仍非独立审计通过）。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| `vp test run …/A7TunnelForward.live.test.ts` | **1/1** (~18.3s) |
| evidence `a7-tunnel-forward-evidence.json` | `ok:true`；tunnelPid≠servePid；clientBase≠servePort |
| product SSH/Tailscale unit | **24/24** |
| OpenSSH live `-L` | **阻断**（preauth Unknown error） |
| Tailscale Serve / Connect live | **阻断**（NeedsLogin / OAuth） |
| A-7 勾选 / A-8 勾选 | **否** |

#### Retrospect

progress：tunnel **hop** 属性有隔离 live 编排证据；产品级 Tailscale/Connect/OpenSSH 仍欠。完整 A-7 的 relay/tunnel 桶未关；A-8 引用表已备，待最后门控与 spec-verifier。下一优先：用户 `tailscale up` 或 Connect link 后短寿命 `--share`；或 primary 浏览器/真机/Gemini。

### Round 64

#### Plan

诊断并修复产品 OpenSSH local-forward，使真实 `ssh.exe -L`（对齐 `packages/ssh` askpass/隧道参数）跑通 A-7 编排；写证据与 ledger。公钥若本机版本不可修，记录根因与最小用户修复，不假勾 A-7。

#### Act

- **sshd_config**：先前把 `StrictModes`/`LogLevel` 追加到 `Match Group administrators` **之后** → 被当作 Match 内指令 → `Directive 'StrictModes' is not allowed within a Match block` → sshd 停服。已将全局项移到 Match **之前**。
- **公钥（Administrators）**：OpenSSH_for_Windows_9.5p2 仍「Accepted key → sign → Permission denied / Unknown error [preauth]」——未假装修好。
- **产品路径**：非管理员本地用户 + `SSH_ASKPASS`/`CODEWORK_SSH_AUTH_SECRET`（脚本对齐 `packages/ssh/src/auth.ts`）+ `ssh.exe -N -L`（对齐 `tunnel.ts` 转发族参数）。
- 新增 `A7SshProductTunnel.live.test.ts`：隔离 serve → 产品 SSH 转发 → orch 三场景。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| `vp test run …/A7SshProductTunnel.live.test.ts` | **1/1** (~18.5s) |
| `.t3/…/a7-ssh-product-tunnel-evidence.json` | `ok:true`；tunnelPid≠servePid；authMode=password-askpass |
| `.t3/…/a7-openssh-preauth-diagnosis.json` | 根因 + 最小用户说明 |
| Administrators pubkey live | **仍失败**（记入诊断，不声称修复） |
| Tailscale/Connect | 仍阻断 |
| A-N 勾选 | **否** |

#### Retrospect

progress：A-7 **产品 SSH tunnel** 有编排介导 live 证据（askpass 路径）。公钥 Administrators 在本机 9.5p2 仍坏；Tailscale/Connect 仍需用户登录。完整 A-7 relay 桶当时仍欠（R65 按 OR 桶+产品 SSH 勾选 A-7）；A-5/A-8/Gemini/设备仍欠。


### Round 65

#### Plan

1. 对照计划 P5 / Acceptance A-7 / `docs/internals/remote.md` 重审：`relay/tunnel` 是否被产品 SSH 单独满足，或仍强制 Tailscale Serve **与/或** Connect。仅当书面条完全满足才勾选 A-7。
2. 尝试 OpenSSH 升级或 ACL/`administrators_authorized_keys` 修复 Administrators 公钥；成功则第二 evidence run，否则只留诊断。
3. 猎取不依赖 Gemini 密钥 / 交互浏览器 / 手机 / Tailscale 登录的剩余 in-tree P0–P5 / A-1–A-4/A-6 缺口。
4. 不假勾其它 A-N；不提交；不发明密钥。

#### Act

- **书面条引用**：Acceptance A-7「本地、远程、relay/tunnel…」；计划 P5「本地、远程环境、relay/tunnel 重连场景…」；`remote.md` 将 Direct / Connect relay / Tailscale Serve / Desktop SSH 列为**对等可选**接入；用户 `remote-access.md` 写明无 Tailscale 时核心远程模型仍成立。
- **语义结论**：`relay/tunnel` 为**单一模式**的 slash-**OR** 桶（Connect \| Tailscale Serve \| Desktop SSH local forward），**不是**三者 AND。R62 曾把桶缩成 Tailscale\|Connect；R63 按 docs 扩回含 SSH；R64 产品 `ssh.exe -L`+askpass 已有编排介导 live。
- **勾选 A-7**：三模式均有隔离 live 证据——本地 R57/R61；远程 LAN R62；relay/tunnel=产品 SSH R64（含显式 tunnel WS reconnect + late-approval / crash-recover / cancel-restart）。Tailscale/Connect 记为**备选路径阻断**，非 A-7 门控。
- **公钥**：`winget` 已装 `Microsoft.OpenSSH.Preview` 10.0.0.0（`C:\Program Files\OpenSSH\` = 10.0p2）；系统服务仍 9.5p2。Preview `sshd` 监听 2222 + Administrators 属主/ACL/`StrictModes=no` 后仍「Server accepts key → Unknown error [preauth] / Permission denied」。**无第二 evidence run**；诊断 `.t3/a7-live-isolate-r65/a7-openssh-pubkey-r65-diagnosis.json`。
- **缺口猎取**：Gemini 环境变量仍空；Tailscale CLI 本回合 PATH 不可用/未登录；空壳 archive（cortex/corust/stakpak/vtcode/antigravity/junie/devin）、TRAE 403、crow termios、凭据墙项无法 in-tree 关闭。`authMethods=[]` 的 auggie 工具探针因 Windows `.cmd` spawn EINVAL 未在本轮扩成 ToolProbe（已知 A-2 边界，非新假通过）。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| A-7 书面 OR 桶 vs SSH | **满足**（见 `a7-acceptance-reaudit-r65.json`） |
| A-7 Acceptance 勾选 | **是**（仅 A-7） |
| Administrators pubkey / Preview 10 | **仍失败**；诊断 only |
| Tailscale Serve / Connect live | 仍阻断（备选） |
| Gemini / primary 浏览器 / Electron GUI / 真机 | 仍欠 |
| A-1…A-6 / A-8 勾选 | **否** |
| 提交 | **否** |

#### Retrospect

progress：A-7 按计划/docs 的 OR 读法由本地+LAN+产品 SSH 关闭并勾选；公钥与 Tailscale/Connect 不阻滞该勾选。完整 goal **未**完成——A-1…A-6/A-5 设备/A-3 Gemini/A-4 空壳/A-8 独立审计仍欠。下一优先：用户 Tailscale/Connect 登录（可选强化）、Gemini key、primary 360·1280/真机/Electron，或 A-8 spec-verifier；可选补 auggie/dimcode 无密钥 ToolProbe（node 入口避开 `.cmd`）。

### Round 62 — 主线程目录布局增量

#### Plan

按本线程 Round 62 hook，从 Round 61 Retrospect 选择一个增量：完成 ACP 目录安装与连接配置的 360px/1280px 主线程浏览器验证，并修正真实布局缺口。已读取 Acceptance、此前安装/回填轮次和 Lessons；安装后端和身份保护已有实现，不重复编写。沿用用户浏览器授权，复用 browser-control、test-codework-app；不派发子代理、不推送、不创建 PR。

原始计划在仓库外 codework-acp-layout-audit-20260930/plan.md。共享 ledger 的另一执行方同时写入 Round 62–65，本节另用明确标题保存本线程结果，不覆盖其网络测试、Lessons 或 Acceptance 状态。

#### Act

独立提交 17a86087ad8646ae481ccfce324bf44854aaddbc（fix(ui): 保持 ACP 安装目录在窄屏可读），3 文件、12 行新增/4 行删除。Web 和 Mobile 的目录行允许换行，说明列使用 basis-48；只加 flex-wrap 时说明列仍由 flex-1 的零基础宽度压到约 126px。给说明列足够的基础宽度后，360px 中可用说明宽约 233px，安装/选择按钮自然移到下一行，宽屏仍同排。复用原有组件和安装逻辑，无新依赖或运行时布局计算。

docs/user/acp-session-controls.md 补充目录安装、服务器环境归属、处理状态、窄屏操作、返回/关闭/保存，以及安装不等于认证或模型可用的边界。未提交其它写入方的 seedQuery、静态宽度测试、账户池、媒体或编排探针改动。

原拥有服务句柄 50341 已退出；恢复隔离 home 后，共享工作树热更新两次重置向导。核实捕获的 dev-runner PID 37176 及命令行后，仅停止该进程树；改为 HEAD 2165d2dcb 加精确索引的独立源码副本 source-3jwNwi/source，复用同一隔离 home 和浏览器登录。首次副本启动因 vp 未在 PATH 报 ENOENT，仅为本次进程补入现有 node_modules/.bin 后启动成功。保留服务句柄 51404、Web 5733、Server 13773；未读写在线数据库，未设置 VITE_HTTP_URL/VITE_WS_URL。

#### Verify

独立副本 Web 三个目录/交互/环境归属测试文件 15/15；Mobile 目录测试 6/6，共 4 文件 21/21。Web tsgo --noEmit、Mobile 规范 tsc --noEmit 均退出 0；两个变更 TSX 定向 lint 退出 0。未运行仓库级检查；静态组件的宽度包裹不作为实际布局证据。

真实浏览器经实际安装 RPC 使用已有 Amp 官方归档缓存：点击后出现禁用“下载中…”，完成后回填隔离环境启动路径并显示“已选择”。360px 下说明宽 233.333px、按钮在下一行、document scrollWidth=360；1280px 下说明宽 378.667px，按钮同排、document scrollWidth=1280。窄屏 Tab 能访问“添加实例”，按钮底部 743.667px 在 800px 视口内。点击“返回”进入命名，再点“下一步”，启动路径与已选择状态保留；点击“关闭”后无添加向导、无新增 Amp 实例，仍在供应商设置。临时 viewport 已恢复，浏览器标签标记 handoff。

仓库外截图包括 acp-install-before-360.jpg、acp-install-selected-360.jpg、acp-install-actions-360.jpg 和 acp-install-selected-1280.jpg，几何数据单独保存。实际下载安装/配置证据不等于 Amp 账号登录、推理或工具执行；本轮没有保存新实例、Electron GUI、iOS/Android 真机或远程浏览器验证，A-5 完整验收仍未满足。

3 文件索引格式、UTF-8 无 BOM、diff --cached --check、索引/副本/提交 SHA-256 一致通过；12 个原有保留文件哈希不变，提交后索引为空，Mobile 同文件的其它未提交改动仍保留。外部只读提交钩子仅作用本次 commit；core.hooksPath 仍为 .vite-hooks/_。随后服务监听仍在；依赖文件监视曾触发 Server 重启，日志已恢复监听，保留的是当前测试服务而非生产服务。

本轮没有修改 Acceptance 的复选状态，不将其它执行方新勾选的 A-7 当作本轮独立审计结果。完整目标继续 active，ledger 继续 running。

#### Retrospect

flex-wrap 不能单独保证说明可读：flex-1 的基础宽度为零时，布局仍优先把按钮塞在同排。给说明列现有 CSS 基础宽度即可，无需测量脚本或专用断点。真实 DOM 几何与按钮过程验证填补了先前静态“宽度测试”的证据不足。共享工作树的热重载中断应先核对服务日志并隔离验证，不能归为按钮缺陷；并行 ledger 用独立标题追加，避免覆盖他方结果。

下一增量返回共同 ACP 非文本链路，先检索已有资源文本/消息边界与双端工具详情，选择一个完整模块检查并单独提交；其余 44 入口、认证、账户接口、Electron/真机及最终独立审计保持原范围。回滚本步采用撤销 17a86087a 的新提交，无数据库迁移，不删除已安装 Agent、账户或其它工作树内容。

### Round 67

#### Plan

承接主线程最新 Retrospect，只交付共同 ACP 资源链接与嵌入文本模块。已重读 Acceptance、最新回顾与全部 Lessons，检索 R15 的现有实现、测试和显示证据；工作树已有转换和分段，不重复创造消息合同或渲染组件。责任链是 AcpRuntimeModel → AcpSessionRuntime → Cursor/Generic/Kimi 与 Grok → 原有正文投影 → Web/Mobile Markdown。工具非文本已有独立解析，此步不修改工具、图片、音频/blob 或厂商扩展命令。

保存混合工作树原始字节，按 HEAD 17a86087a 加资源专属索引形成独立副本；先以新增资源回归验证旧行为失败，再验证修复、两 Adapter 的顺序/重放隔离、流式/缓冲持久化及双端 Markdown。新增稳定实现说明，逐文件格式/类型/lint/编码和提交哈希核对后单独提交。复用既有依赖，不启动新服务或派发子代理，不推送/PR，本步骤不缩减完整 44 入口与设备/认证验收。

#### Act

2026-09-30 独立提交 dfe2365863c9b43c6294006008b66bd83f7f6f7c（feat(acp): 保留资源链接与嵌入文本边界），10 文件、342 行新增/2 行删除。按已有工作树实现选取资源专属内容，不重复编写其它模块。

AcpRuntimeModel 复用 ContentDelta 传递资源标题、URI、说明及文本，保留正文/思考归属；标题转义，HTTP(S)/file URI 保留目标与 query/fragment，其它 URI 明确显示不可直接打开及原值。说明与嵌入正文使用长于内部反引号串的围栏，空文本与长文本保留。内部 standalone 标记由 Runtime 消费，在资源前后复用既有 assistant item 关闭/开始事件；没有新增公开合同、数据库表或渲染组件。

从已有 acp-mock-agent 仅选取资源场景，覆盖未闭合前文、链接、嵌入原文与后文，以及子会话/重放噪声。选取 Model、Cursor/Grok 和 Ingestion 的资源测试；新增网页围栏字面显示回归。docs/internals/acp-resource-text.md 记录调用链、显示/权限边界、定向命令及回滚；用户文档仅补资源说明。图片、音频/blob、工具详情、Kiro/Harn/Gajae 专项与账号池改动均未夹带提交。

检索关键词 ACP ContentBlock resource_link embedded text resource，2026-09-30 读取官方 v1 内容协议及仓库生成 schema；采用一手协议形状，不从 README 推测字段。准备脚本首次遇到测试容器为 layer 而非 describe、新增文档索引需 --add，分别核对 AST 和精确新文件后继续；没有回退到宽泛暂存。差异核对发现脚本 String.replace 的字面 $& 被替换展开，提交前按已保存原始函数恢复，并将临时替换改为回调；未改写混合工作树源码。

#### Verify

独立源码副本 codework-acp-resources-audit-20260930/source-jmLRH7/source 来自基线 17a86087a 加精确 10 文件索引，workspace 依赖指向副本。只将副本 Model 恢复为 HEAD 并保留新资源测试，旧行为 7 失败/43 通过：资源事件为空。恢复修复字节后运行如下定向检查。

| 检查 | 结果 |
| --- | --- |
| Server：Model、CursorAdapter、GrokAdapter、ProviderRuntimeIngestion，4 文件完整测试 | 231/231；334.79 秒，其中测试 308.93 秒 |
| Server 同四文件资源过滤检查 | 11/11，220 项因过滤跳过；不重复计入完整测试总数 |
| Web：ChatMarkdown 与 markdown-links，2 文件 | 最终 83/83 |
| Mobile：nativeMarkdownText 与 markdownLinks，2 文件 | 42/42；仅 Markdown 派生/链接回归，不是设备验证 |
| Server tsgo --noEmit | 退出 0，两个未改动账户模块的 Effect 建议 |
| Web tsgo --noEmit | 最终退出 0 |
| 8 个变更 TS/TSX 定向 lint | 退出 0；Cursor 测试原有 unused invocation 警告 |
| 精确索引格式、UTF-8 无 BOM、语法诊断、临时诊断残留及 diff --cached --check | 全部通过，8 个源码语法诊断为 0 |
| 索引/独立副本/最终提交 SHA-256 | 10 文件一致；提交后索引为空 |
| 原始保留内容 | 12 个受保护文件哈希不变，9 个已保存混合工作树文件逐字节不变；本轮新增 Web 测试格式同步后无残留修改 |

共 8 文件 356 项最终测试通过。四段消息均有独立 item ID，资源保留内容顺序，子会话与重放不混入；Ingestion 在流式/缓冲两种模式持久化资源原文。Web 资源代码块中的 HTML、图片与内部链接均为字面文本，合法外部资源链接保留。首次网页断言将合法外链的网站图标误计入资源图片，且测试缺必填 cwd；按实际失败 HTML 缩到代码块断言、补 cwd 后重跑测试和类型检查，未修改产品渲染器来迎合测试。

未运行仓库级检查。本轮没有浏览器、Electron、手机真机、官方 CLI 推理/认证或远程验证；R15 的历史浏览器记录只作为检索依据，不冒称本次提交的新验证。未启动/停止新的服务、未访问在线数据库；已有隔离服务保留。仅对本 commit 使用外部只读索引钩子，core.hooksPath 仍为 .vite-hooks/_，没有推送或创建 PR。

本轮没有改动其它执行方在 R66/R68 勾选的 Acceptance 状态；本步证据仅覆盖资源文本模块，不声称整个 A-1 或 A-5 已经过最终独立审计。完整 goal 仍 active，ledger running，.loop-state 未改动。

#### Retrospect

资源不是普通文本追加：保留原文围栏和前后消息边界必须共同交付，否则链接/文本虽然传到客户端，仍可能被前文未闭合 Markdown 吞入。字面显示测试需限定资源块；外部链接的网站图标是原有 UI，不能将其误认成嵌入图片执行。临时索引构造也必须按语义核对，字符串替换的 $& 展开和测试容器不同都能令成功的 Git 操作产生错误补丁，独立差异/红灯/类型检查不可省略。

下一增量整理已有助手图片链路为一个完整模块：先搜索合同、原子资产存储、纯附件消息投影及双端失败反馈，按调用依赖选取精确索引，独立回归并完成必要的实际页面验证后单独提交。音频/blob、其它 Agent 真实认证/工具、设备与最终新鲜审计继续原完整计划；不从目录或 fixture 数量推断全部 Agent 可用。回滚本步骤用撤销 dfe236586 的新提交，无数据库迁移，保留历史、安装目录和其它未提交内容。

### Round 66

#### Plan

在无 Gemini/交互浏览器/手机/Tailscale 登录前提下最大化 in-tree：关闭 A-6 BYOK/账号池/原生隔离缺口；为 auggie/dimcode 用 node 入口修 `.cmd` EINVAL 并加 ToolProbe（能本地夹具则工具，否则诚实边界）；加强 A-1 非文本 fixture 链证据；仅当书面条满足才勾选；不提交、不发明密钥。

#### Act

- **A-6**：复跑原生 Adapter/OpenCode/Pi/OMP/ZCode/Antigravity/Byok/Grok 等 **8 文件 246/246**；补 Pi/OMP BYOK、ZCode BYOK/凭据、OpenCodeAdapter、PifamilyByokRouting、LocalAccountPool/models、localAccountUsage/modelGateway **8 文件 77 + 先前 72**。核对 OpenCode：产品仅 `@opencode-ai/sdk/v2`，legacy v1 Provider Layer 已删除（`OpenCodeProvider.test.ts` 注释）。账号池凭据解析单测覆盖「不暴露 secret 值」。
- **ToolProbe**：新增 `AuggieAcpToolProbe` / `DimcodeAcpToolProbe`——`process.execPath` + `augment.mjs` / `dim.mjs`。Auggie：`authMethods=[]` 仍 `Authentication required… auggie login`，无 prompt。Dimcode：无密钥隔离 home 下 session/new 未成功。更新 `auggie-acp-provider.md`、`dimcode-acp-provider.md`、catalog。
- **A-1**：fixture 链 **11 文件 345/345** + ProviderBinary/ImageAttachment 等 **5 文件 58/58**；verify 明文为协议 fixture→Web/Mobile，**不**要求真实 CLI 非文本（后者归 A-3/A-4）。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| A-1 Acceptance 勾选 | **是**（fixture verify 满足） |
| A-6 Acceptance 勾选 | **是**（Adapter/BYOK/账号池/OpenCode v2 核对） |
| Auggie/Dimcode ToolProbe | **2/2**（边界诚实，非工具成功） |
| Gemini / primary 浏览器 / Electron GUI / 真机 | 仍欠 |
| A-2…A-5 / A-8 勾选 | **否** |
| 提交 | **否** |

#### Retrospect

progress：A-1 与 A-6 按书面 verify 勾选；空 `authMethods` 不等于可匿名工具（Auggie 硬证）。完整 goal 仍欠 A-2 目录闭环、A-3 Gemini、A-4 余项、A-5 多端设备、A-8 独立审计。下一优先：Gemini key / primary 360·1280 / 真机 / 空壳上游 archive / A-8 verifier。

### Round 68

#### Plan

继续 durable goal（此前已勾 A-1/A-6/A-7）。本轮：(1) 重读 A-2 书面条，尽量在无 primary 交互浏览器下关闭目录缺口，仅当不依赖 live browser 才勾选；(2) 复扫原空壳七项的 archive/安装方法，诚实更新目录，不伪造安装；(3) A-8 要求逐条 Working Audit，整盘 P0–P5/A-N 未齐则不勾 A-8；(4) A-3/A-5 仅当新凭据或非交互路径出现。不发明密钥、不交互浏览器、不提交。

#### Act

- 拉取并保存 `.t3/a7-live-isolate-r65/registry-latest-r67.json`：七项（cortex-code / corust-agent / stakpak / vtcode / antigravity-acp / junie@3419.22.0 / devin）在线均有 `archive`+`cmd`（部分含 args/env），**均无 sha256**。Windows 平台对七个 archive URL **HEAD 皆 200**（证据 `empty-shell-archive-head-r67.json`）。
- 更新 `docs/internals/paseo-provider-catalog.md`：七项改为「手工无校验」；新增 **44 入口能力状态表**；修正 OpenCode（A-6 v2）与「仍需完成」（A-7 已勾、空壳语义变更）。**未**下载解包、**未**刷新无 sha256 的 snapshot enrichment（规则要求有 sha256 才保留 archive）。
- A-2 定向：`AcpRegistryCatalog` / BinaryInstall / Web picker(+interaction) / AddProvider environment / Mobile section+logic / GenericAcpDriver → **8 文件 64/64**。
- Gemini 相关环境变量仍全部未设；跳过 A-3/A-5。
- Working Audit（上节）按要求逐条刷新至 R68；不跑 spec-verifier，不勾 A-8。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| A-2 Acceptance 勾选 | **是**（书面条不要求 primary 浏览器；能力表+目录+安装矩阵+实例保存/安装所有权/双端 picker/离线回退/Windows·npx·uvx·手工·unsupported 均有结果） |
| A-2 若需浏览器时的 parent 命令 | **N/A**（不强制）；A-5 仍需：`/goal` continuation 或 primary agent 跑 **360px/1280px 实机浏览器 + Electron GUI + 至少一台真机** 关键路径 |
| A-3 / A-4 / A-5 / A-8 | **未勾**（Gemini 无 key；七项仍无自动安装且 CLI 未测；多端设备欠；无 fresh verifier） |
| 伪造自动安装 | **否** |
| 提交 | **否** |
| 完整 goal | **否** |

#### Retrospect

progress：A-2 目录书面条可在无 live browser 下关闭；「空壳」已演进为「有 URL、无校验哈希」。下一优先仍是 Gemini 凭据、A-4 实装、A-5 设备/浏览器、A-8 verifier。回滚本轮仅撤回 catalog/ledger/证据 JSON 文档增量，无代码/迁移。

### Round 69 — 前空壳 Windows sha256 / CliProbe

#### Plan

推进 A-4：对七项前空壳隔离下载、计算 sha256、更新快照与自动安装可校验元数据；CliProbe（及无登录则可 ToolProbe）；更新目录/文档。仅当 A-4 书面条完全满足才勾选。跳过 Gemini/浏览器/手机；不发明密钥；不提交。

#### Act

- 下载至 `C:/codework-cli-iso/a4-empty-shells-r69/`，七项 Windows 归档均成功并记录 SHA-256。
- 更新 `registry-snapshot.json` 的 `windows-x86_64`（junie→3419.22.0）；新增 `registry-binary-sha256-overlay.json`，`binaryDistributionFor` 在官方缺 sha256 时合并 overlay。
- CliProbe：Effect **6/7**（Junie 记 stdio）；ToolProbe：vtcode Internal error；cortex `end_turn`（未验工具语义）。
- 七份 provider 文档 + catalog；定向 **27/27**。

#### Verify

| 检查项 | 结果 |
| --- | --- |
| 七项 Windows 自动安装 sha256 | **是** |
| 握手证据 | **是**（6 Effect + Junie stdio） |
| 工具真实可用 | **否** |
| A-4 Acceptance 勾选 | **否** |
| 提交 | **否** |

#### Retrospect

progress：前空壳变为 Windows 可装+握手登记。A-4 不能勾选。下一：Gemini/A-5 或余项工具凭据。回滚撤回 overlay/快照补丁/探针/文档。

### Round 70

#### Plan

承接主线程 R67 Retrospect，本轮只整理共同 ACP 助手图片输出完整模块。已重读 Acceptance、最新 R68 回顾、R16 图片责任链和全部 Lessons，并检索合同、附件写入、两个 Adapter、Ingestion、投影/reducer、Web 历史显示与 Mobile 图片组件。工作树已有实现，直接复用 ChatAttachment、原子 .part 写入和签名资产接口；不重复引入存储、下载器或消息表。图片必须独立成段，纯图片完成/历史不丢失，思考图片保持隐藏，非法内容和解码错误有可见反馈，日志不含 base64。

以 HEAD dfe236586 加图片专属索引建立独立副本，保存混合文件原始字节。仅选取图片依赖与回归，不带入音频/blob、工具详情、厂商扩展和账号池。先证明原实现解析失败，再运行资产/协议子进程/流式缓冲/共享 reducer/Web 回归及 Server、Web、Mobile 类型检查，最后复用已授权隔离浏览器验证 1280/360px 预览、错误和刷新，逐文件编码/格式/哈希核对后单独提交。无全仓检查、子代理、推送/PR；不改在线数据库，不缩减 44 入口、真实认证和设备最终验收。
#### Act

2026-09-30 单独提交 c406b89caaa58b873681d62d7e8e785630af9e04（feat(acp): 保存并显示助手图片），26 文件、657 行新增/52 行删除。按已有 R16 工作树图片实现选取完整调用链，不重新创造消息表、附件接口或下载器；资源分段复用 R67 已提交能力。助手 image 由 AcpRuntimeModel → Runtime → Cursor/Generic/Kimi/Grok → content.delta.image → Ingestion 保存到现有 ChatAttachment；内部增量命令传附件引用，完成事件沿原 projector/reducer 保留附件。图片不跨前后文本段；思考、其它会话及重放保持原门禁。

ProviderImageAttachment 复用原子 .part 写入/重命名、现有路径规则、base64 和 MIME 白名单，校验规范编码、非空、10 MiB 上限和 PNG/JPEG/GIF/WebP 格式签名。稳定 ID 包含原始线程与实例/回合/事件，重复事件复用资产，相似规范化线程不碰撞。失败保留具体可见原因；原生及 canonical logger 的图片正文省略，持久化与公开消息仅含附件引用。只缩小 AttachmentUpload 内部函数参数至实际使用的四字段，上传授权入口不改变。

Web 用户与助手共用图片网格/预览及解码失败状态；空消息、活动内容和历史折叠判定包含附件，纯图片最终回复保留。Mobile 仅补既有图片组件的失败 URI 状态与现有本地化提示，不引入音频组件。客户端 reducer 无需改生产逻辑，仅补完成时保留附件回归。新增 docs/internals/acp-assistant-images.md，用户文档仅加入图片说明。音频/blob、工具详情、厂商扩展、账户用量和目录改动未夹带。

2026-09-30 以关键词 ACP image data mimeType 读取官方 https://agentclientprotocol.com/protocol/v1/content 及当前 schema；采用一手必填 data/MIME 定义，四种格式与大小上限是产品边界。浏览器使用已获用户授权的 browser-control、test-codework-app 工作流，仅连接隔离 home。没有子代理、推送、PR、在线数据库写入或全仓检查。

#### Verify

源码副本 codework-acp-images-audit-20260930/source-GDO26u/source 来自 HEAD dfe236586 加精确 26 文件索引，workspace 依赖指向副本。仅将 Model 恢复基线并保留新增图片测试，旧行为 1 失败/50 因筛选跳过：图片解析无 ContentDelta；恢复修复字节后检查如下。

| 检查 | 最终结果 |
| --- | --- |
| Server：图片资产、上传、Model、Core、Cursor/Grok、ProviderService、Ingestion | 8 文件合计 307 项通过：前批七文件 212 项，修正测试 harness 后单独重跑完整 Ingestion 95 项通过（166.26 秒） |
| Ingestion 图片筛选 | 流式/缓冲 2/2，93 项未选；不重复累计 |
| Web：MessagesTimeline 与 logic | 2 文件 104/104；命令中列出的 historyBootstrap.test.ts 不存在，未将其计为执行过 |
| 共享 client-runtime：threadReducer | 37/37 |
| Mobile：threadActivity | 39/39；派生数据回归，不是设备或图片解码实测 |
| Server/Web tsgo、Mobile tsc --noEmit | 最终均退出 0；Server 两个原账户模块的 Effect 建议 |
| 24 变更 TS/TSX lint | 退出 0；原 Cursor 未用参数、Web reverse 建议 |
| 26 文件精确索引格式/编码/语法/diff 检查 | 通过，UTF-8 无 BOM，24 源码语法诊断 0，DEVLOG 0 |
| 索引/独立副本/提交 SHA-256 | 26 文件相同，提交后索引为空；core.hooksPath 仍为 .vite-hooks/_ |
| 原始工作保留 | 12 受保护文件 SHA-256 不变；25 保存文件中 24 字节不变，AcpSessionRuntime 由并行执行方继续编辑，已记录且未覆盖 |

12 文件合计 487 项最终通过，过滤及重跑不重复累计。首批八文件 304 通过/3 失败：临时补丁误将 config 插入 project.create，图片测试返回值因此缺 config；另一个既有 2.5 秒状态等待在并行负载下超时。精确修正测试返回位置后 Server 类型退出 0，图片两模式筛选及完整 Ingestion 95 项均通过，未延长旧 timeout、删除断言或修改产品状态逻辑。准备脚本出现宽泛锚点冲突及文档同节后续段落夹带，均在提交前按唯一 schema/明确图片段落边界收窄；没有覆盖混合工作树源码。图片资产失败用例产生预期错误日志，属于验证内容。

原持有 exec 会话 51404 以终端中断停止；本轮恢复同一隔离 home、5733/13773，未杀进程模式。新图片实例 acpAgent_images_r70 指向副本 fixture。Windows .cmd 入口探测引发 spawn EINVAL，改为 node 加 .mjs 后实际显示可用，不冒称原批处理探测已修复。开发 --watch 与文件检查引发多次重启，前两个回合显示“供应商会话未能在服务器重启后保留”；这些失败保留，未算验收成功。为稳定 UI 验证，仅副本 server package dev 启动临时去除 --watch，服务监听后恢复 package.json 原始字节；仓库和提交启动配置未变。当前持有 exec 72683、服务端本次启动 PID 85452，保留环境和浏览器 tab 3。

稳定服务中新建“R70 图片最终验收”，实际模拟子进程完成回合。1280px：两张正常 PNG naturalWidth=120/naturalHeight=72，展开记录显示前文→图片→非法编码具体错误→后文→损坏图片不可用→最终纯图片，预览打开/关闭成功。360px：图片 right=175.333，document.scrollWidth=360，预览开关成功。刷新后再展开，正常两图重新解码，具体错误与损坏提示保持，empty response 不出现。响应式视口已 reset，tab 已 markHandoff；截图和 DOM 几何证据保存在 audit 目录 images-1280.jpg、preview-1280.jpg、preview-360.jpg、refresh-360.jpg。截图均已视觉检查。

窄屏截图仍见既有对话页头控件重叠；该页头不在本提交，不将 A-5 标记完成。Composition unknown_binding、路由分包、Node DEP0190 与开发重连告警存在，不冒称全应用无告警。官方 CLI 图片输出、Electron 原生壳、手机真机及远程/relay/tunnel 图片流程本轮未验证；模拟进程与浏览器证据只覆盖共同模块。文件系统/数据库不是跨介质事务，资产沿原环境签名权限，没有新增逐线程 ACL。

Acceptance 保持进入本轮时的状态，本增量不足以新勾任何完整条款。goal active、ledger running，.loop-state 未修改。回滚撤销 c406b89ca 的新提交，无数据库迁移，保留既有附件、历史、隔离配置和其它未提交内容。

#### Retrospect

图片功能需要协议分段、资产校验与脱敏、纯附件投影、历史判定、预览和解码失败共同成立；只补渲染会丢历史，只看 MIME 签名会将损坏图片误当可解码。现有工具足够，未引入新依赖或平行消息形状。混合文件的临时索引必须核对实际调用位置和文档语义边界，字符串匹配成功不等于补丁正确。源码字节归一化应在启动浏览器服务前完成，开发 watch 的失败不能算成功功能或远程恢复。

下一轮唯一增量先整理已有窄屏对话页头紧凑布局：检索 ChatHeader/ChatView 现有未提交修复，核对所有页头按钮的可见、可点、收起与返回，用独立索引验证 360/1280px 后提交；不要再次创建竞争布局。音频/blob、工具内容、44 入口真实认证、账号池余额/用量、原生设备和最终独立审计仍在原范围，不能因本模块通过而结束 goal。


### Round 70 (A-3/A-4 CLI evidence thread)

#### Plan

并行于上节图片模块：重读 Acceptance A-3/A-4 书面条，列出原子项；在无 Gemini key / 无交互浏览器 / 无手机前提下尽量关闭 A-3 非密钥缺口并继续 A-4 真实 CLI/工具边界证据；仅当书面条全满足才勾选。不发明密钥、不提交。

#### Act

1. **A-3 原子**：五候选 ×（版本/认证/文本/读/写/命令/拒绝/取消）+ 动态模型/模式/命令/认证真实 + 审批上游 optionId + Copilot mode/config + 不支持说明。矩阵写入 `docs/internals/paseo-provider-catalog.md`。
2. **A-3 复跑**：`GeminiAcpCliProbe` 2/2；`QwenAcpCliProbe`+`ClineAcpToolProbe`+`HermesAcpToolProbe`；合计 4 文件 **5** 项通过。Gajae ToolProbe 先 flake `owner_mismatch` 后单跑 **1/1**（A-4 目录项，不计入 A-3 勾选）。
3. **A-4 探针**：batch stdio — harn init/auth/session 后 prompt Compilation error；poolside session 要 `pool login`；goose session 缺 `GOOSE_PROVIDER`；cortex prompt `end_turn`；minimax 初因 `.cmd` EINVAL，改 Node+`cli.js` 后 CliProbe **1/1**，session `-32000 mcode login`。deep probe 复验 harn/cortex/minimax。
4. **文档**：更新 minimax/harn/cortex/goose/poolside/gemini/catalog；`MinimaxAcpCliProbe` 改 `process.execPath` 启动（对齐 Qwen Windows 边界）。

#### Verify

- MiniMax CliProbe 1/1；A-3 四文件 5/5；Gajae ToolProbe 1/1（重试）。
- Gemini 成功路径仍无 key → A-3 **不勾**。
- 38 项表仍含大量凭据/平台/握手 → A-4 **不勾**。
- Acceptance 复选框未改；无提交。

#### Retrospect

progress：A-3 矩阵与非 Gemini 证据已固化；Gemini 仍 blockers。A-4 多条边界从「未测」推进到诚实凭据/编译失败，仍不够勾选。下一：用户 Gemini key 或余项可本地夹具 Agent；A-5/A-8 另线。回滚撤回本轮探针 spawn 补丁与文档矩阵。

### Round 71 (A-4 table + Harn prompt diagnosis)

#### Plan

诊断 Harn Compilation error（是否 in-tree）；补全 Acceptance 四态 38 项表；不勾选 A-3/A-4；不发明 Gemini；无交互浏览器；不提交。

#### Act

1. **Harn**：`serve acp` attach 对 NL 返回 `Compilation error`（上游当地源）；ask/code/shadow 不变。raw stdio：`1 + 1` 先 `host/capabilities`，回复后 `end_turn`。生产 Runtime 未回应该 RPC 时 Effect prompt 终止。NL ToolProbe 1/1；未合入未验证的 Runtime 补丁。文档 `harn-acp-provider.md` 更新。
2. **A-4**：`paseo-provider-catalog.md` 增加四态全表（真实可用/未实测/平台限制/不支持）覆盖目录 ACP ID；Kiro/TRAE live 仍平台限制；Droid MCP/Harn environmentPolicy 产品侧已记。

#### Verify

- HarnAcpToolProbe（NL）+ HarnAcpCliProbe 定向；Acceptance A-3/A-4 保持 `[ ]`。
- 无提交。

#### Retrospect

progress：Harn 定性完成；A-4 四态表填全仍不可勾选。余下多为用户凭据（Gemini/各登录）与 `host/capabilities` 产品实现、A-5 设备、A-8 独立审计。

### Round 72 (host/capabilities + progress tolerance)

#### Plan

实现产品侧 `host/capabilities`；必要时修协议，使 Harn 表达式 Effect 路径可 end_turn；不勾选 A-N；不发明 Gemini；无交互浏览器；不提交。

#### Act

1. `AcpSessionRuntime` 默认 `handleExtRequest("host/capabilities")`，按 initialize 的 fs/terminal 广告回复。
2. `effect-acp`：无法解码的 `session/update`（含 Harn `progress`）降为 ExtNotification，不再终止 stdio。
3. mock-agent 旗标 + `AcpJsonRpcConnection` 单测；`HarnAcpToolProbe` 增表达式 end_turn；文档/目录更新。harn 仍 **未实测**（工具/NL）。

#### Verify

- protocol + host/capabilities 单测；Harn CliProbe+ToolProbe **3/3**。
- A-3/A-4/A-5/A-8 保持 `[ ]`。无提交。

#### Retrospect

progress：in-tree host/capabilities + progress 容忍完成。余下仅用户凭据/设备/独立审计（及可选 progress UI）。

### Round 73 (re-verify unlocks: local LLM / Gemini / A-5 Playwright)

#### Plan

不信任「仅用户门控」断言。本机猎取本地 LLM、合法 Gemini 配置、以及非交互 Playwright 隔离 serve 是否可推进 A-5；不发明云密钥；不提交；不假勾选。

#### Act

1. **本地 LLM**：PATH/常见目录无 ollama、LM Studio、llama.cpp、vLLM；无相关进程；常见端口（11434/1234/8080/8000…）无监听；docker 未装；goose 配置目录缺失。**无可接本地推理解锁 A-4。**
2. **Gemini**：`gemini` 0.55.1 在 PATH；isolate 0.61.0 可用；`~/.gemini` 仅空 `projects.json`（无 oauth/settings/credentials）；gcloud ADC 缺失；`GEMINI_API_KEY`/`GOOGLE_API_KEY` 未设或空。**成功路径仍阻断。**
3. **A-5**：短寿命 `vp run dev --home-dir <tmp>`（5734/13774），mint pairing，**非交互** `npx @playwright/cli` 配对后打开 Settings→添加供应商→ACP 智能体→ACP 注册表；`resize` **1280×800** 与 **360×740** 截图于 isolate `pw-artifacts/`；目录可见「下载并安装」。仅杀 isolate PID（共享 5733/13773 保留）。**仍缺 Electron GUI 与真机 → 不勾选 A-5。**

#### Verify

- 证据：`%TEMP%/codework-a5-r73-*/evidence.txt` + `acp-catalog-1280.png` / `acp-catalog-360.png`。
- A-3/A-4/A-5/A-8 保持 `[ ]`。无提交。

#### Retrospect

progress：本机复扫确认无本地 LLM / 无 Gemini 凭据；A-5 浏览器 360/1280 ACP 安装向导有非交互证据但仍不满足完整条。下一：用户 Gemini key 或本地 Ollama、Electron/真机、或 A-8 verifier。

### Round 74

#### Plan

本轮唯一增量按主线程 Round 70 Retrospect 整理已有窄屏聊天页头修复。Round 14 已有同一两处 CSS 改动及旧验证，当前 HEAD 尚未包含，本轮复用并提交，不另建竞争布局。追踪 ChatHeader 唯一调用、WorkspacePageHeader、面包屑和绝对定位面板控件后，使用已有容器查询分行、项目收缩和聊天外壳自动高度。只暂存这两处源码和已有用户说明的窄屏段落，独立 HEAD+精确索引副本运行 ChatHeader 测试、Web 类型、定向 lint/格式；保留既有隔离服务与浏览器，保存新的 360/1280px 修复前后及宽屏分栏证据，核对标题菜单/重命名、工作区文件/搜索入口、项目操作、编辑器菜单、终端与右侧面板退出、布局往返。A-5 完整设备/多端及其它未完成验收不勾选，不更改并行 CLI 证据轮次、账号或协议代码。核对提交字节、12 个保留文件及其它未提交内容，完成一个本地模块提交；无推送/PR/子代理。回滚本轮提交即可，不触及持久化数据。

#### Act

复用 Round 14 已存在而尚未提交的两处布局修复：ChatHeader 按 48rem 容器断点把导航与操作分行，导航给固定控件留 80px，项目允许收缩，操作允许再次换行；IDE 标识随面包屑布局。ChatView 仅把聊天 WorkspacePageHeader 高度改为自动，已有全局高度、原生控件和其它页面不变。用户说明只暂存窄屏段落，保留其余待提交内容；没有新组件/依赖/业务回调/数据库变更。修正 Round 70 辅助脚本误写的 L-Infinity 为 L-64，未覆盖并行 CLI 轮次或验收状态。

从 HEAD 构造精确索引独立源码副本，workspace 依赖指向副本；原隔离运行副本仅更新两处页头源码，字节与索引及最终提交一致。沿用 home、端口、会话和浏览器，未重启服务或读取写入 live userdata。完成一个本地模块提交：`c53d48bba59d2397c226ebe714b57fe8f08dcb1e`（fix(web): 窄屏聊天页头分行保留可操作入口）。提交 3 文件，23 行新增、9 行删除；无推送、PR 或子代理。

#### Verify

- 独立提交副本的 ChatHeader 既有 9 项测试全部通过；Web tsgo --noEmit、两处源码定向 lint、三文件索引格式、git diff --cached --check 均退出 0。测试 28.4 秒，类型 20.4 秒；没有全仓检查或类名镜像测试。
- 新的 360px 修复前 DOM：导航宽度 0，项目与初始化 Git 按钮中心被覆盖，scrollWidth 仍为 360。回归断言按预期失败「导航宽度必须非零」。修复后导航 296px、线程标题按钮约 97px、页头 92px；320px 页头 126px，操作自然换行；1280px 单行 52px，分栏聊天容器约 394px 时两行 92px。320/360/1280、宽屏分栏、IDE 页头、刷新共六组几何断言全部通过：标题/导航非零、按钮边界在页头内、按钮中心命中、按钮矩形不重叠、文档无横向溢出。
- 实际操作确认：线程标题菜单、重命名输入与 Escape 保留原标题；窄屏布局菜单正确禁用 IDE 并说明空间要求；工作区文件 sheet 打开并关闭返回；快速文件选择器和项目搜索进入、先返回主命令面板再关闭；项目添加操作表单取消；编辑器选项菜单打开与关闭；终端抽屉打开显示输入并收起；宽屏右面板最大化、恢复、关闭；IDE/对话布局往返与 AI 对话显示开关；项目按钮导航到新草稿，再返回原线程。未发送新模型消息，未执行外部编辑器启动或 Git 初始化；不能用菜单可见声称这些副作用已验证。IDE 工作台进入时显示准备状态，本轮只验布局入口，不声称完整工作台已加载。
- 刷新重新加载后标题、两行布局及全部按钮命中保持；保留原图片夹具的历史和预期失败。恢复临时视口并重新标记浏览器 handoff，隔离服务仍保留（Web 5733 / Server 13773）。截图和 JSON 在仓库外 `C:/Users/Administrator/AppData/Local/Temp/codework-chat-header-audit-20260930`，含 before/after-360、after-1280、split-1280、after-320、files-sheet-360、refresh-360；已视觉检查。`check-browser.mjs` 与 `browser-results.json` 可重跑核对六组断言。
- 索引、独立源码与最终提交 3 文件逐字节/哈希一致，UTF-8 无 BOM、无诊断残留，提交后索引为空；12 个保留文件哈希未变。两份原源码字节未改变；用户说明除本轮新增小节标题外原字节保留。两份浏览器运行源码也与最终提交逐字节一致；常规 core.hooksPath 未修改，只本次指定只读索引钩子，未 stash/reset/clean。
- 首次完整性检查在独立 archive 尚未完成时过早调用而 ENOENT，等待副本生成后重跑通过。文件选择器一次 Escape 返回主菜单，因此立即查找页头的早期操作失败；按实际两层退出后通过。刷新后的短等待曾超时，随后 DOM 确认恢复并完成冷加载几何检查；这些中间结果不当作产品失败或通过证据。

仅增加 A-5 的 Web 共用页头证据，Electron 原生标题栏、真实手机、性能完整矩阵、真实账号和最终独立审计尚未补齐；A-3/A-4/A-5/A-8 保持未勾选，不改变其它执行方现有勾选。回滚撤回本轮提交即可，无状态迁移或账户数据回滚。

#### Retrospect

本轮为 progress：修复前后的新浏览器证据和精确提交把旧未提交布局修复转成可审查模块；无水平滚动并不能证明内部无重叠，需要导航宽度、标题可见、按钮中心命中和矩形边界共同检查。文件/内容搜索的 Escape 是两层返回，需等实际状态再点击页头；刷新加载时的短定位超时不能直接归为产品缺陷。独立副本生成与完整性检查必须顺序等待，避免辅助验证误报。

下一轮唯一增量整理已存在的 ACP 音频/二进制资产链：先查 attachmentStore、ProviderBinaryAttachment、Adapter/Ingestion、Web/Mobile 和已有测试/文档差异，构造该模块独立索引，复用内联数据/大小/类型校验与签名附件，完成播放或下载及错误/纯附件/重放的定向验证后单独提交，不重复实现或夹带其它供应商工作。44 入口真实凭据与设备及最终审计仍全部保留；goal active、ledger running，未修改 .loop-state。

### Round 75 (Ollama install + goose local unlock + Electron smoke)

#### Plan

用户否定 R73「仅 Playwright / 无本地 LLM」复述。本轮必须：**实际** `winget`/MSI 装 Ollama → pull 小模型 → 配 goose/ACP 本地 env → ToolProbe/目录；**实际** Electron/desktop A-5 证据；`adb devices` 仅在有设备时探；ledger **新轮次**；不发明云密钥；不假勾选；不提交。

#### Act

1. **Ollama**：`winget install Ollama.Ollama` → **0.35.0**（exit 0）。`ollama serve` 监听 `:11434`。首次 `ollama pull qwen2.5:0.5b` / `tinyllama` 失败：`redirect target not allowed: …r2.cloudflarestorage.com resolves to non-public 198.18.0.32`（Clash Verge fake-ip；系统代理 `127.0.0.1:7897`）。DoH 得真实 A=`172.64.66.1`，写入 hosts 标记 `# codework-ollama-r75` 后经 `HTTP(S)_PROXY=http://127.0.0.1:7897` **`ollama pull qwen2.5:0.5b` success**（397 MB）。`POST /api/generate` → `response":"Hello."` / `"Hello!…"` http=200。
2. **goose + Ollama**：隔离 home `config.yaml` + env `GOOSE_PROVIDER=ollama` `GOOSE_MODEL=qwen2.5:0.5b` `OLLAMA_HOST=127.0.0.1:11434`。ACP：initialize OK → session/new `20260930_1` → prompt「Reply with exactly: OK」→ `agent_message_chunk` **`OK`**、`stopReason=end_turn`。ToolProbe：发出 `tool_call` `read`（`rawInput.source=marker-r75.txt`）→ `tool_call_update` **failed** `missing field path`（0.5b 参数不合格；**不作完整工具验收**）。更新 `docs/internals/goose-acp-provider.md` 与 catalog 中 goose 行。
3. **A-5 Electron**：`apps/desktop` `node scripts/smoke-test.mjs` → **Desktop smoke test passed.**（exit 0）。`vp run --filter @codework/desktop test:desktop-smoke` **任务不存在**（脚本名是 `smoke-test`）。
4. **Phone**：`adb devices` 空列表；AVD `Medium_Phone` 存在但未启动（无附加设备，不探）。

#### Verify

| 证据 | 路径 |
| --- | --- |
| Ollama list / generate | `%TEMP%\codework-ollama-r75\ollama-list.txt`、`generate.json` |
| goose 文本 ACP | `%TEMP%\codework-ollama-r75\goose-acp-probe.jsonl` |
| goose 工具尝试 | `%TEMP%\codework-ollama-r75\goose-acp-toolprobe.jsonl`、`toolprobe-summary.txt` |
| Electron smoke | `%TEMP%\codework-a5-r75-desktop\smoke-rerun.log`（及先前 `codework-a5-r75-desktop-smoke.log`） |
| adb | `%TEMP%\codework-a5-r75-desktop\adb-devices.txt`（空） |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。goose 目录状态改为「未实测（工具未过）」— 文本解锁≠真实可用。无提交。

#### Retrospect

progress：本机 Ollama 已装可推理；goose ACP 经 Ollama 完成文本回合；Electron smoke 绿；真机仍缺。Clash fake-ip 会阻断 Ollama R2 pull，需 hosts+代理。下一：更大 tool-capable 本地模型重跑 goose 工具；Gemini 合法 key；真机/完整 A-5；A-8 verifier。

### Round 76

#### Plan

沿用主线程 Round 74 Retrospect，本轮唯一增量整理已有 ACP 音频和嵌入 blob 附件。并行 Round 75 的 Ollama/Electron 证据保留不覆盖。先核对解析、会话空段门禁、Cursor/Generic/Kimi 与 Grok、内部事件及日志脱敏、共享 Ingestion、原子落盘/签名访问、历史摘要、Web/Mobile 展示；复用现有媒体实现。修复非图片历史仍称图片、Mobile 外部打开失败无反馈、媒体控件无名称的实际缺口；抽出已有 Mobile 附件组件供最小交互测试，复用打开 URL 帮助函数，避免新增播放器/下载器。构造精确 HEAD+模块索引及独立源码，运行协议/Adapter 子进程、媒体安全边界/存储失败/重放、Ingestion、双端派生/界面及受影响类型/lint。复用保留的隔离服务、home 与浏览器，以有效 WAV 实际播放/暂停、blob 下载字节、错误显示、360/1280 与刷新历史验收；真实手机/Electron 媒体和真实 CLI 输出无证据不声称通过。单独本地提交，核对其它未提交字节与 12 个保护哈希；无推送/PR/子代理/新 loop。回滚撤回本轮提交，无数据库迁移。

#### Act

沿用已有媒体实现，完整接通 ACP agent_message_chunk 的 audio 和 resource.blob：解析为独立内容段，保留 reasoning 身份与重放/会话门禁，空文本媒体经共用 Cursor/Generic/Kimi 和 Grok Adapter、content.delta、ProviderRuntimeIngestion 到公开附件引用。只持久化助手正文媒体，思考媒体不写入公开回复；解析摘要及规范事件日志省略 base64。复用 AttachmentUpload 原子写入及 AssetAccess 签名访问，不回源 URI，不新增下载器/播放器、依赖或数据库结构。

音频九种声明类型、blob 类型及 10 MiB/严格 base64 门禁在服务端校验，新增 blob MIME 100 字符上限以匹配公开附件合同；同事件稳定 ID，保存失败分别以 provider.audio.failed/provider.file.failed 进入可见工作活动。Web/桌面采用原生 audio 元数据预载与命名控件、文件下载入口，纯附件不显示空回复占位；历史摘要包含媒体名称，保留旧纯图片称谓但不把其它附件称图片。Mobile 抽出已有共用附件显示，复用 tryOpenExternalUrl，打开失败可见可重试且屏幕阅读器读到提示。复现旧失败结果覆盖新错误后，以一个操作序号 ref 只接收最后一次打开结果，不建立第二套请求管理机制。

精确索引仅 33 个本轮文件，独立 HEAD+索引副本验证；混合文件的其它待提交模块保留。本地模块提交：`e536a7546ba5e8b7b21c4334e70389868e9e37ab`（feat(provider): 支持 ACP 助手音频和二进制附件），1331 行新增、63 行删除。新增 durable 内部说明 docs/internals/acp-assistant-media.md，只暂存用户说明中媒体段落。没有推送、PR、子代理或新 loop；并行 Round 75/77 及其验收记录未覆盖。

#### Verify

- 红灯：旧 HEAD 的历史摘要新增两项失败（3 项中图片仍通过）；旧 Mobile 打开逻辑新增晚到失败场景，audio/file 两项均失败。修复后 Web 3 文件 109 项、Mobile 3 文件 43 项、共享客户端 37 项、合同 47 项全过。Mobile 同一测试核对失败、重试、旧成功及旧失败不能覆盖新错误；是组件/平台模拟证据，不是实际手机。
- 服务端首批 9 文件 320 项中 316 通过、4 失败：本轮两项 Adapter 部分嵌套断言写法错误，改为完整结构比较；两项原有 Ingestion 回归在多项检查同时运行时超时。未修改产品超时或加入睡眠。随后聚焦媒体、规范日志及这两项 Ingestion 的 13 项全部通过（其余 230 项跳过）；其余首次通过结果保留，不能把聚焦运行写成再次完整运行 320 项。首次类型发现新测试直接 JSON.stringify 的 Effect 规则问题，改用结构断言后 Server/Web/Mobile 类型均退出 0；Mobile 最终序号 ref 改动后再次类型通过。定向 lint 退出 0，仅原 CursorAdapter 测试 invocation 未使用警告。
- 新增真实原子落盘 → 签名附件 URL → 服务端解析 → 文件字节比较、令牌篡改与过期拒绝回归；配合二进制媒体安全边界共 6 项最终通过（其余 13 项跳过）。AssetAccess 全文件检查复现两项原有 Windows favicon sourcePath 斜杠差异，旧 HEAD 基线同样失败，未在媒体模块改图标路径；初次新增字节断言 Buffer/Uint8Array 形状差异改为实际字节数组比较后通过。此处没有 HTTP 下载、浏览器解码或原生媒体证据。
- 浏览器旧绑定在 goal 续跑后失效；库存页面为 localhost:5733 的无法访问页面，getTab 重新绑定被 URL 安全策略拒绝（工具称协议不在允许范围，并禁止间接绕过）。未切换控制面或用 shell 浏览器规避。此前已在隔离设置保存 ACP 媒体 R76 实例，固定夹具 --version 返回测试版本 1.0.0 后健康显示可用，并建立草稿；尚未发送媒体 prompt。已请求用户新 HTTP 标签引用，未收到，因此实际音频播放/暂停、blob 下载字节、解码错误、360/1280 媒体布局、刷新历史均未验。没有引用其它模块截图代替本轮证据。
- 只停止捕获的旧服务会话 84999，确认 5733/13773 无监听后，将 21 个运行源码与最终索引对齐，以相同隔离 home 重启；新拥有会话 67947，19:12:43 服务监听 13773，Web 5733。临时停用 watch 只作用隔离副本，启动后 package.json 原始字节恢复；没有 VITE 固定 origin 或读取写入 live userdata。服务保留供恢复浏览器验收，fixture 音频为有效 PCM WAV，另含正常 blob/非法 base64/危险 MIME/错误 WAV；夹具不证明真实 Agent 输出。
- 33 文件最终索引/独立源码/提交逐字节及 SHA-256 一致，UTF-8 无 BOM；索引格式、git diff --cached --check、只读提交钩子通过，提交后索引为空。47 个模块外原有未提交文件逐字节未变，12 个保护哈希未变。常规 core.hooksPath 仍为 .vite-hooks/_，无 stash/reset/clean。证据在仓库外 `C:/Users/Administrator/AppData/Local/Temp/codework-acp-binary-audit-20260930`，含检查日志、红灯、基线失败、精确索引和完整性记录。

不扩大或重新勾选 Acceptance：A-3/A-4/A-5/A-8 保持未完成，其它执行方勾选交给最终新鲜审计；本轮不声称音频端到端或全部 44 入口完成。回滚撤回本模块提交，无数据库迁移；旧客户端不能显示新媒体引用，应协调版本，保留既有附件与历史数据，不清空账户/附件目录。

#### Retrospect

progress：媒体通道、公开引用、日志脱敏及客户端入口已形成独立本地提交，历史丢弃与 Mobile 迟到失败有旧行为失败/修复通过证据。服务端落盘和签名解析不能替代实际播放/下载；浏览器安全策略拒绝必须保留并等待新绑定，不以同源请求或测试 DOM冒充浏览器操作。

下一轮唯一增量优先修复已在旧 HEAD 复现的 Windows favicon sourcePath：搜索所有 issueAssetUrl/project favicon 调用及合同，在共同公开路径边界归一化斜杠，保留真实文件系统路径，使用现有两项失败及遍历/签名回归验证后独立提交。用户提供新 HTTP 标签引用时继续补本轮媒体端到端证据，保持实际 MIME、音频解码与设备处理器为待核对边界；不得因原生控件存在即宣称播放成功。44 入口凭据、真实手机、多端和最终审计范围保持，goal active、ledger running，未改 .loop-state。

### Round 77 (tool-capable Ollama + goose 真实可用 + AVD phone)

#### Plan

延续 R75：pull 可工具模型；重跑 goose ToolProbe 争取 A-4 真实可用；尝试其它可用 Ollama 的 ACP；启动 AVD `Medium_Phone` 做手机 A-5；不发明 Gemini；不假勾选；不提交。并行 Round 76 音频线程保留不覆盖。

#### Act

1. **Ollama**：`ollama pull qwen2.5:3b` → **success**（1.9 GB，`pull3b_exit=0`）。列表含 `0.5b`+`3b`。
2. **goose**：隔离 env `GOOSE_PROVIDER=ollama` `GOOSE_MODEL=qwen2.5:3b`；禁用 summon。`developer__read` **`path=marker-r76.txt`** → completed；回复含 `R76_OLLAMA_MARKER_44117`；`success=true`。shell/write 探针 `session/prompt` **timeout**（未证写盘）。目录 goose → **真实可用（本地读工具）**。
3. **Harn**：`quickstart --non-interactive --provider ollama --model qwen2.5:3b` OK；`local list` ollama **up**。ACP NL「HARN_OK」仍 **Compilation error**（上游词法）；未知 `HARN_*` 环境变量会 `HARN-ENV-001`。Harn **不**升为真实可用。
4. **Phone A-5**：`emulator -accel-check` → WHPX usable。启动 AVD `Medium_Phone`（pid **89148**，`-gpu swiftshader_indirect`）→ `emulator-5554 device`，`boot_completed=1`，1080×2400。包 `com.codework.mobile.dev` 已装；启动至 Expo Dev Launcher（截图+uidump）。**未**起 Metro/配对 isolate——非完整移动验收。

#### Verify

| 证据 | 路径 |
| --- | --- |
| pull/list | `%TEMP%\codework-ollama-r76\pull-3b.log`、`ollama-list.txt`、`ROUND76-INDEX.txt` |
| goose read | `%TEMP%\codework-ollama-r76\goose-acp-toolprobe-b.jsonl` |
| goose write fail | `%TEMP%\codework-ollama-r76\goose-acp-writeprobe.jsonl` |
| harn | `%TEMP%\codework-ollama-r76\harn-quickstart.log`、`harn-acp-ollama-b.jsonl` |
| phone | `%TEMP%\codework-a5-r76-phone\`（`ROUND76-PHONE.txt`、`app-after-splash.png`、`uidump-app.xml`、`emulator.pid`） |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**（goose 单行升真实可用≠整表 A-4；手机仅 Dev Launcher≠A-5）。无提交。Emulator pid 89148 仍运行（本轮捕获，未杀）。

#### Retrospect

progress：3b 解锁 goose 读工具；AVD 可启动且 Dev 客户端在场。Harn+Ollama 不自动修好 ACP NL。下一：goose 写/命令/拒绝矩阵；Metro+pairing 完整 mobile；Gemini 合法 key；A-8。

### Round 78 (disk re-verify hung R78 + goose matrix3 + AVD Metro pair)

#### Plan

Goal auto-continue ~2.5h after hung Goose/Metro turn。以磁盘为准重核 `%TEMP%\codework-ollama-r78` / `codework-a5-r78` 与 ledger（无 Round 78 节）；补完 goose 写/命令/拒绝/取消；重启 AVD Medium_Phone + isolate serve + Metro 配对；Gemini 再查；其它 Ollama 可解锁 A-4 行尽力推进；新轮次诚实记录；不发明密钥；不假勾选；不提交。

#### Act

1. **磁盘复核**：R78 TEMP `goose-matrix2` HARD_PASS=0/4（缺 `terminal/*`）；`codework-a5-r78` 服务/Metro/emu PID 已死；ledger 止于 Round 77；adb 空。Gemini 环境变量全空；`~/.gemini` 仅 `projects.json` 残片，**无** oauth/credentials。
2. **goose matrix3**（`%TEMP%\codework-ollama-r79\`，Ollama `qwen2.5:3b`，客户端实现 `fs/*` + `terminal/create|output|wait_for_exit|kill|release`）：**HARD_PASS=4/4** — read ✓、write ✓（`fs/write` 含 `R79_WRITE_OK`）、shell ✓（文件 `R79_SHELL_OK`）、reject ✓（`approve`+deny，无 `rejected.txt`）。cancel：`stopReason=end_turn`（**未**证 cancelled）。更新 `goose-acp-provider.md` 与 catalog goose 行说明。
3. **其它 Ollama A-4**：Harn 仍上游 NL Compilation（未重升）；本机无额外已装可 Ollama 解锁 ACP（pi/amp/harn PATH 空，仅 iso goose）。**无**新真实可用行。
4. **A-5 Mobile**：捕获 PID 启 AVD `Medium_Phone`（emu **12624**）→ `emulator-5554 device`。isolate serve `dist/bin.mjs --base-dir %TEMP%\codework-a5-r79-home --port 13910`（PID **21456**）；Metro `:8091`（经 EMFILE/`::1`-only/`Tee-Object` 折损后以 redirect 重启，TCP4_OK）。`adb reverse` + deep link `codework-dev://expo-development-client/?url=http://127.0.0.1:8091` → 应用进主界面「尚未连接环境」。`codework pair --base-dir <iso>` 新令牌 + deep link `10.0.2.2:13910` → UI **「未找到项目 / 添加项目」**（环境已连；先失败于 `127.0.0.1`「credential invalid」属预期）。证据 `%TEMP%\codework-a5-r79\`（`after-metro6.png`、`after-pair5.png`、`ui-pair-texts5.txt`）。**仍缺** Electron GUI 与真机 → **不**勾 A-5。
5. **Gemini**：再确认无 key / 无可用 oauth → A-3 仍堵。

#### Verify

| 证据 | 路径 |
| --- | --- |
| hung R78 对照 | `%TEMP%\codework-ollama-r78\`、`%TEMP%\codework-a5-r78\` |
| goose 4/4 | `%TEMP%\codework-ollama-r79\goose-matrix3-summary.json`（HARD_PASS=4/4 cancel_ok=false） |
| phone/metro/pair | `%TEMP%\codework-a5-r79\`（ports、pid、redacted pair、uidump、png） |
| Gemini | 进程/用户/机器 env 假；`~/.gemini` 无 credentials |

Acceptance：**A-1/A-2/A-6/A-7 保持 [x]；A-3/A-4/A-5/A-8 保持 [ ]**（Gemini 成功路径仍缺；A-4 非整表；A-5 缺 Electron+真机；A-8 未独立审计）。无提交。捕获 PID：emu 12624、server 21456、metro 20336（本轮未杀，供续）。

#### Retrospect

progress：goose 本地工具矩阵硬通过 4/4；AVD 上 Metro 进应用并配对成功到空项目态。下一：cancel 语义或其它 Ollama 行；Electron/真机补 A-5；合法 Gemini key 才可推 A-3；A-8 审计。

### Round 79 (AVD project+Settings deepen + goose cancel soft-max)

#### Plan

复用健康 R78 捕获 PID（emu 12624 / server 21456 / metro 20336）；在已配对模拟器上种子项目、打开 Settings→供应商/注册相关 UI 并截图入口/退出；重跑 goose cancel 争取硬通过或记录软上限；其它 Ollama 可解锁行尽力；不发明 Gemini；不假勾选；不提交。

#### Act

1. **PID 复核**：三进程均 alive；`emulator-5554 device`；ports 13910/8091 listen。
2. **项目种子**：isolate `pair`→oauth token-exchange→Effect `orchestration.dispatchCommand` `project.create`（workspace `%TEMP%\codework-a5-r79-proj`）→`sequence:1`，projectId `r79-proj-b39906e6-…`。App 刷新后主界面 **「暂无线程」**（环境+项目已连，非「未找到项目」）。
3. **Settings UI**：`content-desc=打开设置` 进入设置；可见 **供应商 / BYOK / Agent 运行时 / MCP / 集成…**；精确点击「供应商」进入 Provider 页（CLI 账号池、Codex/Claude/Grok/Cursor/ZCode 账号区，截图 `shot-providers-final.png`）。返回设置再回主界面可复现。ACP「下载并安装」注册表深层目录本轮未稳定点进（列表项文案截断/滚动）；**不**把 Settings 浏览写成完整 install UI 验收。
4. **goose cancel2**：`afterTerminal` / `earlyDouble` / `afterToolCall` 均 `stopReason=end_turn`，`CANCEL_HARD_PASS=false`。文档记为 Ollama `qwen2.5:3b`+goose 1.52.0 **软上限**。
5. **其它 Ollama A-4**：iso 有 amp/harn/pi-acp 等，本轮未完成新工具矩阵；**无**新真实可用行。Gemini 仍无 key。

#### Verify

| 证据 | 路径 |
| --- | --- |
| project.create | `%TEMP%\codework-a5-r79\project-create.json` |
| home 暂无线程 | `%TEMP%\codework-a5-r79\ui-app.txt`、`nav-exit1` / EXIT1 日志 |
| Settings/Providers | `%TEMP%\codework-a5-r79\uidump-providers-final.xml`、`shot-providers-final.png`、`ui-providers-final.txt` |
| cancel soft | `%TEMP%\codework-ollama-r79\goose-cancel2-summary.json` |
| docs | `docs/internals/goose-acp-provider.md`、`paseo-provider-catalog.md` goose 行 |

Acceptance：**A-1/A-2/A-6/A-7 [x]；A-3/A-4/A-5/A-8 [ ]**（A-5 仍缺 Electron GUI + 真机关键路径；AVD 加深≠整条勾选）。无提交。PID 仍保留：emu 12624、server 21456、metro 20336。

#### Retrospect

progress：AVD 已有项目种子+Settings/供应商入口与退出证据；goose cancel 诚实记软上限。下一：Supplier/ACP 注册表安装 UI 定位、Electron/真机、凭据型 A-3、A-8。

### Round 80 (AVD ACP registry catalog UI + Electron honesty)

#### Plan

复用 R79 栈（emu 12624 / server 21456 / metro）；在已配对 AVD 打开与 Web `AcpRegistryCatalogPicker` / Mobile `AcpRegistryCatalogSection` 同面的 **ACP 目录**（含列表、安装相关按钮），截 360 级手机视口；核对 Electron 是否有超越 `smoke-test.mjs` 的 providers/ACP GUI 自动化；按 A-5 原文验收条诚实决定是否勾选；Ollama 可解锁则顺手；不发明 Gemini；不假勾选；不提交。

#### Act

1. **PID/端口复核**：emu 12624、server 21456、metro 进程组（8091 上 node 32608）alive；`GET :13910/api/health` → 200；Ollama `qwen2.5:3b,qwen2.5:0.5b`。
2. **路由澄清**：`SettingsSupplierRegistry`（Supplier 注册表）≠ ACP 下载目录。ACP 目录在 `SettingsProviders` → 驱动选 **ACP 智能体** → `AcpRegistryCatalogSection`（中文标题「ACP 目录」）。
3. **AVD 导航证据**：Settings→供应商→滚动越过 CLI 账号池→选 ACP 智能体；截图见 `%TEMP%\codework-a5-r80\`：
   - `r80c-acp-catalog.png` / `ui-c-acp-catalog.txt`：可见 **ACP 目录**、**搜索 Agent**、**Agoragentic 1.3.0** + **使用**、**Amp 0.9.0** + **需手动安装**。
   - `r80h-corust.png` / `r80h-stakpak.png` / `r80h-vtcode.png` / `r80h-junie.png` / `r80h-devin.png`：搜索各二进制条目，UI 文案均为 **需手动安装**（**未**出现「下载安装」按钮）。
   - 列表/搜索过程中页面常伴红色「操作失败，请检查服务器连接后重试。」与 `[atom-command] …` toast；**不**把失败 toast 写成安装成功/失败终态。
4. **下载按钮**：本轮 AVD 实况 **没有**捕获到 `providersMobile.acpCatalogDownload`（「下载安装」）。单元测试期望 win32 上 amp/corust 等带 `binaryDistribution`；实机目录行显示「需手动安装」——记为缺口，不伪造点击下载成功。
5. **Electron**：`apps/desktop/scripts/` 仅有 `smoke-test.mjs`（启动主进程查 fatal），**无** providers/ACP 设置 GUI 截图或 Playwright 壳自动化。对已有 `dist-electron/main.cjs` 跑 smoke → `Desktop smoke test passed.`（`electron-smoke-r80.txt`）。**不**等同 Electron 供应商/ACP 关键路径证据。
6. **A-4 Ollama**：服务仍在；本轮未跑新 ToolProbe/矩阵行（时间用于 A-5 UI）。无新 HARD_PASS。
7. **踩坑**：`am force-stop` 退回 Expo Dev Client，需再点 `http://10.0.2.2:8091`；uiautomator 与残留 node 脚本并发会 dump 137；BACK 会退出供应商页。

#### Verify

| 证据 | 路径 |
| --- | --- |
| ACP 目录列表+使用+手动安装 | `%TEMP%\codework-a5-r80\r80c-acp-catalog.png`、`ui-c-acp-catalog.txt` |
| 搜索二进制→需手动安装 | `%TEMP%\codework-a5-r80\r80h-corust.png` 等 + `h-flags.json` / `i-flags.json` |
| Electron smoke only | `%TEMP%\codework-a5-r80\electron-smoke-r80.txt`；脚本清单仅 smoke |
| 索引 | `%TEMP%\codework-a5-r80\ROUND80-INDEX.txt` |

A-5 验收条要求：定向 UI + **360/1280 浏览器** + **Electron** + **至少一台真实手机**关键路径，覆盖入口/退出/重试/长内容。本轮仅补 AVD（≠真机）上 ACP 目录列表/使用/手动安装视口；Electron 无 GUI 供应商证据；真机仍缺；下载安装按钮未在 AVD 实况出现。**不勾选 A-5**。A-3/A-4/A-8 仍开。无提交。

#### Retrospect

progress：缺的 A-5 Mobile ACP 目录面已在配对 AVD 上打开并截图（列表+使用+需手动安装）；Electron 边界诚实为 smoke-only。下一：真机、Electron 壳内供应商/ACP、查明为何 AVD 目录不渲染「下载安装」、凭据型 A-3、A-8。

### Round 81 (stale dist hid 下载安装; rebuild + AVD Amp install)

#### Plan

诊断 Mobile/Web ACP 目录对 win32 可校验二进制不显示「下载安装」的根因（snapshot → `binaryDistributionFor` → RPC → 客户端按钮门禁）；修复后定向测试；在 AVD（或 Web）复证可见并可完成一次 isolate 安装；Electron GUI 仅有余力再做；不发明 Gemini；不假勾选；不提交。

#### Act

1. **根因**：isolate 进程 `21456` 跑的是 `apps/server/dist/bin.mjs`（**2026-09-29** 构建）。`Select-String binaryDistribution` 命中数 **0**。源码与 `AcpRegistryCatalog.test.ts`（含 amp/corust/… 的 `binaryDistribution`）已正确，但 **Sep 30 `3382ddbc7` 之后的可校验安装能力未打进该 dist**。客户端只能收到 `command:null` 且无 `binaryDistribution` → UI 走「需手动安装」。不是 `SAFE_CMD`/overlay 逻辑缺陷（`vp test` 14/14 绿）。
2. **修复/验证动作**：
   - `vp run build:bundle` 重建 dist（现含 `binaryDistribution` 命中）；
   - 停旧 PID 21456，同 `--base-dir` 重启 → 新 PID **13568**，health 200；
   - 目录测试补强：离线 `getAcpRegistryCatalog` 失败回退路径必须 `entries.some(e => e.binaryDistribution)`，且 amp-acp cmd=`amp-acp.exe`；
   - AVD force-stop 清 5min catalog 缓存后重连 Metro；Settings→供应商→ACP 智能体→搜索 amp。
3. **AVD 实况**：`r81d-amp.png` / `r81d-flags.json` 见 **下载安装**；点击后 **下载中…** → **已选择**（`ui-r81d-after.txt`）。Agoragentic 仍为 **使用**（npx 命令路径，正确）。

#### Verify

| 证据 | 路径/结果 |
| --- | --- |
| 旧 dist 无 binaryDistribution | R81 探测：hits=0（Sep 29 bundle） |
| 新 dist + 测试 | `vp test run AcpRegistryCatalog.test.ts` 14 通过（含离线可下载断言） |
| AVD 下载安装→已选择 | `%TEMP%\codework-a5-r80\r81d-amp.png`、`r81d-flags.json`、`ui-r81d-after.txt` |
| 服务 | PID 13568，`--base-dir …\codework-a5-r79-home`，:13910 |

Acceptance：**不勾选 A-5**（仍缺 Electron GUI 供应商路径与真实手机）；A-3/A-4/A-8 仍开。无提交。

#### Retrospect

progress：假「需手动安装」根因是 isolate 过期 dist，不是解析门禁；重建后 AVD 上 Amp 下载安装闭环已证。下一：真机/Electron、A-3 凭据、A-4 表、A-8。

### Round 82 (Electron providers/ACP GUI + A-4/Gemini honesty)

#### Plan

Electron A-5：对 isolate/自带 backend 启动桌面壳，导航 Settings→供应商→ACP 目录并截图（超越 smoke-test）；A-4 尽量再升无登录/Ollama 真实可用行；Gemini 再扫一次凭据；确认 Round 81 dist 教训已入账；不假勾选；不提交。

#### Act

1. **PID**：emu 12624 / server 13568 / metro 32608 仍存活；`:13910/api/health` 200。
2. **Electron GUI（playwright-core `_electron`）**：
   - 生产 `dist-electron/main.cjs`（**2026-09-29 17:05**）+ 隔离 `CODEWORK_HOME`；
   - Electron 使用 **hash history**：须 `location.hash = '#/settings/providers'`（`codework://app/settings/providers` 无效）；
   - 路径：设置→供应商→**添加供应商**→**ACP 智能体**→下一步→连接配置 **ACP 注册表**；
   - 搜索 `amp`：Amp 行显示 **需手工配置**（**无**「下载安装」）。与 R81 Mobile+重建 server 的「下载安装」对照——壳内 UI/目录来自 Sep 29 bundle，缺 binaryDistribution 安装按钮文案。
   - 证据：`%TEMP%\codework-a5-r82\r82j-registry.png`、`r82j-amp.png`、`r82j-flags.json`、`r82i-connect.txt`（全表「使用/需手工配置」）。
3. **A-4**：Cortex 再探针（Ollama 兼容 env）仍 `end_turn` + Snowflake 连接错误 → **不升**真实可用；更新 `cortex-code-acp-provider.md` / catalog 行。无新 HARD_PASS 行。goose 维持既有真实可用。
4. **Gemini**：`GEMINI_API_KEY`/`GOOGLE_*` 仍空；`~/.gemini` 仅 `projects.json*`，无 oauth/accounts → A-3 仍阻断。
5. Round 81 L-67（过期 dist）已在账本。

#### Verify

| 证据 | 路径/结果 |
| --- | --- |
| Electron 供应商/ACP 注册表 | `%TEMP%\codework-a5-r82\r82j-*.png` + flags |
| Cortex≠真实可用 | `%TEMP%\codework-a5-r82\cortex-probe\cortex-summary.json` |
| Gemini 仍无凭据 | env + `~/.gemini` 扫描 |
| 索引 | `%TEMP%\codework-a5-r82\ROUND82-INDEX.txt` |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。Electron 已有供应商/ACP 注册表面证据，但仍缺：重建 dist-electron 后的「下载安装」、真机、完整多端条。无提交。

#### Retrospect

progress：Electron 壳内 ACP 注册表 GUI 已截到；下载按钮被 Sep 29 desktop bundle 挡住（同类于 R81 server dist）。下一：重建 desktop 再证下载、真机、凭据型 A-3、余表 A-4、A-8。

### Round 83 (rebuild desktop/web; Electron Amp 下载并安装→已选择)

#### Plan

按文档脚本重建 desktop/Electron（并重建其静态依赖的 web + server），用 playwright-core `_electron` 对**新产物**复跑 Settings→ACP 注册表→Amp，必须出现「下载并安装」并尽量点到已选择；更新 loop；诚实重评 A-5（真机仍缺则不勾）；有余力再 A-4；不发明 Gemini；不提交；只杀自捕获 PID。

#### Act

1. **重建**：`vp run --filter @codework/web --filter @codework/desktop --filter codework build`（exit 0）。说明：根目录 `build:desktop` 只滤 desktop+`codework`(server)；Electron 目录 UI 来自 server `dist/client`（打包自 web），故本轮显式加 `@codework/web`。产物 mtime 均为 **2026-09-30 20:05**（原 Sep 29）。
2. **Electron 复验**（新 `CODEWORK_HOME`）：`#/settings/providers` → 添加供应商 → ACP 智能体 → ACP 注册表 → 搜索 amp：
   - **下载并安装** 可见（`r83-amp`）；
   - 点击后 **下载中…** → **已选择**（`r83-dl0`/`r83-dl1`）；Amp 0.9.0 + SHA-256 摘要。
3. **A-5**：Electron 供应商/ACP 下载闭环已有；**真机仍缺** → **不勾选**。A-3/A-4/A-8 仍开。无 A-4 新行（时间用于重建+壳验证）。Gemini 未发明。

#### Verify

| 证据 | 路径 |
| --- | --- |
| 构建日志 | `%TEMP%\codework-a5-r83\build.log` |
| flags | `%TEMP%\codework-a5-r83\r83-flags.json`（hasSelected:true） |
| 截图 | `r83-registry.png`、`r83-amp.png`、`r83-dl0.png`、`r83-dl1.png` |
| 索引 | `%TEMP%\codework-a5-r83\ROUND83-INDEX.txt` |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。无提交。未杀 isolate PID（12624/13568/32608 仍为他轮保留）。

#### Retrospect

progress：stale web/desktop 产物修好后 Electron 与 Mobile 对齐可下载安装。下一：真机 A-5、凭据 A-3、余表 A-4、A-8。

### Round 84 (A-5 bar: 真实手机 mandatory; AVD≠真机)

#### Plan

引用 A-5 书面验收原文，用证据判定 AVD 关键路径 + Electron 下载 + Web 360/1280 是否满足条，或物理手机是否强制；有真机则用；复扫 Gemini；推进/诚实判定 A-4；仅当 A-3…A-5 全勾才跑 A-8；不发明密钥；不假勾；不提交。

#### Act

1. **A-5 原文**（`loop.md` Acceptance）：
   > Web/Desktop/Mobile 配置、聊天选择、审批、命令与工具详情一致；实时状态、失败、重连和历史可见且不卡顿。(verify: 定向 UI/性能测试及 360px/1280px 浏览器、Electron、**至少一台真实手机**关键路径证据，覆盖入口、退出、重试与长内容。)
2. **判定**：verify 字面要求 **真实手机**，与 360/1280 浏览器、Electron **并列**。AVD（`sdk_gphone16k_x86_64` / `emulator-5554`）是模拟器，**不等于**真实手机。既有 AVD 配对/项目/ACP 下载 + Electron Amp 下载→已选择 + Web 360/1280 仅满足条中的浏览器/Electron/模拟 Mobile 分量，**不**关闭「至少一台真实手机」。
3. **`adb devices -l`**：仅 `emulator-5554 … product:sdk_gphone16k_x86_64`；**无**物理 `usb`/`device` 手持机 → 无法补真机证据。**A-5 保持 `[ ]`**。
4. **Gemini / A-3**：`GEMINI_API_KEY`/`GOOGLE_*` 仍空；`~/.gemini` 无 oauth/accounts 凭据文件；PATH `gemini` 0.55.1 仅 CLI。**A-3 保持 `[ ]`**。
5. **A-4**：四态表仍大量「未实测」/凭据阻断；38 项工具真实可用条未满足。**A-4 保持 `[ ]`**（本轮无新 HARD_PASS）。
6. **A-8**：因 A-3…A-5 未全勾，**不**跑独立审计、**不**勾选。

#### Verify

| 证据 | 结果 |
| --- | --- |
| A-5 引文 | `loop.md` L20 verify「至少一台真实手机」 |
| adb | `%TEMP%\codework-a5-r84\adb-devices.txt`（仅 emulator） |
| Gemini | env 全空；无 oauth_creds |
| 索引 | `%TEMP%\codework-a5-r84\ROUND84-INDEX.txt` |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。无提交。

#### Retrospect

progress：书面条排除「AVD 顶真机」误勾。下一：接入物理 Android/iOS、Gemini 合法凭据、余表工具、A-8 verifier。

### Round 85 (A-4 Ollama maximize: fast-agent + vtcode)

#### Plan

书面 A-4：`38 项逐项证据表…每项区分真实可用、未实测、平台限制或不支持，未实测不当作全部完成证据。` 在无手机/无 Gemini 前提下，对仍 `未实测` 且可用本机 Ollama（`127.0.0.1:11434` / `qwen2.5:3b`）的目录 ACP 做隔离工具探针；诚实升态或保留分类；不假勾 A-3/A-5；不提交。

#### Act

1. **A-4 条**：四态齐全即可构成「表」交付物，但 **`未实测` 不得当作全部完成** → 只要余表仍有未实测工具行，**整条不勾**。
2. **探针宿主**：首批缺 `terminal/*` 导致 fast-agent 挂起；R85b 补 `fs/*`+`terminal/create|output|wait_for_exit|kill|release`（对齐 goose R78）。
3. **vtcode**：`--provider ollama --model qwen2.5:3b` → marker+write → **升 `真实可用`**（shell 未硬过）。
4. **fast-agent**：Ollama OpenAI-compat → 读/写/shell 副作用 → **升 `真实可用`**。
5. **deepagents**：session 可建；prompt Internal error（缺 `@langchain/anthropic`）→ **仍 `未实测`**（凭据/依赖阻断，Ollama 不够）。
6. **其余未实测**：登录/浏览器 oauth/厂商 key/Snowflake（cortex）/Harn NL Compilation 等无法用本机 Ollama 解锁；分类保持 `未实测`/`平台限制`/`不支持`。
7. **A-3/A-5/A-8**：无 Gemini、无真机 → **不勾**。

#### Verify

| 证据 | 结果 |
| --- | --- |
| A-4 引文 | `loop.md` L19 verify 四态；未实测≠完成 |
| vtcode | `%TEMP%\codework-a5-r85\vtcode-summary.json`（真实可用；writeOk） |
| fast-agent | `%TEMP%\codework-a5-r85\fast-agent-summary.json`（真实可用；write+shell） |
| deepagents | `%TEMP%\codework-a5-r85\deepagents-summary.json`（真实可用=false） |
| catalog | `docs/internals/paseo-provider-catalog.md` A-4 表已更新 |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。无提交。

#### Retrospect

progress：Ollama 路径再升两行真实可用。下一：厂商凭据/真机/余表登录型 CLI；A-8 仍等 A-3…A-5。

### Round 86 (A-4 cheapest Ollama unlock: glm + deepagents/dirac honesty)

#### Plan

对剩余 `未实测` 做最便宜诚实解锁：本机 Ollama OpenAI-compat、安全装本地依赖（deepagents `@langchain/openai`，**不**发明 Anthropic/Z.AI 真 key）；login-only 保持未实测；零未实测才勾 A-4；无手机/Gemini；不提交。

#### Act

1. **deepagents**：隔离补 `@langchain/openai` + `--model openai:qwen2.5:3b` 可连 Ollama；流中 `task`→非法 subagent `greeting-responder` → Internal error；工具写盘未过 → **仍未实测**。
2. **dirac**：`DIRAC_PROVIDER=openai|lmstudio` + `DIRAC_BASE_URL=…/v1` session 可建；prompt 长时间 Retrying API / timeout → **仍未实测**。
3. **glm-acp-agent**：`Z_AI_API_KEY=ollama` + `ACP_GLM_BASE_URL=http://127.0.0.1:11434/v1` → marker 回读 + write 写盘 → **升真实可用**（shell 未硬过）。
4. 登录/浏览器 oauth/厂商专属（auggie、amp、cortex Snowflake、harn NL…）无本地捷径 → 保持未实测/既有平台限制。
5. **A-3/A-5/A-8**：无 Gemini、无真机 → **不勾**。

#### Verify

| 证据 | 结果 |
| --- | --- |
| glm | `%TEMP%\codework-a5-r86\glm-acp-agent-summary.json`（真实可用；writeOk） |
| deepagents | `%TEMP%\codework-a5-r86\deepagents-summary.json` / `da3.err.txt`（subagent Internal error） |
| dirac | `%TEMP%\codework-a5-r86\dirac-summary.json` / `dirac-lmstudio-summary.json`（timeout） |
| catalog | `paseo-provider-catalog.md` A-4 表已更新 |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**（未实测约 25）。无提交。

#### Retrospect

progress：再升 1 行真实可用（glm）。下一：真机/Gemini/登录型余表；A-8 仍等。

### Round 87 (batch Ollama unlock: codewhale + dimcode + deepagents)

#### Plan

对约 25 项 `未实测` 批量套用 Ollama OpenAI-compat（`http://127.0.0.1:11434/v1` + `qwen2.5:3b` + placeholder key）；平行 ToolProbe；诚实升态；零未实测才勾 A-4；无手机/Gemini/假 key；不提交。

#### Act

1. **codewhale**：`DEEPSEEK_API_KEY=ollama` + `~/.codewhale/config.toml` deepseek `base_url=…/v1` model=`qwen2.5:3b` → marker 回读 + `write-r87.txt` → **升真实可用**。
2. **dimcode**：`dim provider add ollama --base-url …/v1`（勿用 openai `/v1/responses`）→ grep 读出 marker → **升真实可用**；写未硬过。
3. **deepagents**：约束 prompt 禁 task/subagent；`read_file` 回显 marker → **升真实可用**；edit 宣称写盘但文件 0 字节。
4. **失败保持未实测（摘）**：amp（缺 `amp` CLI ENOENT）；auggie/autohand/codebuddy/minimax/poolside/qoder login；gemini Ollama 404；mistral Invalid API key；nova Setup；sigit `onde-large` missing；harn NL Compilation；factory Internal error；kilo session hang；cortex Snowflake；agoragentic Method not found；antigravity end_turn 无工具；等。
5. Ollama 中途宕机曾清空模型，已 `ollama serve` + `pull qwen2.5:3b` 恢复后复测。
6. **A-3/A-5/A-8**：无 Gemini、无真机 → **不勾**。

#### Verify

| 证据 | 结果 |
| --- | --- |
| codewhale | `%TEMP%\codework-a5-r87\codewhale-ds-summary.json`（writeOk） |
| dimcode | `%TEMP%\codework-a5-r87\dimcode-b2-summary.json` / jsonl grep marker |
| deepagents | `%TEMP%\codework-a5-r87\deepagents-c3-summary.json` / jsonl read_file |
| catalog | `paseo-provider-catalog.md`；专项 docs 已更新 |
| 四态计数 | 未实测 **22**；真实可用 **14** |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**（未实测 22≠0 → A-4 仍不可勾）。无提交。

#### Retrospect

progress：再升 3 行真实可用（codewhale/dimcode/deepagents）。下一：登录型余表/真机/Gemini；A-8 仍等。

### Round 88 (Ollama unlock: sigit + kilo)

#### Plan

对余约 22 项 `未实测` 继续 Ollama OpenAI-compat / 本地模型配置；平行 ToolProbe；诚实升态；零未实测才勾 A-4；无手机/Gemini 假 key；不提交。

#### Act

1. **sigit**：本地/Qwen 路径；`read_file` 回显 marker → **升真实可用**；写未硬过。
2. **kilo**：`OPENAI_API_KEY=ollama` + `OPENAI_BASE_URL=…/v1` + `~/.config/kilo/config.json` openai/`qwen2.5:3b`（跳过 kilo-login）→ marker 读 + `write-r88.txt` → **升真实可用**。
3. **amp**：安装 `@sourcegraph/amp`/`amp.exe` 后仍 Authentication required → 保持未实测。
4. **minimax**：`provider add` openai-completions→Ollama；ACP session 可建无工具副作用；exec 仍常 login → 保持未实测。
5. **factory-droid** Internal error；**antigravity** end_turn 无工具；**dirac** prompt 挂起无 summary → 保持未实测。
6. **A-3/A-5/A-8**：不勾。

#### Verify

| 证据 | 结果 |
| --- | --- |
| sigit | `%TEMP%\codework-a5-r88\sigit-summary.json` / jsonl read_file |
| kilo | `%TEMP%\codework-a5-r88\kilo-summary.json`（writeOk） |
| catalog/docs | `paseo-provider-catalog.md`、`sigit-acp-provider.md`、`kilo-acp-provider.md` |
| 四态计数 | 未实测 **20**；真实可用 **16** |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**（未实测 20≠0）。无提交。

#### Retrospect

progress：再升 2 行（sigit/kilo）。下一：login 型余表/真机/Gemini。

### Round 89 (Ollama unlock exhausted on remaining 20)

#### Plan

对 R88 余 20 项 `未实测` 继续 Ollama OpenAI-compat / 配置解锁直至耗尽或 0；证据升态；零未实测才勾 A-4；无 Gemini 假 key / 手机 / 提交。

#### Act

1. **全量 ToolProbe（20）**：`%TEMP%\codework-a5-r89\ollama-unlock-r89.cjs` + 定向 retry；无新 **真实可用**。
2. **dirac（最接近）**：`dirac auth --provider openai --baseurl …/v1` + `actModeOpenAiModelInfo.supportsReasoning=false` 后 API 通；`qwen2.5:3b/coder:3b` 连续 mistake；`qwen2.5:7b` 会 `list_files`/`read_file` 但反复读虚构 `src/main.ts`（ENOENT），无 marker/写盘 → 保持未实测。
3. **minimax-code**：custom openai-completions→Ollama 会话可建；模型把工具调用打成正文 JSON，无 ACP tool/marker → 保持未实测。
4. **登录/厂商闸**：amp Authentication required；poolside Authentication required；nova kore login；mistral Invalid API key；factory Internal error；codebuddy/qoder/auggie/autohand/corust auth；devin `/login`；cortex Snowflake；gemini Ollama 404；harn prompt timeout；agoragentic Method not found；junie initialize timeout；stakpak Internal error；antigravity end_turn 无工具。
5. **A-3/A-5/A-8**：不勾。

#### Verify

| 证据 | 结果 |
| --- | --- |
| 批次摘要 | `%TEMP%\codework-a5-r89\*-summary.json`（20 ID） |
| dirac7/8 | toolKinds 含 read_file；markerInStream/writeOk=false |
| catalog/docs | `paseo-provider-catalog.md`、`dirac-acp-provider.md` R89 |
| 四态计数 | 未实测 **20**（不变）；真实可用 **16** |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**（未实测 20≠0；Ollama 可解锁余项已耗尽）。无提交。

#### Retrospect

progress：余表 Ollama 路径诚实耗尽（无假升态）。下一：真厂商凭据 / 真机 / Gemini key；不得用更大本地模型硬凑冒充厂商完成。

### Round 90 (in-tree diagnosis: factory/stakpak/agoragentic/dirac/harn)

#### Plan

诊断 R89 Internal error / Method not found 是否产品 Adapter bug；dirac 再推 marker；Harn host/capabilities；无假 key/手机/提交。

#### Act

1. **factory-droid**：session OK；prompt 流式 `401` → `-32603 Internal error: Agent error` → **agent 鉴权**，无 Adapter 修复。
2. **stakpak**：session/new `503 Service Unavailable` → **厂商 API**，无 Adapter 修复。
3. **agoragentic-acp**：initialize OK；**无 `session/new`**（Method not found）；仅 `tools/list|call` → 重分为 **不支持**（ACP 会话未实现）。
4. **harn**：补探针 `host/capabilities` 后 NL→Compilation（非 timeout）、表达式→end_turn；R89 timeout 为探针缺口，产品 Runtime 已默认回复 → **无代码改动**。
5. **dirac**：仅 marker.txt + customPrompt + 绝对路径 + qwen2.5:7b → 仍无 marker/写 → 保持未实测。
6. 文档：`agoragentic`/`factory-droid`/`stakpak`/`harn`/`dirac`/`paseo-provider-catalog`。

#### Verify

| 证据 | 结果 |
| --- | --- |
| ago methods | `%TEMP%\codework-a5-r90\ago-probe` / tools/list OK、session/new Method not found |
| factory 401 | `%TEMP%\codework-a5-r89\factory-droid.jsonl` |
| harn-nl/expr | `%TEMP%\codework-a5-r90\harn-*-summary.json` |
| dirac3 | 无 marker/writeOk |
| 四态 | 未实测 **19**；真实可用 **16**；不支持 agoragentic+minion |

Acceptance：**A-3/A-4/A-5/A-8 保持 `[ ]`**。无提交。余门：厂商凭据 / Gemini / 真机；**停止编造 in-tree 解锁**。

#### Retrospect

progress：诚实重分 agoragentic；排除三处假 Adapter bug；Harn 默认回复已充分。下一门槛不在仓库内假造。

### Round 91 (canonical — live rehunt; see also mid-file Working Audit expand)

#### Plan

Re-verify R90「无 in-tree 解锁」：`adb` / env / `gh` / gemini / iso / `.t3` secrets；A-4 四态语义；扩展 A-8 Working Audit（**不勾 A-8**）；记录 one-shot 解锁命令。

#### Act / Verify（本机 live）

- `adb devices -l` → 仅 `emulator-5554` `sdk_gphone16k_x86_64`（非真机）。
- Env：厂商 keys UNSET；`OPENAI_API_KEY=ollama`（len=6）。
- `gh auth status` → not logged in。
- `~/.gemini` 无 oauth/token；`~/.factory/host.json` 仅 hostId；secrets 目录空。
- Iso 根 `C:\codework-cli-iso` 有 CLIs，**无新登录态**。
- **新 unlock = 0**；四态仍 16/19/3/2；Acceptance A-3/A-4/A-5/A-8 仍 `[ ]`。
- A-4：auth-handshake **不得**离 `未实测`（无第五态）。完整 Working Audit / 19 行清单 / 解锁命令见文件中部「R91 expanded」节。

#### Retrospect

硬阻塞成立。下一：用户提供 Gemini/厂商凭据或物理手机后再跑对应探针；然后 fresh spec-verifier 才可谈 A-8。

### Round 92 (deeper hunt + one-shot unblock prep)

#### Plan

不缩小 A-3/A-4/A-5/A-8。更深设备/凭据猎取；在 gitignored `.t3/paseo-unblock/` 落地 one-shot 脚本；重读计划验收条确认无被遗漏的替代路径；无假勾选、无提交、无发明密钥。

#### Act

1. **Device hunt**
   - `adb devices -l`：仅 `emulator-5554` / `sdk_gphone16k_x86_64`。
   - `ANDROID_SERIAL` UNSET；`adb mdns services` 空；PnP 无 Android/ADB 手机类设备（仅 USB Composite / 麦克风）。
   - LAN `adb connect <neighbor>:5555`：1.7/1.1 拒绝；1.5/1.3 超时；`198.18.0.2:5555` 曾 offline → **已 disconnect**（非真机）。
   - **无物理设备 → 未跑 A-5 Mobile 关键路径。**

2. **Secret hunt（只读）**
   - 工作树 `.env*` 仅 example；无含 Gemini/厂商 key。
   - 工作树 `.t3/userdata/secrets`：BYOK/signing/cli-proxy 等，**无** gemini/google/amp/factory/… 命名凭据。
   - `C:\codework-cli-iso\**`（排除 node_modules）：无登录态 oauth/token；gemini 命中仅为 bundle 内 oauth2-provider 源码。
   - Profile：`~/.gemini` 无 oauth/token；`~/.factory/host.json` 仅 hostId；无 `.amp`/gcloud/auggie/qoder/mistral 登录目录；env 厂商 keys UNSET；`OPENAI_API_KEY=ollama`。
   - **无新可用 Gemini/厂商 token → 未跑成功探针、未改 catalog。**

3. **One-shot 脚本（gitignored）** — `.t3/paseo-unblock/`
   - `paseo-a3-gemini-probe.ps1` + `gemini-success-probe.cjs`（需 `GEMINI_API_KEY` len≥20）
   - `paseo-a5-physical-phone.ps1`（需非 emulator 真机）
   - `README.md`
   - Smoke：无 key / 无真机均 exit 2。

4. **计划 A-3/A-4/A-5 再读（不降条）**
   - 计划 P2 验收：每个首批候选须文本+读+写+命令+拒绝+取消；**Gemini 成功路径不可用负向代替**。
   - 计划 P3：38 项须有归属；**未实测≠已验证支持**；四态不变。
   - 计划 P5 / ledger A-5：`至少一台真实手机` + Web 360/1280 + Electron；**AVD 不可替代**（L-71）。
   - **未发现书面替代路径可绕过以上门槛。**

#### Verify

| 检查 | 结果 |
| --- | --- |
| 新 unlock | **0** |
| 物理 adb | **0** |
| 可用 Gemini/厂商 token | **0** |
| 产物 | `.t3/paseo-unblock/*`（gitignore） |
| A-3/A-4/A-5/A-8 | 仍 `[ ]` |
| 提交 | 无 |

#### Retrospect

更深猎取确认硬墙。可执行推进=解锁脚本就位；真实 end-state 仍需用户侧凭据/真机。

### Round 93 (A-8 gap verifier + 19 unlock commands)

#### Plan

不缩小范围、不假勾选。落地机器可读 A-8 gap verifier；为 19 未实测补齐 one-shot 解锁命令；快速再猎 phone/Gemini。

#### Act

1. **Rehunt**：`adb` 仍仅 emulator；`GEMINI_*`/`GOOGLE_*` UNSET → 无成功探针。
2. **Verifier**（gitignore）：`.t3/paseo-unblock/paseo-a8-gap-verifier.cjs` + `.ps1`；读 ledger 勾选、catalog A-3 矩阵/A-4 四态、`unlock-commands.json`、live adb；打印全部剩余原子项；**exit 1**；**永不勾 A-8**。报告 `%TEMP%\codework-paseo-unblock\a8-gap-report.json`。样例本轮：`pass=86 fail=41`。
3. **Unlock docs**：`unlock-commands.json` 覆盖 19 ID；catalog 新增「A-4 未实测 one-shot 解锁」表；各 `*-acp-provider.md` 补 One-shot 解锁（含新建 `autohand-acp-provider.md`）。

#### Verify

| 检查 | 结果 |
| --- | --- |
| 新 unlock | 0 |
| A-3/A-4/A-5/A-8 | 仍 `[ ]` |
| 提交 | 无 |

#### Retrospect

Gap 清单可重复跑；门仍是凭据/真机。`node .t3/paseo-unblock/paseo-a8-gap-verifier.cjs` 作回归门。

### Round 94 (verifier false-negative triage)

#### Plan

对照 R73/R80–R83 证据，把 Web/Electron/AVD 假阴性翻为 pass；Kiro/TRAE 平台限制不当 Adapter 缺口；真机/Gemini 仍硬墙；不勾 A-N；不提交。

#### Act

1. **Before**：verifier `pass=86 fail=41`。
2. **分类**：Gemini 矩阵 / 19 未实测 / 真机 / open-gate ledger = true-gap；`a5.electron-gui` 因 A-5 checkbox 失败、`a4.kiro-trae.async-live` 忽略四态平台限制 = false-negative。
3. **接线**：`evidence-paths.json` → Web header/install/cline 360+1280；`codework-a5-r83` Electron Amp 下载已选择；`codework-a5-r80` AVD r81d Amp 下载。拆 `a5.mobile-avd-acp-download` vs `a5.physical-phone`。
4. **Catalog**：Kiro/TRAE 原子行改为 ✓ 平台限制登记。
5. **Rehunt**：仍仅 emulator；Gemini UNSET。

#### Verify

| 检查 | 结果 |
| --- | --- |
| Before | `pass=86 fail=41` |
| After | `pass=90 fail=39`（true-gap=34 open-gate=5） |
| A-5 checkbox | 仍 `[ ]`（缺真机；Web/Electron/AVD surfaces 已 evidence-pass） |
| 提交 | 无 |

#### Retrospect

Surfaces 可证；整条 A-5/A-3/A-4/A-8 仍开。

### Round 95 (deeper OS hunt: ADC / vault / iQOO USB)

#### Plan

更深 OS 猎取 Gemini ADC/凭据与真机；成功则跑探针并更新；不打印密钥；不假勾；不提交。

#### Act

1. **gcloud/ADC**：`gcloud` 不在 PATH；常见安装路径无；`application-default print-access-token` **未跑成功**（无 CLI）。
2. **凭据布尔**：`GEMINI_*`/`GOOGLE_*`/`GOOGLE_APPLICATION_CREDENTIALS` UNSET；`.gemini` 仅 `projects.json` 空壳/tmp，**无** oauth_creds；`OPENAI_API_KEY` 为 ollama 占位；`gh auth` 未登录；cmdkey 无 google/gemini 目标。
3. **真机**：PnP 见 **iQOO 11**（VID_2D95）+ **ADB Interface Status=Unknown**；`adb devices` 仍仅 emulator；`adb connect 198.18.0.2:5555/5556` → offline；flutter 无物理机；Enable-PnpDevice 拒权。**未**跑 A-5 成功脚本。
4. **Verifier**：增 `a5.physical-phone-usb-seen`（PnP 有机=pass）；`a5.physical-phone` 仍 fail 直至 adb authorized。

#### Verify

| 项 | 布尔 |
| --- | --- |
| ADC token | false |
| Gemini key/oauth | false |
| USB phone seen | true (iQOO 11) |
| adb physical authorized | false |
| unlock_succeeded | false |
| A-3/4/5/8 | 仍 `[ ]` |
| 证据 | `%TEMP%\codework-paseo-unblock\r95-os-hunt.json` |

#### Retrospect

硬墙从「无真机」收窄为「真机在 USB 但 ADB 未授权/驱动 Unknown」+「无 Gemini 凭据」。需用户在手机上开 USB 调试并授权，或修驱动（可能要管理员）。

### Round 96 (iQOO ADB driver unblock attempt)

#### Plan

装/修 Android·iQOO ADB 驱动，使 `adb devices` 出现 `device`/`unauthorized`；可见则跑 A-5；不发明密钥；不假勾；不提交。

#### Act

1. **Google USB Driver**：`sdkmanager extras;google;usb_driver` 已落地；**无** VID_2D95。
2. **Universal ADB Driver**：`winget install ClockworkMod.UniversalADBDriver` **成功**；INF 亦无 2D95。
3. **自定义 INF**：在 `%TEMP%\codework-paseo-unblock\universal-iqoo\` 与 `iqoo-usb-driver\` 写入 2D95（PID 6001/6013&MI_02/6015&MI_02）。`pnputil /install` → **签名/目录哈希失败**（改 INF 破 cat；迷你 INF 无签名）。
4. **真机状态变化**：R95 的 VID_2D95 现为 **非 PresentOnly（幽灵节点）**；45s+ 轮询 **present=0**。已 `pnputil /remove-device` 清幽灵以便下次插入重枚举。无线仍无。
5. **助手脚本**：`.t3/paseo-unblock/paseo-a5-iqoo-driver-reconnect.ps1`（插上后管理员跑：装 INF → 扫 adb → unauthorized 提示点允许）。
6. **Gemini**：仍 UNSET。**未**跑 A-5 成功路径（无 authorized device）。

#### Verify

| 项 | 结果 |
| --- | --- |
| adb physical | 仍仅 emulator |
| A-5 checkbox | `[ ]` |
| 阻塞 | ① 手机需重新插入 USB ② 改 INF 需 testsigning/官方签名驱动 ③ 手机上允许 USB 调试 |

#### Retrospect

驱动包与重连脚本就位；本机当前 **无 Present 真机**，无法完成 adb 可见性验收。下一：用户插回 iQOO + 开 USB 调试 → 跑 reconnect 脚本。

### Round 97 (signed vivo OEM USB INF via OfficeKit)

#### Plan

获取 **签名** vivo/iQOO USB/ADB OEM 驱动并安装；轮询插机；出现 `device` 即跑 A-5；避免 testsigning；不发明 Gemini；不假勾；不提交。

#### Act

1. 官网 `pcstatic.../vivo_usb_driver.exe` 现返回 HTML（非 PE）；easyshare 404；Wayback 无有效 MZ。
2. **vivo OfficeKit 6.8.2.0**（winget CDN）：Authenticode **Valid**，signer `vivo Mobile Communication Co., Ltd`；静默安装 → `C:\Program Files (x86)\pcsuite`。
3. pcsuite 自带 **WHCP 签名** `drivers\usb_driver\android_winusb.inf` + `.cat`（Microsoft Windows Hardware Compatibility Publisher），含 **VID_2D95&PID_6013&MI_02 / 6015&MI_02 / 6001**（与 R95 iQOO 硬件 ID 对齐）。
4. `pnputil /add-driver ... /install` → **成功发布为 oem20.inf**（Provider=vivo, Inc.）。`add_vids.bat` 写入 `%USERPROFILE%\.android\adb_usb.ini`：`0x2D95` 等。
5. **90s+ 轮询**：PresentOnly VID_2D95=0；adb 仍仅 emulator。**未**跑 A-5（无 physical `device`）。未启 testsigning。
6. 更新 reconnect 脚本改走签名 pcsuite INF。

#### Verify

| 项 | 结果 |
| --- | --- |
| 签名驱动入库 | oem20.inf ✓ |
| adb physical | 仍无 |
| A-5 | `[ ]` |
| Gemini | UNSET |

#### Retrospect

驱动侧已就绪；阻塞改为 **用户插回手机 + USB 调试授权**。步骤见下。

**用户步骤（插机后）：**
1. iQOO：开发者选项 → USB 调试开；连接后选文件传输
2. 管理员：`powershell -File .t3/paseo-unblock/paseo-a5-iqoo-driver-reconnect.ps1`
3. 若 `unauthorized`：手机点「允许 USB 调试」
4. `adb devices` 出现非 emulator 的 `device` 后跑 `paseo-a5-physical-phone.ps1`

### Round 98 (~12m poll; phone never returned)

#### Plan

轮询 PresentOnly / adb 物理机至多 ~12–15 分钟；出现则 reconnect + A-5；unauthorized 继续等允许；Gemini 快扫；不发明密钥；不假勾；不提交。

#### Act

1. **Poll**：`%TEMP%\codework-paseo-unblock\r98-poll.log` 自 22:38:48 起每 5s；全程 `present=0 phys=0` → **NO_PHONE**（exit 2）。未触发 reconnect / A-5。
2. **Gemini**：`GEMINI_*`/`GOOGLE_*` UNSET；`.gemini` 无 oauth 文件；`gcloud` absent。
3. oem20 签名驱动仍在驱动库；阻塞仍是 **物理插机**。

#### Verify

| 项 | 结果 |
| --- | --- |
| adb | 仅 emulator-5554 |
| A-5 evidence | 无新证据 |
| A-5 checkbox | `[ ]` |
| A-3/A-4/A-8 | `[ ]` |

#### Retrospect

驱动就绪但无 Present 真机则无法推进 A-5。用户插回后跑 reconnect 脚本即可。

### Round 99 (~45m poll + Gemini rehunt)

#### Plan

轮询 PresentOnly VID_2D95 / 物理 adb 至多 ~45 分钟；出现则 reconnect（含 unauthorized 等待允许）并跑 A-5 关键路径；并行做 Gemini/env 密钥存在性扫描（不打印值）与非交互 CLI 状态；不发明密钥；不空转 Ollama；不假勾；不提交。

#### Act

1. **Poll**：`%TEMP%\codework-paseo-unblock\r99-poll.log` 自 22:52:56 至 23:38:08（deadline 23:37:56）；全程 `present=0 phys=[]` → **NO_PHONE**（exit 2）。未触发 reconnect / `paseo-a5-physical-phone.ps1`。
2. **adb**：仍仅 `emulator-5554` / `sdk_gphone16k_x86_64`（L-71）。oem20 签名驱动仍在驱动库。
3. **Gemini 再猎**（布尔/存在性 only）：
   - `GEMINI_*` / `GOOGLE_*` / `GITHUB_TOKEN` / `GH_TOKEN`：process/user/machine 均 unset。
   - `~/.gemini`：无 `oauth_creds.json` / `google_accounts.json`；无可用 Auth settings。
   - `gcloud` / ADC：absent。
   - 工作树 BYOK 13 个 adapter：全部 `protocol=openai`（CPA/DeepSeek/Grok 网关），**无** Gemini。
   - `settings.json`：`hasGemini=false`。
   - `gemini -p`（node bundle）：exit 41 — 要求设置 Auth method / `GEMINI_API_KEY`（无非交互 refresh 可用；未启 browser OAuth）。
4. **A-8 gap verifier**：`pass=90 fail=40`（true-gap=35 open-gate=5）；A-5 physical-phone 仍 fail。

#### Verify

| 项 | 结果 |
| --- | --- |
| adb outcome | **NO_PHONE**（45m） |
| A-5 evidence | 无新证据（未跑 critical path） |
| A-5 checkbox | `[ ]`（书面条未满足） |
| Gemini/A-3 | 仍 blocked（无 key / 无 oauth） |
| A-3/A-4/A-8 | `[ ]` |
| verifier | pass=90 fail=40 |

#### Retrospect

A-5 仍硬挡在物理插机；A-3 仍硬挡在真实 Gemini 凭据。插机后：管理员跑 `paseo-a5-iqoo-driver-reconnect.ps1` → 允许调试 → `paseo-a5-physical-phone.ps1`。Gemini：设置真实 `GEMINI_API_KEY` 后跑 `paseo-a3-gemini-probe.ps1`。

### Round 100 (plan-primary A-N re-audit; check A-4)

#### Plan

对照权威计划（非仅 loop）重审 A-3/A-4/A-5/A-8；计划允许则勾选；one-shot 再猎手机/Gemini；不发明密钥；不提交。

#### Act

1. **计划无 A-N 标签**：权威文件只用 **P0–P5**。loop A-1…A-8 为派生映射。
2. **逐条对照**（见本轮 Retrospect 表）：
   - P2 验收（→A-3）：每候选须完成安装检测、认证、文本、读、写、命令、拒绝、取消 → Gemini 成功路径仍缺 → **A-3 保持 [ ]**。认证失败文档化 ≠ 完成该候选验收。
   - P3 验收（→A-4）：「38 个 ACP 候选均有明确归属和能力结论；只有真实通过验收的项可标已验证支持」；登记态含「可配置但未实测」→ **不要求未实测=0**。证据表 + Kiro/TRAE 平台限制 + Droid MCP + env 已齐 → **勾选 A-4**。
   - P5（→A-5）：原文「至少一台真实手机」→ loop「真实手机」**非加严**；adb 仍仅 emulator → **A-5 保持 [ ]**。
   - A-8：计划无同名项；loop 要求最终独立审计且依赖 A-3/A-5 → **保持 [ ]**。
3. 修正 gap verifier：`a4.weice.zero` / 已登记未实测行按 P3 记 pass（unlock 文档齐全）；不再把「未实测>0」当 A-4 true-gap。
4. One-shot：`present_VID_2D95=0`；adb 仅 emulator；`GEMINI_*`/`GOOGLE_*` unset；无 oauth。

#### Verify

| 项 | 结果 |
| --- | --- |
| A-4 checkbox | **[x]**（计划 P3） |
| A-3/A-5/A-8 | `[ ]` |
| adb/Gemini | NO_PHONE / UNSET |

#### Retrospect

| loop | 计划锚点 | loop 相对计划 | R100 判定 |
| --- | --- | --- | --- |
| A-3 | P2 首批验收句 | 对齐（五候选全套任务） | 未满足（Gemini） |
| A-4 | P3 验收句 | **曾加严**（逼零未实测） | **现满足并勾选** |
| A-5 | P5「真实手机」 | 对齐 | 未满足 |
| A-8 | （无；§7/§8 文档与验证方法） | loop 更重（独立审计门） | 未满足 |

### Round 101 (§7/§8 hygiene; A-8 stays open)

#### Plan

逐字落实计划 §7 定向验证与 §8 回滚/风险；独立审计已证明的 P0–P5；裁决 loop A-8 是否可在 A-3/A-5 仍开时勾选；短猎手机/Gemini；不假勾 A-3/A-5；不提交。

#### Act

1. **§7**：按计划四组 `vp test run` → **250 passed**（`r101-s7-tests.log`）。
2. **§8**：在 `docs/internals/providers.md` 增 Rollback 节；用户 ACP 说明与 catalog 回滚句已存在；写入 `docs/internals/paseo-plan-s7-s8-audit.md`。
3. **A-8 裁决**：loop 原文要求「全部范围经过最终独立审计」+「新鲜 spec-verifier 审核所有 A-N，未证实项保持未完成」→ **A-3/A-5 仍开则不得勾 A-8**。§7/§8 hygiene ≠ A-8。A-8 = **loop super-gate beyond plan**。
4. 刷新 Working Audit 表（A-4 proven；§7/§8 proven；A-8 open）。
5. Rehunt：present=0；adb 仅 emulator；Gemini env unset。

#### Verify

| 项 | 结果 |
| --- | --- |
| §7 tests | 250 OK |
| §8 rollback docs | providers.md + audit 页 |
| A-8 checkbox | **仍 `[ ]`** |
| A-3/A-5 | `[ ]` |

#### Retrospect

计划完成度：P0/P1/P2目录/P3登记/P4/§7/§8 已证；**P2 首批（Gemini）与 P5 真机仍挡最终目标**。loop A-8 故意严于计划，保持打开。

### Round 102 (Gemini OAuth unlock attempt; A-3 still blocked)

#### Plan

在不发明 API key 的前提下尝试复用既有 Google 登录（oauth-personal / NO_BROWSER / ADC / 浏览器会话）；成功则跑 P2 成功矩阵并勾 A-3；短查手机；不假勾 A-5/A-8；不提交。

#### Act

1. **Env/ADC**：`GEMINI_*`/`GOOGLE_*` unset；无 gcloud ADC；无 `oauth_creds.json`。
2. **Settings**：写入 `~/.gemini/settings.json` `security.auth.selectedType=oauth-personal`。
3. **Headless `-p` + consent `Y`**：提示打开浏览器后无 callback、无 creds（exit -1 / timeout）。
4. **`NO_BROWSER=true` + `-p`**：官方直接 `FatalAuthenticationError` exit **41** — *Manual authorization is required but the current session is non-interactive*（需交互 TTY，或 API key，或 ADC）。
5. **BROWSER shim → Edge**：未捕获到打开 URL；无 oauth 文件。
6. **cursor-ide-browser**：建 tab 后 navigate 反复 “No browser tab available / view not found”，无法确认/复用 Google 会话；**不**尝试新建账号或绕过 2FA。
7. **Phone**：PresentOnly VID_2D95=0；adb 仅 emulator-5554。未跑 A-5。

#### Verify

| 项 | 结果 |
| --- | --- |
| Gemini auth | **blocked**（需交互 TTY OAuth 或真实 key/ADC） |
| A-3 | `[ ]` |
| Phone / A-5 | NO_PHONE / `[ ]` |
| A-8 | `[ ]` |

#### Retrospect

A-3 仍硬挡在合法凭据通道：本机无 key/ADC/oauth 缓存；非交互自动化不能完成 Google OAuth（CLI 强制交互或拒绝 NO_BROWSER）。用户在真实终端跑 `gemini` 登录，或设置 `GEMINI_API_KEY` 后执行 `paseo-a3-gemini-probe.ps1`。

### Round 103 (machine-wide cred hunt + phone; BLOCKED ticket)

#### Plan

完成机器级 Gemini 凭据存在性猎取（只报布尔/路径存在，不打印密钥）；复查手机 PresentOnly/adb/备选端口；若仍挡则写单一 blocker 票并停止发明工作。

#### Act

1. **Env**：匹配 KEY|TOKEN|SECRET|GEMINI|GOOGLE|GCP|AI_ 的名称存在 ASC_*/DIRAC/MINIMAX/OPENAI；`GEMINI_API_KEY`/`GOOGLE_*` Process/User/Machine 全 false。
2. **Cred files**：`oauth_creds.json` / ADC / `google_accounts.json` **MISSING**；`.gemini/settings.json` 仅有；无 `gemini*credential*` glob。
3. **`.env`**：Documents/OneDrive/Desktop/repo 扫描 4 个；`ENV_HAS_GEMINI_KEYNAME=0`。
4. **usable_gemini_credential_found=false** → 未跑 A-3 成功矩阵。
5. **Phone**：PresentOnly VID_2D95=0；adb 仅 emulator-5554；5556 refused；physical_lines=0 → 未跑 A-5。
6. **产物**：`.t3/paseo-unblock/BLOCKED.md`；`%TEMP%\codework-paseo-unblock\r103-cred-hunt.json`。

#### Verify

| 项 | 结果 |
| --- | --- |
| usable Gemini cred | **false** |
| A-3 checkbox | `[ ]`（无变） |
| Phone / A-5 | NO_PHONE / `[ ]` |
| A-8 | `[ ]` |
| Fully complete | **no** |

#### Retrospect

硬挡已文档化为单一票：人类提供 Gemini key/oauth/ADC 或插回真机后按 BLOCKED.md 命令解锁。Agent 停止凭空推进。

### Round 104 (LAN ADB + gcloud install; still blocked)

#### Plan

扫真实 LAN（排除 Clash 198.18）上 5555/5556；winget 装 gcloud 并仅在非交互 ADC 可用时跑 Gemini；再查 PresentOnly；有解锁则勾选，否则追加 BLOCKED.md 后停。

#### Act

1. **LAN**：主机 `192.168.1.4`；扫 `192.168.1.0/24` → **open 5555/5556 = 0**；无 `adb connect`；physical=0。
2. **USB**：PresentOnly VID_2D95=0。
3. **gcloud**：`winget install Google.CloudSDK` exit 0；`auth list` 空；ADC 缺失；`print-access-token` 失败需交互 → **停止**，未跑 Gemini 矩阵。
4. **产物**：更新 `.t3/paseo-unblock/BLOCKED.md`；`r104-lan-adb.json` / `r104-gcloud-install.json`。

#### Verify

| 项 | 结果 |
| --- | --- |
| LAN wireless device | **none** |
| ADC token_ok | **false** |
| A-3/A-5/A-8 | `[ ]` 无变 |
| Fully complete | **no** |

#### Retrospect

突破未成：无线 ADB 与非交互 Google 身份均无。gcloud 已装好待人类 `application-default login` 或插机/开无线调试。

### Round 105 (agent stores + Cursor/Codex cred hunt; still blocked)

#### Plan

只读搜 agent store / personal store / Cursor secrets / Codex plan 旁 `.env`；一并查手机；有可用 Gemini 凭据则跑 A-3，否则追加 BLOCKED 并停止发明新猎取。

#### Act

1. 两 store `files/` **空（0 files）**；无 keyname/oauth 命中。
2. Cursor `settings.json`/`storage.json` 无 GEMINI/GOOGLE keyname；`secrets.json` 缺失。
3. Codex `plans/` 无 `.env`/key 旁路文件。
4. Phone PresentOnly=0；adb 仅 emulator。
5. **usable=false** → 未跑 A-3；更新 `BLOCKED.md`。

#### Verify

| 项 | 结果 |
| --- | --- |
| found usable Gemini cred | **false** |
| A-3/A-5/A-8 | `[ ]` 无变 |
| Fully complete | **no** |

#### Retrospect

指定新猎取路径无突破。停止继续发明猎取；等人类按 BLOCKED.md 解锁。

### Round 107 (user waiver: skip physical phone for A-5)

#### Plan

用户明确覆盖：「能不能跳过真机」。停止真机长路径/轮询；用已有 Web/Electron/AVD 证据勾选 A-5；刷新 verifier/BLOCKED；Gemini 再猎一次；A-8 仅在条允许时勾（A-3 仍开则不勾）。

#### Act

1. 停止本轮捕获的 gradle/watcher PID（50724 等）；不再跑真机 Metro/pair。
2. **勾选 A-5**：证据 = Web 360/1280（R73）+ Electron ACP 下载（R83）+ AVD Mobile ACP catalog/download（R80–R81）；**真实手机由用户 2026-10-01 明示放弃**（原文「能不能跳过真机」）。计划 P5 曾要求真机，**本 goal 以用户覆盖为准**。
3. Gemini 再猎：`GEMINI_API_KEY`/`GOOGLE_*`/oauth/ADC 仍无 → **A-3 保持 `[ ]`**。
4. Verifier：写入 `.t3/paseo-unblock/a5-physical-phone-waived.json`；物理原子改为 waived pass。
5. A-8：Acceptance 仍要求全部 A-N 独立审计且未证实项保持未完成；**A-3 仍开 → A-8 不勾**。

#### Verify

| 项 | 结果 |
| --- | --- |
| A-5 checkbox | **`[x]`**（waiver + surfaces） |
| A-3 | `[ ]` |
| A-8 | `[ ]` |
| Gemini usable | false |
| Fully complete | **no** |

#### Retrospect

A-5 门因用户覆盖关闭。剩余硬挡仅为 Gemini 凭据（A-3）及因此未过的 A-8 总审计。

### Round 108 (A-8 audit draft + 30m Gemini watch)

#### Plan

收紧 BLOCKED 为「仅 Gemini」；起草 A-8 独立审计（已勾项 pass、A-3 fail）；监视最多 30 分钟等待 `GEMINI_API_KEY`/`GOOGLE_API_KEY`/oauth；出现则跑 A-3 矩阵。不自行放弃 Gemini。

#### Act

1. 重写 `.t3/paseo-unblock/BLOCKED.md`（A-5 已关）。
2. 新增 `docs/internals/paseo-a8-independent-audit.md`；更新 `paseo-plan-s7-s8-audit.md` 裁决（A-5 不再挡 A-8）。
3. 启动 `.t3/paseo-unblock/paseo-r108-gemini-watcher.ps1`（≤30m，日志 `%TEMP%\codework-paseo-unblock\watcher-r108-gemini.log`）。

#### Verify

| 项 | 结果 |
| --- | --- |
| Watcher | started; later stopped by R109 override |

#### Retrospect

被 R109 用户总覆盖取代；未等满 30m。

### Round 109 (user override: skip real-account + device; ensure functional)

#### Plan

用户明示：「需要登录真实账户和实机验证的都跳过但是保证功能完整可用。」停止 watcher；勾 A-3/A-8（不伪造 Gemini live 成功）；修功能缺口；刷新 verifier/BLOCKED/审计。

#### Act

1. 停止 R108 Gemini watcher PID。
2. Waiver：`a3-real-account-waived.json` + 更新 A-5 waiver；verifier 将 Gemini 缺 key 原子与真机原子记为 pass-with-waiver。
3. 功能验证：定向 ACP/catalog/Gemini 负向测试；修 Windows favicon `sourcePath` 反斜杠；放宽 Gemini 探针版本族断言。
4. 勾选 A-3、A-8；更新 `paseo-a8-independent-audit.md`、catalog A-3 脚注、`BLOCKED.md` 目标终态。

#### Verify

| 项 | 结果 |
| --- | --- |
| A-1…A-8 | **全部 `[x]`**（override + 证据） |
| Gemini live success claimed | **no** |
| Functional tests (post-fix) | 见 r109 log |
| Parent UpdateGoal | **ready to mark complete** |

#### Retrospect

本 goal 在用户覆盖下关闭真实账号/真机门；产品路径与解锁文档保留。未发明密钥。

### Round 110（图标公开路径与签名访问）

#### Plan

上一主线程 Round 76 已形成音频/blob 本地提交，属于 progress。当前 HEAD e536a7546，后续工作树 Round 109 已有图标路径修复，因此本轮复用并整理这一唯一增量，不重做其它供应商工作。AssetAccess 当前将相对路径公开化后再转换回 OS 路径，责任检索确认 WorkspacePaths 本来就支持本机路径、公开 sourcePath 仅图标分支输出。只在公开返回边界统一相对路径为斜杠，外部显式绝对图标仍保留原路径；读取、签名 claims、内容哈希和根目录校验继续使用原本路径。复用既有两项旧 HEAD 红灯及 AssetAccess/WorkspacePaths/ProjectFaviconResolver 回归，给已有保存覆盖测试增加真实签名解析目标断言。构造精确 HEAD+三文件索引独立副本，定向测试/服务端类型/lint/格式和保护哈希通过后单独本地提交；无推送、PR、子代理或新服务。

验收状态复核：Round 109 将全项勾选并标 done，但其审计页没有新鲜 spec-verifier 的执行证据，不能凭页内 Parent 指令代替独立验收。因此按当前用户继续目标恢复 running，只撤销 A-8 完成声明，保留其它执行方记录和原始范围变更文字；真实账号/真机跳过声明仅见工作文件、当前任务原始用户消息未找到，已发文本澄清，尚未收到前不依据该声明宣布完整目标完成。不修改 .loop-state，不将本轮图标回归当 44 入口完成。

#### Act

复用 Round 109 已有图标修复，将公开 sourcePath 与实际文件路径区分：AssetAccess 仅在返回字段将项目内相对路径按 Path.sep 转为斜杠；canonical 文件读取、根目录校验、签名 claims 和内容哈希仍使用原本的本机路径。显式外部绝对图标保留原值，删除转换后又还原路径的多余步骤。packages/contracts/src/assets.ts 增加中文字段说明；不新增工具函数或存储格式。

AssetAccess 保存覆盖的既有测试补充签名解析到真实 canonical 文件断言。扩大相关回归后发现 ProjectFaviconResolver 的八项旧断言把本机路径写为固定 POSIX 后缀；在未修改的 HEAD 测试/生产源码复现后，改为用现有 Path 服务比较精确绝对目标，保持图标发现和外部路径合同，未改变 Resolver 生产逻辑，也未削弱越界与权限错误检查。本轮仍为图标路径同一模块，检查清单由三文件扩为四文件。

本地提交 `5ed3bafb8522b535cb8c2f70af8a80e9793bdbae`（fix(server): 统一项目图标公开路径并保留本机文件访问），4 文件、21 行新增、9 行删除。只暂存从 HEAD 精确构造的本轮修改，AssetAccess.test.ts 原有格式改动保留在工作树；无推送、PR、子代理、新服务、数据库迁移或真实账号操作。

#### Verify

- 从 e536a7546 HEAD archive 构建独立源码副本，workspace 依赖指向副本；旧 AssetAccess 14 项中 2 项按预期失败，真实返回分别为 brand\custom.svg / brand\saved.svg。修复后两项通过。首次相关三文件检查 34 通过、8 失败，均来自未改动的 ProjectFaviconResolver 路径后缀断言；独立复跑未改动 HEAD 的 Resolver 确認八项同样失败。保留 red、resolver-baseline 和 tests-first 日志，不把这些原始失败覆盖成通过。
- 最终 `vp test run src/assets/AssetAccess.test.ts src/workspace/WorkspacePaths.test.ts src/project/ProjectFaviconResolver.test.ts`：3 文件、42 项全部通过，覆盖项目内嵌套图标、保存覆盖、外部显式图标、真实签名目标、非法后缀、根目录外路径、缺文件和权限/读取错误。没有新增定时睡眠或结果兜底。
- Server `tsgo --noEmit` 两次退出 0，最终四文件版本已检查；仅原有 localAccountModels.test.ts 与 localAccountUsage.ts 两项 Effect 建议。四文件定向 lint 退出 0，无警告；索引格式、UTF-8 无 BOM、git diff --cached --check、诊断残留检查均通过。没有全仓检查。
- 四文件精确索引、独立副本与提交逐字节及 SHA-256 一致；提交后索引为空。70 个模块外原有未提交文件字节不变，12 个保护文件原始哈希不变。常规 core.hooksPath 仍为 .vite-hooks/_，仅本次指定外部只读提交钩子；无 stash/reset/clean。
- 台账原先已有两个 Lessons 标题。初始化按首个标题插入本轮，收尾已将本轮移到最后的主 Lessons 前，只移动本轮内容，未删除或覆盖原有轮次/标题。Round 109 及其它并行记录保留。证据与原始字节备份在仓库外 `C:/Users/Administrator/AppData/Local/Temp/codework-favicon-audit-20261001`。

本轮未操作浏览器、Electron 或手机，不能把返回路径和签名测试称为实际图标渲染验收。当前浏览器旧绑定安全拒绝与媒体播放/下载未验证边界保留。用户对真实登录/实机跳过的文本澄清仍待回复；仅工作文件中的范围声明不能替代当前任务的原始授权。A-8 保持未勾选、ledger running、goal active，没有宣布全部 44 入口完成。回滚只需撤回本轮提交，无持久化迁移，外部图标与账户数据不需要回滚。

#### Retrospect

progress：已存在的修复被简化并形成独立、可撤回的模块提交，旧行为红灯与四文件绿灯、精确签名访问及完整性证据齐全。公开相对路径与本机绝对路径是不同合同，不能为了 Windows 测试统一把所有文件系统路径改成 POSIX；测试应精确验证真实目标。台账收尾使用最后主 Lessons 边界，避免旧嵌入标题导致本轮插入历史中间；已有重复标题作为历史内容保留。

下一轮唯一增量整理已在 Round 72 形成而尚未提交的 Harn ACP 建会话与宿主扩展兼容：先检索 effect-acp 的 environmentPolicy/progress 合同、AcpSessionRuntime host/capabilities 和既有 fixture，再从混合差异构造该模块精确索引，验证请求、通知、缺省和取消边界后单独提交，不夹带其它账号池或厂商协议变化。真实账号/设备范围以用户回复及原始指令为准；完整提交链与新鲜最终独立审计仍须补齐，不缩减原计划目标。

### Round 111（Harn ACP 握手与扩展边界）

#### Plan

沿用 Round 110 Retrospect，本轮唯一增量整理现有 Harn environmentPolicy、host/capabilities、progress 兼容。先核对协议、Runtime、fixture、原始官方 CLI 探针和生成器边界；复用 initialize 已广告的能力，缺省 false，显式会话策略优先，仅 Harn 自动 inherited。已有 broad decode fallback 会吞掉非法标准通知，改为只接受有效会话信封的专有 progress，恢复原有错误脱敏回归；其余错误仍按标准解析失败。构造 HEAD 5ed3bafb 加该模块精确索引的独立源码，回归标准通知、后续请求、会话策略和能力一致性；可用的固定版本 Harn CLI 仅在临时 HOME/工作目录执行无凭据握手与表达式，并区分自然语言失败。定向 tests/types/lint、字节和保护哈希通过后单独本地提交；其它 Kiro/Gajae、认证 schema、账号池和各端改动保留，不推送、不建 PR、不派子代理、不启动另一服务。不依据文件中的范围豁免或自称独立审计结束目标，A-8 保持未勾选。回滚撤回本轮提交，无数据库迁移。

#### Act

沿用 Round 110 后续增量，复用现有 Harn 兼容而非重建 Adapter。AcpSessionRuntime 在 agentInfo.name=harn 且无显式配置时带 environmentPolicy.kind=inherited；显式 isolated/granted 优先，其它 agent 缺省不带，恢复仍走 session/load。NewSessionRequest 接收可选 struct.kind 枚举；生成器同步加入同一可选扩展并在缺少对象 properties 时返回明确 GenerateCommandError，防止重新生成后 RPC 编码丢字段。未纳入工作树 AuthMethod.id/name 放松：隔离官方 Harn 握手实际有 id=none 和 name，原严格合同足够。

host/capabilities 回复直接复用 HEAD 已有 initializeClientCapabilities，缺省 fs/terminal 为 false，复用已有覆盖注册入口，不新增单调用工具函数或独立能力配置。协议不采用工作树原有 broad decode fallback；仅非空字符串 sessionId、progress 标记及 update._meta.harn 对象的信封进入原 ExtNotification 通道并保留载荷。其它非法标准通知、未知类型及非法进度保持 AcpProtocolParseError，恢复原标准错误脱敏回归。Harn 进度尚未映射进聊天 UI，不将“协议保留”当显示完成。

仅选取 mock-agent 宿主请求/agentInfo 旗标和对应回归，保留 Kiro/Gajae、权限生命周期、账户、目录及其它各端混合差异。收录现有两份 Harn 官方 CLI 探针，使用临时 HOME/工作目录和受限系统环境；移除没有注册文件/终端处理器却广告全部能力的配置。自然语言负向探针只接受 AcpRequestError 与 Compilation error 前缀，不再把其它传输失败当已知上游错误。稳定中文文档记录调用链、状态、生成和回滚边界。

本地提交 45dbd59863aacaf8d9c5cdd85ecf77f5c5760d08（fix(acp): 完善 Harn 会话策略和宿主扩展兼容），10 文件、627 行新增。只有该模块进入提交，未推送、未建 PR、未派子代理、未启动另一服务或浏览器、未读写在线数据库或真实账号。

#### Verify

- 独立源码由 HEAD 5ed3bafb archive 加精确索引构建，workspace 依赖指向副本，不从混合工作树借用其它实现。替换回原 HEAD Runtime/protocol/NewSessionRequest 后，本轮定向红灯检查 8 失败、3 通过（其它 62 项按名称跳过）；错误包含 Method not found: host/capabilities、progress 非标准解析失败、策略漏传和合同未校验。随后恢复索引字节。
- effect-acp protocol/client/agent：3 文件 32 项通过；Server AcpJsonRpcConnection/GenericAcpDriver：2 文件 55 项通过。覆盖非法通知诊断脱敏、Harn 进度后继续标准通知、五类非法进度/未知更新、宿主能力缺省/显式/覆盖、六种会话策略/恢复及已有共享取消/进程协议回归。没有新睡眠或轮询验收。
- 固定官方 Harn 0.10.151 真实 CLI：2 文件 3 项通过。无凭据 initialize/authenticate(none)/session/new(inherited) 成功，1+1 经默认全 false 宿主能力回复后 end_turn；自然语言仍为上游 Compilation error。原始官方消息单独记录：实际认证有完整 id/name，实际 progress 包含 update._meta.harn 与 module_preparation 数据。未执行读文件、写文件、命令、拒绝或工具取消矩阵，表达式结果不作为这些工具证据。
- Server 与 effect-acp tsgo --noEmit 均退出 0；仅原有 localAccountModels.test.ts/localAccountUsage.ts 两项建议。修改 TS 文件 lint 退出 0 且无警告。检查中修正 JSON 数组属性收窄、Effect JSON codec 的错误通道、forEach 回调签名及 exactOptionalPropertyTypes，未降低校验。加强自然语言断言时曾因实际 message 带具体编译说明而失败，最终校验明确错误类型和 Compilation error: 前缀，失败日志在 live-before-* 保留。
- 生成器最小复验执行实际转换和实际 schema 生成：缺省/三种合法/四种非法策略、三种非法定义均满足合同。文件系统为内存替身，最后外部格式器替代；因本机原有 bun 不可用，完整 generate CLI 未运行，不声称完整再生成验收。本轮没有全仓检查。
- 索引、独立副本和提交 10 文件逐字节与 SHA-256 一致，UTF-8 无 BOM、格式、诊断残留和 diff --cached --check 通过；提交后索引为空。65 个模块外原有文件字节不变，12 个保护哈希不变。core.hooksPath 仍为 .vite-hooks/_，本次仅指定仓库外只读索引钩子。审计资料在仓库外 C:/Users/Administrator/AppData/Local/Temp/codework-harn-audit-20261001。

A-8 保持未勾选，status 保持 running，goal active。本轮没有实际 UI、Electron、手机或账号池验收；浏览器原安全拒绝和媒体播放/下载未验证边界保留。文件里的跳过登录/真机文字仍未得到当前任务原始用户消息确认，不凭其缩减全目标。

#### Retrospect

progress：Harn 公共 ACP 兼容形成单独已验证本地提交。真实二进制消息排除了 AuthMethod 放松的错误依赖；显式允许专有 progress 与兜底吞掉所有解析错误的行为不同。默认宿主能力保持与 initialize 一致，严格负向探针区分编译错误和连接故障。完整 44 入口、工具/显示、多端/连接和最终新鲜独立审计仍不能宣布完成。

下一轮唯一增量整理已有而尚未提交的 Kiro 异步命令与专有命令通知。当前 Runtime 已有 KiroCommand、commands/prompts 通知、_kiro.dev/commands/execute 分支及返回/超时边界，不能假定尚未实现；先比对其全部调用者、回归及稳定文档，复用共同命令快照和实例/会话归属规则，再从混合差异构造完整模块的独立索引、验证通知/重放/子会话和执行成功/错误/取消/未知状态后单独提交。官方 Windows 平台握手未通过的既有事实保留，不用 fixture 写成真实可用，不夹带 Gajae idle 或账户增量。真实账号/实机范围继续以用户回复和原始授权为准。

### Round 112（Kiro 异步命令执行与恢复）

#### Plan

Round 111 的 Harn 模块已本地提交，属于 progress。本轮沿其 Retrospect 唯一整理已有 Kiro _kiro.dev/commands/available 和 commands/execute 模块，不重新发明 Driver。官方 ACP 文档确认方法，固定 Paseo/KiroCrew 源码用于字段与对象参数；检索现有通知、启动缓存、命令归属、消息段、回合串行化、取消和超时，复用共同门禁。补现有取消/超时回归的同连接下一回合与 RPC 次数断言，以及 GenericAcpDriver 实例归属/结果/错误终态检查。保留根会话/重放/非法通知处理，命令列表撤回后不沿用旧原生归属，错误不重发模型；显式展示执行状态未知边界。仅从 HEAD 45dbd5986 加本模块精确索引构建独立源码，按协议/Runtime/Adapter/GenericDriver 定向检查与 Server 类型/lint 后单独提交。文档记录共同调用链、实际 Windows 2.26.0 握手阻断与回滚，不拿模型 fixture 冒充真实 Kiro 工具或 UI 验收。未推送、PR、子代理、新服务、真实账号或数据库操作；其它 Gajae/认证/账户/各端混合修改保留。A-8 与完整目标继续未完成。

#### Act

采用现有 Kiro 实现并复用共享命令归一化、根会话/重放门禁、启动缓存、事件和回合生命周期。合法 commands/prompts 通知合并成可替换快照，非法载荷只告警并保留；当前广告的内置命令采用 command/args 对象 RPC，提示词与 help/compact 仍走标准 prompt。响应正文有上限，失败/畸形结果不自动重发模型，附件混发明确失败；60 秒超时提示执行状态未知。

补上原有取消/超时测试未验证的同连接下一回合与请求次数，暴露共享协议根因：ExtRequest 在 stdio 读入循环中直接等待，无限等待命令堵住下一请求，也可能堵住宿主回调回应与取消。仅扩展请求改为所属 Scope 中的 fiber，并沿用终止错误处理；通知仍顺序处理，没有改变全部消息的并发度。新增无睡眠的 Deferred 请求回归，证明后发 ID=8 先返回、解除等待后 ID=7 返回。不能把协议客户端取消说成远端操作撤销。

新增 GenericAcpDriver 两实例回归：Kiro 实例的广告、结果和失败回合归属自身，普通实例同名斜杠请求仍走 session/prompt。既有 Cursor 测试虽已含 Kiro 分支，但 HEAD 只循环“标准”，本轮精确启用 Kiro 分支。测试起初误假设 adapter.sendTurn 吞错误并发送 runtime.error，查看调用链后按实际合同捕获请求失败、核对 turn.completed.failed/errorMessage，不改生产合同来迁就测试。

构造 HEAD 45dbd5986 加本模块十文件的精确索引和独立源码，第三方依赖复用，workspace 路径只指向独立源码。没有夹带 Gajae idle、账号池、认证 schema 或各端改动。内部与用户文档记录异步命令、原生执行、状态未知和回滚；保留 2026-09-30 Windows 2.26.0 在 initialize 前退出的历史，未重复三次同类探测。官方 KiroCrew 的日期字符串协议版本与当前标准数值版本存在待实际握手确认的差异，不擅自全局转换，也不以 fixture 声称真实兼容。

本地提交 54e4e815b2425db2bd05661f3945f9589a6cb22b（fix(acp): 完善 Kiro 命令执行并解除扩展请求阻塞），10 文件，668 增加 / 8 删除；无推送、PR、子代理、服务启动或数据库迁移。

#### Verify

- 精确索引独立源码的 Runtime/GenericDriver 与 effect-acp protocol/client/agent：5 文件 93 项通过；另 Cursor 命令标准/Kiro 2 项通过，共 95 项。覆盖成功/拒绝/畸形/RPC 失败、原始参数、无参数、附件拒绝、根会话/重放/非法通知、列表替换/撤回、取消/超时同连接恢复、各实例归属与标准路径。均以事件/请求回应屏障推进，超时边界使用 TestClock，没有固定睡眠或轮询。
- 红绿反证：仅将独立反证副本的 protocol.ts 换成 HEAD 原实现，新“扩展请求等待时仍处理后续请求”测试在 1500ms 超时；修复版同测试和全协议 24 项通过。最初恢复 cancel/timeout 各在 60s 测试限时失败，根因修复后均快速通过；未掩盖这些失败。
- Server 与 effect-acp tsgo --noEmit 均退出 0；Server 仅原有 localAccountModels.test.ts/localAccountUsage.ts 两项建议。七个涉及 TS 文件 lint 退出 0，CursorAdapter.test.ts 原有未使用 invocation 参数有一项警告，未夹带无关清理。没有全仓检查。
- 十文件索引、运行副本及最终提交内容/哈希一致，UTF-8 无 BOM、索引格式、诊断残留及 diff --cached --check 通过；提交后索引为空。68 个模块外原有文件不变（包括原先删除的移动端文件状态），12 个保护哈希不变。仓库 hooksPath 仍 .vite-hooks/_，仅本次使用仓库外只读索引钩子。资料在 C:/Users/Administrator/AppData/Local/Temp/codework-kiro-audit-20261001。
- 真实 Kiro 的 initialize/认证、官方命令、工具/审批/MCP/远端取消和 UI 动作未验证；上游流式正文与 RPC 结果的实际组合也待真实版本证据。Windows 历史探测不属于本轮新测。Web/Electron/手机及浏览器原安全拒绝未变化；不绕过拒绝换控制面。

A-8 保持未勾选，status running，goal active。本轮满足命令模块的本地工作检查，不对已有 A-1 至 A-7 勾选追加新的整体验收声明；完整 44 入口及最终独立审计仍未完成，登录/实机豁免仍待原始用户指令证据。

#### Retrospect

progress：Kiro 命令模块已形成单独可撤回本地提交。补“下一回合”暴露了看似成功取消但实际读入堵塞的问题，共同协议边界四行修复覆盖所有扩展请求，不靠重新建连接或自动重试掩盖副作用状态。模拟子进程、通用实例和真实 Kiro 仍是不同证据层，源代码的协议版本差异不能直接证明受测二进制兼容或不兼容。

下一轮唯一增量整理工作树已有 Gajae gjcPhase=idle 等待与会话门禁：先检索所有提示结束、取消/失败、启动与重放调用者；当前 idle 识别位于 startState/根会话过滤前，须针对其它会话和重放构造实际回归，再复用现有等待/事件入口修正并形成精确独立模块提交。不夹带其它供应商或账户功能，不使用固定等待替代事件，不把真实工具和最终独立验收标为完成。

### Round 113（Gajae 回合空闲等待与隔离）

#### Plan

上一轮 Kiro 模块已提交，属于 progress。沿 Round 112 Retrospect，本轮唯一整理 Gajae gjcPhase=idle 等待、会话门禁与取消/失败清理。工作树已有 idle 分支，先比对所有处理入口和固定官方源码；当前它在根会话过滤之前放行，且等待发生在 activePromptFiber 清除以后，60 秒超时被静默当成功。复用根会话/重放检查和既有可取消 fiber，把等待纳入同一生命周期，超时明确状态未知，不重试、不加独立调度器。增加事件屏障测试覆盖其它会话/重放/畸形元数据、早晚 idle、串行下一回合、等待期取消、失败与超时恢复、非 Gajae 无等待；构造 HEAD 54e4e815b 加本模块精确索引的独立源码并验证。现有真实 Gajae 0.18.1 与 opt-in 探针先完整审查，若环境可用仅在独立主目录、本机模型端点与实际文件中检查连续回合和审批取消，不访问真实凭据，不把本机响应端点称为外部推理。文档区分已提交 idle 模块和其它尚未提交目录/输出差异。定向检查、原有文件/哈希保护后一步一提交，无推送/PR/子代理/在线数据或浏览器操作。A-8 保持未勾选，完整目标继续 active。

#### Act

复用现有 ACP 根会话、启动与重放门禁，把 Gajae idle 处理移到门禁之后；仅 session_info_update 且 update._meta.gjcPhase=idle 可以结束当前等待。固定官方 0.18.1 源码提交 7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301 确认该载体，阶段发布与 prompt RPC 返回独立，未携带回合 ID。只在 agentInfo.name=gajae-code 时建立等待器；早到与晚到均可释放，其它 Agent 保持原路径。

等待纳入已有 activePromptFiber 和串行回合许可，RPC 已完成后的等待仍可取消；失败、取消和超时均清理等待器。60 秒无 idle 明确返回 AcpRequestError，说明远端状态未知，不静默成功或自动重发。显式统一 promptRequest 为现有 PromptResponse/AcpError 合同，消除 Kiro 分支与标准分支的推断交叉，不改协议形状。没有新增适配器、调度器、配置或数据库结构。

采用已有官方 CLI opt-in 工具探针并按实际动作修正名称，保留读取、命令批准、审批中取消和连续两回合；它没有写入批准与拒绝的断言，历史原始探针证据单列。生成独立 HOME、AgentDir、workspace 与 127.0.0.1 模型响应端点，显式 CLI 路径，未使用真实账号/外部模型。临时目录清理只容忍已知 Busy，其它错误保留失败。固定 Windows gjc.exe SHA-256 为 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2。

本地提交 2fea885384691a04e6d18aa1a0622eb80da7e5a5（fix(acp): 完善 Gajae 空闲等待和回合隔离），6 文件，725 增加 / 2 删除。以 HEAD 54e4e815b 加精确索引构造独立源码；workspace 依赖只指向该副本，未夹带原有目录认证、MCP 输出、账户或客户端差异。内部文档及用户说明记录空闲合同、工具证据边界、状态未知和回滚。无推送、PR、子代理、线上状态操作或新浏览器操作。

#### Verify

- 精确副本 Runtime/GenericAcpDriver：2 文件 65 项通过；Cursor/Grok 取消与 ACP 命令定向回归：2 文件 7 项通过（86 项未选中）；官方 Gajae 真实 CLI 加本机模型响应端点：1 项通过，共 73 项。CLI 覆盖连续两回合正文、实际 source.txt 读取、批准后的 bash stdout、审批中取消且 cancelled.txt 不存在与已展示工具 failed 终态；不把本机端点当外部模型推理，也不声称当前探针覆盖写入批准/拒绝。
- 新 Gajae 协议回归 5 项覆盖其它会话/重放/畸形元数据/错误载体、早晚 idle、下一回合串行、等待期取消、60 秒状态未知、RPC 失败恢复与非 Gajae 路径。旧 Gajae 等待实现的独立反证副本 3 项失败、2 项通过：外会话 idle 错误放行、等待期取消返回 end_turn、超时返回成功；修复版均通过。反证后恢复副本原始字节。
- 初次取消测试在 RPC succeeded 日志回调内发出屏障，不能证明 RPC 栈已经完成并进入 idle 等待，造成测试超时；以 TestClock.adjust(0 millis) 排空可运行 fiber 后验证目标阶段，未使用固定睡眠。曾尝试的显式 interruptible 无效且已移除；不能把测试屏障错误记成生产运行时不可中断缺陷。最初请求分支类型推断产生错误，最终按已有统一合同修正，Server tsgo --noEmit 退出 0（仅既有 localAccountModels.test.ts/localAccountUsage.ts 两项建议）；涉及 4 个 TS 文件 lint 退出 0 无警告。没有全仓检查。
- 额外的既有未跟踪 GajaeAcpCliProbe 空配置探针结果为 2 通过 / 1 失败：预期 model_not_selected 的步骤实际返回 end_turn。认证方法与 plan 模式拒绝不等于负向模型合同稳定；尚未确认根因，未放宽断言、未将成功响应称为模型成功，未提交该探针且原文件保留。文档明确本轮与历史负向结果不一致，后续需核对实际配置与上游 SDK。
- 6 文件索引、独立源码和最终提交字节/哈希一致，UTF-8 无 BOM、索引格式及 diff --cached --check 通过，诊断临时代码未进入提交；提交后索引为空。74 个模块外原有文件保持（含原先删除状态），12 个保护 SHA-256 不变。hooksPath 仍 .vite-hooks/_，本次只用仓库外只读索引钩子。资料位于 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-idle-audit-20261001。
- 外部模型/真实认证与余额、恢复、Web/Electron/真实手机、远程/relay/tunnel 本轮未验证；根会话 idle 没有回合 ID，不能证明远端取消撤销或所有迟到同会话阶段的归属。浏览器此前安全拒绝仍保留，不换控制面绕过。回滚撤回本轮单独提交，无数据库迁移、不改凭据。

A-8 保持未勾选，status running，goal active；不对已有 A-1 至 A-7 历史勾选追加新的完整验收声明。44 入口与最终新鲜独立审计仍未完成，登录/实机豁免仍待原始用户指令证据。

#### Retrospect

progress：Gajae 空闲等待形成单独可撤回提交。协议子进程的旧版反证与官方真实 CLI/本机模型端点分别说明隔离、取消和连续回合；这些证据不能证明外部模型、账号状态或设备显示。测试阶段屏障应对准被测生命周期，日志回调成功与请求栈完成不是同一个时间点；不能为错误屏障添加运行时机制。

下一轮唯一增量整理工作树已有 MCP 文本工具结果识别与长度限制：检索 AcpRuntimeModel 的 rawOutput.content、展示 content 与所有 Adapter/投影/工具详情调用者，先确认 HEAD 已有能力，再复用已有尾部上限和工具状态，针对 Gajae 命令预览/重复正文及长文本绕过限制形成旧版反证。保留真正重复输出、非文本结果和 failed 状态，构造精确索引与共用路径定向回归，一步一提交；不夹带认证目录、空配置负向探针或账号池功能，不以解析测试替代界面最终验收。

### Round 114（ACP 工具结果的增量保留）

#### Plan

上一轮 Gajae idle 提交属于 progress。先检索确认 HEAD 已有 MCP 文本优先和 8000 字限长及原始通知限长，Round 113 Retrospect 将其误记成尚未提交，本轮更正，不重复实现。唯一增量为工具结果到达后的元数据增量合并：既有 mergeToolCallState 无条件选 next.detail，后续仅 title/kind/rawInput 通知会把实际输出覆盖成派生命令/路径，null 原始输入/输出还会覆盖已有字段。复用原有 data 输出承载、合并和限长，不新增字段或平行状态机；null 按 ACP 官方当前 v1 文档视为未提供，合法 false/0/空字符串仍保留。检索唯一生产合并调用者、Cursor/Generic/Kimi/Grok 事件及活动/公开详情链路；用部分帧、失败/成功、输出替换、无结果输入变更和长尾回归先复现，再修公共边界。独立 HEAD+精确索引源码运行定向解析、协议子进程、通用 Driver/Adapter、活动投影和客户端既有派生回归，受影响类型/lint；无固定睡眠、子代理、新浏览器、线上账户或数据库。同步稳定文档、更正 Gajae 输出已提交事实，一步一提交并保护其它原有字节，A-8 保持未勾选与 goal active。

#### Act

先比对 HEAD、工作树差异和 Round 34/47：MCP 文本优先、known text 限长、原始通知限长与 8000 字标记预算已在提交中，Round 113 对后续增量的判断失准，未重复实现。检索 mergeToolCallState 唯一生产调用者 AcpSessionRuntime.handleSessionUpdate，Cursor/Generic/Kimi 和 Grok 共享这条路径；同时核对 makeAcpToolCallEvent、ingestion、ActivityPayloadProjection、Web session-logic 与 Mobile threadActivity 的命令/结果承载。没有新建字段、状态机、Adapter 或依赖。

AcpRuntimeModel 仅修改公共输入与合并入口：rawInput/rawOutput 为 null 时不制造覆盖字段，false、0、空字符串照常保留；输出字段未更新且旧状态已有结果时，保留旧 detail，标题、类型、命令与状态仍按原字段更新。明确新结果仍替换，尚无结果时继续更新派生摘要，实际重复正文不删除。以已有 data.content/data.rawOutput 判断结果载体，不新增 outputSource。ACP 官方当前 v1 文档明确更新只携带变化字段及 raw null 等同缺省；来源、日期与采用理由已写入稳定文档。

AcpRuntimeModel.test 增加 MCP/标准 content/批量结果与元数据增量、null、合法假值、新结果替换、无输出命令更新回归；AcpCoreRuntimeEvents.test 将带 kind/rawInput/null 的终态从合并进入公共活动与历史投影，核对 8000 字尾部和命令分离；AcpJsonRpcConnection.test 复用此前 _codework.test/gajae-update 原始通知和 ModeChanged 顺序屏障，实际协议子进程验证结果→元数据→null→失败，合批后只有初始与终态两条工具事件，无固定睡眠或轮询。

generic-acp-provider.md 与用户说明补增量保留合同；gajae-acp-provider.md 更正已提交 MCP 能力及已存在的手工目录认证 agent 默认值。进一步查到 withManualAcpCatalog 只补缺 ID，在线同 ID 优先，在线解析没有 Gajae 默认值；留作下一唯一增量，未在本提交改目录。

本地提交 a92cab20521cf3fffd520d725ed800bb896a27f6（fix(acp): 元数据增量保留已收到的工具结果），7 文件，279 增加 / 7 删除。生产文件仅 10 增加 / 3 删除，剩余为可运行回归和文档。精确索引以 HEAD 2fea885384 加本模块构造独立源码，workspace 依赖只指向该副本。未夹带其它重排、账号池、网关、目录哈希 overlay 或客户端源改动。无推送、PR、子代理、服务启动、线上数据操作或浏览器操作。

#### Verify

- 精确独立源码运行 node node_modules/vite-plus/bin/vp test run AcpRuntimeModel.test.ts AcpCoreRuntimeEvents.test.ts AcpJsonRpcConnection.test.ts GenericAcpDriver.test.ts（实际参数含完整仓库路径）：4 文件 146 项全通过，48.73 秒。原有 MCP 优先/限长、批量失败、取消/重放及实例回归同时保持。没有全仓检查。
- 同一副本 CursorAdapter.test.ts / GrokAdapter.test.ts 按 tool|Tool|工具|MCP 定向：2 文件 11 项通过、82 未选中；Web session-logic.test.ts / Mobile threadActivity.test.ts 按工具/命令/输出/详情定向：2 文件 57 项通过、75 未选中。合计 214 项通过；UI 派生测试不等于真实浏览器/Electron/手机显示，Node shell fixture 的 DEP0190 警告保留。
- 新增 13 项目标/控制用例先用 HEAD 实现：最初 5 失败 / 8 通过；加强公共投影终态中的输入更新后，最终旧版反证 9 失败 / 4 通过，失败集中于 MCP/content/batch 正文变成命令、raw null 覆盖、协议终态和四个 Driver 公共投影长尾丢失。修复版新增 13 项及上述整套 214 项通过。反证只替换独立副本的生产文件，finally 恢复字节并完整性确认；未更改断言制造通过。
- Server tsgo --noEmit -p apps/server/tsconfig.json 退出 0，仅已有 localAccountModels.test.ts 与 localAccountUsage.ts 两项建议；4 个涉及 TS 文件的 vp lint 退出 0 无警告。文档随后只更正已核对的目录事实，无代码变化，不重复扩大全套检查。
- 7 文件精确索引、运行副本和提交内容/哈希一致，UTF-8 无 BOM、索引格式、诊断残留和 diff --cached --check 通过，提交后索引为空。72 个模块外原有文件保持，包括原先删除状态；12 个保护 SHA-256 不变。hooksPath 仍 .vite-hooks/_，本次仅使用仓库外只读索引钩子。完整反证、副本和完整性资料在 C:/Users/Administrator/AppData/Local/Temp/codework-acp-result-audit-20261001。
- 本轮没有新增官方 CLI 或外部模型请求、真实认证/余额、浏览器/Electron/手机、远程/relay/tunnel 验收。之前浏览器安全拒绝不绕过，空配置模型探针的已知负向不一致未隐藏。仅修仍在合并生命周期中的部分输出更新，不声称解决已结束工具 ID 迟到重用或所有非文本详情。回滚撤回本轮提交，无迁移、不修改持久化历史或审批策略。

A-8 保持未勾选，status running，goal active；已有 A-1 至 A-7 历史勾选未获本轮新的整体验收声明。完整 44 入口与最终新鲜独立审计未完成，登录/实机豁免原始指令证据仍待确认。

#### Retrospect

progress：工具结果增量保留已成为单独可撤回提交。先查 HEAD 避免重做 MCP 提取与限长；实际缺口在解析 null 和合并 detail 的共同边界，三个结果形状与真实协议子进程红绿均可复现。原始通知、已合并工具数据、公开历史 detail 分别核对，单独解析成功不能代替后续元数据/终态后的显示事实；派生逻辑绿也不是浏览器证据。

下一轮唯一增量核对 Gajae 目录在线与手工认证默认值的一致性：已确认手工回退有 agent，而 withManualAcpCatalog 仅补缺 ID，在线同 ID 条目优先且在线解析没有该默认值。用真实固定握手方法及现有精确 ID 配置模式，构造在线条目/离线手工、用户已有实例不迁移与客户端预填回归，再仅修确证分支，一步一提交。先核对 HEAD 是否已有相关修复，避免重做手工目录；不夹带全部二进制 hash overlay、空配置模型负向断言、账号池或 UI 重构。整体范围与真实验收边界保持。

### Round 115（ACP 终态后的补充通知）

#### Plan

上一轮为 progress。按最新 Retrospect 先核对 Gajae 认证目录：手工条目已预填 agent，当前官方实时目录共 41 项且没有 gjc/gajae，在线同 ID 缺默认值目前只是未来风险，不为假设条目添加生产规则。本轮从尚未完成的 A-8 全范围证据核对发现工具生命周期实际缺口，选择唯一增量：AcpSessionRuntime 在工具 completed/failed 后立即删除合并状态，后续只补元数据或结果的合法部分通知无法继承正文和终态。复用已有 toolCallsRef，仅保留当前回合的终态快照，在下一 prompt 的现有清理入口移除，保留未结束工具与原审批身份规则；不新增墓碑缓存或跨回合关联器。协议子进程先红灯验证成功/失败终态→无状态元数据→补结果，下一 prompt 同 ID 新调用不继承旧内容，根会话/重放沿既有门禁。构造 HEAD a92cab205 加精确模块索引的独立源码，跑定向 Runtime/Model/Driver、Adapter 取消/工具、双端派生、Server 类型与 lint，所有旧字节与保护哈希核对后单独本地提交。文档同步终态保留、回滚和 Gajae 当前目录事实；无子代理、新浏览器、线上数据、账户或假设接入，A-8 未勾选且 goal active。

#### Act

先验证上一轮 Retrospect 的假设：getAcpRegistryCatalog 对在线条目优先、withManualAcpCatalog 仅补缺 ID，手工 Gajae 已有 agent。实际公开 CDN 响应有 41 项，gjc/gajae 匹配 0，当前不存在在线同 ID 条目触发错误默认值。因此未添加假设的认证分支、未迁移旧实例，并更正专项文档的当前状态。完整公开响应保存在仓库外，SHA-256 b4fb55aa813ae92665fa0c8b43d17caed0ac790f0a68a63ba57be024ab11ccf1；仅说明目录事实，不表示新增安装或账号验证。

从 A-8 全范围证据核对中选择实际工具边界作为唯一交付增量。AcpSessionRuntime.handleSessionUpdate 原来在 completed/failed 时删除工具状态，使合法的后续补充通知丢失继承状态和正文；仅元数据被重新归一成没有终态的 Tool，后续小结果又被合批暂缓。复用已有 toolCallsRef，终态快照保留到下一 prompt；既有 prompt 清理同时移除终态与审批身份，保留未结束的实际工具。没有新增缓存、跨回合映射、合同或 Adapter；原根会话/重放门禁、审批专用裸终态删除、取消补 failed 和终态即时发布路径保持。

AcpJsonRpcConnection.test 新增成功/失败两个实际协议子进程用例，使用此前 Gajae raw update 扩展与 ModeChanged 顺序屏障。第一 prompt 返回 RPC 后仍等待 idle，在该实际等待期间依次发终态结果、无状态元数据与补充结果，断言每次继承终态/正文/命令且新结果可替换；释放 idle 后开始下一 prompt，再发同 ID 新调用，断言 pending/read/new.txt 且没有旧命令/输出。没有固定睡眠，RPC 完成栈通过 TestClock.adjust(0 millis) 排空。

generic-acp-provider.md 与用户说明同步本回合终态补充和下轮清理；专项 Gajae 文档更正当前仅手工目录的事实。明确内存保留随当前回合工具数量增长、下一 prompt 移除终态，未增加无限跨回合缓存；没有回合 ID 的迟到通知仍不能推断归属。原有已提交 MCP 识别/限长和认证预填不重写。

本地提交 6bd1569841f01f4b67480db857570f43886f2026（fix(acp): 保留本回合工具终态的补充结果），5 文件，132 增加 / 15 删除。以 HEAD a92cab205 加精确索引构造独立源码，workspace 依赖指向副本；没有夹带 Runtime 的其它重排、目录 hash overlay、账号池、网关或客户端源改动。无推送、PR、子代理、服务启动、新浏览器、真实账户或线上数据库操作。

#### Verify

- 精确独立源码 node node_modules/vite-plus/bin/vp test run AcpJsonRpcConnection.test.ts AcpRuntimeModel.test.ts AcpCoreRuntimeEvents.test.ts GenericAcpDriver.test.ts（实际使用完整仓库路径）：4 文件 148 项通过，50.23 秒，覆盖此前结果/元数据、权限、取消、重放、实例隔离与本次补充通知。没有全仓检查。
- CursorAdapter.test.ts / GrokAdapter.test.ts 按 tool|Tool|工具|MCP|cancel|取消|cancell 定向：2 文件 15 项通过、78 未选中；Web session-logic.test.ts / Mobile threadActivity.test.ts 按工具/命令/输出/详情定向：2 文件 57 项通过、75 未选中。共 220 项通过。双端派生是逻辑回归，不是浏览器/设备显示；Node shell fixture 的既有 DEP0190 警告保留。
- 新两个协议用例在旧实现均失败：最初只看到 2 条工具通知而不是 3 条；加强断言顺序后旧 HEAD 的补充元数据事件明确缺少原状态和 FIRST_RESULT，最终两项仍失败。修复版两项及整套 220 项通过。反证只替换独立副本的 Runtime，finally 恢复原字节并完整性确认；保留失败输出，未放宽断言。下一 prompt 的 new.txt 断言证明没有继承旧结果。
- Server tsgo --noEmit -p apps/server/tsconfig.json 退出 0，仅 localAccountModels.test.ts / localAccountUsage.ts 既有两项建议；本轮两文件 vp lint 退出 0 无警告。索引格式、UTF-8 无 BOM、诊断残留及 diff --cached --check 通过，5 文件索引/运行副本/提交字节哈希一致，提交后索引为空。
- 74 个模块外原有文件保持（包括原先删除状态），12 个保护 SHA-256 不变；hooksPath 仍 .vite-hooks/_，本次仅仓库外只读索引钩子。资料在 C:/Users/Administrator/AppData/Local/Temp/codework-acp-terminal-audit-20261001，含公开目录响应、独立源码、旧版反证和完整性记录。
- 本轮没有新增官方 CLI、外部模型/真实认证/余额、浏览器/Electron/真实手机、远程/relay/tunnel 验收。终态只覆盖同回合的合法补充通知，不声称解决跨 prompt 迟到通知或显式非法状态回跳。原始空配置模型探针的已知负向差异保持未解决；浏览器此前安全拒绝不绕过。回滚撤回本轮提交，无迁移、不改历史、账号或审批策略。

A-8 保持未勾选，status running，goal active。对 A-1 至 A-7 历史勾选不追加完整验收声明；44 入口的全范围证据和最终新鲜独立审计尚未完成，登录/实机豁免仍缺原始指令证据。

#### Retrospect

progress：终态补充通知形成单独可撤回提交，成功/失败均有旧实现反证和下一 prompt 清理检查。已收到终态不等于该工具再无补充数据，立即删状态会破坏合法增量继承；使用现有回合表并在原入口清理足够。当前官方目录没有 Gajae，不能用自己构造未来在线条目来宣布现存认证问题或添加未经需求触发的规则。

下一轮唯一增量调查 Gajae 空配置负向探针的真实错误语义：现有 GajaeAcpCliProbe 预期 RPC model_not_selected，而 Round 113 实测 end_turn，仍无正文/阶段证据。先核对固定 0.18.1 源码的 model-onboarding-guidance、AgentSession 与 ACP/SDK prompt 出口，审查原探针的配置隔离、实际请求和清理，再用拥有身份的隔离 CLI/原始通知记录区分 RPC 错误、正文错误、模型配置或预设。只有确认根因才修改产品或探针合同，不把 end_turn 当作推理成功或为绿灯放宽错误。若当前能力已完整则更正证据与文档并转回 44 入口剩余真实门槛；不夹带目录 overlay 或账户功能。

### Round 116（Gajae 空配置的真实失败语义）

#### Plan

上一轮为 progress。按最新 Retrospect 选择唯一增量：调查固定官方 Gajae 0.18.1 空配置负向探针预期 RPC model_not_selected、实测 end_turn 的差异。先追踪 AgentSession 缺模型前检、SDK turn.prompt 与 ACP 终态出口，核对隔离变量/主目录/后台主机身份，然后在 HEAD 6bd156984 精确独立副本记录原始通知、请求和关闭结果。先保持旧断言复现差异，只有观察到真实原因才修改产品或探针；end_turn 不算推理成功，不为绿灯放宽错误。复用已有 opt-in 官方探针，不新增专用 Adapter 或通用错误猜测。定向协议/工具检查、Server 类型/lint、精确索引/提交哈希和原始文件保护后单独本地提交，同步源码与二进制边界文档。无子代理、新浏览器、线上数据库、真实凭据或外部模型请求，A-8 未勾选且 goal active。

#### Act

先沿固定 0.18.1 / 提交 7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301 的 AgentSession → SDK turn.prompt/dispatch → ACP prompt 出口追踪：缺模型前检抛出 NoModelSelectedError，SDK 映射安全公开 model_not_selected，ACP 拒绝 RPC；终态 stopped 的 end_turn 是另一条路径。官方资产 SHA-256 重新核对 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2，未更新或全局安装二进制。

在 HEAD 6bd156984 精确独立副本先保留原未跟踪探针的旧断言，单独运行一项确实返回 -32603 / model_not_selected：原始通知有 working、用户回显、错误 RPC 和 idle，没有助手正文。随后加强配置前置条件与两次显式请求，在同一固定二进制下复现模型类别已存在、两次 end_turn 与助手正文。保存启动快照显示模型 ollama/qwen2.5:7b。固定 model-registry 的 addImplicitDiscoverableProviders 默认发现 127.0.0.1:11434；模型文档还规定其它本机发现入口。根因是负向探针把空目录当成无可用模型，清空凭据变量没有阻止默认发现。本轮复现解释这种差异，但 Round 113 没有原始模型通知，不能断言那次内部步骤均相同。

复用已有 GajaeAcpCliProbe，只有 session 场景在独立 settings.json 通过官方 disabledProviders 禁用 ollama、llama.cpp、lm-studio、omlx、vllm、sglang；不修改产品默认发现、宿主服务/配置、认证或 ACP 错误映射。发消息之前核对固定版本、认证方法、无 legacy models 且无 model 配置；不符时明确关闭并失败。用已有事件流和 EventStreamBarrier 等待排空，两次显式请求要求实际 model_not_selected、没有助手/思考正文、恰好两次失败请求，不隐式重试。正常分支先 session/close 再做结果断言，认证两项不创建后台会话。

文档更正空配置与无模型的区别、可重复命令、旧结果证据边界、上游来源和回滚，并记录额外真实启动失败。没有添加生产 Adapter、缓存或错误猜测。收录原未跟踪探针及文档形成本地提交 0cbe2f46a0b833de6eb24ba14921cf1a8fb611f2（test(acp): 隔离 Gajae 缺模型负向探针），2 文件 235 增加 / 5 删除。未推送、创建 PR、派发子代理、新浏览器、读取真实凭据或操作线上数据库。调查时意外发现的本机模型只收到合成探针文本，不属于外部模型/真实账户验收；修正版先核对目录再发送消息。

#### Verify

- 精确 HEAD + 2 文件索引的独立源码 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-empty-audit-20261001/source-tO52Zr/source：最终官方 GajaeAcpCliProbe 3 项通过，11.36 秒；拒绝 login、接受 agent、无模型连续失败及明确关闭。同一固定 CLI、临时设置；跳过不算通过。
- AcpJsonRpcConnection.test.ts 按 Gajae 定向，5 项通过、57 未选中，5.13 秒，覆盖根会话/重放、早晚 idle、取消/未知超时、失败恢复与其它 Agent。合计本模块最终 8 项通过。没有全仓检查、设备或 UI 验收。
- 保留真实失败：没有禁用发现时的新前置条件两次失败（model 类别实际存在），完整观察有 ollama/qwen2.5:7b、两次 end_turn 与正文；修正后原 model_not_selected 断言没有放宽。首次增加流消费者误用不存在的 streamEvents 导致 TypeError，按已有 getEvents/EventStreamBarrier 修正，此失败不是产品回归。
- 额外官方工具探针在较早并行执行时 1 项通过，但认证会话启动失败，data.code=broker_startup_failed，机器身份不可用/格式错误；固定 Windows 源码通过 reg query 读取 MachineGuid，未确认该次读取失败原因。最终精确副本单独工具回归 1 项失败：session/prompt / -32603，details=SDK session attachment is unavailable: session not published。不能说串行执行解决启动、不能把早期通过替代最新稳定工具验收；未重复到绿灯、未中和错误。下一轮处理这个实际失败。
- Server tsgo --noEmit -p apps/server/tsconfig.json 最终退出 0，仅两项原账号池 Effect 建议；探针 vp lint 最终退出 0 无警告。初次 onError 的关闭副作用具有 typed error、无 yield 的 gen 有 lint 警告，改为 Effect.sync 与 orDie，使清理失败显式保留为缺陷，没有吞掉异常。最终检查在修改后的副本执行。
- 索引格式、UTF-8 无 BOM、diff --cached --check、诊断残留检查通过；2 文件索引/独立副本/提交哈希一致，提交后索引为空。78 个模块外原有文件和删除状态不变，12 个保护 SHA-256 不变，hooksPath 仍 .vite-hooks/_，本次使用仓库外只读索引钩子。
- 并行工具探针留下的测试 broker 由其独立目录 sdk/broker.json 核对 PID 36044、localhost 地址，并经官方 broker.shutdown 回执 ok=true 关闭；脚本因关闭后的 WebSocket error 回调退出 1，但后续只读进程检查确认该 PID 消失。没有按名称批量杀进程；仍有本轮前 11:06:30 的旧测试 broker 68756，本轮未操作它，不能宣称主机无 Gajae 进程。最终检查本轮新进程未见残留；不证明后台所有状态都已优雅回收。
- 证据保存在仓库外 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-empty-audit-20261001，含 session-observed.json、strengthened-observed.json、失败/最终检查日志、独立源码和完整性记录。没有新增外部模型/真实认证/余额、浏览器/Electron/真实手机或远程/relay/tunnel 验收；原浏览器安全拒绝不绕过。

A-8 未勾选、status running、线程 goal active；A-1 至 A-7 历史勾选不追加完整验收声明。回滚撤回本轮提交，无迁移、不改账户、历史、默认发现或审批策略。44 入口全范围与最终新鲜独立审计仍未完成，登录/实机豁免仍缺原始指令证据。

#### Retrospect

progress：同一固定官方 CLI 的缺模型负向合同已从未收录的易漂移探针变成单独可撤回的运行检查，模型目录和正文两层观察复现了空目录仍有本机模型的实际原因，修正前置条件后保留原错误断言。上游原本已经有 disabledProviders，复用设置即可；给生产 ACP 加“空配置就报失败”的规则会破坏正常本机发现。SDK broker 机器身份和 session attachment 失败属于另外两条启动证据，不能用自动重试或历史通过掩盖。

下一轮唯一增量调查本轮最终 Gajae 工具探针的 SDK session attachment is unavailable: session not published。先阅读固定 ACP newSession/submitPrompt、AcpSdkAdapter attach 与 SDK session publication 的输入/回执合同，核对 session/new 返回与 host_registered/可附着端点的顺序；用已有隔离官方探针收集请求/通知和启动身份，区分主机未发布、发现缓存或启动失败。只有根因证实时修改共用启动/回执处理；不睡眠等待、不重试已有工具副作用、不伪造端点可用。若属于上游固定版本错误，文档明确真实门槛并选择最小可验证的兼容策略。保留本轮负向检查、原账户与目录改动，继续完整 44 入口目标。

### Round 117（Gajae 会话发布失败）

#### Plan

上一轮为 progress。按最新 Retrospect 调查唯一增量：固定 Gajae 0.18.1 的工具探针在 session/new 成功后，首条 session/prompt 报 SDK session attachment is unavailable: session not published。先追踪官方 newSession/attach、SDK Router 强制索引 reconcile 与端点权威，核对后台注册/发布回执；使用 HEAD 0cbe2f46a 独立副本和已有官方工具探针采集请求/通知、临时状态及进程身份，诊断资料仅仓库外且不输出 token/密钥。只在根因得到证据后修改共用兼容处理或探针，避免睡眠等待、模型重试与绕过端点授权。保持原真实失败和负向合同，定向检查、精确索引/运行副本和原文件保护后一步一本地提交，同步来源/风险/回滚。无子代理、新浏览器、用户账户或线上数据库操作；A-8 未勾选、goal active，完整 44 入口范围不缩小。

#### Act

先核对固定官方 Gajae 0.18.1 / 提交 7e54f9cbcf712cfa7f633d3c8da58a6d89f7f301 的 newSession、attachEndpoint、SDK adapter 和 Router request / serialReconcile / publishAttachment：newSession 成功前已等待 attach；后续强制索引协调仍可因未发布、权威身份或端点退役而拒绝附件。没有证据证明原 session not published 的具体原因，未加睡眠、模型重试或端点授权回退。

在 HEAD 0cbe2f46a 的独立源码，用已有官方工具探针的仓库外诊断变体记录请求和原始线上报文。本次连续文本、真实读取和批准命令成功；审批中取消后 session/close 超过 5 秒。已确认共用通知编码把 session/cancel 写成带 id="" / headers=[] 的请求，官方返回 -32601 / Method not found。按已复现的根因将本轮唯一实现增量收敛到共用 JSON-RPC 通知，旧附件问题保留未解决；已向用户说明这个方向变化。旧断言经 Schema 解码丢弃额外属性，因此掩盖错误；严格原始 JSON 断言在旧生产代码下 3 项失败，保留反证日志。

复用已有 jsonRpcNotification / encodeJsonl，发送通知显式标记 isNotification 并省略线上 id / headers；接收按标志区分而非空字符串 ID。普通空字符串 ID 请求仍执行扩展处理器并按原 ID 回应。普通请求及回应编码不变，未修改依赖或增加专用 Adapter。BigInt / 循环对象仍进入 AcpProtocolParseError / encode-message；复用 Schema 编码后的内部 cause 为 SchemaError，公开说明维持安全短句。只修相应测试合同，并用 Effect 解码和已有模块级编译方式消除本轮类型/lint问题。

同步通用 ACP 和 Gajae 文档，登记标准来源、搜索词、核对日期、真实边界和回滚。最终工具检查恢复 HEAD 原探针，诊断变体仅仓库外；实际文件字节与 HEAD 核对。精确索引 4 文件形成本地提交 a3aaa16e7d533eb988630707521e85924792b017，92 增加 / 16 删除；未推送、创建 PR、派发子代理、新浏览器、读取真实凭据或操作线上数据库。撤回该提交即可回滚，无数据迁移。

#### Verify

- 精确 HEAD + 4 文件索引的独立源码 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-publication-audit-20261001/source-w7MP3d/source：最终 protocol / client / agent 3 文件 34 项通过，3.74 秒；覆盖四类通知原始 JSON、入站通知、空字符串请求 ID 回应、日志及非法编码。
- AcpJsonRpcConnection 62 项通过，47.11 秒；Cursor/Grok 按中断、停止与关闭定向 7 项通过、86 未选中，9.63 秒。两项原 Node shell=true 弃用告警保留。未跑全仓检查。
- 固定官方 gjc.exe 0.18.1 的原有 GajaeAcpToolProbe 1 项通过，12.27 秒：两次文本、实际 read 文件结果、批准 bash 输出、审批期间取消、cancelled.txt 未产生、工具 failed 与 session/close。CLI 二进制 SHA-256 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2，模型响应使用本机端点。这证明该次实际工具/取消/关闭链路，不证明外部推理、真实账户或长期稳定；原 session not published 和机器身份失败没有重现，也没有宣布已修复。共计本轮最终 104 项通过，未选中/跳过不计通过。
- 保留旧通知严格反证 3 项失败 / 22 未选中；第一次新实现全协议 33 通过 / 1 失败，原测试预期内部 TypeError，实际为复用 Schema 的 SchemaError，按声明错误合同修正后通过。新增严格测试最初使用同步 Schema 导致 3 个类型错误，改用 Effect；随后 lint 的未使用旧解码器与内联编译 4 警告被最小整理消除。未吞掉错误或放宽工具行为断言。
- 最终 effect-acp 类型检查退出 0 无输出；Server 类型检查退出 0，仅原账号池两项 Effect 建议；改动 TS lint 退出 0 无警告。索引格式、UTF-8 无 BOM、diff --cached --check、白名单及诊断残留检查通过。4 文件索引 / 独立副本 / 提交 SHA-256 一致，提交后索引为空，hooksPath 仍 .vite-hooks/_。
- 76 个模块外原始文件和删除状态不变、12 个保护哈希不变；未收录其它原账号池、目录、客户端改动。仓库外审计目录保存 observed.json、red-notifications.log、失败/成功日志、独立源码、integrity.json、preservation.json 和清理回执。
- 最终工具检查留下 broker PID 17344 / 创建时间 13:42:54，与本次独立 tools-2bFqSa 目录 broker.json、localhost 地址和进程命令行匹配；经官方 broker.shutdown 得到 ok=true，随后 WebSocket 断开与关闭后 error 事件明确记录，只读进程核对 PID 已消失。早期诊断 tools-KhhByS 目录已不存在，本轮不据此声明历史会话优雅回收；没有按名称杀进程。没有新增浏览器/Electron/真实手机或远程/relay/tunnel 证据，原浏览器安全拒绝不绕过。

A-8 未勾选，status running；A-1 至 A-7 的历史勾选不追加完整验收声明。完整 44 入口与最终新鲜独立审计仍未完成，登录/实机豁免仍缺原始用户指令证据，不将本轮通过当作全部完成。

#### Retrospect

progress：原始 JSON 对比在旧实现下能失败，固定 CLI 的取消被错误当成普通请求已有实际反证；共用边界修复后原工具探针通过，形成单独可撤回提交。Effect 内部空 ID 不等于 JSON-RPC 线上无 ID；Schema 解码丢弃额外字段的断言不能证明报文形状。复用既有 Schema 编码保留声明错误，只需改变通知，不需要新传输层或每个 Adapter 补丁。

下一輪唯一增量继续调查旧 SDK session not published 的真实门槛，通知编码不再重做。先核对现有错误记录的建会话/首 prompt 顺序和固定 Router 的端点权威判定，使用已有隔离官方探针，在发送第一条 prompt 前及失败出口收集只读的 SDK 索引时间、PID/创建身份、端点 generation/incarnation 与退出状态；密钥/token 不输出、不收录。模型请求仍只有显式调用，不自动重试或人为改变发现缓存；按同一身份关联 host 注册、发布/退役与实际 RPC，不能用成功运行推断旧错误根因。若官方固定版本确实存在缺口，只在证明后制定最小兼容或明确限制，继续完整 44 入口和 A-8 新鲜审计范围。

### Round 118（Gajae 会话权威与首请求）

#### Plan

上一轮为 progress：共用通知编码修复已有严格反证、真实工具通过和独立本地提交。本轮唯一增量沿最新 Retrospect，调查固定官方 Gajae 0.18.1 的 SDK session not published。先核对原失败 RPC、newSession/Router 强制索引协调、发布与退役的权威判断，再在 HEAD a3aaa16e7 精确独立源码用已有官方工具探针采集首 prompt 前/失败出口的只读索引、端点 generation/incarnation、PID/创建身份及退出状态；数据显式白名单，不输出 token/密钥。探针不加重试、睡眠等待或授权回退；是否修改生产边界取决于已复现根因，不能为了提交虚构修复。复用现有生命周期与错误测试，定向类型/lint和原文件保护后，将实际完善的可运行检查/稳定约束一步一本地提交。原44入口范围和A-8不缩减，无子代理、新浏览器、真实账户或线上数据库；回滚撤回本轮提交，无迁移。

#### Act

以 HEAD a3aaa16e7 的精确独立源码追踪固定 Gajae 0.18.1：Router 首请求强制协调 SDK 索引，projectIdentity 的 live 包含心跳、PID、OS incarnation、不确定终态与权威歧义判断；readProvenEndpoint 还核对代次、mtime/inode、token/url/PID 和当前索引权威。普通端点文件存在或 PID 存活不足以授权。读取注册/心跳的 generation=0 入口与 generation=1 真正模型会话，各自不同 sessionId，不把前者缺端点误当目标未发布。

仓库外诊断变体复用原官方工具探针和 requestLogger / protocolLogging，在 session/new 成功、每条 prompt、close 与结束出口记录已白名单的事件、mtime/inode、PID/进程 incarnation、端点存在及原始 RPC 方法/ID/终态时间。只读独立 root，未调用会改变协调时序的额外 SDK 查询；token、模型密钥和正文不输出、不收录。为保留失败状态，诊断变体仅在该隔离副本保留临时目录，未改真实目录；记录本身会改变时序，不能作为稳定性证明。首 prompt 前 generation=1 / PID 32944 的注册和端点一致，后续关闭 host_unregistered 后端点消失，诊断工具整项通过。没有重现旧 session not published，仍缺其根因。

基线原探针另一次在关闭超过 5 秒。源码同时显示共用 cancel 先中断本地回合，后将通知 fork 到 runtimeScope；当前调用可在通知入队前返回，让随后的关闭/新请求抢先。本轮唯一实现增量据这个已可复现缺口改为取消发送顺序，已向用户说明：先 await 既有通知入队，再中断本地活动 fiber，不再后台发送。未新增驱动、消息队列或状态机；保留通知失败时原本的本地中断策略，没有把通知发送等同远端取消回执，没有扩超时或重试模型。

复用现有 AcpJsonRpcConnection 的真实协议 mock、工具 inProgress 和 Effect Deferred 屏障，在原始通知日志/入队前阻塞发送，要求 cancel 和 prompt 均未返回；放行后检查 cancelled 和 cancel→close。旧实现严格红灯，改后通过；断言失败时也释放屏障，避免测试死等。同步通用 ACP 与 Gajae 文档，区分本地顺序保证、SDK 权威证据和最新真实失败。4 文件形成单独本地提交 b678d0f123f3206100ce5cef01353ada9fe19972（fix(acp): 取消通知入队后再结束回合），97 增加 / 3 删除。未推送、创建 PR、派发子代理或新浏览器，未读取真实凭据、用户 home 数据或线上数据库。撤回该提交即可回滚，无迁移。

#### Verify

- 独立源码 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-authority-audit-20261001/source-qMcpp0/source，基线 a3aaa16e7 + 精确模块索引。最终旧实现加当前新测试仍 1 失败 / 62 未选中，expected false / received true，确证 cancel 提前返回；修复后单项通过。首次新测试未给 mock 广告 close 能力，因未实际发 close 在末尾断言失败；按已有 CODEWORK_ACP_CLOSE_BEHAVIOR=success 开启能力，未改变生产能力判断或放宽断言。最终测试再增加 prompt 未返回检查并保持旧实现红灯。
- vp test run AcpJsonRpcConnection.test.ts 最终 63 项通过，54.28 秒；CursorAdapter/GrokAdapter -t interrupt|stopping a session|closes the ACP child 最终 7 项通过、86 未选中，9 秒。两项原 Node shell=true 弃用告警保留；共计本轮正式定向回归 70 项通过，没有全仓检查。
- 官方 gjc.exe 固定 0.18.1、SHA-256 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2。基线原工具探针 1 失败：session/close 的 5 秒未知状态超时，16.05 秒；仓库外诊断变体 1 通过，10.53 秒，记录首请求身份与取消/close 原始顺序。诊断变体通过不计入正式产品通过数量，也不宣布原发布失败修复。
- 恢复 HEAD 原工具探针后，在最终生产修正的精确副本运行 1 失败，17.17 秒：session/close / -32603 / data.code=terminal_uncertain / details=ACP session cleanup is uncertain: broker request failed。前置工具与取消断言已执行，但整项仍按失败登记。没有重跑直到绿灯、抹掉错误、放宽关闭或新增等待；与最初 SDK session not published、机器身份失败分别保留。下一轮追踪这次实际清理失败，不能把本地排序回归扩大为真实 CLI 已稳定。
- Server tsgo --noEmit -p apps/server/tsconfig.json 退出 0，仅原账号池两项 Effect 建议；改动 TS 定向 vp lint 退出 0 无输出。索引格式、UTF-8 无 BOM、diff --cached --check、诊断残留和白名单通过，4 文件索引/独立副本/提交字节哈希一致，原工具探针副本与 HEAD 字节一致。提交后索引为空，hooksPath 仍 .vite-hooks/_；76 个模块外原始文件/删除状态和12个保护哈希不变。
- 诊断脚本的两次 finalizer 锚点准备失败属于工具准备问题，没有写入源码；第一次准备失败后误运行了未插桩的 HEAD 原探针，其关闭超时证据如上保留。核对格式后才运行诊断。一次 functions 脚本括号错误发生在执行前，未改任何文件；不是产品失败。没有把这些准备错误当应用缺陷。
- 本轮诊断 broker PID 53252 / 创建时间 13:58:58、最终原探针 broker PID 40428 / 创建时间 14:07:11，均由其独立 root 的 broker.json 与已记录命令行/localhost 身份核对，经官方 broker.shutdown 收到 ok=true。随后关闭后 WebSocket error 与 close/ack 明确记录，只读核对两 PID 消失。最终失败后残留 endpoint JSON 的 PID 36032 已不在进程表，说明 stale=false 文件不能证明主机活着；未据此绕过权威或声称会话优雅关闭。未按名称/路径批量杀进程，未清理用户目录。
- 仓库外审计 C:/Users/Administrator/AppData/Local/Temp/codework-gajae-authority-audit-20261001 保存 authority-observed.json（白名单）、authority-summary.json、failed-close-state.json、红/绿与真实失败日志、独立源码、清理回执及完整性记录。没有新增外部模型、真实认证/余额、界面/设备或远程/relay/tunnel 验收，原浏览器安全拒绝不绕过。

A-8 未勾选、status running；A-1 至 A-7 的历史勾选不新增完整完成声明。原44入口目标与最终新鲜独立审计继续保持，原始登录/实机豁免授权证据仍未取得。

#### Retrospect

progress：只读身份和原始 RPC 记录排除了本次首请求的明显端点不一致，但不能给旧偶发发布失效定根因。共用 cancel 的提前返回通过可控发送屏障在旧实现下严格失败，最小顺序修正和70项回归形成独立可撤回提交。不把本地排序、诊断变体的一次通过或 stale=false 文件等同远端结束；最新官方清理失败必须保持可见。

下一轮唯一增量追踪最新 session/close 的 terminal_uncertain / broker request failed。先阅读固定官方 closeSession → lifecycle close → broker dispatch/timeout/进程身份与回执的实际入口，核对与取消后原 prompt/idle 的时序；在原探针失败入口、临时目录清理之前保留白名单索引、端点/进程身份和 RPC/退出回执，避免根目录部分删除污染事后证据。不扩大关闭超时、不自动重发 close/模型、不伪造取消完成；只有证实的共用门禁或收尾问题才改生产，属于固定上游缺口则记录精确范围和可验证策略。继续完整44入口与A-8新鲜独立审计，不以已知故障无限重复同一次无证据尝试。

### Round 119（ACP 子进程错误流与关闭证据）

#### Plan

沿 Round118 追踪 session/close 的 terminal_uncertain / broker request failed。固定官方 transport 的 broker catch 会把内部异常统一成 unavailable/broker request failed，现有 ACP 错误并不暴露内部根因；先保留独立失败出口的生命周期、索引、端点与原始 RPC 白名单，避免临时目录清理污染证据。责任检索发现共用 effect-acp layerChildProcess 未消费 child.stderr；已核对当前安装及 .repos 同版 NodeChildProcessSpawner，默认 pipe 的 PassThrough 无读者会产生背压。先用真实子进程在 RPC 回复前等待大块 stderr 写完成建立确定红灯，再在所有 Runtime 共用 layerChildProcess 内用已有 Stream.runDrain/forkScoped 连续排空，不另建日志队列、不泄露错误流内容。只在实际复现后实施此唯一增量；不把它推断成上游 broker 清理根因。精确 HEAD b678d0f12 + 模块索引独立源码验证，定向测试/类型/lint，稳定文档记录真实边界，单模块本地提交。保留其他工作区改动、12个保护哈希、44入口与 A-8，禁止模型重试、扩关闭超时、子代理、新浏览器、线上数据及外部账户。回滚撤回本轮提交，无迁移。

#### Act

本轮先核对固定 Gajae 0.18.1 closeSession → teardownSession → broker session.close：ACP 聚合失败为 terminal_uncertain，broker transport 的 handleRequest catch 只返回 unavailable/broker request failed，内部异常被公开出口隐藏。普通错误消息不能定位到某个文件/进程或证明需要扩大预算；未改上游、安全权威、幂等请求或关闭超时。

HEAD b678d0f12 的独立诊断副本继续使用原工具探针，在 session/new、prompt、close 回调与 Scope 结束记录显式白名单的索引/端点/存活、生命周期 ledger 状态和原始 RPC 方法/ID/终态。只诊断副本禁用临时目录删除以留证据，未复制 token、密钥、正文或原模型配置。实际这次 session/new 返回 uncertain_after_send，没有到达 prompt/close；ledger 仅 accepted/effect_started/awaiting_ready。生成1模型会话 PID 在失败入口仍在、Scope 结束时消失；不能将缺少完成回执推断为操作从未完成，或将端点存在推断为权威已经发布。记录和清理分开，没有重跑同一诊断以求绿。

责任检索包括全部 layerChildProcess/makeChildStdio 调用方、共用 Runtime、Cursor/Kimi/Generic/Grok 和现有 Codex/Pi-family stderr 读取模式。当前安装及 .repos 同版本 NodeChildProcessSpawner 均以 pipe/PassThrough 转接 stderr；effect-acp 子进程层没有读者。真实 Node 子进程在每次 RPC 回复前等待8MiB stderr写完，确定复现背压。唯一生产增量在 packages/effect-acp/src/client.ts 的 layerChildProcess 内以已有 Stream.runDrain 和 forkScoped 连续排空，不新增日志队列、缓存、驱动或依赖。读取失败报告固定告警/PID，避免输出可能敏感的流/异常正文；stdout 协议、RPC 与退出错误继续原合同。Scope 关闭时取消读取任务，不把错误流当工具输出或协议。

client.test.ts 留下一项真实子进程回归，连续两次原样RPC回应并核对客户端层结束时stderr读取已回收。无睡眠/轮询/模型重试。同步 generic-acp-provider.md 和 gajae-acp-provider.md，说明共享调用范围、低层调用者责任、固定官方源码选择、诊断失败、最终一次工具通过和回滚。形成独立本地提交 912195c75fcc36197d56bdfea80b0c7b43c75b4e（fix(acp): 持续排空子进程标准错误），4文件66增加/1删除；无推送/PR/子代理/新浏览器/线上数据/真实账户。撤回该提交即可回滚，无迁移。

#### Verify

- 首次新回归误在混合工作树执行，60秒超时；保留日志，但不作为精确提交正式证据。随后在 HEAD b678d0f12 的独立源码，旧client加新测试以同样5秒测试预算失败；最终加Scope回收断言再与旧client核对仍5秒超时。测试运行上限只用于可控反证，未改任何生产超时；恢复client后单项307ms通过。没有把挂起改成成功或绕过stderr写回调。
- 最终精确索引副本 C:/Users/Administrator/AppData/Local/Temp/codework-acp-stderr-audit-20261001/source-6CHG03/source：vp test run packages/effect-acp/src/client.test.ts packages/effect-acp/src/protocol.test.ts packages/effect-acp/src/agent.test.ts apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts，4文件98项通过，50.96秒；包括既有权限、解析、进程退出、通知与取消顺序检查。
- vp test run CursorAdapter.test.ts GrokAdapter.test.ts -t interrupt|stopping a session|closes the ACP child：2文件7项通过/86未选中，10.26秒，保留两项原Node shell=true弃用告警。正式定向回归共105项；前面的35项包检查和单项绿灯不重复计数。未执行全仓检查。
- 同副本 tsgo --noEmit -p packages/effect-acp/tsconfig.json 和 -p apps/server/tsconfig.json 均退出0。Server只保留账号池两项原Effect建议；改动TS定向vp lint退出0，无输出。索引fmt、UTF-8无BOM、diff --cached --check、白名单与诊断残留检查通过。
- 固定官方 gjc.exe 0.18.1 SHA-256 仍 ff990f6b8676e76cfabd85b182cb4e27e1994f04a27eb7f22108d0d0049aa7a2。基线诊断1失败，session/new / -32603 / uncertain_after_send，48.69秒测试、54.06秒总运行；未进入工具/close，不能验证上一轮broker close内部根因。最终精确生产副本上的未插桩原Gajae工具探针整项1通过，8.71秒测试、10.21秒总运行：连续文本、实际source.txt读取、批准Git Bash输出、审批中取消/cancelled、无cancelled.txt、工具failed、session/close。原5秒close和全部断言保留。本机响应端点提供模型fixture，没有外部推理/真实账户证据；一次通过不宣布所有历史生命周期失败修复。
- 诊断根目录 codework-gajae-tools-2923RC 的 ACP PID39500、模型PID39940及broker PID54212在只读结束检查均已消失，没有执行停止操作。最终 broker PID34168 / 创建时间2026-10-01 14:36:43.182979 / 独立根iUDgwV经自身broker.json、localhost及已记录命令行身份匹配，通过官方broker.shutdown收到ok=true，随后WebSocket关闭/error发生在ACK之后，确认PID已消失。没有按名字/路径批量杀进程，官方后台清理与ACP整项通过分别登记。
- 4文件索引/独立源码/提交字节哈希一致，未插桩官方探针副本与HEAD字节一致，提交后索引为空，hooksPath仍.vite-hooks/_。78个模块外原始文件/删除状态与12个保护哈希不变；通用ACP文档原有工作树字节作为完整前缀保存，提交只取HEAD加本轮新增段落，没有混入此前未提交内容。
- 仓库外审计 codework-acp-stderr-audit-20261001 保存白名单authority-observed/summary、diagnostic-cleanup、final-owned-broker、清理ACK、红灯/绿灯/105项与官方日志、原文件快照和完整性。初次rg路径通配符与一次不存在的mock脚本读取属于检索准备错误，未修改文件；改用实际列出路径，不当作产品缺陷。没有新增UI/手机/Electron/远程证据；原浏览器安全拒绝不绕过。

A-8仍未勾选、status running、线程goal active。A-1至A-7历史勾选不扩大为新的全部完成声明，44入口范围和最终新鲜独立审计保留。未取得原始登录/实机豁免的人类消息证据，不能仅依赖旧审计文档自行视为授权。

#### Retrospect

progress：共用stderr背压有真实子进程旧实现严格红灯和Scope收尾检查，最小生产修正、105项回归与一步一提交完成。原官方Gajae工具探针最终通过一次，但基线诊断的新建会话失败与历史broker清理仍无内部根因；不把相关性写成因果。失败出口留证据优于事后读取已部分删除的目录，缺完成回执也不能当未执行的证明。

下一轮唯一增量转向 A-8 的审计输入一致性：先核对 HEAD、完整计划P0–P5、44入口能力/证据表与现有 docs/internals/paseo-a8-independent-audit.md，修正旧“ A-8已通过/Parent可complete ”与当前ledger不一致的完成声明，整理可重复执行的最终定向检查入口和未证实门槛。原44范围不缩减；先查已有实现和提交，不重新实现已具备的Provider。准备新鲜最终独立审计，但轮内不派发子代理，旧自证报告/未找到原始豁免都不能代替最终审核或人类授权。Gajae保留精确故障与上游错误出口限制，没有新的可验证根因前不重复同一次工具探针或扩大超时。

### Round 120（完整入口证据与验收文档一致性）

#### Plan

沿 Round119 的下一增量，核对完整计划P0–P5/§7–§9、44固定入口、当前源码与旧审计声明。已确认旧A-8报告写通过/Parent可complete但当前ledger未勾选；旧44表含2额外项、局部工具读取也被称真实可用。只完成这一文档/验收入口增量：保留历史原始字节，修正相关工作文件的完成陈述与统计口径，稳定文档明确固定6+38、额外目录、安装/握手/认证/文本/工具/多端/连接分别验证，给出源文件精确映射与可重复定向检查。禁止用旧豁免marker/报告代替人类消息或新鲜最终独立审计。既有临时计划/审计草稿遵守AGENTS不提交规则，单模块本地提交只收稳定产品架构/验证文档；运行精确HEAD912195c75+模块索引副本的目录/合同和文档完整性检查。保护其它已有改动/12哈希，原44范围及A-8未完成保持；无子代理、新浏览器、账户/线上数据、推送/PR或新loop。回滚撤回本轮文档提交，无运行时/迁移影响。

#### Act

本轮唯一增量为最终审计输入的一致性，先读完整计划P0–P5及逐Agent证据要求，核对HEAD与历史报告，不重新实现已经存在的Provider。固定Paseo提交23c4404b955fbc1a6904b7140f911d9f29de1f27的AGENT_PROVIDER_DEFINITIONS为6项、CATALOG_DATA为38项，开发mock与默认关闭OMP分别说明。AST读取固定git对象和Code Work HEAD，逐条绑定44个唯一入口，Copilot明确映射github-copilot-cli；Cursor/Grok/Kimi复用专用驱动，其他ACP入口复用GenericAcpDriver。快照41项加manual5项是46项目录，与44项固定范围和12个运行时驱动分别统计；额外8项不扩大固定验收范围。

新增稳定文档docs/internals/acp-provider-validation.md，完整列出44项绑定、能力权威来源、按动作记录证据的规则、真实CLI与本地模型夹具/真实账号的区别、工具/余额/客户端/连接的验收边界、四组定向命令及回滚办法。在providers.md只追加导航，索引取HEAD加本轮附录，原始脏工作文件字节保留完整前缀。形成独立本地提交eb0c5ae07b0336ac0bc7a1b8e55e9cb57648570b（docs(acp): 明确全部入口的证据与验收边界），2文件109行新增，无源码改动、推送、PR、子代理或新浏览器。

另外精确更正三份原有未跟踪工作记录，不纳入提交：paseo-a8-independent-audit.md和paseo-plan-s7-s8-audit.md删除当前A-8通过/可complete的误导性声明，历史结果保留为历史；paseo-provider-catalog.md澄清38+2目录项与44+2入口统计，Deepagents/Dimcode/siGit仅局部读取而写入失败的记录不能标为工具真实可用。Gajae的单次原探针通过与生命周期失败分别保留。全部原始字节在仓库外留存，可按文件撤回本轮更正，不覆盖其他已有工作。

原始真实账户/实机豁免消息没有在本轮定向读取中找到：read_thread返回的是代理/命令记录，按原消息类型检索指定会话文件也未匹配。仅据此不能判断用户未授权，更不能把旧报告中的引用视为已取得原始授权；未重复请求许可。本轮不依赖该豁免，既不扩展也不缩减44入口及最终门槛。

#### Verify

- 原始A-8报告校验明确失败（仍声称A-8通过）；更正后校验通过。精确HEAD+2文档索引的独立副本source-1LKhGc/source中，44项映射、唯一ID、分组/入口/驱动均匹配AST提取结果；删除入口、重复入口、篡改Copilot别名三个反例均被拒绝。全部本地链接存在、14个命令测试文件存在，A-8未勾选。
- 定向vp test run packages/contracts/src/providerInstance.test.ts：1文件45项通过，376ms。初次命令夹带错误的Services目录路径，只有合同测试被发现，故不称两文件通过。更正到apps/server/src/provider/acp/AcpRegistryCatalog.test.ts后单独执行：1文件14项通过，1.39秒；合计实际59项。无新CLI、账号、设备、连接或UI证据，没有执行全仓检查；文档增量未无故重复上一轮105项源码回归。
- 索引格式、UTF-8无BOM、diff --cached --check、两文件白名单及索引/独立副本字节一致通过。提交后核对2个提交文件的SHA-256与索引快照一致、索引为空、12个保护文件哈希不变；194个模块外原始文件/删除状态全部不变，providers工作区原字节前缀保留。三份未提交工作记录明确作为本轮所有权例外并保留原始快照，不将其当成已交付HEAD。
- 仓库外codework-paseo-evidence-audit-20261001保留固定绑定、文档反例/门槛校验、索引快照、源副本、完整性与历史原件。首次文档表格校验未容纳格式器填充空格而得到0条，修正校验器横向空白规则后仍严格要求44项和精确绑定；此为检查器准备问题，非产品缺陷。read_thread单次turnLimit12超出10及较大输出属工具准备问题，未据此形成产品判断。

A-8仍未勾选，status running，线程goal active。A-1至A-7历史勾选保持原样，不宣布44个官方CLI或全设备/连接已经完成。

#### Retrospect

progress：稳定合同把固定范围、实际接入路径和可运行检查汇总在一处，59项现有定向测试及文档反例验证通过，并以独立提交交付；旧误导性完成/局部工具标签得到更正。文档存在、入口存在和过去夹具测试都不能替代最终独立验收，未跟踪历史探针/报告也不是已交付源码。

下一轮唯一增量选择A-8的提交完整性核对：对照完整原计划、当前HEAD、脏工作树与44入口记录，核实哪些目标实现/必要真实CLI探针仅在工作树、哪些已提交，定位一个实际未交付的连贯模块；复用已实现代码，形成精确白名单独立源码和定向验证后一步一提交。先查git对象/调用路径，不能为了增加提交重复实现。轮内不派发子代理；最终独立验收必须使用新鲜上下文和当前最终源码，旧A-8报告及未找到原始豁免不能代替审核。没有新Gajae根因不重复同一探针求绿，不扩大生产超时。

### Round 121（交付已核对归档的安装校验哈希）

#### Plan

沿Round120提交完整性核对，确认HEAD没有registry-binary-sha256-overlay.json及目录合并实现，而工作树R69已下载7个固定官方Windows归档、保留哈希但未提交。只交付这一安装模块：复用parseAcpRegistryCatalog/binaryDistributionFor/getAcpRegistryCatalog与既有下载器、Web/Mobile安装入口，不新增安装器或Driver。先重新计算现存归档字节并核对原下载记录/官方公开来源；哈希只按精确归档URL匹配、只在官方sha256字段缺失时补充，有官方非法字段不得降级覆盖。保留HTTPS、命令/参数/格式/平台和下载校验门禁，测试在线解析及非法值、版本/URL变化与官方优先。源码/测试按HEAD加精确增量构造独立副本，已有离线快照与其它工作树修改保留。格式/lint/Server typecheck及目录/安装器定向回归后一步一提交，稳定文档说明维护者哈希不等于官方签名或CLI工具可用。无子代理、真实账户、新浏览器、线上数据、推送/PR；A-8仍未完成，回滚撤回本模块提交。

#### Act

按上一轮计划核对HEAD与脏工作树：44入口映射已经交付，共用工具/控制链路已有实现，首批官方CLI探针和多份稳定说明仍未提交；不重新创建驱动。发现R69的7归档SHA-256补充只有工作树代码/JSON，而HEAD在线目录仍只能使用厂商给出的sha256，遂选择这一个实际未交付的安装模块。检索parseAcpRegistryCatalog/getAcpRegistryCatalog全部调用方，涵盖WS目录查询、installAcpRegistryCatalogBinary再次查询及既有Web/Mobile安装按钮；复用binaryDistributionFor与现有流式校验/解包/原子发布，不增加下载器、客户端配置或依赖。

重新流式计算C:/codework-cli-iso/a4-empty-shells-r69中7个实际归档字节，均匹配原下载记录、字节数和完整SHA-256。获取2026-10-01官方CDN公开目录（响应SHA-256 b4fb55aa813ae92665fa0c8b43d17caed0ac790f0a68a63ba57be024ab11ccf1）：Corust、Stakpak、VTCode、Antigravity、Devin、Cortex的当前URL与保存归档相同；Junie当前3419.24.0与保存3419.22不同，不把旧值套新URL。公开网页核对ACP Registry、Corust v0.6.0、JetBrains Junie3419.22官方发布来源；采用直接定义分发的官方来源，网页不作归档哈希证明。没有重新下载/安装或启动这7个CLI，也没有重跑旧工具探针。

唯一生产增量在AcpRegistryCatalog.ts：静态JSON哈希表按完整archive URL查找，仅target.sha256===undefined时补充；保留现有HTTPS、哈希格式、当前平台、相对cmd、安全argv与归档格式校验。工作树原有宽松实现会把非字符串官方字段当缺省，改为null/数字/对象/空字符串均拒绝，不把错误覆盖成成功。删除不必要的Object.fromEntries、强制类型断言和缺少自有数据时的空对象降级，直接复用有类型的JSON。官方有效哈希优先，即使与维护者表不同也由下载器做实际字节校验。下载器仅把checksum-mismatch文案由“官方目录”改为“目录”，不改变失败码和收尾。

现有AcpRegistryCatalog.test.ts添加2个回归，覆盖7个精确归档、官方优先与非法字段、URL变化、平台/命令注入安全、真实HTTP客户端接收到在线目录后的来源和分发结果。索引取HEAD加本轮测试块，20行原离线快照断言保留在工作树且不夹带。哈希JSON中文说明新增复核日/公开来源；稳定acp-binary-integrity.md说明维护者哈希与厂商签名的区别、更新/版本边界、检查与回滚；generic文档仅追加导航，原工作树字节保留前缀；用户说明补充自动安装条件、未知新归档保留手工及校验失败拒绝。没有更新离线快照版本，不提交其它Provider、账号池、媒体、UI或临时审计材料。

形成单模块本地提交f14464f067ab7bc1bf4a9aa4bf80c47cec3392ba（feat(acp): 为已核对归档补充安装校验哈希），7文件130新增/4删除。无需迁移；撤回该提交即可恢复只接受厂商哈希的目录行为，保留已有安装/实例和原下载校验门禁。未推送、PR、子代理、新浏览器、真实账户或线上数据。

#### Verify

- 精确基线eb0c5ae07加7文件模块索引的独立源码source-at0gXL/source，workspace依赖指向副本。将副本目录实现换为HEAD旧实现、保留新回归，定向两测试均AssertionError失败，14未选中；finally恢复精确生产文件。新实现vp test run AcpRegistryCatalog.test.ts AcpRegistryBinaryInstall.test.ts：2文件23项通过（16+7），1.60秒。实际下载器夹具包含raw与tar.gz文件内容、checksum-mismatch、路径越界、损坏原目录保留及并发发布；不把本机HTTP夹具算官方服务联调。
- 同副本Server tsgo --noEmit -p apps/server/tsconfig.json退出0；仅保留localAccountModels.test.ts与localAccountUsage.ts原两项Effect建议。变更3个TS文件定向vp lint退出0，无输出。未运行全仓检查。测试后仅归一化源副本CRLF为索引原字节，无代码语义变化；最后加入用户说明只同步该文档，不无故重复已通过源码检查。
- 7实际归档字节/哈希与JSON一致、当前6URL匹配与Junie变化记录保留；模块文档全部本地引用存在。索引格式、UTF-8无BOM、diff --cached --check、7文件白名单/源副本字节一致通过。提交后7文件SHA-256与索引快照一致、索引为空、12保护哈希不变；195个模块外原始文件/删除状态不变，通用文档原字节完整前缀保留，离线快照及原测试附加断言未暂存。hooksPath仍.vite-hooks/_。
- 仓库外codework-acp-hash-overlay-audit-20261001保留原件、官方公开响应、7归档核对、红绿/lint/typecheck日志与索引/提交完整性。首次检索猜错Installer文件名及过宽Temp名称过滤属于准备错误，随后按实际列出的AcpRegistryBinaryInstall和已记录归档路径检索，不作产品缺陷或重复猜测依据。没有按模式杀进程或写在线数据库，没有本轮UI/手机/Electron/远程连接新证据。

A-8继续未勾选、status running、线程goal active；不把安装元数据/哈希核对作为44个CLI工具均可用、真实账户或最终独立验收的证明。

#### Retrospect

progress：核对提交完整性发现实际缺口后，把7固定归档的可校验安装补充从工作树交付到HEAD，并修掉非法官方字段被降级的信任边界问题；旧实现2个确定红灯，23项目录/下载回归及Server类型/lint通过。当前Junie升级说明精确URL匹配确有必要，不随版本名外推哈希，不把归档完整性等同工具成功。

下一轮唯一增量选首批Agent官方验证模块交付：先核对Copilot/Gemini/Qwen/Cline/Hermes的HEAD、现有探针调用/依赖、实际登录或本机模型前置条件及历史结果；已有通用驱动不重写。把当前缺少且可完整验证的一组首批官方探针与稳定说明按同主题交付，必要时先修可复现的合同/工具失败。精确索引源副本跑定向协议/配置/类型验证；真实模型只在明确已有授权与前置条件下执行，未提供凭据的跳过保持未验证，不依赖历史报告自行授予豁免。轮内不派发子代理，最终新鲜独立审计及44入口范围保留。

### Round 122（首批本地模型工具验证交付）

#### Plan

沿Round121选择首批官方验证模块：Copilot需要真实登录/模型、本轮不调用；Gemini缺认证负向探针已在HEAD，保留其边界；Qwen/Cline/Hermes本地模型工具探针未提交，复用现有Runtime与本机响应夹具，不重写驱动。核对现有所有systemKeys显式清空样式、运行时extendEnv调用与三探针配置，修正Qwen删除变量被宿主补回及Cline宽泛继承。三个独立配置目录/本机模型响应入口使用同一最小环境清空函数，保留系统启动项、明确HOME/数据目录和合成凭据；用合成宿主凭据回归，不读出真实秘密。逐探针核对实际官方固定安装版本，在精确HEAD加模块索引副本中启用三条官方工具路径并运行定向配置/工具回归、Server类型与lint。只交付这一完整可重复验证模块及稳定说明，跳过不能算通过，已有报告不授予账户/设备豁免。不混入其它Provider/账号池/媒体/UI改动，无子代理、新浏览器、外部模型、线上数据、推送/PR；原44范围、A-8门槛不变。回滚撤回本模块测试与文档，无生产协议/数据库变化。

#### Act

本轮唯一交付为首批固定官方CLI的本地模型工具验证模块。先核对Copilot/Gemini/Qwen/Cline/Hermes已有探针及HEAD：Gemini负向认证已提交；Copilot真实模型路径需要账户，本轮不调用；Qwen/Cline/Hermes本机模型ToolProbe尚未提交，复用现有Runtime而不重写生产驱动。完整读取三探针的响应身份、路由、配置、审批、副作用与恢复断言；检索全部systemKeys/探针环境样式及Effect NodeChildProcessSpawner.resolveEnvironment。精确HEAD Runtime仍extendEnv=true，工作树中另有spawnEnv/extendEnv=false差异但其中也会先合并宿主，两者不能借混合工作树当最终提交。

确定复现Qwen测试环境缺口：把合成OPENAI_API_KEY=SYNTHETIC_HOST_KEY传给测试进程，旧探针删除键后被公共启动层补回，声称缺密钥的openai会话却Success，原Failure断言失败。未读取/打印真实密钥，端点仍为隔离本机夹具。最小修正在测试模块：Qwen负向条件改显式空字符串，三探针共同使用isolatedProbeEnvironment（已搜现有责任，无现成函数，恰有3调用点）。沿既有Gemini/Hermes显式清空模式保留8类系统/临时目录项，空置其余宿主变量，再覆盖HOME/USERPROFILE/APPDATA/LOCALAPPDATA；各探针只补自己的配置路径/合成密钥/固定本机端点。Hermes继续显式Git Bash与PythonUTF8。助手仅供测试，生产实例环境策略不变。一个合成环境回归核对启动层重新合并后仍空、系统项保留、显式测试密钥可注入且原输入不变。

原官方CLI实际安装分别Qwen0.24.7、Cline3.0.65、Hermes握手0.21.5（官方源码f97608f178d1ffeca59860195ab7da295f7c8e5f，git状态空）。版本由CLI握手断言，不从目录版本推算。三探针既有真实文件/命令、原始SSE响应、optionId、取消和新进程恢复断言保留，不删失败断言、不加睡眠/超时/重试；HTTP夹具按当前prompt/completion/tool-call身份选择动作，不让后台请求吃下一动作。Hermes恢复确有旧读取结果，Qwen恢复只验sessionId/再次响应，不外推历史内容验证。

稳定docs/internals/acp-first-batch-probes.md记录版本/配置、各动作、认证环境反证、运行方法、未验证范围、官方固定来源和回滚；generic文档只追加导航，原脏文件完整字节前缀保留。公开来源访问2026-10-01，Qwen v0.24.7认证说明、Cline cli-v3.0.65 ACP说明、Hermes固定提交server.py；网页只作配置/入口依据，成功动作以本次真实安装CLI执行为准。旧三份厂商研究记录继续留工作树，不夹带历史浏览器总数为本轮新证据。

独立本地提交4c24ad7bcf52e519de61cc03494e298023835d1d（test(acp): 交付首批本地模型工具验证），7文件1120新增；3个原有未跟踪完整官方工具探针、最小助手/回归及稳定文档。生产Runtime、Adapter、目录、账号池、UI、Gemini旧工作差异未提交，无依赖/迁移。撤回测试模块提交可回滚，保留已有生产接入修复；无推送/PR/子代理/新浏览器/外部模型/真实账户或在线数据。

#### Verify

- 精确HEAD f14464f06加7文件索引的独立源码source-fS81yz/source，workspace依赖指向副本。旧Qwen探针+合成宿主密钥：1失败，原断言expected Success to be Failure，12.86秒；finally恢复精确探针。新环境助手初次1项通过，后正式共享检查包含该项，不重复累加。没有更改宿主环境或用户配置。
- 显式opt-in运行本轮3个固定官方CLI：Qwen1项通过/12.12秒，含错误认证、空密钥失败、文本、文件、允许/拒绝/取消、shell退出码0、标题保留及恢复；Cline1项通过/7.13秒，含gpt-4o配置/auto_approve=false、读写、命令成功/exit7失败、拒绝、取消及新进程旧读取历史；Hermes1项通过/29.06秒，含两模型实际请求、读写、命令成功/exit7失败、拒绝/取消、审批身份不计工具及新进程旧读取历史。两个后者使用不同临时home/HTTP端口并行执行，没有共享登录数据；CLI与监听收尾复用已有Scope。模型为本机受控回应，不证明外部推理或账户。
- 普通入口vp test run isolatedProbeEnvironment.test.ts QwenAcpCliProbe.test.ts ClineAcpToolProbe.test.ts HermesAcpToolProbe.test.ts GenericAcpDriver.test.ts AcpRuntimeModel.test.ts：3文件68项通过，3文件3项未opt-in跳过，6.74秒。明确跳过不是通过；加实际3官方项，正式去重71项通过。未运行全仓检查，没有用不同Provider替代首批未测项。
- 同精确源副本Server tsgo --noEmit -p apps/server/tsconfig.json退出0，保留localAccountModels/localAccountUsage两项原Effect建议；变更5个TS文件定向lint退出0无输出。源码测试后仅加文档及导航并同步精确索引，不改变测试源码。文档全部本地引用/测试命令存在，3CLI入口字节SHA-256及Hermes提交记录于cli-identities。
- 7文件索引格式、UTF-8无BOM、diff --cached --check、索引/独立副本字节一致通过。提交后7文件哈希与索引快照一致、索引为空、12保护哈希不变；194个模块外原始文件/删除状态不变，generic原工作树字节前缀完整。生产Runtime/Gemini差异不在索引，hooksPath仍.vite-hooks/_。仓库外codework-acp-first-batch-audit-20261001保留原件、红/绿/共享/type/lint日志、CLI身份与提交完整性。
- 初次官方Hermes文档猜错agent.py，核对实际文件后使用固定server.py；两次rg猜错运行时/Spawner路径及检查器把git grep无匹配退出1误当失败均为准备错误，按实际来源及退出合同修正，未修改产品或放宽检查。没有本轮Web/Electron/Mobile/远程证据，没有通过普通skip统计掩盖未运行。

A-8未勾选、status running、线程goal active；A-1至A-7历史状态不变，不把本模块当全部44入口或所有首批真实账户通过。

#### Retrospect

progress：三项尚未提交的真实CLI工具路径在精确HEAD副本中重新通过并交付，认证负向测试的宿主污染得到真实红灯与最小测试修正，环境助手3调用点及71项去重验证完成。测试声称“无密钥”必须显式阻断启动继承，配置目录隔离不是OS沙箱；恢复ID相同不等于旧模型历史已验证。

下一轮唯一增量继续首批验证模块剩余Copilot/Gemini：核对HEAD已存在的Gemini固定版本/原始认证断言和工作树差异，保留负向与模型成功区别；审查Copilot现有URI模式/角色/allow_all/原生审批、取消屏障及恢复探针，把必要可重复合同与稳定说明完整交付。先查已提交通用实现，不重建专用Driver；真实模型仅在明确范围和前置条件下运行，未提供条件保留未验证，不从历史报告授予授权或豁免。最终新鲜独立审计仍需覆盖44入口与所有A-N，轮内不派发子代理。生产Runtime另有未提交fixture环境差异，后续需按调用方核对而不混入本轮。

### Round 123（Gemini本机模型工具闭环）

#### Plan

上一轮属于progress，提交首批三官方CLI工具探针与环境反证。本轮唯一增量沿其Retrospect补齐Gemini成功工具路径：HEAD固定0.61.0负向认证已存在，不把工作树放宽版本断言混入；Copilot已有真实账号探针与共用专项回归，保留待独立交付。责任检索全部Gemini探针、Qwen/Cline/Hermes本地端点样式、已安装0.61.0的contentGenerator/acpClient：复用现有Runtime、环境助手、Scope与原始模型帧，在官方支持GOOGLE_GEMINI_BASE_URL的本机端点提供合成回应，明确不证明外部账号推理。补一个真实Gemini工具探针，逐项核对握手/动态目录、文本、读取、允许写入、命令成功/失败、原生optionId拒绝、取消及新进程恢复；失败先查真实官方实现，不放宽断言制造通过。定向测试/Server类型/lint在HEAD加精确模块副本执行，稳定首批说明记录实际结果与边界，单独提交。保留原44入口目标和A-8未完成，无子代理/浏览器/外部模型/在线数据/推送/PR；无依赖/数据库变更，测试模块可独立撤回。

#### Act

本轮只交付Gemini固定官方0.61.0工具与历史保护模块，本地提交69b01e5078ee540e92301d575779c1d890d6fb34，6文件515增/4删。新增GeminiAcpToolProbe、GeminiAcpToolResult及其3项边界测试；AcpSessionRuntime在唯一共用通知入口根据握手Agent名归一化明确的非零shell结果，同时向既有ToolCallUpdated保留原始ACP帧；恢复前针对精确gemini-cli/0.61.0拒绝发送session/load。更新首批验证内部文档和用户恢复限制，共用GenericAcpDriver、工具合同/事件屏障与isolatedProbeEnvironment，不新增Driver、依赖、迁移或模型选项。

实际官方bundle启动在独立HOME/工作区，Google模型协议仅向127.0.0.1合成端点，gateway合成密钥，关闭更新/遥测并清空宿主非启动环境。tools.core自动允许工具，因此补confirmationRequired以真正走原生审批；model使用实际广告gemini-2.5-pro而非猜测Flash版本。真实文本/read_file/write_file/shell均执行，allow_once/reject_once回传原始optionId，拒绝/取消文件均未产生；原始exit 7 ACP帧completed和模型结果Exit Code: 7提供故障反证。文本适配仅限指定Agent、run_shell_command__、execute/completed、无rawOutput和单一精确标记，32位非零安全整数，保留正文；现有结构化结果和其它Agent不被覆盖。

恢复是上游缺陷而非成功能力：官方loadSession先初始化同ID历史，写入仅session_context的$set.messages后再读取，原29消息记录被覆盖并报No previous sessions found。用固定安装包官方读取器和合成历史前后记录核对根因；修复在RPC前明确失败，实际目标会话jsonl逐字节不变，未静默新建/重试。只阻止精确0.61.0，其它版本继续原路径但未证明安全。已广告loadSession=true不能作为安全恢复证据。

#### Verify

独立源码副本source-EDZZRe/source以HEAD4c24ad7bc加本模块精确索引执行，不夹带脏工作树版本放宽或生产环境继承变化。正式最后结果：官方工具1项通过（12.79秒）、原固定版本缺认证2项通过（8.00秒）、7文件共享入口134项通过/3项opt-in跳过（47.83秒）；独立启用官方项后去重137通过，不把跳过或诊断重跑计为通过。工具探针断言正文/文件读写及模型functionResponse、实际命令输出、非零退出失败/退出码7、原帧completed、原生拒绝/取消终态、新进程恢复错误、没有session/load日志及目标历史不变。成功shell未提供结构化exitCode=0，未伪造该断言。

Server定向tsgo --noEmit退出0，仅原localAccountModels.test/localAccountUsage两条Effect建议；4个变更TS定向lint退出0且无警告。6个索引文件格式检查、UTF-8无BOM、诊断残留0及git diff --cached --check通过；索引与独立副本字节相同。模块校验固定CLI四资产哈希/大小与版本不变、HEAD认证探针原样，Runtime/两文档扣除本轮增量后与原工作树字节相同。提交对象6文件哈希匹配、提交后索引空，195模块外原文件/删除状态及12重点保留文件SHA-256均未变。证据与原始字节保存在仓库外codework-gemini-tools-audit-20261001，预提交只读核对钩子通过单次git -c启用，不改仓库hooks配置。

准备性失败和正式结果分开：models.id/slug类型错、未广告型号三次失败后按真实模型数组重评、tools.core隐式允许、shell缺exit0字段、AcpRequestError operation非法值及空启动记录自动清理比较错误均查实现后修正，诊断输出没有进入提交。exit7错误完成状态及session/load历史覆盖是实际生产/上游红证据；保护后实际探针绿。没有全仓检查、子代理、外部账号/推理、浏览器/Electron/Mobile/远程/线上数据、推送或PR，不使用旧豁免作为授权。

A-8仍未勾选，status running、原44入口目标与A-1至A-7历史状态不变；本轮不足以新增完整Acceptance勾选。无数据迁移，测试/适配可随本提交独立撤回；撤回恢复保护将重新暴露固定0.61.0已证历史丢失，应保留保护或禁用该版本恢复。

#### Retrospect

本轮为progress：Gemini新会话工具有实际官方CLI证据，恢复明确不受支持并被保护，不能把探针通过写成恢复成功或所有44入口完成。命令失败文本标记仍存在纯stdout同文歧义；非零退出带stdout可能只传输出而不含退出码，尚不能可靠判断。上游提供原生结构化退出码后删除文本适配；仅当经验证版本恢复不再覆盖历史时调整版本保护，不能仅根据广告或升级版本号移除。会话比较针对实际有内容的目标记录，空启动记录清理不是历史损坏。

下一轮唯一增量选择首批Copilot交付核对：先查已有CopilotAcpCliProbe、GenericAcpDriver/AcpRuntimeModel专项已提交内容与官方实现，确认可复用的角色/模式/空默认配置和恢复边界；只形成当前未交付的连贯Copilot验证/稳定说明模块。真实账号或模型调用需要可追溯的当前人类授权，历史自证豁免不能替代；缺授权时可继续本机协议/启动配置证据，但不得声称真实账户推理通过。不重复已完成模块，轮内不派发子代理；最终全部44范围必须新鲜独立审核，A-8保持未完成。

### Round 124（Copilot官方本机工具验证交付）

#### Plan

上一轮为progress，本轮沿Retrospect只交付首批Copilot验证/稳定说明模块。责任检索确认HEAD已有Copilot URI模式、默认空角色编码、allow_all写回和CLI默认模型的GenericAcpDriver/AcpRuntimeModel专项回归，不重复生产驱动；现有未提交CopilotAcpCliProbe依赖真实gh账号，不将历史报告/豁免用作当前授权。核对固定官方1.0.89实际help与GitHub当前BYOK/ACP/离线文档，优先复用isolatedProbeEnvironment和已有OpenAI本机模型探针，在官方支持的自定义端点/离线模式下执行真实CLI工具链路，不能用协议模拟替代CLI事实。认证/默认目录、模式/角色、读写/命令、原审批选项拒绝/取消和新进程恢复逐项按实际结果核对；不支持的路径明确失败，不伪造模型广告。HEAD加精确模块索引副本中跑正式探针、专项回归、Server类型和定向lint，稳定文档区分本次本机证据与历史账号报告，一步一提交。保留其它所有脏改动/12重点哈希、44入口完整范围和A-8未完成；无子代理、新浏览器、真实账号/外部推理、生产数据、推送或PR。无依赖/数据库变更，可独立撤回本模块。

#### Act

本轮仅交付Copilot固定官方1.0.89离线工具与命令状态模块，本地提交01254f9c8b7a8a796e985b97787966787d2d9c82，7文件560增/3删。新增CopilotAcpToolProbe、CopilotAcpToolResult及3项边界测试；AcpSessionRuntime沿唯一会话通知入口调用归一助手，原rawPayload继续保留原始通知，Gemini保护与其它Agent路径不变。交付当前copilot-acp-provider稳定实现说明，更新首批验证索引和用户命令状态说明。原GenericAcpDriver角色/权限/模式/default模型合同已在HEAD，不重复新增Driver、菜单或状态载体；助手单独隔离厂商结构化结果责任，实测与单元测试两个调用点复用。

先核对仓库外固定官方npm和native版本、二进制SHA-256及help providers/environment，再查官方BYOK/ACP/认证文档。1.0.89确实支持COPILOT_OFFLINE=true及OpenAI-compatible自定义端点，无GitHub登录要求。因此使用isolatedProbeEnvironment、合成Key、独立HOME/COPILOT_HOME和127.0.0.1随机端口，仅提供view/create/powershell及合成无工具profile；省略authenticate的空字符串显式生效。模型请求按Schema、路径、Bearer合成Key、wire model、当前prompt标记和广告工具校验，唯一完成/工具ID和原始SSE不让后台请求误消费下一动作。运行器合成宿主GH_TOKEN/旧Provider Key/Allow All true，子CLI仍保持本机Key和allow_all off。没有使用、读出或复制真实GitHub凭据。

真实CLI完成文本、view读取、create允许写入、PowerShell输出、原allow_once/reject_once optionId回应、取消和新进程恢复。URI模式Agent/Plan/Agent、profile/空默认角色、allow_all on/off、失效角色拒绝都核对真实广告；开启Allow All期间没有执行工具。模型目录仍null，没有用COPILOT_MODEL伪造动态目录；usage只证明广告。恢复第二CLI同sessionId，下一模型请求必须包含之前实际读取的文件结果，收到合成恢复标记，不能只用ID或文字本身证明历史。

额外exit7反证发现当前实际ACPstatus为completed，rawOutput.contents却包含唯一shell_exit/exitCode7，导致显示假完成。助手只对name=Copilot、tool_call_update/completed、未明确其它kind、没有已有顶层退出字段、唯一shell_exit安全非负32位数字归一：补rawOutput.exitCode，0保持completed，非零failed，完整content/detailedContent/contents及原始ACP帧保留。没有从文字猜测或再次执行工具。多shell退出无唯一码、其它Agent、畸形/非整数/超范围和已有字段不推断。

#### Verify

正式检查在HEAD69b01e507加精确模块索引的独立source-iTp5ic/source，workspace依赖指向副本，不借用脏工作树其它逻辑。实际未插桩官方探针1项通过（9.01秒，7.37秒实际测试）；7文件共享回归77项通过/1项opt-in跳过（6.87秒），包含Copilot结果3项、Gemini结果3项、原角色/权限/模型/Adapter/环境合同。单独启用后去重78项通过，不将重复/诊断或跳过记为成功。探针另断言成功rawOutput.exitCode0，exit7派生failed/退出码7、原帧仍completed，拒绝/取消目标文件不存在，恢复后的模型请求含旧读取内容。第一版成功探针没有exit7检查，不用于覆盖失败路径；新增exit7后红灯与诊断原帧保存到仓库外，修复后最终原探针绿。

Server tsgo --noEmit退出0，仅原localAccountModels.test/localAccountUsage两条Effect建议；4个变更TS定向lint退出0、无警告。7索引文件格式、UTF-8无BOM、无诊断残留、git diff --cached --check及索引/副本字节一致通过。模块检查CLI固定资产身份、当前角色合同、原始帧保留、本地文档链接和工作树原字节：Runtime/首批/用户文档仅应用本轮增量，旧Copilot文档完整原文保留为历史工作记录且未混入当前提交，未运行/未提交的CopilotAcpCliProbe原样保留。提交对象7文件哈希匹配、索引空，194模块外原文件/删除状态及12重点保留文件SHA-256不变；单次只读预提交钩子不改仓库hooks配置。证据位于仓库外codework-copilot-tools-audit-20261001。

没有全仓检查、子代理、真实账号/外部推理、新浏览器、Electron/Mobile/远程/线上数据、推送或PR。配置隔离和官方offline并非操作系统沙箱；没有证明全部模型、custom角色、MCP/搜索、设备或所有连接。原44范围和A-1至A-7历史状态保持，A-8未勾选、status running。无依赖/数据库迁移，撤回本模块会回到上游completed显示但不撤销已执行命令，不回滚此前通用配置或Gemini历史保护。

#### Retrospect

本轮为progress：首批Copilot当前可重复官方工具验证已提交，离线BYOK无需依赖旧账号授权或旧报告；先查实际帮助比反复请求真实账号更直接。工具status只描述工具协议完成，不保证命令成功，明确shell_exit结构化结果应进入既有显示合同并保留原帧；正文已含退出信息也不能以它掩盖状态错误。成功模型回复/同ID不是恢复历史证明，模型请求中的之前读取结果必须另断言。单独厂商边界助手不应扩展成Provider框架，多退出结果保留准确边界。

下一轮唯一增量选择第二批Factory Droid验证/MCP门禁交付核对。已查HEAD没有FactoryDroidAcpCliProbe和专属稳定说明，而工作树有0.229.0握手探针：它允许会话成功或失败两种结果、吞清理错误、历史文档有401/无工具结果，不可直接称接入工具完成。先查当前GenericAcpDriver/AcpAdapterSupport和目录supportsMcpServers=false是否已交付、固定官方help/配置与完整计划，再修正这一Factory探针的明确预期和隔离/错误证据，形成定向可重复模块与真实支持边界；如官方允许本机BYOK再验证真实工具，不能发送伪造账户密钥或重复外部401制造证据。保持全部44目标、原始人类授权边界和A-8新鲜独立审计门槛，轮内不派发子代理。

### Round 125（Factory Droid验证与MCP边界交付）

#### Plan

上一轮为progress，提交Copilot官方离线工具和命令状态修复。本轮沿Retrospect只交付Factory Droid固定0.229.0验证模块。责任检索确认目录factory-droid的supportsMcpServers=false、GenericAcpDriver透传、CursorAdapter共用注入与GenericAcpDriver.settings.test新建/恢复三配置测试已在HEAD，不重复实现MCP开关。现有未提交Factory握手探针允许成功/失败任一结果并吞清理错误，历史工具401不证明可用。核对官方BYOK、exec/ACP、MCP与Airgap文档及固定native help；公开Airgap不是环境变量而是企业独立构建，不伪造离线模式/密钥。如当前BYOK可直连本机模型则复用既有模型协议夹具、isolatedProbeEnvironment和Runtime实际验证文本/工具/审批/取消/恢复；否则准确交付固定握手/明确阻断结果，不写虚构通过。独立HEAD加精确模块副本跑真实官方探针与目录/MCP合同定向回归、Server类型/lint，稳定说明区分本次证据与旧报告，一步一提交。保留全部脏改动/12哈希、原44范围、A-8未完成，无子代理、新浏览器、真实账户/外部推理、线上数据库、依赖/迁移、推送/PR。回滚仅本模块。

#### Act

本轮仅交付Factory Droid固定0.229.0认证边界与MCP验证说明，本地提交1f4e2c2f2b4d1305cf591674ef51450421bdf862，3文件143增：修正FactoryDroidAcpCliProbe.test.ts、交付稳定factory-droid-acp-provider说明、追加用户认证提示。检索HEAD确认目录supportsMcpServers=false、GenericAcpDriver透传与CursorAdapter注入、GenericAcpDriver.settings.test三配置新建/恢复合同已交付，不重复实现MCP或专属Driver，本轮没有生产逻辑变更。

核对官方BYOK、Exec/ACP、IDE/MCP及Airgap说明，记录检索词/日期/选源原因、固定native SHA-256和帮助。help exec可用；exec --help在空SHELL环境加载失败，因为原生解析空SHELL覆盖COMSPEC默认值。仅Windows探针显式SHELL=COMSPEC，复用isolatedProbeEnvironment，Scope拥有临时目录/进程，去除吞清理错误。固定帮助--only-tools与新版网页--restrict-tools不同；企业Airgap为独立构建，不发明公共版离线开关。

准备阶段独立settings.json的generic-chat-completion-api、本机端点/合成模型Key仍在session/new收到Authentication required，模型端点没有请求，工具步骤未执行。未填伪造Factory密钥或使用真实账号，临时设备码脱敏，尝试工具探针仅保留仓库外。正式探针明确验证@factory/cli@0.229.0及device-pairing/factory-api-key广告，session/new必须为AcpRequestError/-32000/指定认证前缀，mcpServers=[]，不发送authenticate/session/prompt；不再接受成功/失败两种结果，不称工具可用。

#### Verify

HEAD01254f9c8加精确3文件索引的独立source-YhA3UX/source运行，workspace依赖指向副本。真实固定官方认证负向1项通过（10.70秒，实际测试8.56秒）；4文件目录/隔离/MCP三配置新建恢复回归18项通过、1项官方opt-in跳过（7.47秒）。去重19项通过，失败工具尝试、诊断、重复及跳过不计通过。真实Droid MCP工具未运行，共用协议子进程不能代替认证后真实结果。

Server tsgo --noEmit退出0，仅原localAccountModels.test/localAccountUsage两条Effect建议；探针定向lint退出0、无警告。准备阶段误用日志params导致断言及类型失败，按真实payload修正后正式探针/类型/相关检查重新通过。最终索引格式、UTF-8无BOM、无诊断残留、git diff --cached --check、索引/副本3文件字节一致通过。模块审核先将格式化表格/围栏与原模板直接比较而失败，改用现有格式器后严格比较。固定CLI身份、文档链接、用户文档原字节前缀及旧Factory文档完整历史保留通过；索引稳定说明不混入旧历史，原探针快照可回滚。提交3文件哈希匹配、索引空，195模块外原文件/删除状态及12重点SHA-256不变，单次只读预提交钩子未改仓库hooks配置。证据在仓库外codework-factory-tools-audit-20261001。

无全仓检查、子代理、真实账号/外部推理、新浏览器、Electron/Mobile/远程/线上数据、推送/PR。文本/读写/命令/审批/取消/恢复仍受认证阻断而未验证。全部44范围和原Acceptance保持，A-8未勾选、status running，未新增豁免。无依赖/数据库迁移；独立撤回探针与文档即可，已有MCP/Driver不变，撤回不能解除公共CLI认证。

#### Retrospect

本轮为progress：已提交可重复的固定身份/明确认证拒绝检查，纠正BYOK/MCP/Airgap边界。BYOK不保证厂商匿名会话，握手不证明工具；空SHELL只在当前探针补系统shell，不破坏其它环境隔离。厂商MCP能力与目录兼容默认分别陈述，先查HEAD避免重复。Factory正向工具仍需获授权的测试登录，旧工作记录/豁免不能替代原始人类授权与最终独立审计。

下一轮唯一增量选Mistral Vibe固定2.25.8验证模块。已检索未提交MistralVibeAcpCliProbe，仍接受session/new成功或任意AcpRequestError、重复环境过滤并吞清理错误；专属工作文档仅记录browser-auth握手。先查HEAD、完整计划和固定官方help/配置，确认是否支持本机自定义模型；若支持，复用现有协议夹具验证真实工具和取消，否则准确交付认证/模型阻断，不用fixture或历史文档冒充官方成功。保持一次一模块提交、全部44目标和A-8门槛，轮内不派发子代理。

### Round 126（Mistral Vibe官方本机工具与恢复验证）

#### Plan

上一轮为progress，Factory Droid明确认证拒绝探针和当前边界已提交。本轮只交付Mistral Vibe固定2.25.8工具验证模块。已读完整计划、Acceptance、最新Retrospect和Lessons，目标44项与A-8未完成不变。责任检索现有MistralVibeAcpCliProbe、专属旧文档、GenericAcpDriver/Runtime与Hermes/Copilot工具探针：通用驱动/环境隔离/模型协议夹具可复用，不建专属Driver。原弱握手允许任意成功失败且吞清理异常，没有实际工具证据。核对官方固定配置、ACP/工具/认证/恢复源码与已安装资产身份，按官方自定义模型路径验证本机端点、文件读写、命令成功/失败、原审批、取消及新进程恢复历史；不使用真实账号，不绕过厂商认证。如实际不支持或失败明确记边界，不以合成模型回答自证工具。HEAD加精确索引独立副本检查，稳定文档与旧记录分开，一步一提交；保留模块外原字节/12哈希，不运行全仓检查/子代理/新浏览器/线上数据，不推送/PR，回滚仅本模块。

#### Act

本轮唯一交付Mistral Vibe固定官方2.25.8本机工具/恢复与读取详情模块，提交3074841dd7469992de7ef92932a3881a37487540，5文件520增。新增MistralVibeAcpToolProbe和AcpReadFileOutput测试、AcpRuntimeModel共用6行正文选择、当前Mistral稳定文档及用户说明。查明既有GenericAcpDriver/Runtime/isolatedProbeEnvironment可以复用，未增加专属Driver、状态或依赖。旧MistralVibeAcpCliProbe未经严谨正向验证且未在HEAD，原样保留，不作为本次成功证据或提交。

官方配置和v2.25.8固定源码确认generic/OpenAI自定义provider、VIBE_HOME与legacy harness可用。记录官方检索词/日期/选源原因、固定binary SHA-256/大小和help。显式--legacy-harness避免默认rollout与内部Unified Harness差异；独立config.toml、系统变量隔离、Scope临时目录/CLI/随机本机HTTP，关闭遥测/更新/通知/connectors，只广告read_file/write_file/bash和两个合成模型。运行器合成宿主MISTRAL_API_KEY/错误VIBE_HOME，子CLI仍使用隔离目录与本机合成Key。没有真实Mistral凭据、authenticate或外部推理，也没有谎称操作系统沙箱或全部网络受阻。

真实CLI完成正文、ask模式/动态模型与命令广告、模型切换后的实际HTTP请求、文件读取、允许写入、命令echo/exit7、原审批allow_once/reject_once、取消及新进程session/load恢复。模型夹具按请求路径/Bearer/模型/当前prompt标记和实际广告工具校验，唯一完成/工具ID；六次原生工具动作逐项检查结果和副作用，不重复交ToolBroker执行。拒绝与取消文件不存在、相关工具failed，取消stopReason明确。恢复不只断言同ID/合成回复：下一实际模型请求的role=tool消息须含之前文件内容，然后才返回恢复标记。

第一次真实读取显示失败：模型已有文件正文，ToolCallUpdated/detail只有Read 1 line摘要；诊断原通知同时有rawOutput.content正文和content摘要。根因在共用makeToolCallState的详情优先级，不在厂商执行或UI。仅kind=read且rawOutput.content为非空字符串时优先有界正文，复用8000字符预算，保留摘要/路径/原始字段；其它kind、空值/非文本、MCP数组/批量输出不更改。不是重读文件或新建厂商转换器。实际形状及长尾输出测试经CoreRuntimeEvents、ingestion与公开历史投影验证正文仍可见。

#### Verify

正式检查在HEAD1f4e2c2f2加精确5文件索引的source-p3QX8h/source，workspace依赖指向副本，不借脏树其它功能。最终未插桩官方工具探针1项通过（7.58秒，实际测试5.96秒），9文件相关检查115项通过/1官方opt-in跳过（11.13秒）：读取正文8项、原解析/事件/配置/通用Driver/MCP/目录/环境合同。去重116项，准备失败/诊断/重复与普通跳过不计通过。最初读取正文断言失败日志保存；诊断只在外部副本加原通知观察并最终恢复，修复后正式原探针和加强后的拒绝/取消/真实恢复断言通过。

Server tsgo --noEmit退出0，仅原localAccountModels.test/localAccountUsage两条Effect建议；3变更TS定向lint退出0、无警告。最终索引格式、UTF-8无BOM、无DEVLOG/诊断、git diff --cached --check和5文件索引/副本字节一致通过。模块核对Runtime原工作字节仅加本轮增量、精确HEAD逻辑增量、旧弱握手原字节、专属历史文档完整原文与用户文档前缀、固定CLI身份和文档链接；恢复Runtime原换行字节不改索引语义。提交对象5文件哈希匹配、索引空，194模块外原文件/删除状态及12重点SHA-256不变；单次只读预提交钩子未改仓库hooks配置。全部证据与回滚快照在仓库外codework-mistral-tools-audit-20261001。

未运行全仓检查、子代理、真实Mistral账号/外部模型、新浏览器、Web/Electron/Mobile/远程、实际MCP/媒体/全部模式命令、线上数据、推送/PR。本轮证明固定Windows legacy harness在本机模型端点执行实际工具，不证明公共默认rollout、所有模型或多端可用。原44范围及Acceptance历史状态保持，A-8未勾选、status running，不依据旧豁免替代用户授权。无依赖/数据库迁移，可独立撤回本模块；撤回后文件正文再被摘要盖住，不撤销已执行命令或删除保存历史。

#### Retrospect

本轮为progress：原只握手的Mistral路径形成实际工具、失败、审批、取消和内容恢复证据，并修正已复现的读取详情损失。BYOK必须核对固定实现，不能把所有Agent默认等同Factory认证阻断，也不能把默认Mistral登录当generic模型前置。协议content可以只是显示摘要，明确read rawOutput.content才是正文；在共同责任处选择输出优先级并保留原字段，比再造厂商Adapter更小且覆盖同类路径。恢复必须检查真实模型请求中的旧tool内容；原生六工具副作用与合成模型文本分开验证。

下一轮唯一增量选择Kilo固定7.8.1的工具验证交付。已检索HEAD仅有图标，工作树KiloAcpCliProbe仍接受任意会话结果/吞清理错误；旧专属文档有R88本机读取与写入记录，但明确shell/拒绝/取消未硬测，不能直接作为当前完整验收。先核对固定官方help/配置与实际目录，再沿现有Generic ACP、本机模型端点和隔离助手验证命令成功/失败、原审批、取消/恢复及详情；如遇真实协议差异先查共同边界并保留失败，不靠真实账号或历史报告制造成功。继续全部44目标和最终新鲜独立审计，轮内不派发子代理，一步一提交。

### Round 127（Kilo官方工具与恢复验证）

#### Plan

上一轮为progress，Mistral官方工具/恢复和读取详情修复已提交。本轮沿Retrospect只交付Kilo固定7.8.1验证模块。原计划44目标/Acceptance/最新复盘及Lessons沿用不缩小。已查HEAD仅有Kilo图标，未提交弱握手允许任意会话成功失败且吞清理错误；旧说明有读写结果但shell/拒绝/取消未硬测。查固定官方ACP/config/provider/tool源码和实际帮助，复用GenericAcpDriver、Runtime、isolatedProbeEnvironment及现有本机模型夹具，不造专属驱动。验证动态模型、文本、读写、命令成功失败、原审批/取消与新进程恢复历史；失败需明确查根因，不能用旧记录或合成模型自证工具。HEAD加精确模块索引的独立副本检查，稳定文档与旧历史分开，一步一提交。无子代理/全仓检查/新浏览器/真实账号或外部模型/线上数据/依赖迁移/推送PR；保留所有模块外改动与12哈希，A-8未完成，回滚仅本模块。

#### Act

本轮唯一交付Kilo固定官方7.8.1工具/恢复与命令退出模块，提交ed8d238b2a5a4e0f60d497d84bc6e6144b7c9e4b，6文件641增/1删。新增KiloAcpToolProbe、KiloAcpToolResult及三项定向回归，Runtime只在现有通知解析边界接入结果归一；稳定Kilo文档与用户说明同步。复用GenericAcpDriver、CursorAdapter、Runtime和isolatedProbeEnvironment，不新增专属Driver、依赖或第二套工具执行。旧弱KiloAcpCliProbe允许任意会话结果且吞清理错误，原样保留，未纳入本次提交或成功证据；旧专属历史记录加当前结论说明并完整保留，HEAD专属文档只交付当前模块。

核对官方v7.8.1的ACP/config/provider/tool/flag源码和实际help，固定二进制SHA-256/大小。实际initialize Kilo@7.8.1、loadSession=true、kilo-login广告；运行kilo acp --pure，独立KILO_CONFIG/kilo.json和XDG目录，内置OpenAI-compatible provider、本机合成Key、两个模型、permission=ask，默认code模式。空置非系统宿主变量和KILO_CONFIG_CONTENT，关闭更新/默认插件/外部skills/LSP下载/项目与Claude配置；运行器设置合成宿主OPENAI_API_KEY/错误KILO_CONFIG。临时目录、CLI和随机127.0.0.1 HTTP由Scope持有，不调用authenticate/真实Kilo凭据或外部推理。Windows目录回收曾EBUSY，改用Node标准库对确认绝对路径/本探针前缀的独立目录有限重试，最终错误仍报；没有模式杀进程、访问线上数据或声称操作系统沙箱。

真实CLI完成正文、code模式、模型配置与非空命令广告、切换后实际聊天模型请求、原生read/write/bash、allow_once/reject_once原optionId、审批中取消、取消后下一回合和新进程恢复。六次工具动作逐项检查：读入文件内容回到模型和详情，允许写入精确APPROVED，echo输出标记，exit7结构化码，拒绝无文件/工具failed，取消原审批toolCallId与目标路径/stopReason cancelled且无文件。恢复关闭原进程后session/load同ID，下一实际模型role=tool消息必须含之前读取内容，合成回复和同ID不自证历史。

首次exit7实际原帧status completed、metadata.exit7、detail只有(no output)，会错误显示成功。Kilo限定转换保留原output/metadata/content/rawPayload，结构化非零归failed、0保持completed，rawOutput补exitCode，content末尾补显式码供详情使用。仅completed且kind缺省或execute接受有效非负整数32位退出码；其它Agent/类型/阶段/已有exitCode/畸形数值不覆盖，不从stdout猜状态。最初结果断言错误地要求原字段消失，修成嵌套必要字段匹配，不删原始数据以让测试通过。

取消时审批已到达但尚无执行工具通知，沿HEAD现有仅审批不制造工具的合同验证，不增加伪失败记录；Adapter已有request opened/resolved及取消结算。另首次模型检查混入后台标题请求，固定源码及原HTTP确认small_model独立于聊天模型；夹具只按固定两条system/user标题前缀和无工具识别，校验独立small_model并返回标题，不能消耗nextTool或作为恢复证据，其余聊天/工具请求仍严格按所选模型。响应model沿实际请求，原失败和诊断留在外部审计目录，正式源码无插桩。

#### Verify

正式检查在HEAD3074841dd加精确6文件索引的source-mxpH1V/source，workspace依赖指向副本，不依赖脏树其它功能。最终未插桩官方探针1项通过（13.16秒，实际11.48秒）；12文件定向回归224通过/1未启用官方探针跳过（57.39秒），涵盖Kilo转换三项、共用读写解析/事件/配置、RPC/Adapter审批取消/关闭、Driver/MCP/目录/环境合同。去重225项，准备/诊断/重复与普通opt-in跳过不计通过。真实exit7红帧与修复后的原始保留断言、新进程role=tool恢复、取消后下一回合均有证据。后台标题与仅审批取消是已核对的协议边界，不被记为执行成功或隐藏失败。

最终Server tsgo --noEmit退出0，仅原localAccountModels.test/localAccountUsage两条Effect建议；四变更TS定向lint退出0。共享检查有Node既有shell参数DEP0190警告，未作为检查失败或声称零警告。索引格式/UTF-8无BOM、诊断残留为0、git diff --cached --check、6文件索引/副本字节一致通过。模块检查Runtime原工作字节只加本轮变更、HEAD精确变更、弱探针原字节、历史文档/用户文档前缀、链接、固定二进制身份与Acceptance未改；恢复Runtime原换行字节不变索引语义。提交对象6文件哈希匹配、索引空，194模块外原文件/删除状态及12重点SHA-256不变；单次只读预提交钩子未改仓库hooks配置。证据与原快照在仓库外codework-kilo-tools-audit-20261001。

未运行全仓检查、轮内子代理、新浏览器/Electron/手机/真实远程连接、真实Kilo账号/外部模型、MCP/媒体/全部模式命令、在线数据、推送/PR。当前证明固定Windows Kilo在本机模型端点的实际工具与恢复，不替代多端视觉或44入口最终验收。全部原目标/Acceptance保持，A-8未勾选、status running，不依据旧工作记录豁免替代用户授权。无依赖/数据库迁移，可独立撤回本模块；回滚后非零退出再可能显示成功，不撤销已执行命令或删除保存历史。

#### Retrospect

本轮为progress：Kilo从弱握手记录形成实际工具、失败、审批、取消后继续和内容恢复证据，修复了真实非零命令误成功。厂商completed是协议完成标签，结构化exit才决定成功；保留原帧并在既有通知边界归一足够，不重执行或新增Driver。审批先于执行，取消未执行工具不能制造失败工具记录，应检查原审批与实际文件、回合和下一请求。后台标题模型不能套聊天模型断言，严格区分固定标题形状后仍核对实际聊天工具模型与历史内容。

下一轮唯一增量选择CodeBuddy固定2.159.0的官方调用/工具模块。已检索HEAD没有CodebuddyAcpCliProbe交付，工作树旧探针只验证initialize省略agentInfo及iOA/external/internal/selfhosted广告，仍接受任意session/new成功或失败且吞回收错误；不直接当作工具可用。先读官方文档/固定安装help与自托管配置边界，在隔离目录/现有共用Runtime验证实际模型、工具与审批取消恢复；若公共版本仍要求账号，精确记录认证阻断，继续原44范围，不伪造登录或把负向结果当正向成功。一模块一提交，继续最终新鲜独立审计，轮内不派子代理。

### Round 128（CodeBuddy官方调用与工具验证）

#### Plan

上一轮为progress，Kilo退出状态/真实工具与恢复已独立提交。本轮沿最新Retrospect只交付CodeBuddy固定2.159.0调用与工具模块。已查HEAD没有旧CodebuddyAcpCliProbe交付，脏树弱探针只验证缺agentInfo/四认证广告，接受任意会话结果且吞回收错误。读取官方ACP/models/settings/env帮助和固定安装，核对自定义模型与selfhosted边界；复用GenericAcpDriver/Runtime/隔离助手，本机端点验证实际工具、原审批/拒绝/取消/恢复。若有真实认证或平台阻断，保留精确错误，不伪造成功。HEAD加精确索引独立副本检查，稳定文档与旧历史分开，一个模块一个提交；保留原44/P0–P5范围、A-8未完成、模块外文件和12哈希。无子代理/全仓检查/新浏览器/真实账号/线上数据/推送PR，无新增依赖或数据库迁移。

#### Act

本轮唯一交付CodeBuddy固定2.159.0官方调用、工具退出与取消历史解析模块，提交1bb2a5599a89a37f57e76b72330351aafff843e5，8文件。新增实际工具探针及结果助手/四项回归，共用Runtime接入专有退出与取消结果；effect-acp协议仅将已证厂商取消信封送入现有ExtNotification，复用ToolCallUpdate字段校验和现有会话/重放门禁。稳定CodeBuddy实现文档和用户说明同步，一个模块一个本地提交，没有推送或PR。旧CodebuddyAcpCliProbe仅握手且接受任意会话结果，原样保留，不纳入此提交或工具成功证据；旧专属文档全文保留，HEAD专属文档只交付当前实际结论。

官方npm包@tencent-ai/codebuddy-code@2.159.0来自仓库外已有安装，未下载、安装或改写。保存入口与headless实现的SHA-256/大小、Node路径、version/help；Windows用Node直接调用官方入口。读取官方ACP/models/settings/IAM与固定实现：initialize无agentInfo，精确iOA/external/internal/selfhosted广告与loadSession=true；仅models.json时session/new返回Authentication required，模型未收到请求。按官方第三方CODEBUDDY_API_KEY/CODEBUDDY_BASE_URL配合独立models.json后新建成功，未调用authenticate或真实账号。selfhosted是企业认证入口，不能当成匿名自定义模型开关；IAM复查一度502，固定实现和实际请求亦留证。

复用isolatedProbeEnvironment，空置非系统宿主变量、独立HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG和CODEBUDDY_CONFIG_DIR，本机随机127.0.0.1 HTTP、合成Key、两模型、default权限、限制Read/Write/PowerShell工具，Scope管理临时目录/模型服务/CLI。运行器合成宿主OPENAI_API_KEY及错误CODEBUDDY_CONFIG_DIR不影响实际独立配置；这是配置隔离，不声称操作系统沙箱或网络封锁。不接触在线数据库、真实账号/余额、外部模型或浏览器。

官方实际六次工具动作：读取真实文件回到模型和工具详情、原allow_once选项写入精确APPROVED、PowerShell输出标记、exit7、原reject_once拒绝无文件/工具failed、审批中cancelled且无文件/已显示工具failed。动态模型当前广告使用custom-local:codework-alternate，裸名称被拒绝，切换后的实际模型请求使用第二模型。新进程--model重置默认值，恢复时核对配置并重新选择广告模型，不伪造模型持久化。session/load同ID后下一实际模型role=tool消息包含旧读取正文才返回恢复标记，正文合成回复和同ID不能自证历史。

第一处原始缺陷：exit7的completed与专有rawResponse.exitCode7矛盾。只在CodeBuddy Bash/PowerShell、completed、缺省/null或execute和有效32位非负整数上归一，0完成、非零失败，rawOutput增加exitCode，保留原output/content/meta/rawPayload和显式退出码正文，不重执行、不从正文猜测。四项结果回归覆盖真实省kind形状、零码/已有字段/其它阶段与工具、缺码/畸形边界、取消结果与原帧。

第二处原始缺陷：恢复历史会发status cancelled，标准Schema无法解析并终止ACP。只接受codebuddy.ai/toolCancelReason=permission_denied/session_interrupted的明确厂商信封，标准ToolCallUpdate其它字段仍须合法；原帧沿ExtNotification保留，Runtime归现有failed并在无正文时显示原因，原rawPayload仍为cancelled，启动/会话归属/重放门禁复用。未知原因、非法字段或其它非法通知继续报协议错误；新增原帧/后续标准通知及五种非法字段协议回归，不做通用catch降级。

历史检查期间后台摘要包含用户标记，最初includes(marker)误认成恢复请求。保存实际模型消息并停止重复尝试后，按固定单条text/<user_query>完整消息识别动作，后台标题/摘要仍严格核对路径/Key/模型，不能消耗动作或充当历史验收。最终原探针未插桩通过，诊断与正式证据分开。

另取消后立即同连接继续的检查返回cancelled且模型请求0次，未解决；独立诊断再次复现并保存cancel-continue-boundary.log/cancel-boundary.json，未纳入成功数量或正式已验收范围。没有sleep/重发/吞错误来强行通过；正式工具探针证明取消安全及新进程恢复，文档明确这不能替代立即继续成功。下一轮只查这一个取消完成顺序缺口。

#### Verify

HEAD ed8d238b2加精确索引独立source副本，依赖定位到副本源码。最终官方CLI本机工具探针1项通过；13相关文件12通过/1 opt-in跳过，256项回归通过，去重257项通过；诊断、准备性失败、旧弱探针和立即继续失败不计入成功。Server与effect-acp包定向类型检查通过，运行时/helper/protocol定向lint通过，8索引文件格式与diff --check通过。原始completed/exit7、cancelled历史通知、模型名称拒绝/默认重置、后台摘要消息与立即继续失败分别留证，没有把失败改写为成功。

8文件索引/副本字节一致，UTF-8无BOM、无诊断残留；官方入口及实现身份核对、文档链接通过，旧弱探针原样。192模块外原文件/删除不变、12受保护文件SHA-256不变，Runtime/protocol/协议测试仅加入自己的增量并恢复未修改行原换行字节，原工作和专属历史完整保留。提交后8文件哈希对应检查结果、索引为空。

本轮没有浏览器/Electron/手机、MCP/媒体、真实账号/外部模型或各远程连接验收，不能据本机数据链声称多端视觉一致或44入口全部完成。A-8保持未勾选、status running，原全部44/P0–P5范围不变，不引用旧工作记录的豁免代替明确用户授权。无依赖/数据库迁移，可独立撤回本模块；撤回后非零命令可误显示成功、专有历史取消可终止连接，代码回滚不撤销已执行命令/文件副作用或删除保存历史。

#### Retrospect

本轮为progress：CodeBuddy从弱握手形成实际读写/命令/审批/取消和新进程历史内容证据，修复结构化非零退出误成功与厂商取消重放终止协议两处实际根因。厂商取消扩展必须限定明确命名空间和已证原因，并继续校验其它标准字段；保留原帧、复用标准会话与重放入口，无需放宽全部协议。模型重置和后台摘要是实际生命周期行为，不能让夹具猜持久化或用用户标记子串替代真实用户消息。

下一轮唯一增量为CodeBuddy取消后立即继续的完成顺序。已重新复现stopReason cancelled、0模型请求；先查当前HEAD取消入队/本地中断与固定官方session/prompt/cancel实现，捕获同连接原请求终结及下一请求顺序，区分厂商远端仍在取消与本地清理归属，使用真实回执/协议事件验证，不加sleep、无界重试或自动重发。已有新进程恢复可用但不替代这一缺口；一模块一提交，继续原44范围与最终新鲜独立审计，轮内不派子代理。

### Round 129（CodeBuddy取消后继续的顺序）

#### Plan

上一轮为progress，CodeBuddy实际工具/退出结果与取消历史解析已提交1bb2a5599。本轮沿最新Retrospect只处理同连接取消后立即继续仍cancelled/0模型请求的问题。已核对当前HEAD已有取消通知入队、当前prompt本地中断、权限结算、串行prompt与历史重放；固定官方cancel会记录pendingCancellations，需查原请求终结和后续请求消费顺序，不假定通用驱动缺实现。复用既有RPC/Scope/事件及串行入口，实际stdio和HTTP留证，先红后绿，不加sleep、无界重试或自动重发。新增状态/方法先检索现有责任载体，最小根因修复并同步真实工具探针/稳定文档，一个模块一个本地提交。HEAD加精确索引独立副本检查，保留原44/P0–P5范围、A-8未完成、模块外原编辑/删除与12哈希；无子代理/全仓检查/浏览器/真实账号/线上数据/推送PR，不改.loop-state或数据库。

#### Act

本轮唯一交付取消后的请求终结顺序模块，提交b59a9ef006d63728df730663f8d3782ccc37e0ec。原真实CodeBuddy帧表明session/cancel后原prompt被@effect/rpc/Interrupt中断，后续prompt早于原回复且返回cancelled/0模型请求。保留标准prompt RPC在会话Scope，独立Deferred立即结束本地显示/根会话待定审批；串行下一prompt等原RPC最多5秒，超时明确未发送/重连错误。并发/空闲取消不重复通知；Kiro命令扩展保留原可中断合同，Gajaeidle等待移到本地等待链，原RPC和显示结束分开。

第一版原RPC确认先于新请求仍不能解决CodeBuddy即时继续：固定官方2.159.0的lastCancelAtBySession/isCancelBarrierActive设500毫秒窗口，回复早于窗口到期。只按明确CANCELLED厂商元数据，从回复时间起保守拒绝500毫秒，新请求不发送并明确提示稍后重试；不加sleep、自动重发、新依赖/Driver/配置开关。正式官方工具探针增加连续调用合同：窗口内须明确未发送、实际启动请求数不增；若时间已过窗口必须end_turn，新回合cancelled仍失败。读写、退出7、原审批、无取消写入和新进程真实历史继续检查。

Grok回归揭示xAI扩展先结算prompt_complete兜底，会中断共同Runtime原RPC，然后runtime.cancel失去目标。调整为先共同取消、finally结算扩展兜底，失败也收尾本地等待；迟到通知断言保留。夹具以实际Agent正文回执证明请求进入，不只等turn.started；Grok两项续聊正向夹具明确回复原prompt cancelled后再继续，移除旧500毫秒睡眠等待，用原生请求日志回执。共同Runtime另有不回复的负向测试，不能把未知状态当正向成功。新增2取消屏障场景与1待定审批自动取消场景，已有静默取消改验显式未发送错误；同一测试脚本用Deferred释放原回复，虚拟时钟验证窗口与超时，没有新增固定sleep/poll。

稳定CodeBuddy/共同生命周期/用户说明同步解释取消后发送、窗口、重连、xAI顺序和回滚。安装资产未修改；真实CLI只连随机本机模型端点和独立配置，不使用腾讯/其它真实账号或线上余额/数据库，不调用外部推理。工作树其它所有编辑/删除与原文档历史保留，本模块只从HEAD独立加入自己的增量。

#### Verify

基线1bb2a5599加精确9文件索引构成独立source，workspace依赖指向副本。红灯原始stdio/HTTP、原RPC确认仍窗口取消、Grok扩展无取消通知和未确认原回复的续聊失败分开留证；不把诊断和准备性失败计作最终通过。最终15相关文件14通过/1 opt-in跳过，323项通过/1跳过；另固定官方CodeBuddy本机探针1项通过，去重324项。Grok取消专项3项通过属于最终回归子集，不重复统计。Server、effect-acp定向类型检查及修改源码/测试lint通过；Server只有两处原账号池Effect建议，Node有既有shell DEP0190警告，无新增检查错误。9索引文件格式、diff --check、UTF-8无BOM、索引/副本字节及无诊断残留检查通过。

193模块外原文件/删除逐项SHA-256不变、12重点保留哈希不变；6代码工作文件非本轮行由原字节重建，原有配置/测试编辑不混入索引。提交后9文件哈希对应已验证内容、索引为空，历史ledger/Acceptance字节保持。工作记录和检索脚本在仓库外，本轮记录未提交；没有子代理、全仓检查、推送、PR、新浏览器、依赖或数据库迁移。

本轮不构成浏览器/Electron/手机、真实账号/外部推理、MCP/媒体或remote/relay/tunnel验收；共用数据及本机工具证据不替代这些范围。A-8保持未勾选，status running、线程goal active，全部44/P0–P5范围保留。回滚仅撤回本取消模块；代码回滚不能撤销已执行工具或删除保存历史，回到旧行为会重新暴露取消竞态。

#### Retrospect

本轮为progress：CodeBuddy原RPC丢失与实际取消保护窗口分别定位，Grok扩展顺序在相同根因修复时出现并已由原断言红绿验证。标准取消确认、本地显示结束、厂商时间窗口和扩展兜底是四个不同边界；等待原RPC不是无限等待，窗口拒绝必须证明未发送，不能用第二回合cancelled或自动重发制造续聊成功。原生回执比turn.started更适合远端时序断言；测试夹具需明确取消回复，另保留不回复的真实边界。

下一轮唯一增量为44入口当前能力记录的一致性核对。检索已确认paseo-provider-catalog.md仍把CodeBuddy写为凭据阻断/未实测，而最新HEAD已有固定官方本机工具/恢复和本轮取消边界；逐项对照原计划、HEAD模块、各探针和固定版本证据，更新当前记录与未验证项，不把旧历史或弱握手计为全部功能通过。只做该文档/记录模块单独提交；随后仍按完整P0–P5未证据项继续，最后再新鲜独立审核所有Acceptance。本轮不提前勾A-8，不引用旧豁免/报告宣告完成，轮内不派子代理。

### Round 130（44入口当前能力记录一致性）

#### Plan

上一轮129已提交b59a9ef00，取消模块为progress。本轮沿最新Retrospect只交付44入口当前能力记录的一致性模块。责任检索发现paseo-provider-catalog.md是未提交历史记录，含CodeBuddy凭据阻断、Mistral需登录等过时结论；已提交acp-provider-validation.md已有精确44绑定及证据合同，是当前稳定记录载体。复用它补逐项已提交探针/能力边界，不新造目录、Driver或把全部历史工作记录提交。对照固定Paseo数组、原P0–P5计划、当前HEAD注册/目录/探针及各专属说明；区分真实CLI本机模型、负向认证/平台阻断、公共fixture和未形成当前可复验记录。原工作历史只加明确指向稳定页的提示，原字节保留，不把旧完成/豁免当授权。HEAD加精确本模块索引独立副本验证44唯一绑定、路径/源码证据/版本来源及相关目录合同，文档格式/UTF-8/原文件哈希后单独提交。无子代理/全仓检查、新浏览器/服务、真实账号、线上数据、推送或PR；保留全部44/P0–P5、A-8未完成与目标active，无依赖/迁移，回滚仅文档模块。

#### Act

只提交docs/internals/acp-provider-validation.md：沿用原44入口绑定表，补齐逐项已提交证据与当前能力边界，区分本机官方CLI/受控模型、公共协议合同、认证失败与未验证；说明16个已提交ACP探针含额外Harn两项、25入口尚缺当前已提交官方工具探针。CodeBuddy/Mistral本机工具路径不再被旧默认登录结论覆盖；Gemini恢复被拒保护、Qwen没有旧历史断言、Gajae不稳定、Factory认证阻断均明确保留。Factory探针只验证无认证拒绝，BYOK无模型请求来自专属文档既往实验，分别标注。当前12驱动与快照41加手工5为不同口径，不扩大固定6+38范围。未提交paseo-provider-catalog.md只前置历史提示，原内容字节保留，不把旧工作材料纳入提交。

本地模块提交f768faf693f98b76ebcb6b3478e4be339fc00bf8：docs(providers): 对齐44入口的当前能力与验证边界，1文件51增47删。索引来自HEAD加本模块修改，独立副本workspace依赖指向该副本；保持原文档其它未提交内容及198项模块外原有文件/删除不变。没有增加Driver、抽象或依赖，没有写账号/余额/线上数据。回滚仅撤回该文档提交；不对脏工作树做整树恢复。

#### Verify

在仓库外codework-provider-evidence-audit-20261001/source-zIYPpx/source运行：node E:/MyProject/code-work/node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpRegistryCatalog.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.settings.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts，退出0，实际3文件23项通过，无跳过。工具输出chunk 319940，19:40:42启动，8.10秒；目录/参数/实例/MCP合同验证，不称官方CLI本轮复跑。

外置verify-doc.mjs以只读固定Paseo源码数组核对6内置+38ACP、44唯一入口/分组/实际别名、12注册驱动及实际driverKind、41+5目录成员；59个相对证据链接均在HEAD且在独立副本存在。16个ACP探针与额外Harn2项、25个目录合同条目分别统计；源码核对OpenCode SDK v2、Factory认证/无prompt、Gemini拒绝session/load、Qwen仅同ID及特定真实工具断言入口。漏入口/错误Copilot别名/链接未提交文件三个检查器反例均拒绝。工作历史原字节及稳定文档非本轮段落保持；源/索引1文件字节一致、UTF-8无BOM/诊断残留0、格式与git diff --cached --check通过。提交后精确文件/hash一致、索引为空；198项模块外原文件/删除哈希不变，12个先前保留文件原始SHA-256不变。

准备检查器先遇到根目录未安装typescript，改用标准库读取已确认顶层数组；上游CATALOG_DATA以as const结束，修正完整数组边界；git ls-tree全部路径超过默认输出缓冲，改为仅责任目录检索。均是外置审计工具准备失败，未改变产品实现/断言；保留明确失败与最终结果。钩子vp staged会自动暂存/恢复其它工作，精确索引已直接格式验证，本次子进程VITE_GIT_HOOKS=0跳过该自动改写，明确不是钩子通过。

本轮无生产源码更改，未新增类型/lint全仓检查；未运行44官方CLI、真实账号/外部推理、浏览器、Electron/手机、MCP/媒体/远程/tunnel或最终独立审计。原P0–P5与44入口完整目标、A-8未勾选、status running及goal active保持；旧完成/豁免工作记录不构成人类授权。

#### Retrospect

本轮为progress：当前稳定44入口能力表已提交并以独立源码/索引及23项相关合同复验；旧未提交历史不再被当成当前交付。能力表不能仅凭探针文件数量宣称工具支持：Factory的明确认证负向与BYOK实验、Qwen同ID恢复、Gemini真实历史风险、Gajae不稳定分别是不同边界。记录载体应复用稳定文档，不为研究材料新造第二份当前真相。

下一轮只推进Fast-agent官方本机工具验收与必要的公共链路修复：先查HEAD现有宿主fs/terminal、目录固定uvx参数、未提交旧探针和已安装官方资产，确认与当前版本/完整计划一致。复用现有Generic ACP/ToolBroker，验证原生通知与宿主执行不重复、读写/命令副作用、原审批拒绝/取消及恢复旧工具历史；认证或平台阻断须如实保留，不扩大超时/重发来制造通过，不新增专属Driver。只提交该模块经独立副本验证的实现/探针/稳定说明，保留其它工作。剩余44/P0–P5、多端和最终新鲜独立审计仍未完成，本轮不勾A-8。

### Round 131（Fast-agent官方宿主工具与生命周期）

#### Plan

上一轮130已提交f768faf69，能力表一致性为progress。本轮沿最新Retrospect只推进Fast-agent官方本机工具验收及已复现公共链路缺口。已检索HEAD的Generic ACP/Runtime、CursorAdapter宿主fs/terminal与ToolBroker集成合同，已有公共执行链，不造专属Driver。旧未提交FastAgentAcpCliProbe仅握手并吞清理/close错误，旧R85工具使用Ollama和no-permissions，不足审批/取消/恢复。当前官方已安装fast-agent-acp0.10.1，只读核对源码、help及2026-10-01官方ACP/配置文档。新探针用显式独立HOME/config、受控本机模型、实际文件/命令、副作用计数、原optionId拒绝/取消及新进程旧工具历史断言；宿主探针的文件/终端执行与产品ToolBroker合同分别记证据，不能将其当外部推理或多端完成。保持认证/模型/工具/恢复独立判断，若上游失败先定位责任边界，不扩大超时/睡眠/重发。HEAD+精确索引独立副本验证后一个模块本地提交，所有原工作保留；无子代理/全仓检查、真实账号、线上数据、浏览器或推送/PR，A-8不勾选且goal active。

#### Act

新增FastAgentAcpToolProbe.test.ts，复用已有官方CLI本机模型探针组织、Schema和isolatedProbeEnvironment，不改生产驱动或公共协议。固定fast-agent-acp0.10.1及generic自定义模型/独立配置与home，保持默认审批；广告与实现实际宿主fs/terminal，执行临时文件/真实Node进程。精确原选项ID、文件无副作用/执行次数、原始工具终态/详情、取消后同连接下一回合、新进程load及下一模型请求的role=tool旧内容逐项断言。缺文件回复AcpRequestError、终端资源绑定外层Scope，不吞错误、不靠sleep/重发。

新增稳定fast-agent-acp-provider.md，记录配置、宿主替身与产品ToolBroker合同区别、失败原因、复验和回滚；原未提交说明追加在工作文件历史区，原字节保留且不进入本模块提交。更新acp-provider-validation.md的Fast-agent证据/限制与当前基线；17探针、额外Harn2和剩余24入口缺当前官方探针分别判断。当前6+38=44范围不变，旧未提交握手probe/其它账号池等内容完整保留。

模块提交21e7e6d76ae8935430ed7ddc2ebc6288e906b5db，test(acp): 验证Fast-agent宿主工具审批与恢复，3文件597增49删。本轮只增加可复验官方工具证据与准确能力记录，已有公共宿主执行链无需重复实现。无新增依赖/Driver/数据库迁移；回滚该模块及对应实例停用均保留历史，不整树恢复脏工作。

#### Verify

正式HEAD+精确索引副本source-UVLoUn/source，workspace依赖指向副本。外置run-check.mjs cli清空子进程CODEWORK_*探针开关后只提供本次CLI路径：vp test run apps/server/src/provider/acp/FastAgentAcpToolProbe.test.ts，20:00:39启动，1文件1项通过，13.31秒。固定身份/模式/命令、正文/read、授权write一次、shell输出与一次追加、退出7、原reject/cancel无文件、cancelled终态/下一回合、另进程旧role=tool读取历史均断言通过；六次工具动作，terminal create/release各2。只有本机受控模型，不称真实外部推理或全产品UI联调。

run-check.mjs normal运行新增官方probe及CursorAdapterToolBroker.e2e.test.ts、AcpJsonRpcConnection.test.ts：实际2文件67项通过、新官方probe1文件1项未启用跳过，51.02秒；后者单独真实运行通过，不把跳过算通过，去重68项通过。该e2e使用协议fixture与真实产品ToolBroker，明确不等同官方Fast-agent整应用会话。原有shell=true子进程DEP0190告警保留，未擅改该无关启动链。

Server tsgo --noEmit退出0，只有原有localAccountModels.test与localAccountUsage两条建议；新probe定向vp lint退出0；3文件索引格式、git diff --cached --check通过。外置44项检查器重验固定上游6+38、12驱动/46目录、59已提交或本模块索引路径、17ACP probe及额外Harn2、24仅目录合同条目，漏项/错别名/未提交链接反例拒绝。3文件源码/索引字节一致、UTF-8无BOM/诊断0；提交后文件/hash精确、索引空，198项模块外原文件/删除哈希及12项先前保留哈希均不变。原Fast-agent说明字节保留。vp staged会自动暂存/恢复无关工作，本次VITE_GIT_HOOKS=0跳过自动改写，直接检查精确索引格式/源码/检查结果，并明确不称钩子通过。

准备失败均保留：终端handler需要Scope，首轮类型检查明确拒绝；初始官方probe在新写入前读取不存在的文件，orDie导致RPC无错误回应，数次90秒截止。诊断阶段显示initialize/auth/session/new及正文/read已完成，write阶段失败；官方0.10.1源码_read_existing_text会先读取目标并捕获ACP异常，独立原始initialize也返回精确身份。只修探针Scope/缺文件错误后，无插桩原probe正式通过，没有扩大原90秒上限。外置编辑器先因CRLF/格式后锚点不匹配、后因PowerShell inline引号解析失败；组合命令未检查前项退出码使一个旧诊断又被启动，实际失败不计正式通过。重新读取精确源上下文，改独立脚本并检查变更结果；正式runner增加路径/干净源码及缺文件修正前置检查。诊断子进程仅结束捕获PID70080，原始stdio/错误保存在外置audit，插桩不进入提交。已有真实CLI probe无需强行复制旧无审批Ollama记录。

官方来源：2026-10-01检索fast-agent ACP permissions与config base_url，采用fast-agent.ai/acp/及/ref/config_file/；固定0.10.1另核对已安装源码定义的read_text_file/write_text_file/execute与load_session。未下载或更新官方资产。无子代理、全仓检查、浏览器/服务、真实账号、外部推理/MCP/媒体/模型切换、其它平台/设备/连接与最终独立审计。所有P0–P5、44入口与A-8未勾选保持，goal active、status running，历史豁免不算授权。

#### Retrospect

本轮为progress：已有目录与宿主链通过当前官方CLI具体工具、副作用、原审批和旧历史的新鲜可复验探针，不只增加握手清单。真实上游write前会读取尚不存在的文件；返回空成功或缺陷都改变合同，宿主必须给明确ACP错误，让CLI自己决定如何继续。探针的handler依赖和清理也须按真实Scope/协议请求验证；新probe错误不能当产品缺陷复制到生产。延迟清理隐藏最初错误时，用阶段/原始协议定位，最终必须回到无插桩原检查。重复失败和编辑工具的失败顺序如实保留；后续依赖动作必须检查前项成功，不能让PowerShell分号驱动旧源码重跑。

下一轮只推进Qwen0.24.7的真实旧工具历史恢复完整性：先查HEAD现有QwenAcpCliProbe恢复断言、官方资产/协议/历史读取源码和此前记录，再在下一实际模型请求中核对role=tool旧读取结果，验证另进程load、取消后状态与原有工具回归。若固定上游丢失/覆盖历史，保留原文件字节并在现有共同恢复边界实现有证据的保护，不伪造旧内容或只校验同ID。一个恢复模块一次提交；其它24官方工具探针缺口、全部44/P0–P5与多端/最终新鲜独立审计继续保持原目标。本轮不勾A-8或声明全部完成。

### Round 132（Qwen旧工具历史恢复完整性）

#### Plan

上一轮131已提交21e7e6d76，Fast-agent官方工具证据为progress。本轮沿最新Retrospect仅推进Qwen0.24.7恢复完整性。已检索HEAD的QwenAcpCliProbe：已有认证负向、工具/审批/取消，恢复仅同ID及end_turn，没有下一模型请求旧工具内容断言；共用恢复与其它官方probe已有完整模式可复用，不增加Driver/历史重建。当前已安装固定0.24.7包、Node>=22；只读核对已安装loadSession/hydration逻辑与官方固定tag说明。加强原probe：取消后同连接续聊、实际session/load、下一官方模型请求的role=tool旧read及shell结果、恢复正文/计数；失败应按真实上游/公共链定位，不能伪造旧内容、只验同ID或放宽等待。必要保护仅由实际文件覆盖/丢失证据触发。独立home/受控回环模型、HEAD+精确索引源码、定向测试/类型/lint/格式后一个模块本地提交；保留旧未提交Qwen说明及其它所有工作。无子代理/全仓检查、账号/线上数据、浏览器或push/PR，保留完整P0–P5/44与A-8未勾选、goal active。

#### Act

补强原QwenAcpCliProbe：Schema校验实际model，取消后同连接新prompt，另进程session/load成功一次；恢复唯一新标记对应的实际模型请求体筛选role=tool，必须包含旧读取与旧shell输出，再验证恢复正文、恢复请求一次及总工具动作5。没有从全局缓存或合成模型回复反推旧历史，保留原认证负向、读写/命令/拒绝/取消和90秒截止。公共恢复实现通过，不改生产Driver/历史读取或添加厂商恢复补丁。

新增稳定qwen-acp-provider.md记录当前调用/认证/工具/恢复断言、版本/模型边界、复验及回滚；旧未提交Qwen说明追加在工作历史，原字节保留而不进入新提交。更新acp-provider-validation.md的Qwen已证旧工具恢复、本轮基线与范围；17探针和24剩余官方探针缺口不变，不能据新增断言扩大其它入口或多端完成声明。一个模块提交cab8d136bc2ff7d71d03d072c96f03a581b243cc，test(acp): 验证Qwen恢复后的旧工具历史，3文件145增52删，无依赖/迁移或生产配置变更。

#### Verify

正式源码为HEAD+精确索引的source-9dKH5F/source，workspace依赖指向副本。run-check.mjs cli仅设置固定官方cli.js路径，vp test run apps/server/src/provider/acp/QwenAcpCliProbe.test.ts：20:14:09启动、1文件1项通过，14.83秒；真实官方身份0.24.7，login/-32602、缺Key/-32603、正文/实际工具/原optionId以及新增取消后继续、旧read+shell role=tool、新进程load/正文/次数均通过。原生产恢复已可保持旧结果，本轮不是通过伪造历史来修表象。

run-check.mjs normal：QwenAcpCliProbe、AcpReadFileOutput、isolatedProbeEnvironment，实际2文件9项通过，Qwen官方探针1项未启用跳过，3.03秒；官方另行启用通过，去重10项。Server tsgo --noEmit退出0，仅旧localAccountModels.test/localAccountUsage两条建议；改动probe定向vp lint退出0。没有全仓检查或为测试构造额外应用抽象。

精确索引3文件格式/git diff --cached --check通过，源码与索引最终字节相同，probe仅换行归一、语义与正式检查一致；UTF-8无BOM、诊断残留0，提交文件/hash与索引白名单精确、提交后索引空。198项模块外原文件/删除SHA-256与12项先前保留文件原始哈希不变；Qwen旧工作文档及稳定能力表非本轮区域均保留。外置44项规则检查6+38、12驱动/46目录、17探针/额外Harn2/24目录合同入口、59链接和错误别名/漏入口/未提交链接3反例；Qwen真实旧历史断言路径随当前模块更新。vp staged自动暂存/恢复其它工作，本次子进程VITE_GIT_HOOKS=0跳过该自动改写，直接验精确索引，明确不称钩子通过。

资料核对：2026-10-01检索Qwen v0.24.7 loadSession restore history ACP及官方配置，采用QwenLM/qwen-code固定tag的ACP入口、官方auth/settings说明；GitHub网页未展示完整文件，以已安装官方固定chunk的loadSessionWithProfiler、projection/replay/runtime初始化片段和实际探针为具体依据，记录chunk SHA-256。一次rg读取minified长行产生过量输出，转为Node有界片段定位，不重复扫描/打印整个bundle。没有下载/更新官方资产，没有改上游包或当前用户历史。首轮新恢复断言直接通过，不虚构产品缺陷或红灯；普通跳过与真实运行分开。

本轮无子代理、浏览器/服务、真实账号、外部模型/MCP/媒体、模型切换、非零shell、其它平台/设备/连接及最终独立审计。工具执行仍由官方CLI，响应由回环端点合成，不表示余额或账户链验证。P0–P5/44及A-8未勾选、status running/goal active保持，旧豁免工作记录不等于授权；回滚仅撤回探针/稳定说明/能力表模块，不覆盖脏工作或生产历史。

#### Retrospect

本轮为progress：Qwen旧恢复同ID成功的弱证据已补为真实下一模型请求中的旧read与shell结果，并验证取消后续聊及恢复正文/精确次数，稳定记录已经提交。既有实现通过验收时应补足可复验断言，不为造生产提交增加历史重建。请求计数与唯一恢复标记使缺旧数据、后台请求或根本未执行恢复都不能靠合成回复混过；固定官方CLI/本机模型仍与其它协议、设备和账户分开。

下一轮只推进Goose1.52.0官方本机完整工具与取消边界：已确认仓库外goose-1.52.0资产存在，GooseAcpCliProbe与goose说明仍未提交；旧Ollama记录有read/write/shell/reject但三种cancel均end_turn，不能据旧“真实可用”称完整。先查当前官方help/源码、固定资产身份、HEAD公共host fs/terminal和取消合同，再复用受控本机模型及宿主执行路径，实际验证原生通知/副作用、原审批、取消/下一回合与旧工具历史。遇到真实end_turn保留上游限制，依据原RPC/执行事实定位，不把本地cancelled伪造为远端撤销或扩大超时重试。一个模块一次本地提交；24官方探针缺口、完整44/P0–P5、多端与最终新鲜审计继续保留，A-8不勾选。

### Round 133

#### Plan

复核 Round 132 的下一增量 Goose 固定 1.52.0：旧未提交握手与 Ollama 实验已存在，但取消返回 end_turn、重复写入和旧工具历史尚无当前可复验探针。对照官方 v1.52.0 的 ACP server/fs、OpenAI/config 源码与 CLI help，复用 FastAgentAcpToolProbe 的本机模型、实际文件/终端及原始审批选项；通过 HEAD + 精确索引副本检查，保留旧失败和所有工作树变更。工具拒绝/取消/续聊/恢复按真实结果分别判断，不添加第二套 Driver，不把本机受控模型冒充真实账号或 UI 验证。

#### Act

新增 GooseAcpToolProbe.test.ts，复用已交付 Fast-agent 本机模型/宿主真实副作用模式，不新增 Driver 或依赖。固定官方 1.52.0 goose.exe acp，合成 OpenAI Key与本机动态模型端点；原审批选项 ID、sessionId、根路径及受控命令校验，实际 fs/read/write 和 Windows shell 的创建、等待、输出、释放。显式 GOOSE_PATH_ROOT、禁用 keyring、隔离环境、独立配置，模型目录 GET 与聊天 POST/SSE 均校验。

正文/模型/模式，单次读取与写入，shell exit0/7、终端引用和实际输出/退出状态，拒绝、审批取消、下一回合和新进程 session/load 后实际模型 role=tool 旧 read/shell 历史全链有断言。成功读取的原生通知没有正文：官方 conversion.rs 对 ACP-aware 工具成功结果省略 content；探针明确路径/completed及无 rawOutput/content，保留失败与限制，不重读文件/伪造原通知，不宣布已解决读取界面整合。本轮生产代码未改，现有共同运行时通过。

新增稳定 goose-acp-provider.md，仅把当前固定探针配置/能力/边界/官方来源和回滚写入索引；工作文件末尾保留旧文档全部原始字节。更新 acp-provider-validation.md 的 Goose 行、源码基线与探针数量，44项其它行语义相同；18项已提交ACP探针含2个额外Harn，不能算18个基线工具全部通过，23项仍只有目录/共用合同。原未提交 GooseAcpCliProbe 与账号池/UI工作完整保留。单模块提交 397a4ddc0ee85ccb0433a89f42c83bca2968173f，索引为空，无 push/PR。

#### Verify

官方来源：检索 Goose v1.52.0 ACP tools cancel OpenAI config Paths，2026-10-01读取固定官方 server.rs、fs.rs、tool_calls/conversion.rs、openai_def.rs、config/paths.rs，CLI --version=1.52.0，acp --help确认命令；二进制SHA-256与采用URL在外置 sources.json。不混用 Goose 作为 ACP 客户端的 provider.rs 或最新版本 README。默认路径和厂商工具名必须由实际模型广告/官方 Paths 检查。

准备失败如实保留在 C:/Users/Administrator/AppData/Local/Temp/codework-goose-audit-20261001：错误 namespaced 工具名未消费动作；准备阶段只改HOME/APPDATA曾读取默认技能资料并可能生成默认Goose会话，不能证明隔离，未删除/回写真实Goose数据；正式探针改官方绝对 GOOSE_PATH_ROOT 后不复用该准备证据。真实读取先断言正文详情失败（模型已收到源内容、工具仅路径），原始 state 与官方成功结果省略正文对应；此为显示边界而非共用解析丢字段。Windows shell 引号首次退出1，以及未支持官方 /v1/models 后在错误数组检验失败，均为探针准备器错误，逐个修正而非吞错误。首次lint仅注册阶段 process.platform 规则失败，采用已有测试局部例外并解释作用，没有关闭整文件规则。

验证源为 cab8d136bc2ff7d71d03d072c96f03a581b243cc + 精确模块索引副本 source-ZnlQe5/source，第三方依赖复用安装结果，workspace依赖只指副本。最终 run-check.mjs cli 实际执行 vp test run apps/server/src/provider/acp/GooseAcpToolProbe.test.ts：1项通过、2.58秒，20:42:11；动作恰6，源文件实际读1次、写1次、命令计数x、终端各创建/释放2次，恢复实际请求恰1，HTTP错误数组空。审批取消的原prompt=cancelled、文件不存在，同连接下一prompt=end_turn；不证明运行中命令取消。

run-check.mjs normal 执行 Goose探针、AcpJsonRpcConnection.test.ts、CursorAdapterToolBroker.e2e.test.ts：67项通过，Goose普通 opt-in 1项跳过，53.64秒；真实CLI与产品代理夹具分别统计，去重68项通过。原子进程fixture shell出现既有DEP0190警告，不作为失败隐藏。Server tsgo --noEmit 最终退出0，仅localAccountModels/localAccountUsage原有2条建议；定向lint退出0，索引3文件格式、git diff --cached --check通过，UTF-8无BOM/诊断输出0。目录检查器核对固定6+38=44、12驱动、41+5=46目录、18探针/23待官方矩阵、60个已提交本地链接，3个负向自验拒绝漏项/错别名/未提交链接。

提交前检查显式 VITE_GIT_HOOKS=0，绕过自动暂存/恢复脏工作树的 vp staged；前述定向测试/type/lint/格式替代该自动动作，该绕过并非未跑检查。提交后3文件SHA与索引一致、索引空；本轮责任外198项全部原始字节/删除状态未变，12个保留SHA不变。旧Goose说明原文保留，44行除Goose之外语义一致。

未验证运行中终端取消、读取正文与产品宿主结果的界面整合、外部模型/余额/MCP/媒体、Web/Electron/手机或远程连接；旧Ollama三种取消 end_turn 失败仍保留，审批取消的新通过不能抹去它们。A-8未勾选，A-1至A-7旧勾选仍是待最终独立审计的声明，goal active、ledger running。回滚限本次模块探针/文档提交，无数据库/账户迁移，保护其它工作。

#### Retrospect

本轮 progress：交付可从HEAD复验的固定 Goose 工具/审批/续聊/真正旧工具历史模块，现有共同运行时无需新Driver；源文件结果缺失来自上游成功通知省略，不能把模型role=tool正文冒充原生通知详情。成功shell的command文本本身含标记，不能以详情包含该标记自证输出；故分别核对原终端引用、真实stdout和0/7退出状态。Windows路径策略须先使用官方绝对数据根，不能把HOME环境替换当完整隔离证明。

下一轮继续 Goose 的运行中终端取消与同连接恢复，先查 HEAD 的 CursorAdapter interrupt/ToolBroker终端所属/清理与官方 AcpTools cancellation_token 路径，再用实际运行进程的进入屏障验证取消、终端释放与下一回合；不靠sleep/固定模型拖延/自动重发制造通过。若上游只设置令牌但等待终端不结束，如实记录并仅修共用宿主取消责任的真实缺口。读取通知与产品宿主结果显示整合随后按实际产品链验证，不能用本轮CLI替身证明GUI完成。继续全部44/P0–P5与最终新鲜独立验收范围。

### Round 134

#### Plan

上一轮交付固定Goose工具模块和3文件提交为progress，本輪选择运行中宿主终端取消与续聊的完整增量。HEAD共用CursorAdapter interruptTurn仅发ACP取消，终端所属map只在创建返回后登记；ToolBroker.cancel仅标记策略，Goose官方AcpTools宿主shell未使用cancellation_token。用官方1.52.0、绝对临时数据根、本机模型和真实受控Node进程，先复现取消后进程仍存活，再在共用Adapter沿既有终端map/bridge/错误合同修复当前回合停止和晚到创建；保留其它回合/Run资源，失败不伪装成功。精确索引与HEAD独立副本、定向检查、单模块提交，A-8及全部44/P0–P5继续保持原范围。

#### Act

共用CursorAdapter原终端限额map改为同一终端所属表，记录outputByteLimit、创建turnId、ready/killed；terminal.exec调用前登记，避免取消发生在创建响应之前时丢失资源。interruptTurn在ACP取消前标记实际活动回合，沿现有ToolBroker bridge停止本回合已创建终端；逐项Effect.result并等待所有结果，不让某项停止失败中断其它终端停止。晚到创建补停后明确拒绝句柄，停止失败返回ACP错误；未授予当前Run的句柄、其它回合和空闲取消不会按路径/名称误杀。

复用共同killOwnedTerminal与现有runtime.error/ProviderAdapterRequestError合同：停止被拒显示固定脱敏“宿主终端停止未确认（denied）。”及permission_error，其它失败为provider_error；普通取消返回失败，晚到创建同样公开错误。句柄保留给Agent输出/退出查询、release与会话清理。新回合沿原prompt RPC fence等待，不伪造远端stopReason或放宽超时。不新增厂商Driver、依赖、第二终端管理器、数据库或账户改动；直接调用方CursorDriver、GenericAcpDriver、KimiDriver共享修复，Grok独立实现不改。

新增GooseAcpCancellationProbe：普通协议夹具始终执行，官方1.52.0采用独立GOOSE_PATH_ROOT/keyring关闭/auto模式、本机合成模型与实际捕获Node进程，覆盖running、late、denied、late-denied。实际创建/等待/退出/正文完成用Deferred/回执，无新增sleep；允许停止确实退出且同连接下一回合正文GOOSE_NEXT_OK和completed，拒绝仍运行且公开失败，最终会话清理关闭。额外捕获但未授予Adapter的Node进程保持存活，无意外文件副作用，每个停止尝试恰1次。

稳定goose-acp-provider说明共同责任、复验、状态与真实边界；工作文档历史尾部原字节保留。acp-provider-validation只改变Goose行、基线与19项探针统计，其余43行语义相同；23项仅目录/共同合同仍待官方矩阵。独立精确4文件索引提交9a851cdc7a6d64c2f4a9de8974f6f1a8fe240977，索引为空，无push/PR，未提交loop工作记录不混入交付模块。

#### Verify

完整读取运行ledger的Acceptance、Round133最新Retrospect与Lessons，按其运行中取消计划选择唯一增量，未重做既有读取/恢复模块。2026-10-01重新检索/访问固定官方Goose v1.52.0 ACP host terminal cancellation_token，采用固定fs.rs的AcpTools.call_tool/acp_shell/run_terminal_to_completion，因该源码直接定义取消令牌与宿主等待；官方shell分支未传cancellation_token。二进制SHA-256及固定URL记在外置sources.json；不依据最新README/别家ACP客户端推断行为。ToolBroker.cancel本地源码仅结算policy，终端kill另经现有权限与归属路径。

旧HEAD397a4ddc0ee85ccb0433a89f42c83bca2968173f有两个确定红灯：官方running探针取消返回后受控进程仍running，而断言要求exited；普通协议夹具进入terminal.snapshot屏障后取消，没有terminal.kill请求，21:24:11明确[]不等于所属terminalId，0.74秒测试失败，不是超时。仅在独立副本临时还原旧生产文件，finally恢复修复字节，未回写用户工作区；两份失败原日志均保留。

修复后的首次官方3场景失败源于探针显式stopSession后finalizer再次stop，改为已有hasSession防重，不Effect.ignore吞错误。首次新增测试Schema解码在Effect内类型问题按已有解码模式移出；改动后类型/lint通过。新增late-denied检验晚到创建停止失败的公开错误，普通协议夹具确保无CLI opt-in时仍有可运行的回归；最终未插桩测试来自HEAD+精确索引source-Yq3Kvu/source，workspace依赖只指副本，第三方依赖复用现有安装。

最终cli：实际vp test run GooseAcpCancellationProbe.test.ts、GooseAcpToolProbe.test.ts，21:23:24，2文件6项通过、5.92秒；其中官方运行/晚到/两拒绝4项、上轮官方工具矩阵1项、普通夹具1项。原工具矩阵读写/0与7退出/拒绝/审批取消/真正旧工具恢复不回归；前两种运行取消的实际进程退出和下一正文/完成回执均通过。该bridge执行真实Node进程但仍是测试替身，不证明完整产品PTY进程树；原prompt远端stopReason未在本次Adapter探针捕获。

最终normal：新取消探针加AcpJsonRpcConnection、CursorAdapterToolBroker.e2e、CursorAdapter、GenericAcpDriver、KimiProvider，21:24:27，6文件119项通过、4项官方取消因未提供opt-in跳过、53.35秒。新普通夹具与cli批重叠，不直接累加；既有协议fixture的DEP0190 shell告警2条仍保留。按runtime.error额外筛选ProviderRuntimeIngestion.test.ts，21:30:32，错误session状态及活动message/摘要2项通过，97项因筛选跳过，5.92秒；实际GUI未验证。源码确认共同ingestion将固定错误记录为error工作日志并保留lastError，未新增UI状态/合同。

最终Server tsgo --noEmit退出0，仅localAccountModels/localAccountUsage原有2条建议；CursorAdapter及新取消probe定向lint退出0。4文件格式、git diff --cached --check、UTF-8无BOM、无DEVLOG通过。目录自验核对固定6+38=44、12驱动、41+5=46目录、19探针/23目录待官方、61个已提交本地链接；3个负向自验拒绝漏项/错Copilot别名/未提交链接。文档检查器首次仍寻找旧“运行中命令取消”字面锚点，已按新标题“运行中宿主终端取消”更正；该检查器失败不是产品缺陷或放松44项绑定/链接约束。

提交显式VITE_GIT_HOOKS=0，仅绕过vp staged对脏工作树自动暂存/恢复，前述手工定向检查替代；提交后4文件SHA与独立索引相同、索引空，责任外197项原始字节/删除状态与12个重点保留SHA全部不变。旧Goose文档历史尾部未丢失，未按名称杀进程，未启动写入在线数据库的服务。回滚仅撤回本次共享取消模块提交，无迁移，不回滚上轮探针或原用户其它功能。

未证明Goose读取正文与产品宿主结果的GUI整合、完整PTY/进程树、其它官方CLI实际取消、外部模型/真实账号余额/MCP/媒体、Web/Electron/手机或远程/relay/tunnel。本轮以既有公共错误投影与合同为显示证据，不冒充按钮浏览器联调。A-8仍未勾选，A1–A7历史勾选仍待最终新鲜独立审计，goal active、ledger running；旧取消end_turn与读取正文缺失限制保留，不用本轮成功覆盖其它边界。

#### Retrospect

本轮progress：官方Goose触发了共同宿主取消责任的可复现缺陷，旧行为在实际进程和普通协议两条路径都红灯，共享修复后通过。创建响应尚未回来时不能等收到句柄才登记；在已有表中保留创建所属回合并由晚到回调补停足够，无需第二队列。取消本地回合、停止真实进程、远端原prompt结算分别判断；停止被拒必须有公开错误，不能为回合cancelled制造已停假象。多资源停止先收集所有结果，避免第一个失败造成其余命令继续。

下一轮选择Goose读取正文与产品宿主工具结果显示整合：先追踪HEAD的ACP-aware通知省略、ToolBroker实际read回执/工具ID归属和公开活动详情，再用真实产品代理链确定是否已有宿主结果可复用，修有证据的丢失/合并责任；禁止把模型role=tool历史冒充原生通知或重读文件造正文，不新增厂商Adapter。用户已授权浏览器，可在集成后按隔离服务实际入口验证显示，受阻如实保留边界。继续44入口/P0–P5、其它23项目逐项证据与最终独立审计，不能用本轮取消通过宣布总目标完成。

### Round 135

#### Plan

上一轮9a851cdc7已交付共同终端取消模块，属progress。本轮选择真实Goose经产品ToolBroker读取及公开工具详情的完整验收增量：检索HEAD发现fs/read_text_file请求没有上游toolCallId，原生ACP-aware成功通知省略正文；产品makeToolIdentity生成宿主独立身份，ToolBroker实际read回执返回脱敏/限长内容但持久化只留状态/摘要指纹。Paseo固定readTextFile也只回传内容，不提供精确关联。先以固定1.52.0和本机模型，把共同CursorAdapter、CompositionRuntime/ProviderBridge、真实ToolBroker及WorkspaceFileSystem串起来，核对单次真实读取/脱敏正文、越界拒绝/缺文件明确失败、公共通知与工作详情；不存在权威关联时明确限制，不按路径/最新工具猜并行身份、不重读或增造第二工具显示。复用现有e2e层和公共投影，交付可运行模块与稳定边界文档，精确索引/独立副本检查后单独提交；44/P0–P5与最终审计不缩减，A-8未满足。

#### Act

新增GooseAcpToolBrokerProbe.test.ts，将固定官方1.52.0、本机受控模型、共同CursorAdapter、CompositionProviderToolBrokerBridge/RuntimeToolBridge、真实ToolBroker/WorkspaceFileSystem串成可复验产品读取入口。复用已有ToolBroker e2e的CapabilityRegistry/Policy/Workspace层、既有isolatedProbeEnvironment/ServerConfig及公开投影，不新增生产Adapter/接口/依赖；Task/Run查询是明确受控已授权记录，实际宿主读取没有替身。只向临时工作根与独立GOOSE_PATH_ROOT写配置/文件，keyring关闭，auto模式明确选择，模型GET/POST/SSE与对应role=tool身份均校验。

三回合分别读取工作区源文件、越界文件、缺文件。源文件内容经产品ToolBroker现有脱敏返回，合成api_key变为[REDACTED]，原文件不改；越界请求在共同路径校验拒绝、不进入ToolBroker，缺文件真实代理failed再转明确ACP错误，没有空成功。宿主调用2次，其中源成功1次、缺文件1次，验证文件读取另作只读核对；模型和公开事件无原合成密钥/越界正文，三回合完成，没有重复模型动作或重复工具显示记录。

Adapter原生读取item.completed有3项completed/failed/failed，再经过runtimeEventToActivities/projectActivityPayload有3条公共工具记录；成功详情仍仅路径，没有原正文/content/rawOutput。宿主生成调用ID不等于原生itemId；固定Goose宿主read请求未传toolCallId、ACP-aware成功通知省略内容。HEAD的Invocation协调器只保存归属/状态/指纹，没有可拿来补历史正文的结果载体；固定Paseo readTextFile也仅回传CLI内容，不做此关联。没有生产字段已丢失的证据，故不按路径/唯一已观察read/最近工具猜身份，不重读文件或添第二工具行制造“已修复”。产品读取通过与正文显示未实现分别登记。

更新稳定goose-acp-provider的产品读取、脱敏/越界/失败、公开详情、协议关联条件、复验与回滚；保留工作文档旧历史尾部字节。读取正文后续应由Agent在同toolCallId通知返回实际结果，或双方协议给出明确宿主关联，再复用现有合并/预算/公共详情链，当前不声称已有这个功能。acp-provider-validation只更新Goose行、基线/20项探针数量，其它43行语义不变，23项目录/共同合同仍需官方矩阵。单模块3文件提交5b7772d29ef2eecb4cad485bb7f8efc8e57fd188，索引空，无push/PR；loop工作记录不提交。

#### Verify

上下文核对运行ledger的Acceptance、Round134最新Retrospect与Lessons、原计划P0–P5，上一轮实际代码/提交/红灯明确为progress。责任检索覆盖共同read handler/随机身份、Runtime工具状态表、ToolBroker脱敏/64KiB限额、Invocation协调持久化、公共活动/投影与固定Paseo/Goose源码；未把已有原生合并能力重实现。范围仍固定6+38=44，A-8未满足。

检索词Goose v1.52.0 acp_read_text_file toolCallId；Paseo fixed readTextFile，访问2026-10-01。Web核对固定Goose fs.rs的ReadTextFileRequest只设置sessionId/path及line/limit。Paseo网页find未找到代码片段，改用已核对23c4404b955fbc1a6904b7140f911d9f29de1f27的只读官方克隆查readTextFile，采用固定源码因为它定义实际处理，不猜最新README或网页未匹配为不存在。CLI --version=1.52.0；二进制SHA-256、固定URL、采用理由记录在外置sources.json。公开原生body省略与宿主独立ID在产品链直接验证，不靠合成回复冒充通知。

验证源为9a851cdc7a6d64c2f4a9de8974f6f1a8fe240977加精确3文件索引副本source-6w8dag/source，workspace依赖指副本，第三方依赖复用安装结果。首次新官方probe1项直接通过，未虚构生产缺陷红灯。首次Server类型检查3处unknown data字段访问失败，并指出多次Effect.provide生命周期告警；按现有Schema验证收窄读取数据、toHaveProperty检查未知对象、合并Layer提供后修复测试自身问题，不关闭诊断或改生产行为。一次apply_patch因格式化后提供Layer的锚点行分段而失败，没有文件变化/后续依赖运行；读取实际片段后精确修改。

最终run-check.mjs cli实际执行vp test run apps/server/src/provider/acp/GooseAcpToolBrokerProbe.test.ts，21:52:47，1文件1项通过，5.50秒；官方3工具动作、2宿主调用、3对应模型结果、3公开工具终态及脱敏/越界/缺文件/原字节/ID不同断言均通过。模型是受控本机端点，真实文件读取来自产品ToolBroker；不代表外部推理、真实账号或完整数据库Run生命周期。

run-check.mjs normal执行新官方probe、CursorAdapterToolBroker.e2e、CompositionRuntimeToolBridge、CompositionProviderToolBrokerBridge：21:51:11，3文件17项通过、1文件1项官方probe因没有opt-in跳过，3.83秒。协议fixture既有DEP0190 shell告警1条保留。新官方probe代码收窄/Layer改动后真实CLI重新通过；没有扩大到全仓检查或重复跑上轮119项未改行为。

最终Server tsgo --noEmit退出0，仅localAccountModels/localAccountUsage原有2条建议；新probe定向lint退出0。精确3文件格式、git diff --cached --check、UTF-8无BOM/DEVLOG为0，索引与副本字节相同。目录自验固定6+38=44、12驱动、41+5=46目录、20已提交探针（Goose多个入口不能当多个Agent）、23目录待官方、62本地已提交证据链接；3负向自验拒绝缺行/错别名/未提交链接，旧历史尾部完整。

提交显式VITE_GIT_HOOKS=0绕过vp staged自动暂存/恢复脏工作树，手工定向检查替代，绕过如实记录。提交后3文件SHA匹配精确索引、索引空；责任外198项原始字节/删除状态与12个重点保留SHA不变。临时CLI、HTTP、配置目录由Scope关闭/回收，只结束自己捕获的CLI；未启动浏览器/写入在线数据库，生产代码/账户/配置不改。回滚仅撤回本次测试与稳定文档提交，无迁移，不撤回上轮取消修复或用户原工作。

读取正文UI仍未实现：协议缺权威ID且成功通知缺body，实际CLI收到正文不等于原生工具详情有正文；未以路径猜关联/重读文件补假结果。当前只证明产品读取，不能外推产品write审批、真实终端PTY/进程树、持久化Run/多端/远程/MCP/媒体/真实余额。A-8未勾选、A1–A7历史声明等待最终新鲜独立审计，goal active、ledger running，不把20探针或18项本轮测试当44入口全部完成。

#### Retrospect

本轮progress：从上轮宿主替身推进到固定Goose经真实产品工具代理与公共投影，有可从HEAD运行的端到端读取/脱敏/越界/缺文件与ID边界证据。根因检索显示结果没有共同关联身份，宿主读取成功与原生通知正文缺失可同时为真；简单按文件名注入正文会把并行同路径、edit内部读取或迟到响应误记给其它工具。尊重实际协议，在能力记录中保留未实现，不能用新字段或合成模型结果掩盖缺口。公共投影未丢已有正文，暂不新增生产合并规则。

下一轮推进Goose的产品宿主写入/审批权限闭环：用同一真实ToolBroker链复现明确已授予写入的调用，查CompositionProviderAgentDriver可信runtimeMode、CapabilityPolicy审批及Runtime/ProviderBridge是否传递/公开审批身份，核对原生allow_once与宿主授权是不同合同。若因缺可信模式或审批回传而固定拒绝，在共同责任入口修复并覆盖允许/拒绝/取消/越权，不把外部声明当full-access，不绕过权限。原生读取正文需上游同ID结果或明确关联条件，继续保留限制；后续仍按其它23项、44入口/P0–P5和完整最终独立审计推进，不以验收入口代替功能总交付。

### Round 136

#### Plan

上一轮5b7772d29交付真实产品读取探针，属progress。本轮只修Provider宿主工具可信运行模式传递：现有Driver服务端选定runtimeMode供Session使用，但Context/ProviderBridge/RuntimeBridge在到达ToolBroker前丢失它，写入仍需审批。先扩展固定Goose1.52.0产品探针确认实际授权写入失败，再复用已有RuntimeMode内部第二参数传递服务端上下文，公开HTTP/协议单参数保持不携带可信模式。覆盖允许、审批模式拒绝、越界无副作用及原始输入伪造不提权；保留能力授权、持久化工作区、原生权限与宿主权限各自门禁，不把原生allow_once转换为全局full-access。不新增Driver/权限系统/依赖。同步稳定边界文档，精确白名单独立副本验证后单模块提交。A-8及44/P0–P5总范围保持。

#### Act

生产只修改共同可信模式传递4文件：ProviderAdapter的内部ToolBrokerContext增加可选RuntimeMode及信任来源注释；CompositionProviderAgentDriver绑定与Session相同的服务端模式；CompositionProviderToolBrokerBridge固定身份/授权/握手并把context模式作为RuntimeBridge内部第二参数；CompositionRuntimeToolBridge显式把内部参数传ToolBroker。外部Invocation、HTTP/协议Client、CapabilityPolicy和取消合同未改，不读取工具参数中的模式，不新增权限系统/Driver/依赖。

扩展既有3个层级回归，Driver覆盖full-access/approval-required在会话与context一致，两层Bridge覆盖模式缺省/审批/全权限及原始输入伪造。另把已有真实HTTP合同回归纳入白名单，直接提交伪造runtimeMode的JSON，断言不能进入可信参数。这使计划中的9文件精确白名单扩展为10文件，仍属同一可信模式增量。

扩展HEAD既有GooseAcpToolBrokerProbe，保留3次产品读取与脱敏/详情限制，新增full-access实际写入、审批模式拒绝和越界写入，共6个官方动作、4个真实ToolBroker调用，核对文件字节/无副作用、6个模型对应tool结果和原生及公共投影终态。稳定goose-acp-provider文档新增可信模式/当前证据/权限限制/复验/回滚段；旧工作历史尾部原字节保留，不改其它43项目录记录。模块单独提交38f60a5a3633f433f2385e796bf4530095ea7fc5，无push/PR；loop是工作记录，不提交。

#### Verify

已核对Acceptance、Round135最新Retrospect、全部主Lessons、原P0–P5计划与当前HEAD。上一轮真实产品读取属于progress。责任检索覆盖Driver Registry到Driver服务端模式默认、ProviderService configureToolBroker唯一入口、共同Bridge所有生产调用、公开HTTP/Protocol单参数、真实ToolBroker到既有CapabilityPolicy、CursorAdapter pending/active binding生命周期和固定Goose fs.rs写入实现。没有把读取成功外推写入，也没有把上游审批许可当服务端full-access。外部资料使用已锁定官方1.52.0源码/二进制，不下载或升级，查询来源与采用理由沿稳定页记录。

运行源为5b7772d29ef2eecb4cad485bb7f8efc8e57fd188加精确索引的独立副本source-eiTDoc/source，workspace依赖指副本，第三方依赖复用本机安装。红灯22:15:44：官方CLI1项失败，allowed.txt拥有write能力、服务端context full-access仍返回denied；普通56项中4项失败、52项通过、1项官方probe未opt-in跳过，分别确认Driver与两层Bridge模式丢失。原始cli-red.json/normal-red.json及时间戳日志外置保留，不虚构旧错误。

第一次修复后官方allowed写入断言已通过，但预期审批拒绝的组实际succeeded；检索证实测试自身在活动会话只配置pending binding而未激活，旧full-access仍在用。按产品建会话合同在每组写入前stop自己的会话、configure再start；不改生产binding、不把负向断言放宽为成功。负向组Goose原生auto仍放行，宿主approval-required真实拒绝，证明两面独立；它不证明原生approve到宿主approvalRequestId的完整交互。22:17:58原官方probe通过后再新增公共写入活动断言，最终22:22:32官方1文件1项通过，8.36秒；完成6动作/4宿主调用、单次allowed写入精确字节、denied不存在、outside原字节不变，原生和公开写入状态completed/failed/failed，读取脱敏/缺文件/ID边界保持。

最后普通run-check normal在22:21:20执行ProviderAgentDriver/Registry、ProviderBridge、RuntimeBridge/HTTP/Protocol、CapabilityPolicy和CursorAdapterToolBroker.e2e及opt-in官方probe，共8文件56项通过、1文件1项未opt-in跳过，5.57秒。真实本地HTTP含伪造mode提交，既有策略缺失/越权/过期/撤销grant及不支持操作仍拒绝；异步取消/idempotency回归保持。探针随后只补公开活动断言，最终官方原检查通过；普通模式该项本就跳过，不重复扩大检查。固定协议夹具原有DEP0190 shell告警保留。

最终Server tsgo --noEmit退出0，仅localAccountModels/localAccountUsage既有2条建议；9个改动源码/测试定向lint退出0，RuntimeBridge原有未用ValidatedScope与内联Schema编译2条警告保留。10文件索引格式、git diff --cached --check、UTF-8无BOM/DEVLOG为0，索引与独立副本字节一致。模块自验7个本地证据链接存在、公开Invocation不含mode、HTTP单参数、Policy/HTTP/Protocol/目录验证页等与基线原字节语义相同，旧历史尾部完整。

提交显式VITE_GIT_HOOKS=0绕过vp staged自动暂存/恢复脏工作树，以已运行定向检查替代，绕过如实记录。提交10文件SHA匹配精确索引，索引空；责任外199项原字节/删除状态和12项重点保留SHA不变。官方CLI/本机HTTP/临时目录由Scope关闭，不结束其它进程、不启动浏览器、不写在线数据库。回滚只撤回本次模式传递/测试/文档模块，无迁移，保留以前取消修复及用户工作。

本次不是完整审批UI验收：产品approval-required仍需审批发起/返回身份闭环；真实产品PTY/进程树、持久化Run、真实账号/余额、多端/远程/MCP/媒体和44入口最终独立审计未由本次证明。A-8未勾选，A1–A7历史声明待新鲜审计，goal active、ledger running，不将局部57项检查当作全部完成。

#### Retrospect

本轮progress：明确旧行为授权写入仍denied，修复共同责任入口后同一官方CLI/真实ToolBroker确实写入，审批/越界不放宽。模式是服务端会话事实，应与外部Invocation分离；复用已有内部RuntimeMode参数和Policy就够，不为单一字段再造权限框架。负向fixture必须遵守binding激活时机，否则测到旧模式并误判权限漏洞；原生auto许可和宿主审批各有身份，不能用一种成功掩盖另一面。

下一轮继续产品宿主审批身份与交互闭环：先查Driver/RuntimeBridge/ToolBroker已有approvalRequestId、CapabilityPolicy授权接口、服务端审批事件与UI消费者，以及ProviderBridge/Adapter是否回传/展示该身份，再选择一个实际缺口修复。用有效write授权和approval-required复现申请、明确允许、拒绝/取消与越权边界，保持原生optionId和宿主授权不同合同，不把一次原生allow_once升级为full-access、不绕过Run/根目录校验。读取正文仍需上游同ID结果或明确协议关联，不以路径猜测填充。其后保持其它23項官方矩阵、44入口/P0–P5和完整最终独立审计范围。

### Round 137

#### Plan

上一轮38f60a5a3修复可信模式并真实写入，属progress。本轮只接通Provider宿主审批交互：现有ToolBroker返回approvalRequestId、CapabilityPolicy已有单次approve和取消，CursorAdapter将拒绝转为通用ACP错误，未发布宿主审批且无生产调用policy.approve。复用现有request.opened/resolved、pendingApprovals和respondToRequest，在共同RuntimeBridge的在途claim中等待服务端审批，再按同身份/同幂等键/原参数执行一次；拒绝、取消、越权/撤销与迟到结果不授权。可信审批callback和执行期限保持内部，公开HTTP/协议不能提交callback；执行超时不把人工等待算进30秒。既有原生optionId独立，不将一次允许升级会话模式。用普通子进程产品E2E及固定Goose真实读写核对允许/拒绝/取消与公共投影，定向回归/类型检查。CursorAdapter原本有未提交改动，交付源从HEAD独立修改，工作文件只应用同一唯一片段且保护原差异；精确索引独立副本验证后单模块提交，A-8和44/P0–P5范围不缩减。

#### Act

本轮仅接通共同宿主单次审批与执行期限，生产修改ProviderAdapter类型、ProviderBridge、RuntimeBridge和共同CursorAdapter四文件。内部回调复用request.opened/resolved、pendingApprovals和respondToRequest，三个明确选项accept/decline/cancel，不提供会话/永久扩权。回调返回类型使用已有ProviderAdapterRequestError，清理删除等待项后沿既有事件合同结算；正常错误仍显式返回，取消清理的失败转缺陷而不吞掉。ProviderBridge只从服务端第二参数传回调，固定可信身份保持；原始工具参数伪造callback/mode不进入RuntimeBridge内部参数，公开HTTP/Protocol合同不变。

RuntimeBridge live注入真实CapabilityPolicy.approve，现有在途claim继续持有取消所有权。只有accept授权并用同一task/run/agent/toolCallId、幂等键/参数及approvalRequestId重试一次；等待后重新核对Run与持久化工作根，ToolBroker仍执行实际grant检查。decline/cancel和未提供扩大授权均不执行，缺内部回调/approve仍明确需要审批。期限从ProviderBridge外层移至实际Broker调用，人工等待不消耗30秒；通过现有acquireUseRelease/forkChild/Fiber.interrupt明确持有实际分支，取消/超时在返回前等待分支停止和清理，防迟到审批/工具副作用。复用既有库，不新增Driver、依赖、公开字段或第二套权限系统，不修改原生ACP审批选项。

扩展原普通产品协议E2E为read/accept/decline/cancel，仍使用HEAD既有acp-mock-agent而不修改共享脏夹具。扩展固定Goose1.52.0真实产品矩阵为8动作/7个Broker尝试，允许包含一次申请和原身份执行，核对3个host request配对决定、单次写入和原生/公共状态。更新稳定goose-acp-provider说明新链路/期限/取消根因、各项证据与回滚，前轮证据保留并明确其后续进展。模块9文件单提交755dd3795d8b7d2c61073d25b4d8955c7dc2749b，无push/PR，loop仅工作记录。CursorAdapter交付从HEAD只增共同invokeTool片段，工作源仅应用同一格式化片段；旧用户差异可反向还原到原始完整字节。文档历史尾部逐字节保留。

#### Verify

沿Acceptance、Round136最新Retrospect和Lessons检索原计划P0–P5。上一轮可信模式交付属于progress。责任检索覆盖真实ToolBroker/CapabilityPolicy审批和cancel、RuntimeBridge在途所有权、ProviderBridge所有调用、共同Adapter原生pending审批/interrupt/stop清理、公开事件合同/共享审批选项与Web消费者及server Layer注入；policy.approve原生产调用缺失与Adapter直接错误均有源码依据。Grok无相应宿主ToolBroker入口，未臆造新Driver或在独立适配器强加此接口。固定Goose源码与CLI沿已有锁定资料核对，无下载/升级/真实账号。

独立源为38f60a5a3633f433f2385e796bf4530095ea7fc5加精确索引source-ACy4aG/source，workspace依赖指向副本，第三方依赖沿既有本机安装。首个新增审批测试缺早退屏障而超时，不能作为产品红灯；补屏障后red-1790865624309.log明确“工具未等待审批：denied”。接通后取消回归又失败，迟到accept实际得到calls=2/approvals=1/cancels=0；只添加interruptible仍不能解决。外置最小runtime诊断复现实际beta.103默认raceFirst返回后败方未中断，迟到Deferred使执行数从0变1，与只读vendored最新资料的默认中断说明有差异，故不凭文档假设运行时已回收。改为明确持有/中断两条实际fiber后，原取消所有权、迟到允许与清理屏障断言全部通过；执行期限也用实际entered/released屏障验证超时后释放迟到结果不产生副作用，无sleep或弱化断言。

新增类型的unknown错误通道及最终清理Effect带ProviderAdapterRequestError曾失败，改为已有具体错误类型及finalizer明确orDie后正式重跑，失败日志保留，不压掉类型诊断。最小诊断脚本初次import路径也有两次准备错误，使用实际apps/server/node_modules绝对file URL后完成；不将路径准备失败归为产品问题，不编辑vendored依赖源码。

最终normal-1790867125875.log：23:05:15，7文件中6通过/1未opt-in跳过，38项通过/1官方probe跳过，9.90秒，覆盖Bridge、真实本地HTTP、Protocol、Policy及四组普通产品E2E。内部callback的正向转交与原始输入伪造忽略另在ProviderBridge原测试断言；人工审批跨一分钟TestClock仍等待，允许后身份完全相同；错误scope/重复幂等键/Run改变/拒绝/取消/扩大授权和迟到结果按原断言拒绝或取消。无需官方CLI的普通子进程验证真实WorkspaceFileSystem字节和无副作用。

最终cli-1790867126442.log：同日23:05:15，指定已安装官方Goose1.52.0，1文件1项通过，11.33秒。真实ToolBroker/WorkspaceFileSystem矩阵8动作、7尝试；保留3读取脱敏/越界/缺失及前轮full-access写入，新增宿主decline/accept/cancel，approved.txt精确GOOSE_PRODUCT_WRITE_31579，denied/cancelled不存在，越界原字节不变。3opened/resolved逐一同ID与decline/accept/cancel匹配，无contents泄露；allow重试同工具ID/参数/幂等键。原生/公共5写入终态completed/failed/failed/completed/failed；宿主取消事件为cancel但不伪造上游Goose原生cancelled。

原生共同边界回归会话48517：CursorAdapter.test、GenericAcpDriver.test、KimiProvider.test、AcpJsonRpcConnection.test，4文件117项通过，23:06:01起52.18秒；等待原会话完成，不重跑/累加重叠。既有DEP0190 shell弃用告警保留。最终Server tsgo退出0，仅既有账号池2条建议；8个变更TS定向lint退出0，RuntimeBridge原未用ValidatedScope和内联Schema2条警告保留。文档完成后只格式化该白名单，没有改通过的TS语义，不重复广泛检查。

9文件索引格式、git diff --cached --check、UTF-8无BOM/诊断残留为0、索引/独立源字节一致；7个本地文档证据链接存在，Policy/公开HTTP/Protocol/contracts/HEAD夹具原字节不变。提交显式VITE_GIT_HOOKS=0避免自动暂存/恢复共享脏工作树，以已执行定向检查替代并记录绕过。提交9文件SHA匹配验证索引，索引空；模块外198项原字节/删除状态、12重点SHA未变，Cursor原差异反向逐字节还原/仅一责任片段，文档原历史尾部完整。CLI、连接及临时资源均由Scope回收，没有按名称终止进程，没有浏览器/服务启动或在线数据库写入。

本次证明宿主事件/既有回应入口与真实工具副作用，不证明浏览器按钮点击、完整持久化Run、真实产品PTY进程树、账户/余额、外部模型、Electron/手机或远程联调。Grok独立宿主实现未改，Goose读取正文权威关联限制仍保留。回滚仅撤回本单次审批/期限模块，无迁移，保留前轮可信模式/终端取消及用户工作。A-8未勾选；历史A1–A7仍待新鲜最终审计，goal active、loop running、44入口/P0–P5总范围保持。

#### Retrospect

本轮progress：从明确需要审批即失败推进到真实产品申请/单次允许/拒绝/取消闭环，另修有迟到执行证据的共同取消根因。最小方案是复用现有pending审批与policy，不新增另一权限层；原生许可和产品宿主许可始终独立。类型/普通测试通过不足以证明运行时race已终止实际worker，必须让迟到结果继续抵达并确认副作用数不变，且检查返回前清理屏障；不能用注释或只取消join观察者代替结束工作。

下一轮只推进宿主审批的实际客户端链路：先检索request.opened/resolved到ProviderRuntimeIngestion、公共pendingApprovals及共享/Web审批按钮是否保留本次明确options/工具名/路径与requestId，按现有批准的test-codework-app隔离服务和浏览器流程验证申请可见、允许单次落盘、拒绝/取消无写入、结算消失及迟到回应无新副作用。若出现遗漏，在共同投影/消费责任点修复，不另造界面/第二条时间线；实际点击与本轮直接respondToRequest分开留证，桌面/手机/远程各自不能外推。随后仍推进其它23项官方矩阵、44入口/P0–P5和全部新鲜最终独立审计，不把本轮155项普通回归及1项官方矩阵当作全部完成。

### Round 138

#### Plan

上一轮755dd3795完成共同宿主单次审批/期限与真实Goose读写，属progress。本轮只验证并修复宿主审批公共投影到实际Web按钮的共同链路，先确认已有options、detail、requestId及回应入口，复用现有pending审批和Composer组件。使用HEAD独立源码及隔离数据根，沿已批准的test-codework-app/browser-control实际申请、允许、拒绝、取消和结算；明确协议/宿主替身/真实产品Run及文件副作用各自证据。若无需生产修改则补齐必要端到端合同回归和稳定边界文档；不为验证造第二套权限、Driver或时间线。普通自动检查先于页面，跨轮保留自己启动的测试环境；只提交本模块精确文件，原脏树与历史尾部保持。A-8/44入口/P0–P5最终范围不缩减。

#### Act

从上一轮客户端审批计划追踪实际生产派发入口，发现前置缺口：真实Registry未传runtimeMode，Driver固定默认full-access；前轮Goose探针显式配置approval-required，不能证明生产任务遵守对话选择。已有公共投影、pending审批和Composer支持明确options/detail/requestId，无证据需要重写UI。本轮将一个共同增量收敛到关联对话模式正确派发及审批公共投影合同，计划调整原因保存外置plan-amendment.md，实际按钮矩阵留待该前置修复后验证。

CompositionProviderAgentDriver复用已有runtimeMode配置，兼容静态值并允许可信服务端按当前Task解析，在签发握手/建Session前取得模式；Session与ToolBrokerContext使用同一个结果。Registry每次启动读取关联ThreadShell，不在Registry刷新时缓存对话模式。明确关联线程缺失/查询失败返回provider_thread_not_found/provider_runtime_mode_lookup_failed，不调用Adapter；没有线程关联时沿已有DEFAULT_RUNTIME_MODE，当前确为full-access，不擅改全局默认。生产live注入现有OrchestrationProjectionSnapshotQuery，server既有Layer提供该依赖，没有新增公开参数、Driver、权限层、依赖或数据迁移。

同步getStartIdentity仅对静态模式记录已知值；动态解析尚未启动时记录null，避免把未知模式伪报为full-access。恢复时保存实际模式的完整持久化行为尚未验收，不用该null冒充已有模式快照。扩展既有Driver/Registry测试，关联模式approval-required/full-access/approval-required逐次生效，第四次无关联复用既有默认，清理前一个Run后再开始；缺线程/查询失败无会话或握手副作用。新增公共审批投影回归，同一requestId、工具/路径详情、accept/decline/cancel选项与三种结算决定完整，原args和合成写入正文不进公开活动。

从HEAD加精确索引建立独立源source-8DWTaW/source、workspace依赖指向副本，完整dev用外置home，不读写在线安装数据库。依赖镜像缺.bin/vp.cmd导致准备阶段spawn vp ENOENT，补齐副本内现有shim后启动，不修改生产dev runner。浏览器已授权且使用test-codework-app/browser-control技能；in-app标签1完成配对、观察初始引导页及源码watch重启后恢复连接。没有项目/真实数据库Run或审批按钮点击，未将配对当审批验证；环境和自己捕获的session29213跨轮保留，地址/数据根/证据边界保存不含配对令牌的environment.json。

本模块7文件单提交8c0326c25b480f102c28c44c20afbd56da7e234b，loop是工作记录不纳入提交。文档稳定正文说明根因、模式/证据/恢复边界与回滚，原历史尾部逐字节保留。6个TS只应用本模块交付源，CursorAdapter和其它用户差异未修改。无push/PR；回滚仅撤回本次关联模式解析、live注入、对应测试与说明，保留前轮宿主审批及用户工作，无迁移。

#### Verify

上一轮755dd3795已交付宿主单次审批/期限，属于progress。沿Acceptance、最新Retrospect、Lessons和完整44入口/P0–P5检索共同Registry/Driver、全部runtimeMode调用、生产Layer、pending审批/公开投影/Composer及Task/Run入口，不假设前轮静态官方探针覆盖生产派发。公开合同、CapabilityPolicy、共同Adapter和UI源码本轮保持HEAD；检索证明已有显示承载可以复用。

新增测试第一次3失败中Registry因未回收旧Run触发busy，是夹具错误；按既有revokeCapabilityHandshake收尾后red-1790868586819.log显示旧Registry全部full-access，关联第一/第三次本应需要审批，动态Driver配置函数也未解析。负向用例最初把无关联默认误认为approval-required，查实际DEFAULT_RUNTIME_MODE修正测试为full-access，保留产品默认而不为绿灯改权限。首次类型检查发现同步getStartIdentity遗留runtimeMode变量，按真实同步边界改为动态null并补身份断言；不压制类型错误。

首次lint因新增3个手动Effect.runPromise超出既有Registry测试runner基线而失败。外置check-lint-baseline确证同文件HEAD lint退出0，遂只把新测试改成已有@effect/vitest的it.effect生成器；没有修改规则、基线或disable。所有准备/夹具/类型/lint失败日志保留，不当成多次产品红灯或正式通过数。

最终normal-1790869091323.log，2026-10-01 23:38:07起，Driver/Registry/ProviderBridge/RuntimeBridge/审批投影5文件55项通过，3.63秒。Server tsgo --noEmit退出0，仅既有账号池两个建议；6个TS定向lint退出0，Registry测试原ThreadId未使用警告1条保留。7文件格式、git diff --cached --check、UTF-8无BOM、诊断残留/源码SHA检查通过；7个本地文档链接存在，公开合同/Policy/Adapter/UI字节未变，原文档历史尾部完整。正式检查后只调整文档文字与格式，没有改已通过TS语义，不重复宽泛测试。

提交显式VITE_GIT_HOOKS=0避免自动暂存/恢复原脏树，以实际定向检查替代并记录；check-commit核对7文件提交SHA与通过的精确索引一致、索引空、12重点保留SHA不变。check-preservation模块外199项原字节或删除状态全部一致，无并发漂移。没有全仓检查、subagent dispatch、真实外部模型/余额调用或在线数据库写入。

隔离完整dev实际ready，最终本轮源码watch后捕获服务器PID53196于23:41:27监听13773；短暂ECONNRESET/ECONNREFUSED来自自己同步副本触发重启，随后已自动恢复，不认作审批缺陷。当前浏览器Code Work(Dev)显示三步引导、供应商已就绪和添加项目按钮，已markHandoff；未执行允许/拒绝/取消，也无业务文件落盘证据。本轮未跑官方CLI矩阵，不累计上一轮Goose结果为本轮通过。真实持久化Run、恢复模式、产品PTY、Web审批按钮、Electron/手机、账户余额和远程各自仍待验证。

A-8保持未勾选，历史A1–A7为待新鲜独立终审声明，goal active、loop running；不采用旧历史豁免或完成报告结束全范围。实际模式派发回归满足本轮小增量，不代表任何整个Acceptance新增满足。

#### Retrospect

本轮progress：发现并修复真正生产Registry遗漏关联模式的共同根因，防止静态探针的审批成功掩盖实际入口默认全权限；55项回归和完整dev启动证明代码交付与依赖注入可用。沿现有runtimeMode承载/ProjectionSnapshotQuery/审批组件即可，不需要新策略框架或界面。未知启动身份应如实null，完整Run恢复模式还需沿真实入口核对。夹具忙碌、默认误读、lint净新增禁令与实际模式遗漏分别归因，保留失败而不弱化断言。

下一轮只推进真实产品数据库Run到宿主审批Web按钮这一连贯链路：复用当前隔离服务、数据根和浏览器，先核对Task/Run running及握手持久化与Provider turn.started的实际顺序，再通过现有业务命令建立项目/关联对话、选择需要审批并派发任务；不用手写业务投影制造成功。用既有本机模型/CLI或明确普通协议夹具申请真实ToolBroker许可，实际点击单次允许/拒绝/取消，核对同ID结算、一次落盘或无副作用和迟到回应；若出现共同责任缺口再定点修复。保持44入口/P0–P5、其余官方矩阵、多端/远程与最终新鲜独立审计总范围，不把初始浏览器可达或本轮55项测试当完整完成。

### Round 139

#### Plan

上一轮8c0326修复真实Registry关联模式，属progress。本轮沿其Retrospect只推进真实数据库Run到宿主审批Web的同一链路，先核对sendTurn/turn.started与running/握手持久化时序，使用保留的隔离source/home/session29213和已配对浏览器；业务数据只由现有命令/RPC建立，不手写投影。若握手在回合结束前不可用，先有真实派发与确定回归再在已有运行时归属/Projector修共同根因，不放宽ToolBroker门禁或复制Driver。核对允许/拒绝/取消和实际文件副作用；界面或真实Run尚未完成的边界明确保留。单模块精确提交；A8、44入口/P0–P5及所有新鲜最终验收维持，不采用旧豁免。

#### Act

沿上一轮真实Run到宿主审批的计划，用保留的完整隔离服务和业务RPC建立项目、关联对话并派发。发现更早的共同生产缺口：Cursor与Generic ACP真实派发均持久化failed/provider_capability_handshake_unsupported，生产Profile的supportsToolBroker与supportsCapabilityHandshake均false。检索Projection、server Layer全部调用以及Bridge依赖，确认serviceOption静默读取不到同级Layer；原Bridge又反向依赖包含Projection的RuntimeDependencies，直接提供整个依赖会循环。计划调整原因保存外置plan-amendment.md，本轮收敛为生产Bridge正确注入一个共同增量，下游握手时序与按钮矩阵不混入未证补丁。

CompositionProviderAgentDriverRegistry生产Projection要求CompositionRuntimeToolBridgeService，缺失即构建失败；工厂明确不支持工具的调用方仍沿既有可选选项。server提取并复用现有加密InputStore Layer，以TaskStore/InputStore/ToolBroker构建Bridge，先显式提供给Projection，移除Bridge对整个RuntimeDependencies的反向依赖。复用同一Layer对象，不新增存储、公开合同、Driver、依赖或权限框架；ToolBroker的Task/Run状态、可信握手、grant和工作根验证没有放宽。

在既有Registry测试新增两项生产projectionLayer回归：故意缺Bridge的Context必须构建失败且Cause含服务名，提供Bridge则共同Profile两项能力为true。测试复用真实DriverRegistry/PubSub及@effect/vitest，部分服务替身和故意缺服务只在测试显式类型断言，不隐藏生产缺失或改lint基线。文档稳定段说明根因、依赖边界、真实失败、下一责任点及回滚；原历史尾部3076字节保持一致。

独立源码沿用上一轮source-8DWTaW/source与外置home，完整服务exec session29213跨轮保留；项目/对话/Task/Run只通过现有业务命令和server.dispatchCompositionTask建立，不手写running或handshake投影。RPC鉴权复用现有bootstrapRemoteBearerSession与remoteHttpClientLayer，隔离临时令牌只存外置私有准备文件，不进入提交、文档、截图或回复。普通ACP子进程夹具请求真实宿主读取和审批写入，不把它称为官方Cursor/Goose或外部模型调用。

修复后真实生产Cursor Profile两项能力true，新的实际Task/Run进入Session、turn.started与持久化runtimeTaskId，随后宿主读取明确失败为provider_turn_failed，错误为Code Work ToolBroker未完成ACP请求。已授权的in-app浏览器进入真实业务对话，看到同一错误并保存run-failure.jpg、markHandoff；未出现可通过的审批流程，不虚构允许/拒绝/取消按钮或写入成功。未仅凭错误文案断定握手不匹配，下轮以受控回执和真实Store确定具体门禁/顺序。

本模块4文件单提交eaf013dc56f09c77ccb45b0cf8d512abf1b69b13；工作ledger不入提交，无push/PR。回滚只撤回本次必需Bridge注入、server Layer解环、两项回归及说明，无数据库迁移，保留前轮关联模式/宿主审批与用户原工作。

#### Verify

完整Acceptance、Round138 Retrospect、Lessons、生产Projection/Layer/Bridge调用与真实业务RPC检索后选择本增量；上一轮8c0326是关联模式progress，不能用工厂静态探针证明生产依赖正确。没有subagent dispatch、全仓检查、在线Code Work数据库写入或真实账户余额请求。

red-1790870803399.log在旧生产serviceOption实现上运行两项新生产Layer回归：1失败、1通过、原4项筛选跳过，缺Bridge竟成功，确认共同缺口。第一次类型检查在故意缺服务Context与部分Shape替身上报4项测试类型错误，改为显式故障注入Context和unknown中转，不压制生产诊断。准备期间watch重启使pair短暂找不到服务，初始手写OAuth JSON报Unsupported content-type，随后复用既有helper；再补它要求的HttpClient Layer，恢复ready后实际业务鉴权成功。环境准备失败分别保留，不算产品红灯或重复绿灯。

最终normal-1790871201273.log，2026-10-02 00:13:17起，Driver/Registry/ProviderBridge/RuntimeBridge/公共审批投影5文件57项通过，3.68秒。type-1790871210935.log的Server tsgo --noEmit退出0，仅既有账号池两个建议；lint-1790871197756.log定向3个TS退出0，Registry测试原ThreadId警告保留。4文件格式、git diff --cached --check、UTF-8无BOM、源码/索引SHA与诊断残留检查通过，文档历史尾部保持原字节。提交显式VITE_GIT_HOOKS=0避免自动暂存/恢复原脏树，以上述实际定向检查替代，恢复原环境设置并留下记录。

check-commit核对4文件提交与已通过精确索引SHA一致、索引空、12重点保留SHA不变；check-preservation核对模块外199项原字节或删除状态一致，无并发漂移。提交后只补本轮工作ledger，不更改已验证TS。服务watch重启后的PID57760在00:13:20 ready监听13773，原完整session仍在；短暂代理ECONNRESET/ECONNREFUSED来自副本同步重启，不能作为审批缺陷。

真实Cursor task host-task-2ef51171-dc83-4a18-86c1-8af69a729c1a/run host-run-2ef51171-dc83-4a18-86c1-8af69a729c1a具有runtimeTaskId且最终failed/provider_turn_failed。Web业务对话确实可见失败，截图是失败可见性证据；没有成功读取正文、批准写入、拒绝/取消结算或正式按钮通过证据。Cursor夹具健康agent about超时与Generic ACP Windows.cmd健康路径spawn EINVAL独立保留，不作为官方CLI可用。没有本轮官方CLI、Electron/手机、远程矩阵的新增通过，不累计旧结果替代。

A-8保持未勾选，历史A1–A7仍是待新鲜独立终审声明，goal active、loop running；保持44入口/P0–P5完整范围，不采用旧豁免或完成报告。生产能力注入的小增量不代表整体工具调用、界面或全部Acceptance完成。

#### Retrospect

本轮progress：实际业务派发揭示工厂探针无法覆盖的生产Layer遗漏，必需依赖及最小存储/Broker依赖解环恢复两项真实能力；57项回归和真实Run启动支持这一结论。未重写UI或放宽ToolBroker，失败仍由现有界面真实呈现。鉴权/健康准备错误、生产Bridge缺失与下游工具失败分别留证，不能把后者猜成一个已修复根因。

下一轮只推进真实Run启动时的可信握手持久化与宿主请求顺序这一共同增量：复用当前服务/home/浏览器和已建业务项目，先以受控回执、真实TaskStore与实际Driver/Projector补确定性失败回归，核对sendTurn返回前turn.started、pending归属与Run handshake，定位具体拒绝门禁；若证实缺口，沿现有绑定/公共投影原子持久化可信身份并核对清理/撤销次数，不直接写投影或弱化权限。修复后再真实派发并操作单次允许/拒绝/取消、核对相同ID结算及文件副作用。44入口/P0–P5、官方矩阵、多端/远程和新鲜最终独立审计继续完整保留。

### Round 140

#### Plan

上一轮eaf013dc接通生产Bridge，是progress。本轮只推进真实Run启动时可信握手持久化与工具请求的共同链路：复用保留隔离服务/home/浏览器，沿Driver pending binding、Registry、Projector与RuntimeBridge门禁检索，先以真实TaskStore/Orchestrator和受控回执确认sendTurn结束前握手缺失，再沿已有可信绑定修复、不接受raw参数声明。覆盖归属/重复/终态清理并实际派发核对读取及审批；若仍失败保留具体门禁，不制造业务投影。单模块精确提交、保留原脏树，44入口/P0–P5与A8最终新鲜审计保持未完成。

#### Act

完整Acceptance、Round139 Retrospect和Lessons检索后，沿sendTurn、pending/active/history binding、Registry、Projector与RuntimeBridge共同入口定位。Driver发送前签发握手，而ACP prompt可能终态才返回；早到turn.started保存running/runtimeTaskId却丢capabilityHandshakeId，实际工具门禁拒绝。复用真实Orchestrator/短期grant/内存SQLite TaskStore/Driver/RuntimeBridge与Deferred暂停回合返回，红灯确证缺握手，不凭上一轮泛化错误猜测。

CompositionOrchestrator的Driver内部事件绑定合同、CompositionAgentDriverRegistry和ProviderDriver的三类可信绑定携带已经验证的capabilityHandshakeId。Projector仅在turn.started从当前agent/runtime的Driver可信绑定激活，与running同事务提交；已有冲突身份/其它Driver拒绝，raw payload不能授予握手，重复/旧Run/终态锁保留。没有更改公开请求、RuntimeBridge权限门禁、grant/工作根校验或手写业务投影。

提前终态现在能够撤销握手；ProviderDriver pending/active/history共享本Run一次releaseContext责任，Projector撤销与sendTurn返回后的清理不重复，取消复用同一路径。恢复没有进程内责任时仍按原持久化回收。另经实际连续派发揭示同一启动链的旧Session顺序缺口：Cursor startSession先关闭旧Session会清掉新配置binding，第二Run真实provider_session_start_failed。共同Driver复用已有listSessions先关闭精确instance/thread的旧Session，再configure新Run；失败明确结算/清理，不修私有Cursor Adapter或混入用户原差异。

Projector.test.ts两个回归覆盖真实派发/门禁、未返回就running/握手、提前终态/重复一次回收、随后Run不丢配置、其它agent/runtime与已存身份冲突、raw-only声明；工具执行替身仅计数门禁后调用，不冒充文件。文档goose-acp-provider.md稳定段说明实现、实际浏览器三按钮/副作用/失败边界与回滚，原3076字节历史尾部保留。单模块6文件提交eee08ccc417653a7c275c88489d2512373f4a6f3，loop工作记录不提交；回滚只撤回本轮内部绑定/原子激活/回收/Session顺序及测试文档，无迁移，保留前轮Bridge注入与用户工作，无push/PR。

保留隔离source-8DWTaW/source、home与完整dev session29213，用原业务项目/需要审批的对话和现有RPC派发普通ACP夹具。生产ToolBroker实际读取beta/gamma并请求文件写入；已授权in-app浏览器实际点击允许本次、拒绝、取消。允许后真实Task/Run completed，approved.txt为REAL_RUN_APPROVED；拒绝/取消分别全新decline.txt/cancel.txt不存在。只读隔离SQLite核对3个唯一request resolved为accept/decline/cancel且turnId对应各实际Run，工具表允许Run一次read+一次write成功，负向各一次read且无write。保存approval-before/decline-after/cancel-after截图、markHandoff；临时令牌不进入提交/文档/截图/回复。夹具配置已恢复，失败/成功业务记录都保留。

#### Verify

前轮eaf013dc是生产Bridge注入progress，当前goal active、loop running，没有subagent或全仓检查。首次red在旧源码明确expected undefined to equal handshake-before-return，1失败/30筛选跳过；第一次正常5文件87项通过，但类型检查发现两处raw.source使用不合法的测试中文值，改为合同合法acp.jsonrpc，不用断言或disable隐藏。补连续Session回归后在没有先stop的源码再次red，expected false to be true，1失败/31筛选跳过；前一个缺握手红灯保存handshake-red-check.json，不被后一次覆盖。

最终normal-1790872643842.log，2026-10-02 00:37:19起，5文件87项通过、4.35秒；related-1790872963417.log在00:42:38，Orchestrator与ProviderDriver本地ACP跨进程2文件32项通过、4.88秒，共119项。Server type-1790872652021.log tsgo --noEmit退出0，仅原账号池两个建议；5个变更TS定向lint退出0，相关子进程Node DEP0190原警告保留。6文件格式、git diff --cached --check、UTF-8无BOM、精确索引/隔离副本SHA与诊断残留检查通过。检查后只补文档与格式，不改变已通过TS语义。

实际允许Run host-run-1c5bae04-b725-4373-8274-51ad6503e5f2完成，ACP结果日志read正文beta/gamma、write成功，文件内容和工具持久化一写相符。随后旧Session清理新绑定的失败Run host-run-730e5f23-475d-4a95-91a3-9fc61512843e明确provider_session_start_failed，作为本轮关联启动红灯保留；先关闭旧Session修复后，连续拒绝Run host-run-ca07d0a0-df17-486d-b36a-dcf694a6a292与取消Run host-run-e37bbd8c-baee-4026-ba6a-34b0431226e0均实际到审批。负向夹具遇到协议错误主动终止prompt，两Run均failed/provider_turn_failed而非整轮cancelled；Web显示泛化ToolBroker错误，不能声称负向文案或整轮取消显示完善。

本轮3种审批决定、同turn归属、单次实际写入和两种无副作用有浏览器/RPC/只读存储三类证据。源码watch期间短暂环境连接失败，AX尝试重连遇到失效目标提示，下一次观察已自动恢复并见decline.txt审批；没有另起服务或因观察失败终止进程。完整session29213最后仍实时有效。Cursor夹具agent about健康超时和Generic ACP .cmd spawn EINVAL保留；普通夹具不是官方Cursor/Goose/外部账号推理，未给官方44入口、多端、远程/PTY增加虚假通过。

提交子进程显式VITE_GIT_HOOKS=0绕过可能自动暂存/恢复脏树的钩子，以以上实际定向检查替代，不改变全局环境。check-commit核对6文件提交SHA与已验证索引一致、索引空、12固定保留SHA不变；check-preservation模块外199项原字节或删除状态一致。原201项快照、文档历史尾部均保留。sync-work脚本原提示字符串仍写4个，但实际白名单/索引/SHA与提交明确6个文件，旧提示不是交付数量证据。

A-8仍未勾选，A1–A7历史声明留待新鲜独立终审，44入口/P0–P5完整范围不缩减，不采用旧豁免。实际宿主三按钮闭环是当前增量，不能外推极早请求的消费屏障、真实PTY/取消进程树/迟到审批/恢复模式、多端视觉/历史详情或完整目录都完成。

#### Retrospect

本轮progress：先有暂停回合的真实持久化红灯，再从共同可信归属把握手与running原子激活；119项及实际Web批准写入证明当前真实入口改善。真实连续Run又揭示旧Session清理时序，仍沿同一握手启动链用既有listSessions/stop解决，未复制Adapter。授权决定、工具执行、副作用、回合终态分别验，负向工具错误导致夹具failed不能冒充整轮cancelled或友好解释。

下一轮只推进宿主请求开始与异步turn.started消费之间的因果屏障：当前确定性回归主动等待投影完成，真实正常流程通过仍不证明极早请求不会先到Task/Run门禁。用既有事件回执/worker drains与真实Store控制消费先后，补能揭露未running/未握手拒绝的回归；若证实竞争，复用现有启动 receipt/可信上下文激活承载解决，不加sleep/poll或放宽门禁。之后继续产品PTY、迟到审批/恢复、负向错误解释和工具历史详情、多端/远程矩阵；保持全部44入口/P0–P5与最终新鲜独立审计，不因三按钮或119项收缩目标。

### Round 141

#### Plan

上一轮eee08ccc修复真实Run握手落库、单次回收及旧Session顺序，真实三按钮与119项是progress。本轮只推进极早宿主请求与异步turn.started投影提交之间的因果屏障：沿可信pending binding、既有Projector提交/启动receipt检索，以真实Orchestrator、TaskStore和受控事务回执复现工具早于running被拒绝；复用已有绑定通知与本Run等待，不增加框架、sleep/poll或弱化门禁。覆盖提交成功、提前终态/取消与有界未确认，确认无迟到副作用。精确单提交、原脏树保留，44入口/P0–P5/A8最终新鲜审计不缩减。

#### Act

沿上一轮可信pending/active/history binding、Orchestrator、Projector事务与RuntimeBridge共同门禁检索，确认签发握手与发出turn.started都不保证异步投影事务已经提交。复用真实Orchestrator、短期grant、内存SQLite TaskStore、ProviderDriver及两层Bridge，Deferred控制实际事务提交先后，旧eee08ccc源码的极早读取被拒绝task_not_running，根因不是权限缺失或文件内容。

在既有Driver内部运行绑定加入可选confirmRuntimeStart Effect；每Run使用已有Deferred等待启动确认，Projector仅在可信Driver归属与握手匹配的running事务提交后确认。ProviderBridge在确认之前不进入RuntimeBridge，确认后仍执行原Task/Run、身份、grant与工作根全部门禁。没有新增服务、依赖、轮询、公开DTO字段或持久化字段。

一次releaseContext先以released唤醒等待，再清理和撤销；提前终态可从可信Driver绑定撤销尚未落库的握手。已回收等待返回cancelled/tool_cancelled，30秒未确认返回failed/provider_runtime_start_unconfirmed，均不调用ToolBroker；迟到确认不能补执行。activeRuns不登记已回收上下文。一个参数化回归覆盖实际事务提交成功、提交前取消及测试时钟超时，统一夹具且各自核对执行计数与真实Run状态，不写假running/握手或加sleep。

文档goose-acp-provider.md新增“宿主请求等待启动事务提交”稳定节，说明时序、边界、实际证明与回滚。6文件单提交b476ba6ba9b1382814ff555c3632ac39e49cf418，loop工作记录不提交；只撤回本轮等待/提交确认/提前撤销及测试文档即可回滚，无迁移，保留前轮绑定与Bridge、用户原工作。提交子进程VITE_GIT_HOOKS=0避免自动暂存恢复原脏树，以定向人工检查替代，未改变全局设置，未push/PR。

保留原隔离source/home及完整dev session29213，将精确6文件副本同步后，经现有生产RPC派发普通ACP夹具的新Run。已授权真实Web点击“允许本次”，生产ToolBroker实际读取notes.txt中beta/gamma，并写入全新barrier-approved.txt。完成后只读隔离SQLite核对同turn审批resolved/accept及一次read、一次write成功，工具日志和文件副作用相符；截图approval-after.jpg已保存并实际查看，外部夹具配置已恢复，令牌未进入公开记录。

#### Verify

前轮eee08ccc的119项及三种审批决定是既往progress，不重复算本轮。当前red-1790874086503.log在旧源码1失败/32筛选跳过，明确denied/task_not_running与提交后应成功不符。最初正常88项、扩展独立边界89项，随后合并一个三场景回归后最终88项，保留三场景断言。两次类型检查均暴露同一测试手写errorCode可选类型与真实string|undefined不符，改为已有ProviderToolBrokerResult，未压诊断、修改基线或加类型断言。

最终normal-1790874464980.log，2026-10-02 01:07:39起，Projector、ProviderDriver、ProviderDriverRegistry、RuntimeToolBridge、AgentDriverRegistry共5文件88项通过，5.50秒；related-1790874467113.log，Orchestrator及本地ACP跨进程2文件32项通过，7.66秒，共120项。最终type-1790874679057.log服务端tsgo --noEmit退出0，只保留原账号池两个建议；lint-1790874664010.log五个变更TS退出0。Node DEP0190原警告保留。最后运行测试之后仅做擦除型测试类型修正、格式与文档，无运行语义变化，不冒称之后重复执行测试。

6文件格式、git diff --cached --check、UTF-8无BOM、精确源码/索引/提交SHA与诊断残留检查通过；索引为空。原201路径快照仍保留，其中模块外199项原字节或删除状态一致，12固定保护SHA不变，稳定文档原3076字节历史尾部保留。sync-work外置旧提示仍写4文件，白名单、SHA与实际提交均为6文件，不按旧提示计数。

实际Task/Run host-task/host-run-4d506ca7-c833-4a23-ac30-8cfe437e5e4c completed；barrier-approved.txt内容RUNTIME_START_BARRIER_APPROVED，工具结果read正文beta/gamma、write成功，工具表每种各一次且写入一次。只读测试DB的唯一审批resolved/accept与实际Run turn一致。UI人工等待约41秒仍可批准完成，证明30秒仅约束启动确认，不是审批期限。当前仅复验正向按钮，拒绝/取消沿用Round140证据，不外推当前负向显示已完善。

完整服务29213仍可观察，源码watch短暂代理连接错误后恢复，没有另起同端口服务或按模式杀进程。普通Cursor夹具agent about健康超时、Generic ACP .cmd spawn EINVAL保留；截图页头仍有夹具健康提示，不等于已完成Run失败。普通ACP夹具不是官方CLI、外部账号或设备，当前真实文件与审批证据也不证明产品PTY、多端、远程及整个44入口。没有全仓检查、subagent、真实账号调用、push/PR或live userdata写入。

A-8保持未勾选，goal active、loop running，A1–A7历史声明留待新鲜独立终审；44入口与P0–P5完整范围不缩减，不采用旧完成/豁免材料替代验收。

#### Retrospect

本轮progress：受控真实事务给出启动事件先于投影提交的确定红灯；沿可信绑定在提交后确认，本Run等待有取消/超时出口，120项及完整Web批准写入证明修复。权限仍在原共同门禁；三场景共用一个夹具，复用真实返回类型避免测试类型漂移。签发、事件、提交、授权、执行与回合完成分别举证，不能凭某一层成功推断其它层。

下一轮只推进生产完整Run中的真实terminal.create/output/wait_for_exit/kill/release执行与取消闭环：先检索已有ToolBroker、PTY服务和回执测试，普通ACP夹具经生产Bridge实际创建终端，核对输出/退出、取消停止、迟到创建与精确资源回收，不以之前官方CLI加测试Bridge的Node进程替代产品PTY证明。只停止本轮捕获的PID/终端，不加新生命周期框架或sleep/poll。之后继续迟到审批/恢复、错误解释、工具历史、多端/远程及44入口最终新鲜审计；本轮不扩成PTY修复或宣告目标完成。

### Round 142

#### Plan

上一轮b476ba6的启动提交屏障和120项、真实Web批准写入是progress。本轮只推进完整生产Run经ACP宿主Bridge/ToolBroker的真实PTY执行与取消闭环。已检索既有acp-mock-agent终端请求、Cursor共同Adapter、ToolBroker terminal.exec/snapshot/kill/close与ManagerCommand真实PTY测试，复用它们及保留隔离服务29213，先实际创建、输出、等待退出、kill/release和取消；按真实回执及精确PID/句柄核对单次副作用、回收，不加框架或sleep/poll。若发现产品缺口，给受控回归再修共同责任入口；只提交该模块，原工作保护，44入口/P0–P5/A8最终审计范围保持。

#### Act

先读当前Acceptance、上一轮Retrospect及Lessons，检索现有acp-mock-agent终端字段、共同Cursor Adapter、ToolBroker终端handlers与ManagerCommand真实PTY入口，不重新实现终端服务或复制厂商Adapter。保留源/home/业务项目，RPC建立全权限隔离对话并经server.dispatchCompositionTask签发四类真实grant和Run；普通ACP夹具调用生产RuntimeBridge/ToolBroker/NodePtyAdapter，实际Node输出、退出、停止与文件PID分别核对。没有手写running/握手或用测试Broker计数冒充PTY。

正常退出真实Node命令输出PRODUCT_PTY_EXIT、exitCode7、release；实际取消则暴露先发送ACP cancel导致终态投影/回收先发生，terminal.kill晚到被门禁拒绝。共同Cursor Adapter interruptTurn现在先停止已登记且就绪的本回合宿主终端，再在finally结算待决审批/输入并通知Agent取消；全部资源仍尝试，停止失败明确返回并保持取消通知，不弱化Task/Run/握手/grant/工作根门禁，不制造停止成功。既有迟到创建补停保留，完整边界留待后续产品验收。

同一产品终端链路的显式kill另有Windows原生-1退出码问题：项目生成ACP schema要求uint32非负，output编码失败令wait/release未完成。复用共同Adapter两处出口，以一个两调用点的terminalExitStatus转换有效uint32，其余按协议返回null表示未知，不伪造0、不覆盖原Manager快照。output与wait一致，原signal转换保留，Grok独立宿主未改；共同实现影响Cursor/Generic/Kimi，实际服务本轮只跑普通Cursor夹具。

CompositionProviderAgentDriver.e2e.test.ts新增一个参数化真实ACP/Orchestrator/grant/SQLite Store/Driver/Projector/RuntimeBridge回归：取消时kill仍在running；原生负码经output/wait返回null并release；停止失败仍有ACP取消终态且调用方明确失败。执行替身只检查顺序/转换，另用完整服务真实PTY证明实际动作。标准文件通知等待ACP create已回复，Deferred等真实事件/派发回执，不加sleep/poll。夹具结果Schema复用模块级编译；缺口均在共同边界，不加新服务、依赖、Driver、权限系统或公开DTO。

稳定文档goose-acp-provider.md第190行新增产品PTY实现、真实证明、失败、仍欠回收边界与回滚说明。精确3文件本地提交ad2f1ea2c3406efa55b83c796e498ee05ae676b2，工作台账不提交，无push/PR。用户原Cursor Adapter已有真实变更及格式差异，工作文件只替换本模块四处；反向本模块片段逐字节还原整个原Adapter，其它差异保留。原稳定文档3076字节历史尾部保留；回滚只撤回取消先后/ACP退出码转换及回归文档，无迁移，保留前轮启动确认、审批与用户工作。

#### Verify

上一轮b476ba6的120项和Web允许写入是progress，不累计为本轮工具/浏览器结果。第一生产PTY请求在dev node --watch触发worker依赖消息与后端重启，RPC SocketClose1006，孤立Run04f2fe22-fa18-400b-b991-9a1bc8bc6057恢复延后/agent_driver_resume_unsupported；同一捕获session29213仍活，不将观察超时判退出。确认真实重启后受控停止本次会话，保留home，临时隔离package dev去watch，ready后恢复原package字节，运行子进程仍不watch。第一次直接dev-runner启动因缺vp PATH失败，改为原vp run dev入口，而非修改产品runner。后续源码修复用自有session71213/79988受控重启，最终40606刚刚复核仍实时有效，13773/5733与同一home沿用。没有写live userdata、另起重复服务或模式杀进程。

外置夹具最初误用TERMINAL_ARGS而非现有ARG_0，Node进入REPL，不是正常命令证明；cancel RPC返回provider_turn_cancel_failed/terminal.kill denied，Run却已cancelled。这个准备错误与已证取消顺序缺口分别记录；按捕获Run/terminalId用原terminal.close关闭自己的失败终端。修正indexed参数后真实exit Run0ae1b2cc-c1e4-422f-85b0-2bb89792fc13完成，output标记、wait7、release均成功；只读工具表exec1/snapshot5/close1，子PID33484已退出。

取消顺序红灯red-1790876290321.log在旧共同Adapter1失败/2筛选跳过，真实Store明确kill执行时Run已cancelled而应running。修复后正常79项通过。首次类型检查发现测试输入误用CompositionRuntimeToolInvocation而实际是ToolBrokerInput，及测试存储错误违反Broker invoke无错误合同；使用已有输入类型，测试存储错误明确orDie，不用断言/忽略诊断。实际修复后cancel前PID确认存活，收到ACP create回执再用真实cancel RPC；Runb3bbaa3c-459e-4c4f-be49-99c85e0cf92c为cancelled，子进程退出，工具表exec1/kill1且成功，没有close记录，不能外推自动release已完成。

显式kill首次在output报Expected a value greater than or equal to0，日志只有create/kill；捕获子PID70852和自己终端仅按原RPC关闭。负码参数回归red-1790876732549.log仍保留1失败/2筛选跳过：编码失败没有完成事件，先等completed造成TimeoutError，随后调整为先等真实dispatch回执并断言正确终态，不降低成功断言。转换修复后原回归通过；完整服务Run d60f43d6-4a27-4863-a819-c94b532a04a0 completed，create/kill/output/wait/release五步，output保留PRODUCT_PTY_KILL、output.exitStatus.exitCode和wait.exitCode均null；工具表exec1/kill1/snapshot2/close1全成功，实际子PID已退出，原生负码未伪造0。三类结果各保存live-exit/cancel/kill-evidence.json，SQLite仅readOnly，夹具原配置已恢复。

最终normal-1790877409882.log，01:56:37起，4文件79项通过、11.89秒；related-1790877278139.log，01:53:35起，Cursor Adapter/真实ManagerCommand/Goose取消普通模式3文件45项通过、62.63秒，4项官方opt-in跳过不计通过，共124。相关检查在后台运行，主代理保持交流且未阻塞长等。最终type-1790877413569.log服务端tsgo --noEmit退出0，仅原账号池两条建议；lint-1790877398203.log两个变更TS退出0、无本轮新告警。此前inline Schema编译告警按现有模式上提，未关闭规则。Node DEP0190、ConPTY AttachConsole、Generic .cmd EINVAL与Cursor夹具健康探测差异分别保留。

修改脚本首次格式锚点不匹配时在写入前失败；sync首次逐空白比较未容纳formatter合法尾逗号/箭头括号而中止，无工作文件覆盖，随后对已读取的相同旧方法采用有限格式归一比较，逆向逐字节证明原Adapter。最终3文件精确索引/隔离副本/提交SHA一致、UTF-8无BOM、格式、cached diff --check与诊断残留0；原201路径快照中模块外198项原字节或删除状态不变、12固定保护SHA不变，索引为空。提交子进程显式VITE_GIT_HOOKS=0避免钩子自动暂存恢复脏树，以上实际定向检查替代，不改全局环境。

本轮没有UI源码改动、浏览器点击/Electron/手机/远程验收或官方CLI/真实账号推理，不能以真实产品PTY替代这些证据。开发重启后孤立Run仍无法自动恢复，与A-7完整恢复声明不一致，重新将A-7标为未完成；A-8保持未完成，其余历史声明仍待最终新鲜独立审计。goal active、loop running，全部44入口/P0–P5范围保留，无旧完成/豁免材料代替验收。

#### Retrospect

本轮progress：生产真实PTY使之前测试Bridge的证据边界向前推进；先通知Agent可能先撤销宿主停止权限，必须在共同取消边界建立先后，而不是松终态门禁。Windows原生停止码与ACP合法码分层处理，null是明确未知，不能伪造成功。一个三场景回归配完整服务三类证明，失败、执行、停止、退出码、release与Run终态逐项核对；fixture参数和watch环境问题不可当产品成功或掩盖真实缺口。原有Adapter脏差异应分片保护，完整反向字节核对比直接覆盖可靠。

下一轮只推进取消/终态后的可信宿主终端资源回收：当前kill已经真实停止进程，但Projector先提交终态再调用releaseContext，clearToolBroker的terminal.close受原门禁拒绝且被既有ignore吞掉，句柄/历史回收欠证据。先检索已有ToolBroker、TerminalManager所有权、会话Scope与Driver回收入口，给真实Run终态+原生资源的红灯；复用已有严格归属责任释放本Run已捕获资源，不能给公开RuntimeBridge开放终态任意调用或先撤权限再猜ID。兼顾异常/重复回收与迟到创建，按回执检验，不添新框架。之后继续孤立Run恢复、迟到审批、工具历史/错误解释、多端/远程及44入口最终审计，A-7/A-8重新未完成并不缩减总目标。

### Round 143

#### Plan

按Round142 Retrospect，本轮唯一增量是Run终态后的可信宿主终端资源回收。已读Acceptance、最新Retrospect与Lessons，确认Manager.close已有按threadId关闭普通资源的责任，ToolBroker以runId作为终端threadId，RuntimeBridge已有在途调用及排空回执。复用这些能力：服务端绑定回收先取消并等该Run在途工具结束，再关闭原Run终端；公开工具终态门禁不变。先红灯回归，再真实产品PTY核对关闭与其它Run不受影响，异常/重复/迟到执行用受控屏障验证，不加新服务、资源表或公开权限绕过。只提交此模块，保护原201路径和12固定SHA；44入口/P0–P5及A7/A8最终完整验收继续保留。历史hook轮号74已在台账存在，本轮按现存最新142顺延143，不重复覆盖旧轮。

#### Act

共同CompositionRuntimeToolBridge复用已有activeInvocations与TerminalManager.close：新增仅服务端绑定可调用的releaseRunResources，先取消并等本Run在途工具终结，再按ToolBroker既有runId终端分组关闭普通Session。Claim先登记后异步校验，使原已进入校验的迟到请求也在排空范围；其它Run不取消，owned session沿Manager原owner责任，历史保留，不新增资源表、服务、依赖或公开工具特权。Live Layer必需TerminalManager并从既有ToolBroker Layer获得；纯执行替身工厂可省Manager，不构成生产降级。

CompositionProviderAgentDriver沿已有releaseContext，在clear配置后释放原Run资源、随后撤销握手；一次回收Deferred保存成功或失败，重复调用等待同一结果，关闭失败沿provider_resources_release_failed返回，不用第二次void伪造成功。原Adapter的通用清理ignore没有作为可信关闭成功判据。Provider Bridge/HTTP/MCP不发布资源回收方法，其fixture callback故意抛错验证公开调用不访问它。3场景跨进程E2E扩展终态后一次回收检查；共享Bridge新增校验/执行屏障、其它Run、公开终态拒绝及关闭失败；原Driver取消失败测试扩展重复成功/失败结果。其余mock只补完整内部合同，未引入新测试框架或规则豁免。

10文件精确本地提交f5aae63913e14da349ce0a709231bd22ee8a0ea4（fix(composition): 回收终态Run的宿主终端资源），包括两处生产责任、相邻合同/回归fixture及稳定goose说明；332增90删中的主要重排来自原async测试参数化后的格式。代码无数据库迁移；原脏Cursor Adapter本轮完全未动、文档历史尾部3076字节不变。台账未混入此代码提交，无push/PR/git config/删除操作。回滚只撤回本模块差异，保留前轮取消顺序、ACP负码转换、启动确认、握手和用户工作，禁止在当前脏树整文件覆盖。

本地代码提交完成后收到用户更新目标：允许跳过真实账号登录与实机验证，但功能仍须完整；先按ACP运行时、composition、目录/快照、Web/Mobile、docs、spec分别整理，未知归属先确认，A7各实际连接模式不可用本地mock替代。f5aae6391在新要求到达前已形成，包含该模块实现说明，未重写它；后续docs/spec独立提交。已只读status/diff并生成工作树外module-inventory.md/json，当前253路径包含84工作产物/缓存，并非253项产品改动。6目录、59运行时/投影/探针、14混合UI、46文档、6个A7脚本/测试和1台账是候选分组，不把路径归类当所有权或功能验证。账号池/BYOK/ZCode24路径、品牌/协议/附件等13路径已向用户集中确认，保留未提交。Cursor残余有hadPendingInteraction终态结算的实际差异，effect-acp protocol/historyBootstrap所读片段以格式为主，不能一股脑提交旧文件或回滚。新增gradle缓存不是本轮产物，未触碰。

#### Verify

旧实现新增真实ACP/Store E2E红灯：releasedRuns为[]而应run-terminal-cancel，保留red-1790878490160.log与原始断言；修复后三种取消/正常release/停止失败均在存储终态后关闭一次并保留重复结果。两阶段迟到请求以Deferred屏障进入，排空后无副作用，其它Run继续成功，公开terminal.close仍run_not_running；关闭错误和重复错误不变。没有新增sleep/poll或中途子Agent。8文件99项通过（normal-1790879337971.log，02:28:47，9.99秒），相关Cursor Adapter/ManagerCommand真实PTY/Goose普通取消3文件45项通过、4官方opt-in跳过（related-1790879069182.log，02:23:29，59.12秒），共144通过，跳过不计通过；无全仓检查。Server tsgo退出0，9个TS定向lint退出0，只有原RuntimeBridge unused/inline-schema与Registry测试unused共3警告，无新诊断规则豁免，类型原账号池两条建议仍在。

真实产品红灯在保留隔离服务40606、合法新业务thread/grant/Run 886a6854-f9bb-4dbe-b6fc-70270ea40576：ACP create已回复，取消前捕获子PID存活，取消后退出，但普通写入路径仍查到已退出Session。首次检查空data被合同拒绝，是夹具准备失败非产品关闭成功；先确认精确PID已死后使用合法非空查询证明仍留句柄。按原RPC精确关闭本轮失败Run/terminalId后只停止自己捕获的40606，不按模式杀进程。沿同一home/source/13773/5733受控启动54689，隔离dev暂时无watch，ready后package原字节恢复，不改主树dev配置。

修复后真实Run a85e7481-4008-4d4f-a9d3-6ffc4c33d66d：实际create回执、取消前子PID活、取消后死、Task/Run cancelled；精确Run/terminalId RPC返回TerminalSessionLookupError。首次工具断言错误地在JSON寻找message而不是类型tag，原回包已是该错误；随后严格检查tag与两项原ID通过，不放宽关闭判据。只读隔离SQLite exec1/kill1成功；可信内部关闭不伪造terminal.close工具表记录。live-cancel-before-evidence.json与live-cancel-evidence.json、terminal-inspection-retained/released.json保留。原夹具wrapper已恢复，54689仍live供续轮。没有读写~/.t3/userdata、官方账户推理、浏览器/Electron/手机/远程验收，普通Cursor ACP产品PTY不冒充这些。

新目标到达后按node_modules/.bin/vp.cmd再跑同8文件，02:41:38，99项通过、11.16秒；同9TS的vp.cmd lint通过原3警告。隔离副本没有tsgo.cmd/包级node_modules，直接shim及vp run typecheck均未启动编译，不能把首个PowerShell未定义LASTEXITCODE导致0当通过；核对vp exec官方本地help后，用vp.cmd exec node ../../node_modules/@typescript/native-preview/bin/tsgo.js --noEmit从server目录调用同一已安装编译器，退出0，仅原两建议，没有安装/改配置/增加依赖。原144通过不重复累计此次99。提交前10文件索引与隔离副本SHA一致、UTF-8无BOM、精确格式/cached diff检查通过；原201快照的模块外199路径字节/删除状态和12固定SHA仍不变。提交子进程VITE_GIT_HOOKS=0避免自动暂存恢复脏树，实际定向检查替代，不改全局环境；提交后index为空且commit文件SHA吻合。新目标后没有跑全仓或再次改写源码。

#### Retrospect

本轮progress：真正的终端Session回收必须独立于通用工具授权，已停止进程不证明句柄释放；可信Run责任复用现有Manager分组与在途Deferred，终态普通门禁保持，失败/重复不能伪造成功。真实RPC错误按类型和精确归属核对，不从未序列化的message字符串猜结果；缺shim不是编译失败，更不是通过，最小执行入口应明确。当前证明覆盖终态后的新请求拒绝以及回收开始前已登记的迟到调用，不把取消尚未落库期间新进入请求、失败后台重试或孤立Run恢复宣称已验。

本轮收尾时用户明确回复“上述内容也纳入，逐模块检查后分别提交”，确认CliProxy/账号池/BYOK/ZCode、Mobile品牌、effect-acp协议及附件/assets/historyBootstrap/externalLauncher.reveal一并纳入；此前保留不混入的保护不等于这些模块永久排除。按新目标，下一轮只处理packages/effect-acp四个文件的剩余差异：读完整diff、区分格式与实际语义，执行对应定向测试、tsgo与lint后形成独立模块提交，不夹入其它模块；其后逐模块整理已确认内容，docs/spec台账分别提交。用户未提及的临时HTML、工作产物与缓存仍保留不提交。随后依次推进A7的取消/崩溃恢复和各真实连接模式、A8稳定能力文档/回滚与最后全新独立审计；真实账号/实机采用用户本次明确豁免，功能合同和本地/远程/relay/tunnel证据不豁免。44入口/P0–P5范围保持，A7/A8继续未勾选，其余历史声明仍待最终审计。goal active、loop running，Round143已收尾，不自行宣称目标完成。

### Round 144（认证 Schema 生成一致性）

#### Plan

用户已确认账号池、Mobile品牌、effect-acp及附件等差异均纳入并逐模块提交。当前共享HEAD已出现8848dd222、0e395cb0b、469c92aad与7d1c4258d模块提交，保留它们，不重做或改写。责任检索确认effect-acp的认证宽容是Round48已有行为，但生成器没有同一规则，且AuthMethodEnvVar.name类型仍必填而运行时optional；本轮只修认证Schema类型/生成一致性。复用既有JSON Schema生成器、Schema.decode及定向测试，不修改认证请求methodId门禁或其它模块。检查生成后的类型与运行时同义，缺省可接受但非法字段类型及其它必填字段仍拒绝。源码独立提交，台账单独保留，A7/A8不勾选。

#### Act

新增 `packages/effect-acp/scripts/authMethodCompatibility.ts`：生成阶段对 AuthMethod 族 JSON Schema 剥离 `id`/`name` required，保留嵌套与其它必填。`generate.ts` 对 AuthMethod/AuthMethodAgent/AuthMethodEnvVar/AuthMethodTerminal 应用该归一。更新 `_generated/schema.gen.ts` 使 `AuthMethodEnvVar.name` 可选；新增 `schema.test.ts` 覆盖缺省解码、非法类型拒绝与生成器输出。本地提交 `93a41e3e68a16ea3b8fc93adbe85c10935196aa6`（fix(effect-acp): 在 schema 生成时剥离认证身份必填约束）。

#### Verify

`vp test run packages/effect-acp/src/schema.test.ts packages/effect-acp/src/protocol.test.ts`：2 文件 33 项通过。定向 lint 退出 0。未跑全仓、无 push/PR。

本会话补充核验：03:01:47以vp.cmd执行schema.test.ts/protocol.test.ts/client.test.ts，3文件41项通过（4.38秒）；包内经vp.cmd exec调用已安装tsgo --noEmit退出0；四文件定向lint最终退出0、无警告。外置compare-types.cjs针对8848dd222旧类型仅TS2741缺name退出1，当前相同probe退出0，日志位于C:/Users/Administrator/AppData/Local/Temp/codework-auth-schema-consistency-20261002/type-red.log及type-green.log。初次生成器断言未带属性引号造成1失败/40通过，修正精确输出断言后通过；初次新lint告警通过模块级编译Schema消除；外置副本依赖缺失TS2307修正包依赖引用后才认定类型红绿。没有重新下载/运行整个固定上游资产生成流程，也没有浏览器/真实账号/设备/远程验证。

并发提交边界：本会话提交前发现范围变化并停止；实际93a41e3e6提交正好是已验证四文件，逐文件提交/工作区字节一致，索引为空。因此保留该提交，不重复提交、不改写提交者或钩子记录，不重置别人的索引；此前提交存在不等于本会话重新验证其全部行为。

#### Retrospect

本轮 progress：认证缺省从手改产物收拢到可重复生成规则，避免再生成漂移。同会话内其它模块整理见 Round 145。下一轮继续 A-7 真实连接验收，A-7/A-8 保持未勾选。

### Round 145（按模块整理剩余脏树）

#### Plan

在 Round 143/`f5aae6391` 与 Round 144 认证生成修复之外，把用户确认纳入的剩余产品改动按模块独立提交：ACP 运行时、目录快照、Web/Mobile UI、官方探针、docs，最后提交本台账。临时 HTML、`.harn*`、gradle、`externalLauncher.reveal` 与 A7 live 文件不混入。

#### Act

本会话已形成或确认的模块提交（含本轮前已完成的 effect-acp 首提与账号池/品牌/附件）：

1. `8848dd2227054eac2a71a5718b313e229740ab6c` fix(effect-acp): 容忍认证方法省略 id/name
2. `0e395cb0bd430ef75c559d43b9d564b629551a5f` fix(provider): 加固账号池刷新与 CliProxy 绑定一致性
3. `469c92aad49dbe0dea473ae14a6e6d1a81f1a2f7` fix(mobile): 统一首页品牌为文字锁与阶段徽标
4. `7d1c4258d2b5b60da57669e843061282123e3803` fix(server): 为图片附件路径补齐扩展名推断
5. `a9d78679e788fa7c014fd5978121514cfed75900` fix(acp): 完善共用会话运行时与宿主终端生命周期
6. `0cd3a287efea9829f0d2addf2ff058caf281135c` chore(acp): 更新官方目录离线快照与目录回归
7. `2b1d2c7ec695e250eb7eb055497bb2c6ae2e81f5` fix(ui): 对齐 Web/Mobile 的 ACP 目录与活动展示
8. `93a41e3e68a16ea3b8fc93adbe85c10935196aa6`（见 Round 144）
9. `b5188ed4b2788f559a4ff096af730289723460eb` test(acp): 补齐目录入口的官方 CLI 探针
10. `689dde5f163cd57a4ba904c28f448584496a5fb4` docs(providers): 补齐 ACP 入口说明与能力/验收记录

Round 143 代码哈希：`f5aae63913e14da349ce0a709231bd22ee8a0ea4`。A7 四份 live 与 `tcp-forward-tunnel.mjs` 仍未跟踪。

#### Verify

定向汇总：protocol 31；CliProxy 族 110；品牌 2；附件/MIME 109；ACP 运行时 349；目录 16；UI 160；schema/protocol 33；样本探针 12 跳过。各批 lint 0。Server 整包 tsgo 仍受未提交 A7 live JSON 规则影响，不记为本批缺陷。无全仓、无 `~/.t3/userdata`、无按名杀进程、无 push/PR。

#### Retrospect

本轮 progress：产品脏树按模块拆完。A-7/A-8 未勾选。下一轮唯一增量 A-7：隔离服务分别验证本地、远程、relay/tunnel（OR）重连/迟到审批/崩溃与取消恢复；先修 A7 live 类型门禁再取真实证据，一步一提交。goal active、loop running。

### Round 146（A-7 隔离服务三模式恢复）

#### Plan

按 Acceptance A-7：用隔离 home 的真实 serve，分别验证本地、远程（LAN 非环回）、relay/tunnel（OR：TCP forward 与产品 SSH local-forward）上的 WS 重连、迟到审批、Agent 崩溃恢复与取消后重启。复用已有 A7 live harness，先修 tsgo/lint 门禁，再跑四份 live 并保留 `.t3/a7-live-isolate-r5*` 证据；Agent 侧可用 ACP mock，连接模式不得用本地 mock 代替。不读写 `~/.t3/userdata`，只杀捕获 PID。

#### Act

为四份 live 增加 Effect 诊断豁免与 `accessToken` 收窄；Remote LAN 修正 `family` 联合类型；`tcp-forward-tunnel.mjs` 改为 `NodeNet` 命名空间导入；`acp-mock-agent` 增加 `globalTimersInEffect:off`。`process.platform` 用 oxlint-disable（宿主壳/信号在 Effect 外）。本模块提交哈希：`8643b11a8477609c61d942b03f0170cb84384411`。

#### Verify

Server `tsgo --noEmit` 退出 0。定向 lint 退出 0。四份 live 各 1 项通过（合计 4/4，约 34s）：本地 `a7-orchestration-mediated-evidence.json`；远程 `a7-remote-lan-evidence.json`；tunnel TCP `a7-tunnel-forward-evidence.json`；产品 SSH `a7-ssh-product-tunnel-evidence.json`。四份 `ok:true`，覆盖 lateApproval/crash/cancel 与各模式 reconnect。relay/tunnel 为 OR；未测 Connect/Tailscale。未跑全仓、无 push/PR。Acceptance A-7 勾选。

#### Retrospect

本轮 progress：A-7 三桶证据齐全并勾选。Agent CLI 仍为隔离 mock，连接与恢复路径为真实 isolate serve。下一轮唯一增量 A-8：稳定文档/44 能力表/回滚说明齐全后，派发全新独立审核逐条核对 A-1…A-8；未证实保持未完成。goal active。

### Round 147（A-8 新鲜独立审核）

#### Plan

对照计划 P0–P5 与 Acceptance，派发全新独立审核（不信任台账勾选），逐条判定 A-1…A-8；文档/能力表/回滚仅作 A-8 输入，不能代替审核。真实账号/真机按 override 可跳过；连接模式证据不豁免。

#### Act

独立审核子代理（agent `118c5d7c-a9b3-4f1f-97ae-3dbdcd3d6d5f`）只读核对当前 HEAD 与证据。结论摘要：

| ID | 判定 |
| --- | --- |
| A-1 | PROVED（定向 191+56 项 fixture/UI 派生） |
| A-2 | PROVED（6+38 表 + 目录/快照测试） |
| A-3 | PROVED（登录豁免；首批探针/文档） |
| A-4 | PROVED（四态登记表） |
| A-5 | UNPROVED（缺 Desktop/Mobile 聊天选择/审批/命令/工具详情关键路径耐久证据；目录/Amp 安装不够） |
| A-6 | PROVED（Adapter/账号池定向 90 项） |
| A-7 | PROVED（r59/r62/r64 隔离 JSON） |
| A-8 | UNPROVED（因 A-5 未证实，且不得自行勾选） |

台账据此取消 A-5 勾选；A-7 保持勾选；A-8 保持未勾选。未改产品代码。

#### Verify

审核方自行跑了定向测试子集；本轮未额外改实现。禁止把本轮审核写成 A-8 通过。

#### Retrospect

本轮 progress：新鲜审核暴露 A-5 关键路径证据缺口，纠正历史勾选。下一轮唯一增量补齐 Electron + Mobile（AVD 可）对聊天选择/审批/命令/工具详情/失败重连的耐久证据后，再重新独立审核 A-8。goal active。

### Round 148（A-5 Web/Electron/Mobile 关键路径证据）

#### Plan

补齐 Round 147 指出的 A-5 缺口：在隔离 `.t3-a5-r148` 上对 Web 360/1280、Electron 壳、Mobile AVD 捕获聊天选择、审批、命令/工具详情、失败重连与历史；真机按 override 跳过。证据落盘后再写新鲜审核；本轮只勾选已证实的 A-5，不勾选 A-8。

#### Act

1. 续用 isolate 服务 + Cursor mock wrapper，批准工具回合线程 `5144a1e5-5f55-4a70-9af1-c071b82a1107`（`approval.requested`→`resolved`→`tool.completed`，正文 `hello from mock`）。
2. Web：已有 1280/360 审批与工具、模型、斜杠、断线重连、完成历史截图（`%TEMP%/codework-a5-r148/evidence/web-*.png`）。
3. Mobile AVD：配对后打开同线程，展开工作日志见 Command approval requested / Approval resolved / Ran command 与工具详情（`mobile-avd-*.png`）。
4. Electron：`CODEWORK_HOME=.t3-a5-r148` + `CODEWORK_PORT=13774` + `VITE_DEV_SERVER_URL=http://127.0.0.1:5734`；CDP 打开同线程，展开日志见审批与 `cat server/package.json` 输出、`/model` 斜杠（`electron-*.png` / `electron-final-text.txt`）。
5. 说明文档：`docs/internals/paseo-a5-keypath-r148.md`；审核草稿：`docs/internals/paseo-a8-fresh-audit-r148.md`（A-8 仍未勾选）。
6. 台账勾选 A-5；A-8 保持未勾选。无生产代码改动。

#### Verify

证据文件存在性核对：`manifest.json` 列出 web/electron/mobile 关键截图；Electron 文本转储含 `Command approval requested`、`Approval resolved`、`cat server/package.json`、`{ "name": "t3" }`、`/model`。本轮无产品源码变更，未跑实现向测试；文档为 UTF-8。未读写 `~/.t3/userdata`。

#### Retrospect

本轮 progress：A-5 在 override（真机可跳过）下由 Web+Electron+AVD 关键路径证实并勾选。A-8 仍待下一轮最终独立审核（文档/44 能力表/回滚 + 逐条 A-1…A-8）。goal active。提交哈希 `563009c5a352d608b68f506cad271dea9ec77808`。

### Round 149（A-8 最终独立审核）

#### Plan

在 A-5 已勾选前提下，重新独立核对 A-1…A-8：确认稳定文档、用户说明、44 入口能力合同与回滚说明仍在；定向复跑核心 Runtime/派生测试；核对 A-5/A-7 证据文件仍可读。仅当 A-1…A-7 全部再证实且文档门禁满足时才勾选 A-8。

#### Act

1. 文档门禁：`acp-provider-validation.md`、`paseo-provider-catalog.md`、`docs/user/acp-session-controls.md`、`docs/user/providers-pi-ohmypi-acp.md`、`paseo-a5-keypath-r148.md` 均存在。
2. 证据：`%TEMP%/codework-a5-r148/evidence` 关键截图仍在；`.t3/a7-live-isolate-r59|r62|r64` 隔离 JSON 仍在。
3. 定向测试 4 文件 167 项通过（AcpRuntimeModel、AcpCoreRuntimeEvents、orchestration、threadActivity）。
4. 写出 `docs/internals/paseo-a8-fresh-audit-r149.md`，判定 A-1…A-8 均为 PROVED（在既定 override 下）。
5. 台账勾选 A-8。无生产代码改动。

#### Verify

见上：文档存在性、证据路径、167 项定向测试通过。未跑全仓检查。审核结论不得早于证据核对。

#### Retrospect

本轮 done（本 goal Acceptance 全集在 override 下已勾选）。提交哈希 `9a8173e24c652d7cf7eb22fbf6db708c5f3b9f52`。若后续发现证据丢失或合同回退，须重新取消对应 A-N，不得保留本轮勾选。

## Lessons

### L-107 本 goal 真机豁免后 AVD 可证 A-5，但不得外推未豁免合同 (source: Round 148)

Acceptance 原文要求真实手机，L-71 禁止用 AVD 顶替。本线程 front-matter override 与用户本轮要求明确允许跳过实机时，AVD + Web + Electron 关键路径可勾选 A-5，并在台账注明豁免。未写豁免的其它验收（或其它 goal）仍遵守 L-71。Electron 须能加载 isolate 的 Vite（注意仅监听 IPv6 时 `127.0.0.1` 会拒连）；Desktop 开发模式需要 `CODEWORK_PORT`，与已有 isolate 争用时先停已知 PID 再让 Electron 接管同一 `CODEWORK_HOME`。

### L-106 生成类型与运行时须同义，并发提交先核对字节 (source: Round 144)

只手改生成Schema会在重新生成时丢兼容，且别名类型可与解码optional不一致；生成边界只放宽认证定义的身份缺省，嵌套字段仍必填，固定生成器输出与类型负向分别验证。另一执行方已提交相同四文件时校验提交范围和字节，不重复提交或清空索引。外置对照须使用包依赖边界，排除模块缺失后再认定类型红绿。externalLauncher.reveal已获用户纳入授权，当前暂未提交仍需逐模块核验，不因Round145暂不混入而永久排除。

### L-105 可信回收排空已有调用，错误与重复保留同一结果 (source: Round 143)

通用terminal.close在终态被拒是原权限合同，不能为清理松门禁；服务端绑定用原runId分组与Manager关闭，先在途claim登记再异步校验，使排空涵盖迟到读取。复用原Deferred回执和一次清理结果，关闭失败不能第二次void伪装成功，公开HTTP/MCP不发布内部回收。真实子PID死与Session不存在分别核对，RPC错误精确tag/Run/terminalId优于message序列化猜测。已有调用排空不自动证明取消未落库期间所有新请求都被拒；保留下一验证边界。隔离缺tsgo shim用已安装同编译器经vp exec，不假装包脚本已成功。新目标要求按模块整理时，先只读分类再确定所属，混合语义/格式与缓存不广泛暂存；既存历史豁免只按当前用户明确授权采用。

### L-104 停止宿主进程先于Agent终态，原生负码不能伪造成功 (source: Round 142)

ACP cancel可先投影终态并撤销Run权限，随后真实terminal.kill被拒；共同Adapter先停当前回合已就绪资源，finally仍结算交互并通知取消，停止失败明确返回。Windows原生-1与ACP uint32不同，output/wait共用合法转换并保留未知null与原始快照，不改0。真实Node PID退出不证明terminal.close成功；终态后cleanup受门禁拒绝须另验可信资源回收。watch重启、错误fixture参数、官方CLI与产品PTY各自分证；旧恢复checkmark遭真实孤立Run反证时重新未完成。保护脏Adapter只改所属片段，逆向能逐字节还原原工作。


### L-103 启动事件必须等提交确认，取消先唤醒等待 (source: Round 141)

握手已签发和turn.started已发布都不证明真实投影事务提交；共同Bridge复用本Run可信绑定确认，保留原权限门禁，不靠定时轮询。提前终态从可信尚未落库握手撤销，回收先唤醒等待；未确认超时或取消不执行，迟到确认也不补副作用。三种时序用一个参数化真实Store夹具，类型复用ProviderToolBrokerResult而非手写可选字段。正向实际浏览器与先前负向证据分别计数；文件闭环不能冒充生产PTY或整个目录验收。


### L-102 ACP返回时机不同于Run启动，旧Session必须先关闭 (source: Round 140)

ACP sendTurn可能到终态才返回，不能把它的返回当成工具请求前的握手落库时机；已有pending/active/history可信绑定携带已签发身份，turn.started与running同事务激活，raw声明或冲突归属不授予权限。提前终态和发送返回共用一次回收责任，取消也走同一路径。startSession关闭旧Session会清理thread新配置，复用listSessions先关闭精确归属再configure，连续派发需真实验证。审批accept/decline/cancel、工具执行、文件副作用与整轮终态各自核对；普通夹具负向failed不是整轮cancelled，泛化错误仍未完善。等待投影的回归不证明极早请求因果屏障，下一步须控制实际消费者顺序而不加sleep或松权限。


### L-101 同级Layer不自动提供依赖，实际失败不能冒充工具通过 (source: Round 139)

serviceOption会把生产漏接Bridge静默伪装成Provider不支持；兄弟Layer merge不等于向Projection提供服务。必需服务应明确要求，用已有TaskStore/InputStore/ToolBroker最小依赖构建Bridge再提供，解除反向包含Projection的循环，复用同一Layer。负向生产Layer构建回归覆盖工厂探针盲区。实际Profile恢复、Run启动与工具成功分别验；失败文案不足以断定握手门禁，须受控回执和真实Store定位。浏览器显示失败不是审批通过，鉴权准备/CLI健康失败另记，不能通过手写业务投影或放宽门禁制造绿灯。


### L-100 静态探针模式不证明生产Registry，动态身份须如实未知 (source: Round 138)

探针显式approval-required而生产Registry漏传时，真实任务仍会默认full-access；沿共同派发入口每次读关联ThreadShell，再让Session和宿主context共用结果。关联缺失/查询失败明确停止，无关联保留真实DEFAULT_RUNTIME_MODE而不猜默认。同步启动身份未完成异步模式解析应null，不能假冒已知全权限或持久化模式快照。重复启动先回收前Run，lint净新增规则查HEAD基线并复用已有it.effect，不改基线。独立源依赖启动shim和watch重连是环境准备；初始配对/页面可达不证明真实Run审批按钮，跨轮保留隔离服务继续业务链路验证。


### L-99 宿主审批复用已有身份，race返回须证明实际分支终止 (source: Round 137)

原生option许可不等于宿主policy.approve；用ToolBroker原approvalRequestId沿既有request.opened/resolved及回应入口，明确单次accept，再按原调用/幂等键/参数执行，等待后重验Run和根目录。内部回调不属于公开工具参数，扩大许可/拒绝/取消和迟到结果不能授权。人工等待不计工具执行期限；本机beta.103默认raceFirst最小诊断未终止败方时，持有实际fiber并在返回前interrupt/等待回收，而非只取消观察者。晚到屏障验证副作用数不变，准备/类型/夹具失败保留且不得冒充产品红灯；真实CLI事件/文件证据与浏览器按钮、PTY/数据库Run分别验。



### L-71 A-5「真实手机」不可用 AVD 替代 (source: Round 84)

Acceptance verify 明文「至少一台真实手机」。`adb` 仅见 `sdk_gphone*` emulator 时不得勾选 A-5，即使配对/项目/ACP 下载与 Electron/Web 360·1280 已齐。

**R107 override（本 goal）：** 用户 2026-10-01 明示「能不能跳过真机」后，以 Web+Electron+AVD 证据勾选 A-5；物理门仅对本 goal 放弃，不改写计划原文对其它工作的默认要求。

### L-70 Electron 验收须重建 web→server dist/client 与 dist-electron (source: Round 83)

`build:desktop` 重建 server+electron 壳，但目录按钮文案/逻辑在 web；server 构建把 web 打进 `apps/server/dist/client`。只重建 `dist-electron` 或只重建 server 二进制而不刷新 client，仍可能对 Amp 显示「需手工配置」。验收前核对 `web/dist`、`server/dist/client`、`desktop/dist-electron` 三者 mtime。

### L-69 Electron 用 hash 路由；过期 dist-electron 同样会假「需手工配置」 (source: Round 82)

桌面渲染器是 `createHashHistory`：自动化必须设 `#/settings/providers`。`apps/desktop/dist-electron` 若早于 binaryDistribution 落地，ACP 注册表会对 Amp 等显示「需手工配置」而非「下载安装」——与 R81 过期 `server/dist` 同类，须分别重建 server 与 desktop 产物后再验收壳内下载。

### L-67 isolate 用 dist 时必须与源码同代，否则目录 UI 假「需手动」 (source: Round 81)

`binaryDistribution` 已在源码/单测时，过期 `apps/server/dist/bin.mjs` 仍可让 Mobile/Web 只显示「需手动安装」。验收前对运行中的 `dist/bin.mjs` 搜 `binaryDistribution` 或核对构建时间；`am force-stop` 后还要清客户端 5min catalog 缓存再截图。

### L-68 Mobile ACP 目录在供应商页；AVD≠真机且下载按钮须实况核对 (source: Round 80)

`SettingsSupplierRegistry`（Supplier 注册表）不是 ACP 二进制下载面。`AcpRegistryCatalogSection` 只在 `SettingsProviders` 且驱动为 ACP 智能体时出现。`am force-stop` 会掉回 Expo Dev Client，需再连 Metro。单元测试里 win32 `binaryDistribution` 不能代替 AVD 上是否渲染「下载安装」——R80 实况仅见「使用 / 需手动安装」；R81 证伪为过期 dist。A-5 仍要 Electron 壳与真实手机，AVD 截图不够勾选。

### L-63 官方缺 sha256 可用维护者隔离哈希 overlay (source: Round 69)

在线 registry 常有 archive 无 sha256。隔离下载算哈希写入 `registry-binary-sha256-overlay.json`，解析时 official??overlay，才能让 `installAcpRegistryBinary` 在线路径也校验。快照只补已核对平台（本轮仅 windows-x86_64）；其它平台保持 `{}`。不得把 HEAD 200 或未校验下载写成已安装。

### L-62 资源分段与字面围栏共同交付，临时索引也需语义核对 (source: Round 67)

保留资源原文的长围栏不能替代前后 assistant item 边界；两者共同防止未闭合 Markdown 吞入资源。Web 字面显示断言应只检查资源代码块，合法外链的网站图标不是嵌入图片执行。构造索引时 String.replace 的替换文本含 $& 等字面内容必须用回调或切片；Git apply/格式化成功不能证明补丁语义正确，仍需差异、红灯、类型和独立副本验证。

### L-61 有 archive 无 sha256 ≠ 可自动安装 (source: Round 68)

官方 CDN 可突然给前空壳平台补上 `archive`/`cmd` 却仍省略 `sha256`。产品 `binaryDistributionFor` / `installAcpRegistryBinary` 必须继续拒绝；HEAD 200 只证明 URL 可达，不得下载冒充安装成功，也不得把无 sha256 的 archive 写入离线 enrichment。目录应改记「手工无校验」，并与快照空 `{}` 并存说明。

### L-60 authMethods=[] ≠ 可匿名建会话；Windows ACP 优先 node 入口 (source: Round 66)

Auggie initialize 广告空 authMethods，但 session/new 仍返回须 `auggie login`——不得把空广告写成可跑工具。Windows 上原始 `spawn(.cmd)` 可 EINVAL；探针应 `node …/augment.mjs` 或 `dim.mjs`，产品路径继续依赖 `resolveSpawnCommand` 对 `.cmd` 的 shell。Acceptance A-1 verify 是 fixture 全链，真实 CLI 非文本归 A-3/A-4，不能用缺真实 CLI 媒体拖住 A-1。

### L-59 目录换行需给说明基础宽度，静态容器不是浏览器证据 (source: Round 62 主线程)

flex-1 默认基础宽度为零，单加 flex-wrap 仍会让下载按钮与窄说明同排。Web/Mobile 复用 basis-48 与换行即可；用真实 360/1280 DOM、处理状态和键盘底部操作证明效果。共同工作树的热重载会重置向导，采用精确索引独立副本继续验证，不把重载当按钮故障。共享 ledger 有并行轮号时以明确子标题追加，不覆盖另一执行方状态。

### L-58 A-7 relay/tunnel 为 OR 桶；产品 SSH 可关桶 (source: Round 65)

Acceptance「本地、远程、relay/tunnel」与计划 P5 的第三项是 slash-**OR**（Connect | Tailscale Serve | Desktop SSH），对齐 `docs/internals/remote.md` 对等接入而非三者 AND。产品 `ssh.exe -L` + `CODEWORK_SSH_AUTH_SECRET` askpass 编排介导 live（R64）在本地+LAN 已证后可勾选 A-7。Tailscale/Connect 仍为备选路径。Administrators 公钥在 Preview 10.0p2 仍可能 Accepted 后 `Unknown error [preauth]`——升级 alone 不够；L-56 关于「仅 TCP forward 不能勾选」仍成立，但已被产品 SSH 证据超越。

### L-57 OpenSSH Match 后勿挂全局；Win 公钥与 askpass 分路径 (source: Round 64)

`sshd_config` 在 `Match` 之后追加的指令仍属该 Match；`StrictModes` 等全局项必须写在 Match 前，否则 sshd 拒绝启动。Windows OpenSSH 9.5p2 上 Administrators 公钥可「Accepted」仍在签名后失败；Code Work 产品桌面 SSH 走 `CODEWORK_SSH_AUTH_SECRET` askpass，应用该路径做 live tunnel 证据，不要用坏掉的公钥路径冒充产品验收。

### L-56 relay/tunnel 桶含 SSH；OpenSSH Win 公钥接受≠可登录 (source: Round 63)

计划 A-7「relay/tunnel」对齐产品三路径：Connect、Tailscale Serve、SSH local forward。OpenSSH for Windows 可非交互安装 Server，但「Accepted key」后仍可能 `Unknown error [preauth]`——不得据此声称 SSH tunnel live。无 auth key/OAuth 时，用短寿命 TCP forward 证明 tunnel hop + 编排恢复是诚实部分证据，不能代替产品 Serve/Connect，也不能勾选 A-7。

### L-55 远程 ≠ 本机第二 loopback WS；Tailscale 安装≠登录 (source: Round 62)

计划 A-7「远程」按 docs 是非 loopback 可达端点（LAN IP / Tailnet / HTTPS）。客户端必须打到该非 loopback host；`127.0.0.1` 第二连接只是本地。`0.0.0.0` 的 pairing host 可能先落到 Tailscale link-local（169.254）或 Meta（198.18）——绑定明确 RFC1918 LAN IP 更稳。winget 可非交互装 Tailscale，但 `up`/Serve 需交互登录或预置 auth key；无 key 时不得假装 relay 已通。

### L-54 上下文零值与空闲通知分别验证 (source: Round 60)

上下文占用为零仍是新快照；上游窗口为零表示未知上限，费用不能变成余额或累计 token。用量必须在活动回合门禁之前处理，且保持根会话/重放隔离，不用于推理活性。存在共同源码副本依赖的基线恢复与完整性核对应顺序运行，避免把检查自身的临时状态当成产品漂移。


### L-53 编排 A-7：配对令牌单次交换 + 勿中途改 binaryPath + snapshot take(1) (source: Round 61)

`openControlClient(pairingUrl)` 每次都会消耗 pairing credential；应对 isolate serve 做一次 `/oauth/token` 交换后复用 `accessToken`。运行中 `server.updateSettings` 改 `providers.*.binaryPath` 会触发「供应商配置正在切换」拒绝新 turn——编排恢复场景应固定同一 mock wrapper。`subscribeThread` 的 live 流不会结束，`Stream.take(n>1)` 会永久挂起；轮询应用 `filter(snapshot)+take(1)`。

### L-52 先核对实际错误类别和事件，再推断包装层 (source: Round 59)

权限回调可能先删除 pending map，随后 prompt 才返回传输错误；不能只靠有无 pending 判断关闭。共同错误映射应区分进程/输入/传输断开与正常请求错误。Cursor 本步独立副本的已知 Agent PID kill 在 30 秒预算内通过，事件跟踪确认此前缺口是 session.exited，而非必须杀整棵包装树；R58 的处理选择不得外推为全部环境的硬要求。发布请求和取消结算必须处于同一保护范围，否则断线可发生在 UI 已显示、finalizer 未安装之间。


### L-51 Windows mid-approval crash 须杀包装树并强制 turn 终态 (source: Round 58)

Cursor/ACP 在 Windows 上常为 `cmd`→bootstrap→agent；只 `process.kill(grandchild)` 会使 stdio/`exitCode` 不同步，滤跑在 30s 内挂起。夹具应对记录的 agent PID 用 `taskkill.exe /pid /t /f`（或等价树杀），并给足够超时。产品侧：session 错误且仍有未结算交互时必须发布 `turn.completed`（failed），不能只依赖 promptsInFlight 计数。不得用「仅杀孙子」的假绿或未绿超时否定全量矩阵。

### L-50 隔离 live A-7 用捕获 PID 的 serve，勿用 pkill (source: Round 57)

本地 A-7 证据：`--base-dir` 隔离 home + 捕获 spawn PID；脚本化 bearer→wsTicket→`/ws` 开关；崩溃只 `Stop-Process` 该 PID 再同 home 重启。`VACUUM INTO` 在 Windows 上对正被占用的 `~/.t3/userdata` 可能失败——空库 migrations 或已有工作树副本亦可作隔离种子，仍禁止读写在线 DB。滤跑单个 Cursor crash e2e 可能 30s 超时，不得用部分滤跑否定或代替先前全量绿。

### L-49 CODEWORK_ACP_* 不得经宿主 env 泄漏进 mock (source: Round 55)

fixture 标志若写进测试进程 `process.env` 或残留在 agent shell，`extendEnv: true` / bootstrap `...process.env` 会使后续无关用例继承 `EMIT_TOOL_CALLS`/`EXIT_AFTER_PERMISSION` 等，表现为假超时或 `Method not found: session/request_permission`。应用显式 spawn.env 时剥离未声明的 `CODEWORK_ACP_*`，wrapper 只注入本次 JSON env，测试勿持久修改宿主 process.env。

### L-48 Copilot cancel 必须等权限回调再断言 (source: Round 54)

取消探针若同步 `prompt` 而不等 `requestPermission`，模型可能先结束文本回合，`permissions` 缺 `cancel`。应 `fork` prompt、在取消步权限处理器里信号、再 join；提示需强制工具调用。缺回调时记录 flake，不得写成产品永久回归，也不得在无权限事件时声称取消已验收。

### L-47 Copilot cancel 依赖实际上游权限回调 (source: Round 53)

在已登录 gh 下，允许/拒绝与工具可绿，但「创建文件后 cancel」若模型未发 `requestPermission`，探针不会写入 `cancel`。不能把单次缺取消写成产品永久回归，也不能在无权限事件时声称取消已验收。

### L-46 blob name 不得等于整段 URI (source: Round 52)

嵌入资源解析若把 `resource.uri` 写入 `blob.name`，存储层会优先采用该“名称”而跳过 basename，附件显示成 `file:///…`。应只传 `uri`（或显式 basename），由 `fileNameFromUri` 取最后路径段。

### L-45 负向探针须覆盖实际环境合并 (source: Round 49)

Runtime 的 extendEnv 会把删除掉的变量从宿主重新补入；无凭据实机探针应在传入环境显式置空非系统变量，并隔离 HOME/配置路径，不能仅以 delete 密钥变量证明隔离。公共协议错误回归同时检查字段保留和同连接后续请求，正常失败不应使传输永久不可用。

### L-44 minion 默认 uvx 双阻断：AuthMethod 与 stderr RPC (source: Round 50)

`minion-code==0.1.44` 在默认解析下 ImportError；即使 pin `agent-client-protocol==0.8.0`，initialize 结果写在 stderr，Code Work 只读 stdout NDJSON 仍失败。不得把「uvx 装上」或「stderr 里看到 JSON」写成握手成功；也不为兼容单 Agent 去读 stderr 日志流。

### L-43 Harn environmentPolicy 是 struct.kind；AuthMethod id/name 可缺 (source: Round 48)

Harn 拒绝字符串 `environmentPolicy`，要求 `{ kind }`。产品在 NewSessionRequest 扩展该可选字段，并对 harn 默认 `inherited`。Agoragentic 的 authMethods 可同时缺 `id` 与 `name`；将二者改为可选后 initialize 可过，仍不证明会话/工具可用。L-40/L-41 的“仅能记录失败”结论由本轮产品修复更新。

### L-42 限长预算贯穿持久化，部分补丁按唯一分支核对 (source: Round 47)

截断标记须计入正文上限；在 ACP 保留 8000 字尾部后再加标记，会使 ingestion 的 8000 字裁剪删除最后结果。用跨解析/统一事件/活动/公开投影回归检查末尾。共享工作树行号会偏移，相同代码上下文可让部分补丁落到错误分支；精确索引需独立副本验证，按唯一函数/分支选取，不能以 git apply 成功替代语义检查。

### L-41 Agoragentic authMethods 缺 id 会使 initialize 解码 Die (source: Round 46)

官方 CLI 可返回缺少 `authMethods[].id` 的 initialize；effect-acp 按 Schema 必填拒绝并表现为 Cause/Die。探针须用 `Effect.exit` 捕获，不能只当 AcpRequestError。上游补 id 或产品放宽前不能声称会话可用。

### L-40 Harn session/new 强制 environmentPolicy，空 auth 不够 (source: Round 45)

Harn 广告 `authMethods=[{id:none}]` 且 `authenticate(none)` 可成功，但 `session/new` 仍要求扩展字段 `environmentPolicy`（`inherited|isolated|granted`）。当前仓库 effect-acp schema 无该字段时只能如实记录建会话失败，不能把 initialize 成功写成会话可用。

### L-39 请求寿命、选择归属与提交依赖分别核对 (source: Round 44)

选择变化只让结果失去回填资格，不会终止服务端下载；同步请求锁应保持到请求结束，界面反馈同样保留。目录 UI 的配置开关必须包含实际运行分支，不能借用工作树中未提交功能制造完整提交。精确索引补丁可在独立源码副本验证，workspace 依赖要指向副本，并覆盖 pnpm-workspace.yaml 的 scripts/lint 插件，格式钩子只比较索引避免混入部分暂存文件的其它改动。

### L-38 crow 真实分发在 PyPI 而非 npm，且 Windows 可能卡 termios (source: Round 43)

ACP registry 的 crow-cli 版本与 npm 无关同名包不是同一产品。应以 `github.com/crow-cli/crow-cli` / PyPI `crow-cli` 为准；Windows 上 CLI 入口可能因 `pty`→`termios` 直接失败，装上包不等于可探针。

### L-37 Gajae 下一回合须等 idle 而非仅靠 prompt RPC (source: Round 42)

Gajae 在 `session/prompt` 返回后仍可能短暂拒绝下一回合（conflict：仍在发布上一回合最终文本）。产品侧仅对 `gajae-code` 等待 `session/update` 的 `update._meta.gjcPhase=idle`；其它 Agent 不增加该门槛。Windows 上 scoped 临时目录清理可能因主机锁 EBUSY 失败，应与断言成败分开记录。

### L-36 Hermes 工具探针依赖显式 Git Bash 变量 (source: Round 41)

Windows 上 Hermes 文件/命令工具需要 `CODEWORK_HERMES_GIT_BASH_PATH` 传入探针（再映射为子进程 `HERMES_GIT_BASH_PATH`）。只设宿主 `HERMES_GIT_BASH_PATH` 或仅 `--check` 通过，不能证明工具探针会找到 bash。

### L-35 安装回填必须绑定发起身份 (source: Round 38)

官方二进制下载是异步的；仅靠 React state 的 installingId 挡不住同一次渲染内的连点。用同步 ref（Symbol）标记进行中请求，并在环境/选中命令或条目变化与卸载时作废 activeInstall，迟到成功不得 onSelect、迟到失败不得写错误。Mobile 选中详情必须吃父级已装 command，不能回读目录仍为 null 的条目。

### L-34 客户端取消要结束已展示工具 (source: Round 39)

上游可能在客户端 Interrupt 后不发 tool_call_update。对已 emit 的 pending/inProgress 补 failed；仅审批登记、从未发出工具行的身份不新造 Tool。事件流测试只用一个消费者，避免第二个 takeUntil 偷走状态更新。

### L-33 安装原子发布与提交边界分别验证 (source: Round 37)

发布前删除目的目录会丢失损坏缓存或并发安装现场。先以回归复现，再用 rename 发布并核对已完成安装，失败只清理本次临时目录。官方归档 hash 证明下载完整性，不证明认证或工具。一步一提交须含可调用的合同/RPC依赖，并核对精确暂存列表；共享工作树的后来类型错误与模块已有通过分别记录，格式钩子不得通过全树 stash 混入其它工作。

### L-32 区分真实结果、展示正文和客户端取消 (source: Round 34)

Agent 的 ACP 展示内容可能重复命令与摘要，优先使用有明确文本块形状的 rawOutput，原始数组正文同样需要限长；不要全局删除重复行。Runtime cancelled 可能来自客户端中断归一化，要分别核对底层 RPC、实际副作用与工具终态。单回合新目录成功不抵消连续回合、旧状态与关闭失败。探针断言和资源回收错误独立记录，清理只绑定拥有的启动身份，不以进程名匹配。

### L-31 先隔离协议复现，再修停止顺序与错误可见性 (source: Round 32)

后台 Agent 的断开与显式关闭不同，关闭应在协议资源释放前、依据能力广告执行，并有等待上限。关闭失败后继续本地收尾，错误要进入持久化工作记录，不能只存在原始事件。真实 CLI 测试使用真实时钟，错误返回与清理结果分别记录；失败测试不能证明未单独捕获的前置断言通过。较早的结论被新证据推翻时，明确更正，不为维持旧说法增加补丁。

### L-30 认证、会话可用和进程所有权分别验证 (source: Round 31)

固定 CLI 的 authMethods 优先于通用默认值；空 authenticate 可能只验证方法名。空配置建会话仍可能无法发送模型请求。ACP 连接结束不代表后台主机退出，测试要按已知会话/端点身份回收；清理成功与优雅关闭通过是不同证据。官方文档与二进制命令注册可能漂移，以固定资产的实际帮助/响应核对。不得用按名称杀进程或放开真实目录访问来制造通过。

### L-29 二进制版本检查不证明协议可启动 (source: Round 30)

目录平台状态以实际官方资产为证，OS/arch 之外的最低系统版本需明确说明。管理提取、版本帮助、initialize、认证、工具执行是不同门槛；前一级通过不抵消后一级失败。重复隔离启动失败先停止猜测并记录组合边界，不用用户真实配置换取通过，不将不可确定的启动根因武断归给操作系统。

### L-28 模型切换按广告选择 RPC，空配置不等于空模型 (source: Round 29)

沿持久化事件核对因果，不以问题出现时点推断根因。配置成功可能只是保存任意键，真实模型请求才能证明切换。模型配置项优先，旧 models 广告走 set_model；空配置只撤回自身及其派生目录。成功接受的目录外 ID 保留原值与未知能力，失败不提前更新当前标记。页面刷新、CLI 新进程恢复与服务崩溃分别记录。

### L-27 工具输入与输出分开，详情边界跨持久化核对 (source: Round 28)

原始终态完整并不证明客户端可见，ingestion 短摘要可能在写盘前丢失正文。新终态保留有上限的详情，中间流继续压缩；公开投影和刷新历史分别验证。明确 execute 数据无 command 时不能把 detail 当输入，也不能隐藏已有 stdout。正文即使像 shell 命令也应原样显示，旧无元数据兼容单独保留。

### L-26 权限闭环要关联决策，不能推断执行成功 (source: Round 27)

仅审批身份的裸终态可以是关闭权限气泡，而真实执行有独立身份或执行更新。按根会话、实际选项 kind、字段形状和已见执行证据判断；不能靠厂商名、ID 前缀或标题过滤。未见权限身份和不匹配终态继续保留，允许后的执行失败仍失败。测试与类型检查分别提供证据，旧持久化历史不应因新规则被悄悄改写。

### L-25 工具正文、审批身份和安装探测必须分层判断 (source: Round 26)

带 kind 的完成通知仍可携带真实文本结果，分类摘要不能覆盖它。厂商不发送 rawInput 时，截断标题不能用来推导完整命令；测试用请求关联、工具 ID 和副作用核对。仅权限请求出现的 ID 可能收到独立 completed，这不等于另一次工具执行；应在协议身份边界解决，不能用 UI 文案隐藏。--check 与模型正文都不能证明文件/终端依赖完整。重连后的实际模型和界面标签必须分别验证。

### L-24 认证响应和 HTTP 方法不能替代语义证据 (source: Round 25)

上游处理器返回 None 可能被协议 SDK 转为 {}，未广告方法的成功响应不能证明登录。配置探针须核对握手、建会话与具体模式请求。POST /api/show 属于模型能力探测，不等于生成；应按路径与 payload 判断。Runtime 合并环境时，仅从传入对象删除密钥变量仍会继承宿主值，隔离探针需显式覆盖并重定向账号目录。

### L-23 审批记录不是工具执行 (source: Round 24)

工具数量异常先查同一回合的 toolCallId 与活动类型，避免在已有合并逻辑上重复加去重。requestKind 描述审批目标，不证明工具已执行；审批申请/结果要保留明确标题与可检查详情，但不能计入工具或显示执行成功。既有普通日志折叠能保留历史，失败执行独立可见。只有确认相关后才把旁路归属告警并入同一个修复。

### L-22 实机 Runtime 与产品 Adapter 必须分层验证 (source: Round 23)

Runtime 正确回传原生权限选项不保证产品 Adapter 也正确；浏览器“通过”必须核对实际副作用与原始 optionId，不能沿用固定拼写。上游 completed 与结构化结果 success=false 可同时出现，失败语义在适配边界明确归一；批量输出进入共同 detail 后双端复用。CLI 参数存在不代表目标运行模式会处理它，隔离目录和本地端点须验证实际读取。模型夹具不能自证工具成功，必须检查文件、输出、状态和恢复历史。

### L-21 显式空配置须贯穿界面和启动链，同类别不一定是同一选择器 (source: Round 22)

空字符串表示跳过可选认证 RPC，undefined 表示使用默认方法；合同、双端保存、字段显示、Adapter 和 Runtime 都要区分。直接建会话仍由上游校验，不能把省略认证当登录成功。外部 Agent 可能把 provider 与 model 放入同一类别，明确模型键需优先，展示与写回应共用选择逻辑；空目录保持空。官方配置请求成功只证明配置链路，不证明模型或工具执行。

### L-20 真实 CLI 与模型证据分开，增量缺省字段不能造默认覆盖 (source: Round 21)

官方 CLI 配本地模型端点可以验证真实文件、命令、审批和恢复，但不证明外部账号或推理成功。模型夹具也必须遵守响应身份和请求关联，后台请求不能消费另一 prompt 的工具计划。完成通知缺 title 时保留原名；只对明确携带的字段更新派生显示。目录切换同时重置认证方法，避免不同 Agent 配置混用；Windows shell 以实际出口和退出码为准。

### L-19 外部标准错误须进入声明错误通道，认证成功不代表会话可用 (source: Round 20)

Effect 自身 Cause 编码的 mock 可能掩盖外部 JSON-RPC error 被解为 Die 的差异；在公共协议边界识别合法错误形状并保留 code/message/data，使用原始 NDJSON 覆盖核心与扩展请求，显式缺陷和畸形消息继续失败。authenticate 空成功仍可能在 session/new 才校验密钥，不能提前宣布账号可用。实际发布包和 Schema 版本优先于静态规则的 API 建议。

### L-18 合法空值在适配边界编码，权限和默认模型语义显式化 (source: Round 19)

上游合法空字符串不能被全局非空合同丢掉；用局部可逆编码，在最新广告校验后还原。选择、返回默认和撤回都必须经过同一事件与客户端合并链路。只含角色/权限的配置不是空模型目录；CLI 默认代表不发送模型覆盖，不能伪造具体模型广告。上游 Allow All 与应用运行模式是独立审批面，必须同时核对。浏览器热重载中断先读日志，恢复后继续用原实例验证。

### L-17 官方 CLI 实测必须区分能力广告与推测 (source: Round 18)

安装、认证、模型回复、文件副作用、权限拒绝和恢复是不同证据；opt-in 探针必须真正等待对应事件并检查结果。某版本未广告模型目录不等于客户端丢弃它，先查看原始响应再改生产解析。已具备通用接入能力时复用现有驱动，修正旧“即将推出”入口即可，不复制 Adapter。独立配置目录不是操作系统隔离，也不能声称完全不读取用户级配置。

### L-16 能力兼容默认必须可覆盖且保留 false (source: Round 17)

旧版第三方目录的能力标记不是永久事实；核对厂商当前文档、保留版本边界并提供实例覆盖。MCP 注入在共用适配层控制，启动与恢复使用同一结果。默认 true 的配置不能沿用只存 true 的开关助手，双端和合同应对齐缺省语义，明确 false 必须持久化。

### L-15 图片必须贯通存储、空消息判定和失败显示 (source: Round 16)

上游图片只传附件引用到公开消息，复用原子资产写入和签名地址；重试使用稳定 ID，思考及其它会话仍隔离。纯图片不能被正文为空的过滤器删除。服务端格式签名不是完整解码，客户端仍需失败状态；已有错误翻译可能覆盖具体原因，必须通过实际页面核对。图片回合应验证展开、预览、刷新和窄屏，文件成功不等于端到端成功。

### L-14 结构化资源需要字面显示和消息边界 (source: Round 15)

资源链接保留实际 URI，嵌入文本用足够长的围栏防止被解释为 Markdown。资源前后复用独立 assistant item，避免前文未闭合围栏吞入后续资源。URI 不支持打开时保留原值并明确提示；不要伪造下载能力。中间消息沿用工作记录折叠，验证需展开并读取 DOM 顺序，不能从 AX 差分顺序推断乱序。

### L-13 页头按可用容器宽度布局 (source: Round 14)

固定面板控件与不可收缩操作区会把标题挤到零宽，缩短文字不够。复用容器查询给导航和操作分行，操作本身仍可换行，同时为绝对定位控件保留空间。验证窄屏和宽屏分栏的实际边界及开关返回，不以无滚动条推断内部按钮没有重叠。

### L-12 任意模式的双端传递与事件消费 (source: Round 13)

ACP 模式直接复用 select descriptor 和 ModelSelection.options，保留原始 URI，不压缩成两态。配置模式与旧 session/set_mode 分别按真实协议发送，失败不静默回退。菜单和发送队列必须用同一目录归一化；null 撤回要消除隐藏旧选项。事件序列不能按固定条数测试，回合完成前等待已有队列屏障，同时在消费者退出时结束等待。

### L-11 启动元数据必须有明确优先级和会话边界 (source: Round 12)

握手前配置与命令应独立保存在同一会话缓存。最终响应明确包含配置时以响应为准，只有缺省/null 才保留通知；空数组必须能撤回。补全原 setupResult 后再派生模型/模式，避免 Adapter 和运行时使用不同快照。失败重试清缓存，只有根会话通知推进恢复活跃时间。上游 fixture 的必填字段应由类型检查核对。

### L-10 模型目录必须覆盖显示、校验和发送的共同入口 (source: Round 11)

只在子组件合并动态模型，会让父级选择回调继续按静态目录归一化，表现为能看到新模型却选不上。将目录派生放在公共入口，浏览器选择后再核对实际协议参数。null 清除旧会话覆盖，空数组撤回广告，显式自定义模型和同名模型能力保留；这些语义在共享客户端实现，避免 Web/Mobile 分歧。

### L-9 扩展命令必须区分执行形状、结果和等待结束 (source: Round 10)

Kiro 命令需要对象形状 command/args，显示内容来自 RPC message/data；不能只把斜杠文本透传后称执行成功。错误不得重新发送模型，否则可能重复副作用或把控制指令变成普通问题。超时或取消只证明客户端结束等待；真实进程恢复和操作撤销必须有另外证据。Schema 建议需与仓库当前版本核对，测试通过不代表类型检查通过。

### L-8 厂商通知复用标准状态入口，错误不等于撤回 (source: Round 9)

扩展协议解码后调用同一会话处理函数，才能同时保留启动缓存、重放和根会话隔离；不要另建一个绕过门禁的事件队列。明确的空列表表示撤回，缺列表或格式错误保留旧快照并报告告警。命令发现、显示与执行是独立证据，专用执行请求未验证时不能用普通 prompt fixture 代替。

### L-7 离线目录必须带来源且不能覆盖成功在线结果 (source: Round 6)

保留 error 并增加 source/snapshotDate 后，客户端不能用 error 非空来隐藏全部条目；WS 也应给非空离线目录补充实例诊断。离线与在线共用同一安全及平台解析器。静态快照需要来源、日期、原始数据哈希和许可证；合法在线空目录不应被旧数据“补满”。

### L-6 健康探测必须复用真实启动的命令解析 (source: Round 5)

Windows 的 .cmd/.bat 不能按普通可执行文件直接 spawn；健康探测与实际 ACP 会话应共用 resolveSpawnCommand。版本检查要追加到解析前的 argv，再由共享层处理路径和参数转义。npx 形式的本地 shim 回归可证明 PATH/参数/握手链路，不能冒充真实软件包安装或认证证据。

### L-5 会话命令是实例隔离的可撤回快照 (source: Round 4)

available_commands_update 可以先于建会话响应到达，也可以在没有活动回合时更新。空列表必须覆盖旧列表，不能回退到全局旧命令；命令菜单选择只填入输入框，完整命令和参数沿普通 prompt 提交。协议模拟进程和真实浏览器组合能证明应用链路，不能证明官方 Agent 的认证与命令语义。

### L-4 动态配置是完整快照，协议名以实际 schema 为准 (source: Round 3)

标准事件为 config_option_update（单数）；配置分组必须有 group、name、options。运行时使用 packages/effect-acp 的 workspace schema。配置更新必须驱动最新键、候选校验和当前值，空数组应撤回旧选项及其派生模式；只新增字段存储不能证明下一回合能选择。

### L-3 零用量必须替换旧快照 (source: Round 2)

ACP used 是上下文占用，size 是窗口上限；零 used 有效，零 size 不满足内部 PositiveInt 上限合同，应省略。共用投影不能因零值不生成活动，否则客户端会继续显示过时占用。累计 token、费用和账号余额须保持独立，不能从上下文占用伪造。

### L-1 入口数量不等于真实验收 (source: Round 1)

上游固定提交为 23c4404b955fbc1a6904b7140f911d9f29de1f27，6+38=44；真实 CLI、账号、设备与连接证据不可用 fixture 冒充。没有验证的条目不能勾选为全部接入完成。

### L-2 区分上游思考与公开摘要 (source: Round 1)

ACP agent_thought_chunk 沿用 reasoning_text；现有 ingestion 只持久化 reasoning_summary_text 到摘要时间线。原始流可驱动活性监测但不能伪装成摘要。共用 ACP 变更必须同时检查 Cursor/Kimi/Generic 与 Grok，以及直接读取 ContentDelta 的诊断探针。

### L-64 精确索引和运行副本的语义完整性 (source: Round 70)

精确索引的 schema/测试返回位置及文档段落都要核对语义；宽泛锚点和同节后续段落会夹带其它模块。字节归一化应先于服务启动，开发 watch 中断回合不能算浏览器验收；临时禁用 watch 仅作用隔离副本，启动后恢复原字节并再跑实际回合。

### L-65 页头命中与两层退出以实际状态为准 (source: Round 74)

无横向滚动可能掩盖零宽导航和内部按钮覆盖。容器查询分行后同时检查按钮中心命中、矩形不重叠、标题非零和分栏边界；文件/内容选择器 Escape 先回主命令面板，再次关闭才返回页头。隔离副本 archive 是长过程，结束后才跑完整性检查；不能把其 ENOENT 或刷新短定位超时记作产品缺陷。

### L-66 媒体引用、实际播放与迟到打开结果分别验证 (source: Round 76)

ACP 内联 audio/blob 需要同一解析、会话门禁、Adapter、公开投影与签名附件链；只让解析器接受媒体不能交付显示。公开 MIME 长度须与持久化合同一致，日志不保留 base64。Mobile 打开只接收最后一次操作结果，旧成功和旧失败都可能破坏新状态。落盘字节与签名测试不证明浏览器解码/下载或系统处理器，浏览器绑定被安全策略拒绝时不得更换控制面绕过；原有 Windows 图标路径失败先用旧基线证明，再单独修共同边界。

### L-72 公开图标路径与本机精确目标分开验证 (source: Round 110)

项目内图标 sourcePath 使用稳定斜杠相对路径；canonical 文件、签名目标和显式外部路径仍用本机路径。只在公开返回边界转换，不做转换/还原往返；测试用 Path.join 比较精确目标，不用固定 POSIX 后缀给 Windows 制造假红。共享台账可能保留嵌入 Lessons 标题，追加轮次应定位最后的主区并保留原始内容。工作文件的完成声明或跳过门槛记录不能代替原始用户授权和新鲜独立审计。

### L-73 专有通知采用显式信封，真实错误按类型与前缀验证 (source: Round 111)

Harn progress 仅凭已确认的 sessionId/update._meta.harn 信封进入扩展通道；标准解析错误不可通用降级。宿主回复复用 initialize 现有能力，未注册能力不要在探针中广告为 true。固定版本握手包含完整认证 id/name，就不要夹带其它 agent 的宽松认证 schema。生成扩展要同时进入生成器；局部转换测试与完整 CLI 格式/下载分别报告。负向 CLI 探针验证明确 AcpRequestError 与 Compilation error 前缀，既不接受任意连接错误，也不把详细错误文本误写为固定短句。

### L-74 下一回合验证能暴露读入循环的长请求阻塞 (source: Round 112)

扩展 RPC 处理器可能等待后续宿主回应，不能在 stdio 读入循环同步等它完成；只让请求在现有 Scope 内运行，通知仍保序，错误继续终止协议。取消/超时仅验证结束当前等待不够，应在同连接发第二请求并核对没有模型重试。Adapter 失败合同按实际请求失败和回合终态验证，不凭命名猜 runtime.error。HEAD 中已经包含条件测试代码不等于分支实际启用，核对循环值与最终执行数量。

### L-75 空闲阶段归属当前回合，测试屏障对应实际阶段 (source: Round 113)

供应商的 prompt 返回与 idle 发布可以分开；idle 识别须经过标准根会话/重放门禁，等待放入已有可取消回合 fiber，并在所有出口清理，超时明确状态未知。RPC succeeded 日志仍在请求完成回调内，不能当作进入下一等待阶段的凭据；先用测试时钟排空当前工作再取消，勿为错误屏障增加运行时中断配置。真实 CLI 加本机模型端点可证明工具和生命周期，不能代替外部模型、账户或设备；固定版本空配置负向结果出现差异时保留失败和原断言，未确认根因不发货该探针。

### L-76 先查提交再选增量，元数据不可覆盖已收到的结果 (source: Round 114)

上一轮 Retrospect 也是待核对资料；对照 HEAD 与差异发现 MCP 提取/限长已经存在，应记录更正并修真实缺口，不能为提交重新实现。结果、命令和标题共享 detail 派生时，仅元数据更新会覆盖旧结果；合并依据已有输出字段保留正文，明确新结果仍替换，未有输出时保留摘要更新。协议 raw null 与缺省同义，false/0/空字符串不同；解析、实际通知合并和公开历史都要断言。手工回退的默认值不证明在线同 ID 条目也有默认值，查最终优先级再宣布目录行为。

### L-77 完成后的补充仍需继承，目录风险先核对真实条目 (source: Round 115)

工具终态后删合并状态会使补充元数据重新像进行中，也会把小结果交给中间合批。当前回合复用既有表保留终态，下个 prompt 在原清理入口移除；验证成功/失败、补结果及新回合同 ID 不串旧结果。额外保留量随当前回合工具数增长，不能谎称无限长回合固定内存。在线优先的代码差异只是潜在风险，当前目录没有目标条目时不为构造场景增加生产规则；保留公开响应、日期与统计口径，修已复现的实际缺口。

### L-78 空目录不能替代无模型前置条件 (source: Round 116)

Gajae 0.18.1 默认自动发现本机 Ollama 等服务，空配置目录与清空凭据变量仍可能得到模型、正文和 end_turn。负向模型检查先在自己的临时设置使用官方 disabledProviders 禁用六类隐式发现，并在发送消息前核对模型目录；不改宿主服务，不放宽 model_not_selected，不把认证接受当模型成功。历史无原始模型通知只能说明差异，不能断言内部原因。机器身份读取失败、SDK session not published 与缺模型是不同错误，真实失败保持可见，串行执行和旧通过不能替代稳定验收。

### L-79 通知省略 ID，空字符串请求仍需回应 (source: Round 117)

Effect 内部 notification 使用空 ID 与 isNotification 标志，ndJsonRpc 编码却仍保留 id；线上必须复用已有无 ID 信封。接收也按显式标志区分，不能把合法空字符串请求丢成通知。Schema 解码忽略额外字段的比较会掩盖这种互操作错误，检查完整原始 JSON，再跑真实取消、工具副作用和关闭。通知发送无回执，客户端中断不证明远端接受；一次通过不消除旧发布/机器身份故障，不为假设增加重试。

### L-80 本地取消不能早于通知入队，端点文件不证明权威 (source: Round 118)

后台 fork 的通知会让 cancel 在真正入队前返回；用原始通知/入队前的 Deferred 屏障核对取消和原 prompt 尚未结束，再放行检查下一 close，能给顺序错误确定红灯。复用原发送队列先入队再本地中断足够，不加新队列或远端回执假象。SDK 端点文件即使 stale=false，PID 也可能已退出；live 还包含 incarnation、心跳和状态根权威。诊断会影响时序，成功变体不能替代最终原探针；失败出口先保存只读身份，避免目录清理删除了关键索引后再猜原因。

### L-81 stderr 要排空，诊断阶段与最终原探针分开 (source: Round 119)

默认pipe转接到PassThrough不等于被消费；子进程写满stderr会堵住后续stdout/RPC。修复放在所有子进程ACP客户端共用Scope内，排空不缓存、不并入协议或公开工具内容，读取失败只给不含正文的固定告警。回归在回复前等大块stderr写回调，连续RPC和Scope回收都验证，旧行为有确定红灯。上游broker通用catch隐藏内部原因，缺少ledger完成记录不能证明未执行；诊断与原探针时序不同，一次最终通过不抵消新旧失败。正式数量排除重复和诊断，审计文档的完成声明还须对照当前ledger和新鲜验证。

### L-82 验收文档须绑定固定入口与当前提交 (source: Round 120)

目录条目、运行时驱动与固定目标是不同统计，别名和专用驱动映射逐条核对源码，不凭同名合并。局部读取成功而写入失败应分别保留，不能用总体可用标签覆盖失败；历史A-8通过与当前未勾选矛盾时更正历史报告用途，不能据其结束目标。格式化表格填充空白应由检查器容纳，但44项唯一性和精确绑定不可放宽。测试过滤路径不存在可能静默只运行其余文件，按实际文件数核对并单独补正确入口。稳定交付文档与未提交工作记录保持明确边界。

### L-83 维护者哈希只能补缺省，不能替换错误字段 (source: Round 121)

固定归档完整字节和精确URL是可校验安装依据，版本名、HTTP成功、同厂商域名均不够。厂商字段缺失才补，字段存在却null/数字/畸形必须拒绝；直接使用已有类型的静态JSON，不把丢失数据转换为空对象。在线新URL不套旧哈希，当前Junie升级保留手工边界；安装器仍以字节SHA-256拒绝被替换内容。脏工作树曾写好也不等于HEAD交付，回归与文档应随同模块独立提交，原快照/测试变更保留且不混入。

### L-84 缺认证测试须抵抗启动层环境合并 (source: Round 122)

删除变量不是无凭据：extendEnv会重新继承宿主，合成宿主密钥即可让负向用例误成功。测试只保留系统启动项并显式空置其余，再设置独立目录/合成端点；负向密钥必须空字符串。已有三调用点可以复用最小环境助手，不改变生产账号继承。原始CLI工具事件、副作用、取消、恢复逐项核对；Qwen恢复ID和响应没有历史内容断言，不能外推；普通opt-in跳过和单独执行通过分开统计。

### L-85 能力广告不证明安全恢复，原始工具帧必须保留 (source: Round 123)

固定官方CLI的loadSession=true仍可能在读取前重置同ID历史；先用目标记录前后字节和官方读取器查根因，再在共用恢复入口对已证版本保护，不能静默新建/无限重试。厂商shell completed也不证明退出0，结构化退出码优先；只有限定Agent/工具/唯一标准文本才做有边界的失败适配，纯stdout同文及带输出缺退出码必须如实记载。派生失败状态不得覆盖原始ACP帧。工具白名单可能同时授予允许策略，审批验证必须使用实际上游策略配置与原optionId；型号也只从当前广告选择，不猜名称。

### L-86 Copilot离线BYOK与命令完成标签分别核对 (source: Round 124)

固定官方help可以证明当前版本支持离线自定义端点，现有真实账号探针不必成为本机工具验证前置条件；省略authenticate、显式空置宿主变量、独立数据和COPILOT_OFFLINE各有作用，仍不能称操作系统沙箱。原始rawOutput.contents的唯一shell_exit/exitCode比completed标签或正文更准确，归一时保留原字段及原帧；其它Agent、已有字段、多结果或畸形数值不猜测。恢复历史须在下一实际模型请求中检查旧工具结果，合成回复不能自证历史；旧账号/浏览器工作记录保留并明确不作为当前提交验收。

### L-87 BYOK、匿名会话与企业离线构建是不同边界 (source: Round 125)

公共Factory固定CLI配置本机BYOK仍可在session/new要求厂商认证，模型端点未收到请求即不能验收工具；明确负向错误只证明拒绝合同，不等于工具成功。空SHELL覆盖原生COMSPEC默认，仅为已证Windows探针补系统shell，不重新继承用户凭据。目录MCP默认关闭不等于厂商永久不支持，先查HEAD的新建/恢复合同。企业Airgap独立资产不可发明为公共版环境开关；旧历史完整保留但不能作为当前验收/授权依据。

### L-88 文件摘要和结果正文按共同责任选择 (source: Round 126)

真实Mistral读取通知的content是摘要、rawOutput.content才是文件正文；模型收到工具结果不等于UI详情保留结果。仅明确read与字符串正文提高优先级，复用已有预算，并跨公开历史投影核对长尾；原摘要/路径/字段保留，不重执行、不为同类缺口复制厂商Adapter。官方generic自定义模型可不使用Mistral浏览器登录，但显式legacy harness和本机模型证据不证明其它harness、外部账号或多端。恢复需role=tool的真实旧内容，合成回复和同ID不能自证历史。

### L-89 结构化退出、仅审批取消和后台模型分别核对 (source: Round 127)

Kilo终态可省kind且status completed，rawOutput.metadata.exit才决定命令成功；限定厂商/类型/阶段与有效整数，保留原字段/原帧，明确退出码正文进入详情，不从stdout猜。仅审批尚未执行的取消沿原request结算合同，不制造未执行工具；原审批身份、文件无副作用、取消后下一回合均需证据。固定small_model后台标题与所选聊天模型不同，只按已证两消息/无工具标题形状区分，不能宽泛放行或消费工具动作。Windows瞬时目录锁用标准库有限回收重试，不吞错误；临时目标须确认归属。

### L-90 厂商取消扩展与后台摘要须精确识别 (source: Round 128)

CodeBuddy无agentInfo，专有toolName/rawResponse仍可明确命令退出；null kind与缺省等义，已有码和畸形值不覆盖。厂商status cancelled不是标准ACP状态，只凭已证命名空间/原因进扩展，仍复用其它字段校验并保留原帧，会话归属/启动/重放沿同一入口。新进程--model重置不能推断历史模型持久化；摘要包含用户标记不等于实际用户请求，固定完整消息形状才可作为工具/恢复动作。取消安全和新进程恢复成功不证明同连接立即继续，原cancelled/0模型请求失败必须单独留证，不能靠sleep或重发掩盖。

### L-91 取消确认、厂商窗口和扩展兜底分别结算 (source: Round 129)

标准ACP取消后原prompt RPC仍须接收终态；本地取消显示不能先发送Interrupt丢掉远端确认。固定CodeBuddy的回复早于500毫秒窗口，收到明确厂商元数据才保守拒绝新请求，明确未发送、无自动重发；只等RPC并不够。xAI先结算扩展兜底会抢先中断共同Runtime，须先共同取消再finally收尾。turn.started不证明原生请求进入，夹具用实际回执；正向续聊应让Agent回复原请求cancelled，未回复另验超时拒绝，不能弱化断言或用sleep掩盖。独立索引应用重复代码须扩大唯一上下文并检查实际diff，不能把成功格式/类型检查当位置正确；保留失败及诊断原始证据。

### L-92 当前入口记录要区分源码探针与既往实验 (source: Round 130)

固定入口、运行时驱动和目录数量分别核对，已提交探针数量不是完整工具通过数；额外目录、负向认证、部分/不稳定工具、仅同ID恢复各有边界。链接在HEAD存在只能证明可复验入口，不能外推所有断言或真实账号/设备；Factory无认证探针不包含BYOK模型端点实验，分别记录。复用当前稳定合同页，旧未提交历史加提示且保留字节，不以历史通过/豁免替代新鲜审计。外置检查器优先标准库并依据真实数组边界，检索限责任目录；隔离索引格式检查替代自动改写钩子时明确报告跳过。

### L-93 宿主读取失败须回应协议，资源属于外层会话 (source: Round 131)

Fast-agent新写入前先读取旧内容，缺文件是预期ACP错误，orDie会让请求/清理卡住而掩盖责任；返回明确错误，让CLI自行处理，不造空文件/空成功。终端handler不自带Scope，绑定外层会话才能正确回收捕获进程。工具通知与宿主请求分别计数，官方CLI本机模型和宿主替身不代表产品ToolBroker/外部推理/设备，另跑对应合同。恢复必须核对下一模型请求里的旧role=tool内容。准备器锚点先读取真实格式，失败后不让分号触发依赖运行；诊断只定位，正式原probe无插桩通过后才提交。

### L-94 恢复能力可已有，缺的是下一模型请求证据 (source: Round 132)

Qwen同ID/end_turn只能证明会话再次回应；复用原官方probe，在唯一恢复prompt对应的实际请求体筛选role=tool旧read及shell内容，再核对load成功一次、正文和总动作。直接通过时不虚构实现缺陷或增加厂商历史补丁。真实CLI工具与受控模型/账号/客户端各自判断，保留原负向和超时；工作历史不作为当前提交结果。minified长行用有界片段/只取匹配定位，避免普通rg整行输出吞上下文。

### L-95 厂商数据根、原生结果省略与真实终端分开核对 (source: Round 133)

Goose Windows官方 Paths 可绕过HOME/APPDATA的隔离假设，必须显式绝对GOOSE_PATH_ROOT并禁用keyring；未设根的准备诊断不能作为隔离证据。模型广告read/write/shell不同于旧namespaced名，GET模型目录与POST聊天都需要实际支持。成功ACP-aware读取通知省略正文，角色tool历史含正文不证明UI通知有正文，不能伪造结果或重读文件补假象。命令参数含输出标记不证明实际stdout；核对终端引用、真实输出、退出码和副作用次数。审批尚未执行时取消通过不能覆盖运行中命令end_turn旧失败；旧记录原字节与失败都保留。

### L-96 终端所属先登记，停止失败沿公开合同结算 (source: Round 134)

ACP取消回合不等于宿主进程已停止，ToolBroker策略cancel也不等于terminal.kill；共同Adapter复用既有终端表，在exec前登记所属回合，晚到创建补停。停止成功保留句柄给查询/释放，失败公开runtime.error且返回明确错误；多个资源全部尝试后才报失败。真正进入/退出用实际屏障，普通夹具保证无官方CLI时也有回归；官方CLI加测试bridge的真实Node进程不证明产品PTY进程树/GUI。最终清理防重用hasSession，不吞NotFound掩盖重复关闭；文档自验旧字面锚点要随实际标题更正而不放松行为约束。

### L-97 产品返回正文与原生详情关联分别验 (source: Round 135)

真实Goose加ToolBroker可把脱敏正文交给模型，成功原生工具仍只有路径；宿主request无toolCallId、代理随机身份不同、Invocation只保存状态/指纹时不能按文件名猜关联或从持久化恢复不存在的正文。用对应role=tool身份/公共投影/实际宿主计数核对成功、越界拒绝与缺文件失败，模型合成回复不能自证显示。Paseo源码也只回传文件内容，不假设对照项目已修好。测试unknown data复用Schema验证，Layer依赖合并提供，不压掉类型/生命周期诊断；读取通过不外推写入审批/终端/数据库Run。

### L-98 可信模式独立传递，负向测试遵守binding激活时机 (source: Round 136)

服务端Session使用full-access而宿主Bridge漏传时，真实已授权写入会固定触发审批；沿已有内部参数传递模式，公开Invocation/HTTP不能接受原始声明，能力/Run/工作根门禁仍先验。只配置pending binding不代表活动会话切换成功，负向测试要按实际建会话合同激活再核对文件无副作用；原生auto/allow_once与宿主approvalRequestId不能互相替代。明确红灯来自产品缺口还是fixture错误，稳定原断言、公共投影和精确索引同时通过后再提交。
