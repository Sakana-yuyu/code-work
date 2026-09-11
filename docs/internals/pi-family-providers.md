# Pi / OhMyPi 供应商（pi-family）

Pi 与 OhMyPi（omp）是同一家族的两个内置供应商：Pi 走 `pi --mode rpc`，OhMyPi 走 `omp --mode rpc-ui`，都用 stdin/stdout 上的 JSONL RPC 与 Code Work 通信。两者都**只有 BYOK 一种形态**：Code Work 在受管 agent 目录里只注册指向本地 BYOK 网关的模型供应商，并清洗子进程环境，CLI 物理上接触不到任何第三方模型凭据。

驱动注册在 `apps/server/src/provider/builtInDrivers.ts`（driver kind `piAgent` / `ompAgent`）。供应商架构总览见 [providers.md](./providers.md)，BYOK 网关本身见 [byok-gateway.md](./byok-gateway.md)。

## 文件地图

| 职责                                          | 文件                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| JSONL RPC 传输（请求/超时/退出哨兵）          | `apps/server/src/provider/pifamily/jsonlRpcProcess.ts`                         |
| 行解码 + OMP v2 chunked 帧重组                | `apps/server/src/provider/pifamily/jsonlFrameDecoder.ts`                       |
| Pi 协议类型（`--mode rpc` v1）                | `apps/server/src/provider/pifamily/piRpcTypes.ts`                              |
| OhMyPi 协议类型（`rpc-ui` + v2 + host tools） | `apps/server/src/provider/pifamily/ompRpcTypes.ts`                             |
| BYOK 受管配置（models.json / 环境清洗）       | `apps/server/src/provider/pifamily/byokProviderConfig.ts`                      |
| 共享生命周期骨架（终态/看门狗/挂起交互）      | `apps/server/src/provider/pifamily/pifamilyAdapterSupport.ts`                  |
| Pi 适配器（事件解析独立）                     | `apps/server/src/provider/Layers/PiAdapter.ts`                                 |
| OhMyPi 适配器（事件解析独立）                 | `apps/server/src/provider/Layers/OmpAdapter.ts`                                |
| 共享快照构建（探照灯/模型列表）               | `apps/server/src/provider/Layers/PifamilyProvider.ts`                          |
| 驱动（受管目录 + 路由 + 文本生成）            | `apps/server/src/provider/Drivers/PifamilyDrivers.ts`                          |
| 设置 schema                                   | `packages/contracts/src/settings.ts`（`PiAgentSettings` / `OmpAgentSettings`） |

## wire 协议：同族格式，两套语义

两家共用一条 wire 格式：客户端写出 `{...command, id}` 单行 JSON；子进程回 `{type:"response", id, success, data, error}`（按 id 关联请求），其余 JSON 帧全部是事件通知。`jsonlRpcProcess.ts` 统一承载：

- 控制面请求默认 30 秒超时（长阻塞 RPC 可显式传 null）；请求挂起期间进程退出统一以 `exited` 失败。
- stderr 只进 8 KiB 环形缓冲，拼进退出诊断，不进事件流。
- 进程退出、stdout 结束都会触发合成的 `{type:"process_exit", error}` 哨兵帧并结束事件流——上层适配器永远拿得到终态信号，崩溃的 CLI 不可能让一轮对话停在 running。
- win32 上 cmd/bat shim 会引入 shell 包装进程，close 默认走 `taskkill /t /f` 树杀；posix 只杀直接子进程。

事件解析在两个适配器里**相互独立**：Pi 与 OMP 的事件语义不同（OMP 有 host tools、审批、子代理、todo/goal/notice 等 Pi 没有的帧），共享解析只会把两边的协议漂移耦在一起。协议允许版本漂移，未识别帧丢弃并计数，不中断会话。

### Pi：协议 v1

单行单帧。终态是 `agent_end` / `agent_settled` 双事件：`agent_end` 携带 `willRetry`，为 true 时（自动重试中）先缓存消息等 `agent_settled` 才终态；否则直接终态。`extension_ui_request` 承载 select/input/confirm 等宿主 UI 请求，映射为用户输入（见下文）。Pi 没有客户端工具执行协议。

### OhMyPi：协议 v2 + chunked 帧 + host tools

OMP 自 17.x 起协商 v2 chunked 传输：就绪时发送 `{type:"ready", supportedProtocolVersions:[1,2], maxFrameBytes:1MiB, maxReassembledFrameBytes:64MiB}`。适配器等 `ready`（10 秒）→ `negotiate_protocol` 确认版本（1 或 2）后才继续。超过 1 MiB 的帧被拆成若干 `rpc_chunk` 帧（base64 载荷，单 chunk 上限 256 KiB），`jsonlFrameDecoder.ts` 按 chunkId 重组：坏帧/坏 chunk 经 `onProblem` 上报并丢弃（截断到 500 字符，仅诊断用），重组超限（64 MiB）整组丢弃，都不中断流。

OMP 相对 Pi 的语义扩展（详见 `ompRpcTypes.ts` 头注释）：

- host tools：客户端 `set_host_tools` 注册工具，omp 发 `host_tool_call` / `host_tool_cancel` 请求客户端执行，客户端回 `host_tool_result` / `host_tool_update`；
- 审批：`--approval-mode yolo|write|always-ask` 管控内置工具，`extension_ui_request` 承载 Approve/Deny 与问答；
- 子代理、todo、goal、notice、auto-retry、auto-compaction 等 Pi 均没有。

## BYOK 构造性强制

这两个供应商不是"可以配置成走 BYOK"，而是"只有 BYOK 一条路"。强制由三层构造保证（`byokProviderConfig.ts` + `PifamilyDrivers.ts`）：

1. **受管 agent 目录**：`resolvePifamilyAgentDir` 派生 `<stateDir>/provider-homes/pi-family/<driverKind>/instance-<id>/agent`，经 `PI_CODING_AGENT_DIR` 传给子进程。注意不用 `PI_CONFIG_DIR`——OMP 把它相对 home 拼接（绝对路径会 join 出垃圾路径），隔离一律走支持绝对路径的 `PI_CODING_AGENT_DIR`。
2. **受管 models.json**：目录里只写一份 `models.json`（原子写 + 0600），把网关注册为唯一模型供应商：
   - `codework-openai`：baseUrl 为 `/byok-gw/openai[/source/<instanceId>]/v1`，`api: "openai-completions"`；
   - `codework-anthropic`：baseUrl 为 `/byok-gw/anthropic[/source/<instanceId>]`，`api: "anthropic-messages"`；
   - `apiKey` 是网关 token（不是真实供应商密钥），只落在这份 0600 的本地文件里，不进 argv、日志或事件；
   - model id 直接用 BYOK adapter id，网关按它路由并替换为上游真实 `modelId`。
     目录里没有 auth.json——CLI 在受管目录下找不到任何第三方登录态。
3. **环境清洗**：`scrubPifamilyEnvironment` 从子进程环境剥掉全部第三方供应商密钥（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GENAI_API_KEY`、`OPENROUTER_API_KEY`、`GROQ_API_KEY`、`MISTRAL_API_KEY`、`XAI_API_KEY`、`DEEPSEEK_API_KEY`、`TOGETHER_API_KEY`、`FIREWORKS_API_KEY`、`GLAMA_API_KEY`、`REQUESTY_API_KEY`、`MOONSHOT_API_KEY`、`ZHIPU_API_KEY`、`DASHSCOPE_API_KEY`），以及会把 CLI 指回用户目录或其它模型角色的 `PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`、`PI_SMOL_MODEL`、`PI_SLOW_MODEL`、`PI_PLAN_MODEL`。否则 CLI 仍可能凭环境变量连上自己的账号，破坏 fail-closed。

实证（2026-09-10，omp 17.4.2）：受管目录下 `get_available_models` 只返回注册的 `codework-*` provider。协议核对依据 pi-mono / Paseo origin/main（2026-09-10）的 RPC 契约。

**fail-closed 路径**：

- BYOK 源没有可用路由时，`startSession` / `sendTurn` 在 `resolvePifamilyModel`（`pifamilyAdapterSupport.ts`）直接校验失败：无路由报 "No BYOK model adapters are routable…"，未知 model 报 "No BYOK adapter is published as model '…'"，不回退、不猜默认。
- 网关侧未知模型返回 404；有 `model` 字段必须匹配同协议通道（见 [byok-gateway.md](./byok-gateway.md) 的路由规则）。
- Gemini 协议通道不经网关（网关既有边界），`pifamilyModelRoutes` 直接排除——Gemini 适配器不会出现在 Pi/OMP 的模型列表里。

**BYOK 源变化 → 重建**：`ProviderInstanceRegistryHydration.ts` 为 pi/omp（`alwaysRouted`）计算 `__byokSourceFingerprint`（所选 BYOK 源的启用状态 + 网关路由的 sha256）。模型、端点、密钥或启用状态变化 → 指纹变化 → 实例配置变化 → Registry 按忙碌实例边界延迟重建，重建时 `PifamilyDrivers.ts` 重写 models.json。摘要只进内存不进持久设置，driver 解码时剥离该字段。

**文本生成**：提交信息等辅助生成不走子进程，`PifamilyDrivers.ts` 直接用 BYOK 源实例的设置构造 `makeByokTextGeneration`——同一模型、同一路由。

**快照**：`PifamilyProvider.ts` 上报的模型列表即网关路由（openai + anthropic），auth 固定 `byok`（标签 `BYOK Gateway`）。探照灯不受启停影响：禁用只改状态文案，CLI 缺失必须如实上报"未找到"。

## 工具通道：Pi 走宿主 MCP，OMP 走 host tools 桥

### Pi：宿主 MCP 通道（与其它 CLI 一致）

Pi 没有客户端工具执行协议。Code Work 工具经现有宿主 MCP 通道注入：`PiAdapter.ts` 把 code-work MCP server 写进临时 `--mcp-config` 文件（`mcpServers` 映射 + auth/oauth 关闭，与 `~/.pi/agent/mcp.json` 同构），与 Claude/Codex/Cursor/Grok/OpenCode 的注入方式一致。pi 原生工具只做可见性映射（`tool_execution_start/update/end` → `item.*`，bash/shell → `command_execution`，edit/write/apply_patch → `file_change`），可用 `launchArgs` 限制，例如 `--tools read,grep`。

### OhMyPi：host tools 经 ToolBroker

OMP 的 `set_host_tools` 允许客户端注册宿主工具，这是 Code Work canonical 工具面的接入点（`OmpAdapter.ts`）：

- 注册的工具是 `workspace.read_file`、`workspace.write_file`、`terminal.exec`、`terminal.snapshot`、`terminal.kill`、`terminal.close`（`loadMode: "essential"`），经 `capabilities.toolBrokerCanonicalTools` 声明，ToolBroker 绑定后（`configureToolBroker`）发送 `set_host_tools`。
- omp 发起 `host_tool_call` 时经 ToolBroker bridge `invoke`（toolCallId 前缀 `omp-host-`，幂等键 `${runId}:omp-host-${toolCallId}`）执行；`host_tool_cancel` 映射 bridge `cancel`。
- 全部状态都映射回 agent 可见的工具结果：成功 → `host_tool_result`（content 为结果 JSON）；拒绝（denied）、取消（cancelled）、失败（failed）→ `isError: true` + 明确原因文本。桥未绑定就被调用也回 isError 结果，不会让 agent 挂起。
- ToolBroker 的能力握手、授权（grant）与策略链由 composition 层统一裁决，OMP 适配器只做协议翻译（见 [providers.md](./providers.md) 的 ProviderAdapter 契约）。

## 审批与用户输入

### OhMyPi 内置工具审批

OMP 自己的内置工具（bash/edit/write 等）由 `--approval-mode` 管控，启动时按 `ompApprovalModeForRuntime`（`OmpAdapter.ts`）从 Code Work 运行模式映射：

| Code Work 运行模式           | `--approval-mode` |
| ---------------------------- | ----------------- |
| `approval-required`          | `always-ask`      |
| `auto-accept-edits` / `auto` | `write`           |
| `full-access`                | `yolo`            |

实例设置 `approvalMode`（`auto` | `always-ask` | `write` | `yolo`）非 `auto` 时直接覆盖映射。审批请求到达时是 `extension_ui_request`（标题形如 `Allow tool: X`，选项 Approve/Deny）→ 映射 `request.opened`（requestType 按工具名映射 command/file/dynamic）→ 用户经现有审批 UI（`thread.approval.respond`）决策：accept 系回 `value: "Approve"`，decline/cancel 回 `cancelled: true`，随后发 `request.resolved`。

非审批形状的 `extension_ui_request`（问答、select 等）映射 `user-input.requested`，回答经 `respondToUserInput` 以 `extension_ui_response` 回传，随后发 `user-input.resolved`。

### Pi 用户输入

Pi 的 `extension_ui_request` 全部按用户输入处理（`user-input.requested` / `user-input.resolved`）。Pi RPC 模式没有工具审批协议，`respondToRequest` 恒返回校验错误。

## 事件映射与终态保证

原始帧在 `ProviderRuntimeEvent.raw` 中的来源标识为 `pi.rpc` / `omp.rpc`（`packages/contracts/src/providerRuntime.ts` 的 raw-source 联合）。两家的公共映射：

| pi-family 事件                                      | ProviderRuntimeEvent                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `message_update` 的 `text_delta` / `thinking_delta` | `content.delta`（`assistant_text` / `reasoning_text`）                           |
| `message_end`（user/custom）                        | `item.completed`（`user_message`）                                               |
| `tool_execution_start` / `update` / `end`           | `item.started` / `item.updated` / `item.completed`（含 isError → failed）        |
| `compaction_*`                                      | `item.completed`（`context_compaction`）                                         |
| `auto_retry_start`                                  | `runtime.warning`                                                                |
| `agent_start` / `turn_start`                        | 标记 turn 已开始（不发独立事件）                                                 |
| `process_exit`（合成哨兵）                          | 结算交互 + `turn.completed{state:"failed"}` + `session.exited{exitKind:"error"}` |

OMP 独有映射：`subagent_lifecycle` / `subagent_progress` → `task.started` / `task.progress` / `task.completed`（`taskType: "provider_subagent"`）；`todo_reminder` → plan item；`notice` error 级 → `runtime.warning`，其余 → unknown item；`goal_updated` → unknown item；`auto_compaction_*` → `context_compaction` item。

**终态保证**（`pifamilyAdapterSupport.ts`，两家共用）：任何路径最终都收敛到 `completeTurn` / `failTurn` / `abortTurn` 之一，`turn.settled` 布尔防止 `agent_settled` / `process_exit` / abort 双发终态事件：

- `agent_end`（Pi 的 `willRetry` 场景等 `agent_settled`）→ 从缓存的 pendingSettledMessages 里找最后一条 assistant 的 `errorMessage` 决定 `completed` 还是 `failed`；
- `abort` / `thread.turn.interrupt` → `turn.aborted`（Pi 先 `clear_queue` 再 `abort`，旧版 pi 没有 `clear_queue` 时容错）；
- 进程退出 → `process_exit` 哨兵 → failTurn + `session.exited`；
- 看门狗：`PIFAMILY_TURN_INACTIVITY_TIMEOUT_MS`（5 分钟）无内容/工具进展强制 `runtime.error` + failTurn；**挂起审批或用户输入时暂停计时**（15 秒轮询），等待用户不会被判死；
- `prompt` 的 ack 返回 `agentInvoked: false`（斜杠命令等不经 agent 的输入）→ 立即终态；
- `stopSession` → 结算挂起交互（approval → `cancel`，user-input → 空）→ abortTurn → 关进程 → `session.exited{exitKind:"graceful"}`。

## 设置参考

`packages/contracts/src/settings.ts`：

| 字段                   | Pi   | OhMyPi         | 说明                                                        |
| ---------------------- | ---- | -------------- | ----------------------------------------------------------- |
| `binaryPath`           | `pi` | `omp`          | CLI 路径；`--version` 探测安装与版本                        |
| `launchArgs`           | 可选 | 可选           | 追加启动参数（按引号语义拆分）。Pi 例：`--tools read,grep`  |
| `approvalMode`         | —    | `auto`（默认） | `auto` 按运行模式映射；`always-ask`/`write`/`yolo` 固定覆盖 |
| `byokSourceInstanceId` | 隐藏 | 隐藏           | BYOK 源实例；缺省 `byok`（默认实例）                        |
| `customModels`         | 隐藏 | 隐藏           | 未使用，保留实例配置形状                                    |

其余行为：模型切换是会话内的（`capabilities.sessionModelSwitch: "in-session"`，`set_model`）；resume 游标是 CLI 的 session 文件路径（`piSessionFile` / `ompSessionFile`）；图片附件支持 png/jpeg/webp/gif（base64 进 prompt）；不支持会话回滚（`rollbackThread` 恒失败，不声明 `threadRollback`）。

## 测试现状

`apps/server/src/provider/pifamily/` 下共 42 个测试（+1 个环境门控真机测试），配套 mock agent 脚本 `apps/server/scripts/pi-mock-agent.mjs` / `omp-mock-agent.mjs`（`MOCK_PI_*` / `MOCK_OMP_*` 环境变量切换场景）：

- `jsonlFrameDecoder.test.ts`（16）：行缓冲、CRLF、v2 chunk 重组（乱序/交错/超限/坏 base64/长度不符）、`supportsJsonlRpcProtocolV2`。
- `byokProviderConfig.test.ts`（9）：受管目录形状、环境清洗键集、模型路由（gemini 排除）、models.json 的 provider 拆分与 token 落盘、原子写。
- `PiAdapter.test.ts`（8，真实子进程）：事件顺序 + 每个事件过 `Schema.is(ProviderRuntimeEvent)`、interrupt、进程退出 failover、模型错误、fail-closed（未知模型/空路由）、stall+stopSession、user-input 回环。
- `OmpAdapter.test.ts`（7，真实子进程）：v2 协商（argv 与 `negotiate_protocol` 均经 mock 命令日志断言）、ToolBroker host-tool 闭环（invoke 参数/幂等键/六个 canonical 工具）、denied 工具、审批 accept/decline、interrupt、子代理 task 事件。
- `PifamilyByokRouting.e2e.test.ts`（2，核心验收）：mock agent → **真实网关路由层**（挂真实 TCP 端口）→ fake upstream。证明模型改写（adapter id → 真实 modelId）、鉴权替换（网关 token → 上游密钥）、token 不出现在上游请求与任何序列化事件中；未知 adapter → 网关 404 → 回合落到 failed 终态且上游零调用。
- `OmpReal.e2e.test.ts`（1，`PI_FAMILY_REAL_E2E=1` + 本机 omp 才跑）：真机 17.4.2 验证 v2 协商、受管目录凭据隔离（`get_available_models` 只见受管 provider）、经 fake upstream 的完整回合。

相邻既有覆盖：网关路由/鉴权（`byok/modelGateway.test.ts`）、指纹重建（`ProviderInstanceRegistryHydration.test.ts`）。已知留白：看门狗无 e2e（适配器未暴露超时参数，`PiAdapter.test.ts` 头部有说明，stall+stopSession 覆盖同一终态收敛路径）。
