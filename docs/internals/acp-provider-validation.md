# Agent 入口与验收合同

本页说明 Code Work 的入口绑定、能力事实来源和可重复验证方法。入口覆盖、安装、握手、认证、文本、工具执行及客户端显示分别取证；任何一项成功都不能替代其它项。核对日期为 2026-10-01，Code Work 源码基线为 912195c75fcc36197d56bdfea80b0c7b43c75b4e。

## 固定范围与入口绑定

Paseo 固定提交 [23c4404b 的内置定义](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/protocol/src/provider-manifest.ts)有6项，[同提交的 ACP 目录](https://github.com/getpaseo/paseo/blob/23c4404b955fbc1a6904b7140f911d9f29de1f27/packages/app/src/data/acp-provider-catalog.ts)有38项，ID无重叠，共44个预定义入口。OMP在Paseo默认关闭，开发mock不计入。采用注册数组及目录数据，因为它们决定实际入口；检索词为 AGENT_PROVIDER_DEFINITIONS、CATALOG_DATA、BUILT_IN_DRIVERS、MANUAL_AGENTS。此固定范围不随官方目录增减而改写，也不表示44个官方CLI已完成运行验收。

Code Work 的 [BUILT_IN_DRIVERS](../../apps/server/src/provider/builtInDrivers.ts)有12项，包括10个具名运行时、通用ACP及BYOK。下表的“内置”是Paseo的分组；Copilot在Code Work通过通用ACP实例接入，不增加同名专用驱动。冒号后的ID是目录选择来源，保存的实际实例ID由用户命名，不能用目录ID替代 providerInstanceId。

| Paseo ID        | 固定分组 | Code Work 入口              | 承载驱动         |
| --------------- | -------- | --------------------------- | ---------------- |
| claude          | 内置     | claudeAgent                 | ClaudeDriver     |
| codex           | 内置     | codex                       | CodexDriver      |
| copilot         | 内置     | acpAgent:github-copilot-cli | GenericAcpDriver |
| opencode        | 内置     | opencode                    | OpenCodeDriver   |
| pi              | 内置     | piAgent                     | PiDriver         |
| omp             | 内置     | ompAgent                    | OmpDriver        |
| agoragentic-acp | ACP      | acpAgent:agoragentic-acp    | GenericAcpDriver |
| amp-acp         | ACP      | acpAgent:amp-acp            | GenericAcpDriver |
| auggie          | ACP      | acpAgent:auggie             | GenericAcpDriver |
| autohand        | ACP      | acpAgent:autohand           | GenericAcpDriver |
| cline           | ACP      | acpAgent:cline              | GenericAcpDriver |
| codebuddy-code  | ACP      | acpAgent:codebuddy-code     | GenericAcpDriver |
| codewhale       | ACP      | acpAgent:codewhale          | GenericAcpDriver |
| cortex-code     | ACP      | acpAgent:cortex-code        | GenericAcpDriver |
| corust-agent    | ACP      | acpAgent:corust-agent       | GenericAcpDriver |
| crow-cli        | ACP      | acpAgent:crow-cli           | GenericAcpDriver |
| cursor          | ACP      | cursor                      | CursorDriver     |
| deepagents      | ACP      | acpAgent:deepagents         | GenericAcpDriver |
| devin           | ACP      | acpAgent:devin              | GenericAcpDriver |
| dimcode         | ACP      | acpAgent:dimcode            | GenericAcpDriver |
| dirac           | ACP      | acpAgent:dirac              | GenericAcpDriver |
| factory-droid   | ACP      | acpAgent:factory-droid      | GenericAcpDriver |
| fast-agent      | ACP      | acpAgent:fast-agent         | GenericAcpDriver |
| gemini          | ACP      | acpAgent:gemini             | GenericAcpDriver |
| gjc             | ACP      | acpAgent:gjc                | GenericAcpDriver |
| glm-acp-agent   | ACP      | acpAgent:glm-acp-agent      | GenericAcpDriver |
| goose           | ACP      | acpAgent:goose              | GenericAcpDriver |
| grok            | ACP      | grok                        | GrokDriver       |
| hermes          | ACP      | acpAgent:hermes             | GenericAcpDriver |
| junie           | ACP      | acpAgent:junie              | GenericAcpDriver |
| kilo            | ACP      | acpAgent:kilo               | GenericAcpDriver |
| kiro            | ACP      | acpAgent:kiro               | GenericAcpDriver |
| kimi            | ACP      | kimi                        | KimiDriver       |
| minimax-code    | ACP      | acpAgent:minimax-code       | GenericAcpDriver |
| minion-code     | ACP      | acpAgent:minion-code        | GenericAcpDriver |
| mistral-vibe    | ACP      | acpAgent:mistral-vibe       | GenericAcpDriver |
| nova            | ACP      | acpAgent:nova               | GenericAcpDriver |
| poolside        | ACP      | acpAgent:poolside           | GenericAcpDriver |
| qoder           | ACP      | acpAgent:qoder              | GenericAcpDriver |
| qwen-code       | ACP      | acpAgent:qwen-code          | GenericAcpDriver |
| sigit           | ACP      | acpAgent:sigit              | GenericAcpDriver |
| stakpak         | ACP      | acpAgent:stakpak            | GenericAcpDriver |
| traecli         | ACP      | acpAgent:traecli            | GenericAcpDriver |
| vtcode          | ACP      | acpAgent:vtcode             | GenericAcpDriver |

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
