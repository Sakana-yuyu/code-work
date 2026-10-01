# Agent 入口与验收合同

核对日期2026-10-01，当前源码基线cab8d136bc2ff7d71d03d072c96f03a581b243cc。下表逐项关联已提交证据与能力边界，代表可复验路径和既往明确结果，不表示本次重新运行了44个官方CLI。旧未提交目录/账号/设备报告不进入当前成功统计；本次补验Goose固定CLI工具与恢复，其余入口保留既往明确证据与目录合同。认证、安装、模型回复、文件副作用、拒绝/取消和恢复各自判断。

## 固定范围与入口绑定

Paseo 固定提交 [23c4404b 的内置定义](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/protocol/src/provider-manifest.ts)有6项，[同提交的 ACP 目录](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/app/src/data/acp-provider-catalog.ts)有38项，ID无重叠，共44个预定义入口。OMP在Paseo默认关闭，开发mock不计入。采用注册数组及目录数据，因为它们决定实际入口；检索词为 AGENT_PROVIDER_DEFINITIONS、CATALOG_DATA、BUILT_IN_DRIVERS、MANUAL_AGENTS。此固定范围不随官方目录增减而改写，也不表示44个官方CLI已完成运行验收。

Code Work 的 [BUILT_IN_DRIVERS](../../apps/server/src/provider/builtInDrivers.ts)有12项，包括10个具名运行时、通用ACP及BYOK。下表的“内置”是Paseo的分组；Copilot在Code Work通过通用ACP实例接入，不增加同名专用驱动。冒号后的ID是目录选择来源，保存的实际实例ID由用户命名，不能用目录ID替代 providerInstanceId。

| Paseo ID        | 固定分组 | Code Work 入口              | 承载驱动         | 已提交证据入口                                                                                                       | 当前能力与未验证边界                                                                                                                                                                  |
| --------------- | -------- | --------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude          | 内置     | claudeAgent                 | ClaudeDriver     | [Adapter合同](../../apps/server/src/provider/Layers/ClaudeAdapter.test.ts)                                           | 现有SDK驱动及工具/审批事件合同；本页未新增官方账号、工具或多端实测。                                                                                                                  |
| codex           | 内置     | codex                       | CodexDriver      | [Adapter合同](../../apps/server/src/provider/Layers/CodexAdapter.test.ts)                                            | 现有app-server驱动合同；本页未新增官方CLI完整工具/审批/恢复实测。                                                                                                                     |
| copilot         | 内置     | acpAgent:github-copilot-cli | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/CopilotAcpToolProbe.test.ts)                                        | 固定1.0.89离线BYOK本机模型：正文、读写、shell成功/exit7、原审批拒绝/取消、新进程旧工具历史；GitHub账号、外部推理与设备未验。                                                          |
| opencode        | 内置     | opencode                    | OpenCodeDriver   | [Adapter合同](../../apps/server/src/provider/Layers/OpenCodeAdapter.test.ts)                                         | 当前源码导入SDK v2；不由此推断v1兼容。真实CLI/全部工具矩阵与外部模型未在本页复验。                                                                                                    |
| pi              | 内置     | piAgent                     | PiDriver         | [Pi合同](../../apps/server/src/provider/pifamily/PiAdapter.test.ts)                                                  | 受管BYOK和JSONL RPC；保持本地网关凭据约束。合同测试不代表实际CLI/外部模型及全部工具已验。                                                                                             |
| omp             | 内置     | ompAgent                    | OmpDriver        | [OMP合同](../../apps/server/src/provider/pifamily/OmpAdapter.test.ts)                                                | 受管BYOK、rpc-ui独立语义；审批/host tools/子Agent分别核对，不以Pi结果替代；本页无新增官方实测。                                                                                       |
| agoragentic-acp | ACP      | acpAgent:agoragentic-acp    | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧记录有session/new缺失；当前提交未收录可复验官方会话/工具探针，不把MCP tools/\*等同ACP会话。                                                                                         |
| amp-acp         | ACP      | acpAgent:amp-acp            | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧握手/安装记录不等于模型与工具通过；当前仅目录和共用合同，真实Amp凭据/工具待验。                                                                                                     |
| auggie          | ACP      | acpAgent:auggie             | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧空auth广告后仍要求登录；当前仅目录和共用合同，安装/握手不当作认证或工具通过。                                                                                                       |
| autohand        | ACP      | acpAgent:autohand           | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | ACP wrapper与底层Autohand安装是不同前置条件；当前仅目录/共用合同，官方工具矩阵待验。                                                                                                  |
| cline           | ACP      | acpAgent:cline              | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/ClineAcpToolProbe.test.ts)                                          | 固定3.0.65本机模型：正文、读写、shell成功/exit7、拒绝/取消及新进程旧读取历史；未证明外部账号/MCP/各端。                                                                               |
| codebuddy-code  | ACP      | acpAgent:codebuddy-code     | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/CodebuddyAcpToolProbe.test.ts)                                      | 固定2.159.0本机模型：正文、读写、PowerShell成功/exit7、拒绝/取消及旧工具历史恢复。取消后先等原RPC；厂商窗口内明确未发送。腾讯认证/外部推理未验。                                      |
| codewhale       | ACP      | acpAgent:codewhale          | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 手工入口；旧读取/写入记录与未通过shell分别保留，不计为当前完整工具/恢复通过。                                                                                                         |
| cortex-code     | ACP      | acpAgent:cortex-code        | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧end_turn无文件或命令副作用断言，不计工具通过。                                                                                                                 |
| corust-agent    | ACP      | acpAgent:corust-agent       | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧oauth_browser广告与握手不证明账号/模型或工具。                                                                                                                 |
| crow-cli        | ACP      | acpAgent:crow-cli           | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧PyPI启动记录有Windows termios/pty阻断；未在当前提交形成官方工具探针，不使用无关npm同名包作证。                                                                                      |
| cursor          | ACP      | cursor                      | CursorDriver     | [官方CLI探针](../../apps/server/src/provider/acp/CursorAcpCliProbe.test.ts)                                          | 已有专用入口；官方探针主要覆盖握手/模型配置，未覆盖全部文件、命令、拒绝/取消矩阵；共用Adapter合同不补足真实证据。                                                                     |
| deepagents      | ACP      | acpAgent:deepagents         | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧读取与写入空文件的矛盾记录保留；当前仅目录/共用合同，不计写入成功或完整支持。                                                                                                       |
| devin           | ACP      | acpAgent:devin              | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧devin-browser广告不是登录或工具验收。                                                                                                                          |
| dimcode         | ACP      | acpAgent:dimcode            | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧grep读出标记不证明写入/完整工具；当前仅目录/共用合同，完整官方矩阵待验。                                                                                                            |
| dirac           | ACP      | acpAgent:dirac              | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧模型返回虚构路径，无真实读取标记/写盘；当前仅目录/共用合同，不记工具通过。                                                                                                          |
| factory-droid   | ACP      | acpAgent:factory-droid      | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/FactoryDroidAcpCliProbe.test.ts)                                    | 固定公共0.229.0探针验证无认证session/new被拒；专属文档保留本机BYOK同类拒绝/无模型请求的既往实验，未形成工具探针。不记工具通过；MCP默认可覆盖，Airgap非公共开关。                      |
| fast-agent      | ACP      | acpAgent:fast-agent         | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/FastAgentAcpToolProbe.test.ts)                                      | 固定0.10.1本机模型：正文、宿主读写/命令成功及exit7、原审批拒绝/取消、取消后继续及新进程旧工具历史；宿主替身与产品ToolBroker合同分别验证，外部模型/账号/MCP/各端未验。                 |
| gemini          | ACP      | acpAgent:gemini             | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/GeminiAcpToolProbe.test.ts)                                         | 固定0.61.0本机模型：正文、读写、shell、拒绝/取消。广告loadSession仍会覆盖旧历史，当前明确拒绝恢复并保留文件；非零命令带stdout缺结构化码的结果未完全可判。                             |
| gjc             | ACP      | acpAgent:gjc                | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/GajaeAcpToolProbe.test.ts)                                          | 固定0.18.1本机部分检查：连续正文、read、bash允许与审批取消；agent认证不等于模型凭据。既有机器身份/会话未发布失败仍保留，不宣称稳定工具全通过；write/拒绝/恢复待验。                   |
| glm-acp-agent   | ACP      | acpAgent:glm-acp-agent      | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧读写副作用与未通过shell分别保留；当前仅目录/共用合同，不把公开环境参数当凭据或工具成功。                                                                                            |
| goose           | ACP      | acpAgent:goose              | GenericAcpDriver | [官方工具探针](../../apps/server/src/provider/acp/GooseAcpToolProbe.test.ts) / [调用与边界](./goose-acp-provider.md) | 固定1.52.0本机模型：正文/模型/模式、真实读写、shell exit0/7、原拒绝、审批取消/续聊、新进程旧read/shell历史通过；读取通知仅路径无正文、运行中命令取消保留待验；外部账号/各端未验。     |
| grok            | ACP      | grok                        | GrokDriver       | [官方CLI探针](../../apps/server/src/provider/acp/GrokAcpCliProbe.test.ts)                                            | 已有专用入口；握手/模型与可选纯文本live，不执行工具矩阵。xAI取消兜底顺序有Adapter回归；fixture不等于官方模型/工具通过。                                                               |
| hermes          | ACP      | acpAgent:hermes             | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/HermesAcpToolProbe.test.ts)                                         | 固定0.21.5本机两模型：正文、读写、shell成功/exit7、拒绝/取消及新进程旧读取历史；Windows需显式Git Bash。外部账号/各端未由本机检查证明。                                                |
| junie           | ACP      | acpAgent:junie              | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 固定归档维护者哈希有检查；仅证明安装完整性，旧stdio握手不替代当前Runtime/工具复验。                                                                                                   |
| kilo            | ACP      | acpAgent:kilo               | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/KiloAcpToolProbe.test.ts)                                           | 固定7.8.1本机模型：正文、读写、bash成功/exit7、拒绝/取消与下一回合、新进程旧工具历史；标题模型单独判断，不替代聊天模型；Gateway/MCP/各端未验。                                        |
| kiro            | ACP      | acpAgent:kiro               | GenericAcpDriver | [固定版本记录](../../docs/internals/kiro-acp-provider.md)                                                            | 固定2.26.0资产/帮助通过，但本机握手前初始化失败；命令对象/回执/取消/超时为协议fixture结果，真实工具未验；Windows ARM64不可用。                                                        |
| kimi            | ACP      | kimi                        | KimiDriver       | [专用Provider合同](../../apps/server/src/provider/Layers/KimiProvider.test.ts)                                       | 复用已有Kimi驱动与共用ACP合同；当前提交没有本入口专属官方工具探针，未计为完整工具已验。                                                                                               |
| minimax-code    | ACP      | acpAgent:minimax-code       | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；native依赖装好与无auth广告不等于实际工具/审批成功。                                                                                                              |
| minion-code     | ACP      | acpAgent:minion-code        | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧默认依赖ImportError与RPC写stderr记录保留；当前仅目录/共用合同，不改读stderr作协议来冒充可用。                                                                                       |
| mistral-vibe    | ACP      | acpAgent:mistral-vibe       | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/MistralVibeAcpToolProbe.test.ts)                                    | 固定2.25.8且显式legacy harness本机模型：正文、读写、bash成功/exit7、原审批拒绝/取消、旧工具历史恢复；不要求此路径先浏览器登录，不外推默认/其它harness与各端。                         |
| nova            | ACP      | acpAgent:nova               | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 旧kore-cli身份/认证广告与Nova目录名不同；当前仅目录/共用合同，官方工具矩阵待验。                                                                                                      |
| poolside        | ACP      | acpAgent:poolside           | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧平台/握手记录不证明Windows工具或模型，实际目标平台待验。                                                                                                       |
| qoder           | ACP      | acpAgent:qoder              | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧登录/会话记录不替代原生文件、命令、审批与恢复。                                                                                                                |
| qwen-code       | ACP      | acpAgent:qwen-code          | GenericAcpDriver | [官方CLI探针](../../apps/server/src/provider/acp/QwenAcpCliProbe.test.ts)                                            | 固定0.24.7本机模型：认证错误/缺Key、正文、读写、shell exit0、原拒绝/取消与下一回合；新进程load后下一模型请求含旧read/shell的role=tool结果，恢复正文/次数均验；外部账号/MCP/各端未验。 |
| sigit           | ACP      | acpAgent:sigit              | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；旧配置/工具记录未形成当前可复验官方探针，完整矩阵待验。                                                                                                          |
| stakpak         | ACP      | acpAgent:stakpak            | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 当前仅目录/共用合同；分发平台/依赖与实际工具支持分别判断，完整矩阵待验。                                                                                                              |
| traecli         | ACP      | acpAgent:traecli            | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 手工入口及延迟commands通知合同；发现/显示不等于命令执行，官方工具/审批/恢复待验。                                                                                                     |
| vtcode          | ACP      | acpAgent:vtcode             | GenericAcpDriver | [目录/实例合同](../../apps/server/src/provider/acp/AcpRegistryCatalog.test.ts)                                       | 公开环境参数随实例配置；当前仅目录/共用合同，不能据此推断模型/工具已验。                                                                                                              |

18个已提交ACP探针不等于18个基线入口都完成工具验收：Harn两项属于额外目录，不计入44；Cursor/Grok为广告或纯文本探针，Factory为明确认证拒绝，Gajae保留不稳定结果，Qwen旧工具历史断言仅覆盖固定本机模型路径。实际官方CLI加本机受控模型端点的文件/命令检查只证明相应固定版本的动作，不代表外部推理、真实账号余额、MCP/媒体或多端连接。Cline/Hermes/Gemini/Qwen的源探针也可作为证据入口，不依赖尚未提交的专属工作文档。

CodeBuddy和Mistral已有本机自定义模型工具路径；旧“必须先登录才可运行工具”仅描述当时默认配置，不能覆盖当前路径。详见[CodeBuddy](./codebuddy-acp-provider.md)、[Mistral Vibe](./mistral-vibe-acp-provider.md)、[Copilot](./copilot-acp-provider.md)、[Kilo](./kilo-acp-provider.md)、[Factory](./factory-droid-acp-provider.md)和[取消生命周期](./acp-request-lifecycle.md)。未形成当前官方探针的条目仍可配置并复用通用驱动，既往零散通过/阻断是后续复验线索，不是完整支持的结论。

快照来源为 [registry-snapshot.json](../../apps/server/src/provider/acp/registry-snapshot.json)，固定获取日期2026-09-30、原始响应SHA-256为18d781f81a4f57ca45868eb50a60c9b6cb552f83b9aa5f639772231cc460c56e。该快照41项，另由 [manual-agent-catalog.ts](../../apps/server/src/provider/acp/manual-agent-catalog.ts)补5个缺失ID，共46个目录项；在线成功结果以当次响应为准。Grok走专用驱动，不在目录中补一个同ID条目。Cursor/Kimi可从目录配置，但仍保留已有专用入口。

基线映射之外还有ACP目录入口 `antigravity-acp`、`claude-acp`、`codex-acp`、`grok-build`、`harn`、`kimchi`、`opencode`、`pi-acp`；其中opencode与具名驱动同名，是不同接入路径。它们不追加到Paseo的固定44统计。别名只采用明确映射：Paseo copilot → github-copilot-cli；不要按名称合并 grok/grok-build、pi/pi-acp 或具名驱动与社区wrapper。

## 能力与执行状态

| 事实             | 权威输入                                             | 能证明什么                                                          |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 目录、平台与分发 | 当前响应或注明日期的快照，目录解析结果               | 有入口、适用平台、可用安装方式；不能证明已安装或CLI已锁定版本       |
| 实例配置         | 所选环境的settings、command/environment/authMethodId | 保存了可启动配置；不能证明握手或认证成功                            |
| 握手与宿主能力   | initialize响应及实际宿主请求                         | 协议成立与广告的能力；不能证明所有广告能力已执行                    |
| 认证与模型       | authenticate、session/new及真正模型请求              | 各自成功阶段；authMethods为空或authenticate接受不代表账号/模型可用  |
| 模型、模式、命令 | 当前根会话的配置/通知与回执                          | 会话实际广告；空目录可撤回，失败不替换成虚构成功                    |
| MCP              | 实例设置、兼容门禁和实际请求                         | 是否注入及调用结果；Factory Droid默认关闭MCP，不向所有Agent强制注入 |
| 原生工具         | tool_call/update、结果、文件/命令副作用              | CLI执行事实；展示通知不会让宿主再次执行工具                         |
| 宿主工具         | ACP fs/terminal请求、ToolBroker回执、副作用          | 宿主执行或明确失败；仅审批行不是执行成功                            |
| 取消与恢复       | 取消通知、当前回合终态、远端结果、续聊与历史         | 各阶段分别判断；本地cancelled不证明远端撤销，关闭失败仍可见         |
| 用量、费用与余额 | 各自明确的接口/响应                                  | 不从上下文token或费用推导账号余额，未知不显示为零余额               |
| 页面、设备与连接 | 实际入口操作、当前状态及版本、配对/连接记录          | 被测客户端与连接方式；Web不替代Electron/手机，loopback不替代远程    |

共享ACP链路见 [通用ACP](./generic-acp-provider.md)、[会话元数据](./acp-session-metadata.md)、[工具结果](./acp-tool-results.md)和 [请求生命周期](./acp-request-lifecycle.md)。Pi/OMP继续采用 [受管BYOK约束](./pi-family-providers.md)，不能照搬Paseo的凭据策略。Gajae的已知生命周期失败与单次工具结果见 [固定版本边界](./gajae-acp-provider.md)；一次通过不能取消历史不稳定的记录。

每个Agent记录应包含：provider/profile与实例/环境、CLI实际版本、OS/arch、transport、authentication、models/modes、text/reasoning、read/write/exec、approval/question、MCP、cancel/resume、Web/Desktop/Mobile、local/remote、证据与限制。按每个动作记录通过/失败/未验证/上游不支持和理由，再判定该入口的总体状态。读取通过、写入失败时保留两项结果，不写“工具全部可用”；上游不支持也不伪装成适配已完成。

“真实可用”必须注明被测版本、平台、模型端点和通过的动作范围。安装、握手、负向认证、mock或本地模型夹具属于各自证据；本地端点可验证真实CLI和工具副作用，但不证明外部模型推理、真实账号或余额接口。旧通过需要复核是否对应当前提交、同一依赖和原断言；诊断插桩会改变时序，不能替代未插桩原探针。

## 可重复的定向验证

先构造当前提交加精确模块索引的独立源码与数据目录。第三方安装依赖可复用，workspace依赖须指向副本；检查源码/索引字节和实际客户端产物，避免混入其它未提交功能或旧dist。不要写入正在使用的用户数据库，不设VITE_HTTP_URL/VITE_WS_URL，不按名称批量结束进程。

以下命令从仓库根目录执行，按触及范围选择；它们是验证入口，列出命令不代表已经执行或通过。

```powershell
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/acp/AcpRuntimeModel.test.ts apps/server/src/provider/acp/AcpCoreRuntimeEvents.test.ts apps/server/src/provider/acp/AcpRegistryCatalog.test.ts
node node_modules/vite-plus/bin/vp test run apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Layers/CursorAdapter.test.ts apps/server/src/provider/Layers/CursorAdapterToolBroker.e2e.test.ts
node node_modules/vite-plus/bin/vp test run apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.activity.test.ts apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts
node node_modules/vite-plus/bin/vp test run apps/web/src/components/chat/MessagesTimeline.logic.test.ts apps/web/src/components/chat/MessagesTimeline.performance.test.ts apps/mobile/src/lib/threadActivity.test.ts
```

协议传输变更同时检查 packages/effect-acp/src/client.test.ts、protocol.test.ts、agent.test.ts及 apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts；Grok复用ACP时按改动选其Adapter回归。合同改动检查 packages/contracts/src/providerInstance.test.ts及相关schema入口。服务端/Web按各自tsconfig运行tsgo --noEmit，Mobile用tsc --noEmit；lint列实际改动文件，不运行全仓检查。异步等待receipt、barrier或drain，不靠固定睡眠制造通过。文件名含e2e仍需读取实现确认是mock还是真实CLI/服务。

官方CLI探针采用独立配置、显式前置条件和脱敏输出。未提供opt-in条件而跳过不能记为通过；不能为了通过扩大生产超时、伪造上游能力或重发可能产生副作用的模型请求。关键UI路径分别核对设置/聊天/命令入口、退出/重试、审批、实时失败和刷新历史；360px/1280px Web、Electron、手机与本地/远程/tunnel记录各自结果。

## 完成判断与回滚

逐条对照原计划的P0–P5、定向验证方法、风险及固定目录，而非只看勾选数或测试总数。最终独立验证必须覆盖全部要求及其证据范围；历史审计报告、解锁命令或豁免marker不能自行证明用户授权或最终完成。明确的人类范围调整应保存原始消息、适用目标和被调整门槛，不把跳过真实账户验证改写成真实账户已通过，也不把设备豁免外推到其它工作。缺失或矛盾的证据保留未完成，版本/时序变化后的结果重新判断。

保持单一主题提交和明确回滚边界：文档更正可撤回其提交；配置可逐实例停用而保留历史；目录/可选合同保留旧命令兼容；协议及UI按相应提交撤回。停用仅限记录并核对拥有身份的PID，CLI关闭、后台broker回收和目录删除分别判断。记录清理失败，不以清理成功证明原任务执行成功。
