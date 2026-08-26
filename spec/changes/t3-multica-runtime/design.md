# T3 统一 Runtime Adapter 与 Multica 协同设计

## 目标

在不把 Multica 的数据库、页面或内部任务模型嵌入 T3 的前提下，让 T3 统一管理 Provider、CLI、IDE 和 Multica runtime。T3 保留任务、运行、事件、授权和能力控制面；外部 runtime 只负责执行，并通过 Adapter 回传可幂等归属的事件。

本设计覆盖服务端适配层、Composition Driver 接入、Multica daemon 协议边界，以及 Web/Desktop/Mobile 后续消费的稳定接口。真实 Multica daemon、真实 IDE 和多端 E2E 不在本设计阶段宣称完成。

## 现状依据

- `apps/server/src/composition/CompositionOrchestrator.ts` 已定义 Composition Task/Run 派发和取消，但 Driver 只有启动、取消和运行时事件归属能力。
- `apps/server/src/composition/CompositionProbeRegistry.ts` 已定义 runtime、IDE、Multica 的探测结果，但尚未由统一 Adapter 提供探测和生命周期操作。
- `apps/server/src/composition/CompositionProviderAgentDriver.ts` 已将 T3 Provider Session/Turn 映射为 Composition Agent Driver。
- `packages/contracts/src/compositionRuntime.ts` 已定义 runtime probe、IDE profile、Multica probe 和事件信封合同。
- `packages/contracts/src/providerRuntime.ts` 已定义 T3 统一 `ProviderRuntimeEvent`，Composition Task Runtime Projector 已能将 Provider 事件投影到 Task。
- Multica 官方 daemon 采用注册、心跳、任务派发/进度/完成和 WebSocket 控制连接；HTTP claim/heartbeat 仍是正确性路径，WebSocket 主要用于控制、唤醒和 RPC。

## 架构

```text
Web / Desktop / Mobile
          |
          v
T3 Composition RPC + Capability Policy
          |
          v
Composition Orchestrator + Task/Run/Event Store
          |
          v
Composition Agent Driver Registry
          |
          +--> Provider Agent Driver --> T3 ProviderService --> Codex/Claude/OpenCode/Byok/ACP
          |
          +--> Multica Agent Driver --> Multica Runtime Adapter --> HTTP + WebSocket daemon protocol
          |
          +--> IDE Agent Driver ------> IDE Adapter handshake + T3 Tool Broker
          |
          +--> CLI/other Runtime Adapter
                                  |
                                  v
                         ProviderRuntimeEvent / CompositionEventEnvelope
                                  |
                                  v
                         Composition Task Runtime Projector
```

Adapter 不直接写 Composition 数据库。所有状态变更通过 Driver、事件投影器和持久化 Store 完成，避免外部协议的重试把 T3 状态写坏。

当 `CompositionTaskDispatchRequest.assigneeKind` 为 `squad` 时，`assigneeId` 是持久化的 `CompositionSquad.squadId`；Orchestrator 读取该 Squad 的 `leaderAgentId`，使用 Leader 对应的 Agent Driver 执行，Task 仍保留 Squad 归属，Run 记录实际 Leader Agent。Leader 不存在时拒绝派发，不把 Squad ID 猜测成普通 Agent ID。

## Interfaces

### Canonical Tool Plane

Composition 的工具入口采用“描述符 + 执行器”注册模型。`ToolBroker` 只负责统一的幂等、取消、Capability Policy、Grant 校验、审批、审计、结果去敏和错误归一化；具体工具通过注册的 handler 访问现有 T3 服务。这样 Provider、BYOK、ACP、CLI、IDE 和 Multica 不需要分别实现文件、终端、Git 或 MCP 的安全边界。

第一批 canonical tool 只开放已经存在且边界明确的能力：

| 工具                   | 底层服务              | 操作    | 说明                               |
| ---------------------- | --------------------- | ------- | ---------------------------------- |
| `workspace.read_file`  | `WorkspaceFileSystem` | read    | 读取受信任 workspaceRoot 下的文件  |
| `workspace.write_file` | `WorkspaceFileSystem` | mutate  | 写文件，默认需要审批               |
| `terminal.open`        | `TerminalManager`     | execute | 打开或复用 task 绑定的受控终端会话 |
| `terminal.write`       | `TerminalManager`     | execute | 向已打开的会话写入有限长度输入     |
| `git.status`           | `GitVcsDriver`        | read    | 获取当前 workspace 的 Git 状态     |
| `git.diff`             | `GitVcsDriver`        | read    | 获取受限大小的工作区差异预览       |

工具 handler 必须声明 canonical 参数 Schema、Capability ID、操作类型和结果大小上限。外部 Runtime 提供的 `cwd` 只能与持久化的 task workspaceRoot 相等；终端 `threadId/terminalId` 必须绑定到 task，Git 只允许在该 workspaceRoot 上执行。未注册工具、参数不合法、作用域不匹配或缺少 grant 时返回 canonical denied/failed result，不把底层异常直接泄漏给外部 Runtime。

```text
Provider / BYOK / ACP / CLI / IDE / Multica
                    |
                    v
       Runtime Tool-call WS RPC
                    |
                    v
             CompositionRuntimeToolBridge
                    |
                    v
                 ToolBroker
          (idempotency + policy + audit)
                    |
       +------------+-------------+
       |            |             |
 WorkspaceFileSystem  TerminalManager  GitVcsDriver
```

注册层先在服务端闭环；前端只消费 capability descriptor，不复制工具执行逻辑。后续 MCP、Browser、Cursor/VSCode IDE API 和 Provider API 继续按同一合同接入，不能绕过 `ToolBroker` 直接执行。

### CompositionRuntimeAdapter

每个外部 runtime 实现以下能力：

```ts
interface CompositionRuntimeAdapter {
  readonly runtimeId: string;
  readonly driverKind: "acp" | "cli" | "ide" | "multica";
  readonly probe: () => Effect.Effect<
    CompositionRuntimeProbeResult,
    CompositionRuntimeAdapterFailure
  >;
  readonly listAgents: () => Effect.Effect<
    ReadonlyArray<CompositionRuntimeAgent>,
    CompositionRuntimeAdapterFailure
  >;
  readonly heartbeat: () => Effect.Effect<
    CompositionRuntimeHeartbeat,
    CompositionRuntimeAdapterFailure
  >;
  readonly dispatchTask: (
    input: CompositionRuntimeTaskInput,
  ) => Effect.Effect<CompositionRuntimeTaskResult, CompositionRuntimeAdapterFailure>;
  readonly cancelTask: (
    input: CompositionRuntimeTaskRef,
  ) => Effect.Effect<CompositionRuntimeCancelResult, CompositionRuntimeAdapterFailure>;
  readonly resumeTask: (
    input: CompositionRuntimeTaskRef,
  ) => Effect.Effect<CompositionRuntimeTaskResult, CompositionRuntimeAdapterFailure>;
  readonly streamEvents: (
    input?: CompositionRuntimeEventFilter,
  ) => Stream.Stream<ProviderRuntimeEvent, CompositionRuntimeAdapterFailure>;
}
```

合同要求：

- `runtimeId`、`agentId`、`taskId`、`runId`、`runtimeTaskId` 都必须稳定且非空。
- `dispatchTask` 必须支持幂等键；重复派发同一 `runId` 只能返回原运行或明确的冲突错误。
- `cancelTask` 必须返回 `cancelled`、`cancel_requested` 或 `already_terminal`，不能把取消请求伪装成终态完成。
- `resumeTask` 只能恢复外部 runtime 明确支持恢复的任务；不支持恢复时返回稳定错误码。
- `streamEvents` 的每个事件必须有稳定 `eventId`；投影器按 `(taskId, runId, sourceEventId)` 去重。
- Adapter 不获得 T3 工具的隐式权限；文件、终端、Git、MCP、浏览器和 IDE 操作仍通过 Capability Registry/Tool Broker 授权。
- `capabilityGrantIds` 是 T3 内部的 task-scoped 授权引用，不等于外部 runtime 已完成授权握手。Adapter 只有在外部协议明确支持并完成校验后，才可以声称 grant 已注入；否则必须保留明确的未支持边界。
- 带 grant 的 Runtime dispatch 必须先完成 `CompositionRuntimeCapabilityHandshake`，并把返回的 `handshakeId` 带入派发；握手状态为 `unsupported` 或 `rejected` 时不得创建外部任务。

### MulticaAdapter

Multica 适配器使用 daemon 的 HTTP 注册/心跳/任务控制路径和 WebSocket 控制路径。WebSocket 断开时，Adapter 必须退回 HTTP 探测和心跳；重连后只能补发幂等控制，不得重复创建 T3 Run。

任务创建使用 Multica 官方的 `POST /api/issues/quick-create`，而不是把 daemon 的 claim 接口当作 dispatch：

```text
T3 Agent/Squad 映射
    -> X-Workspace-ID + agent_id/squad_id + prompt
    -> Multica quick-create
    -> queued task_id
    -> daemon claim
    -> start/progress/complete/fail
```

Adapter 配置必须显式提供以下映射：

```ts
type MulticaTaskAssigneeRoute = {
  readonly t3AgentId: string;
  readonly workspaceId: string;
  readonly multicaAgentId?: string;
  readonly multicaSquadId?: string;
};
```

每一条 route 只能指定一个远端归属。缺少映射时 dispatch 失败，不根据名称、前缀或本地 ID 猜测 Multica UUID。T3 的 Squad 可以通过一个以 Squad ID 为稳定 Driver key 的 route 映射到 `multicaSquadId`；后续若要支持动态 Squad 列表，应把列表同步和 route 持久化作为独立节点。

quick-create 的返回值只保证返回异步队列 `task_id`。当前官方接口没有与 T3 `runId` 等价的幂等键，因此 Adapter 只在进程内按 `idempotencyKey` 复用已接受结果；网络请求成功但响应丢失后重启仍可能产生重复创建，不能宣称跨进程 exactly-once。生产级自动重试需要后续的持久化 outbox、服务端幂等能力或冲突校验。

Multica runtime 映射为：

- `runtimeId`: `multica:<daemonId>:<runtimeId>`。
- `agentId`: `multica:<daemonId>:<agentId>` 或 runtime profile 的稳定 ID。
- `runtimeTaskId`: Multica 返回或事件中的 task ID。
- `CompositionMulticaProbeResult`: 由 daemon 版本、capability、Squad/Leader/Task Graph 能力组成。

Task 事件映射：

| Multica 事件            | T3 ProviderRuntimeEvent                     | Composition 状态                         |
| ----------------------- | ------------------------------------------- | ---------------------------------------- |
| `daemon:task_available` | `task.updated`                              | 不直接改变终态，只触发重新探测/拉取      |
| `task:dispatch`         | `task.started`                              | `running`                                |
| `task:progress`         | `task.progress`                             | `progress`                               |
| `task:completed`        | `task.completed` 或 `turn.completed`        | `completed`                              |
| `task:failed`           | `runtime.error` 或 `turn.completed`(failed) | `failed`                                 |
| daemon 断线/恢复        | `runtime.warning`                           | 保留运行状态，直到心跳超时或终态事件确认 |

不能从“收到派发”推断任务完成，也不能把 WebSocket 唤醒帧当成任务事实；任务事实必须来自 HTTP claim/状态或带稳定事件 ID 的事件。

## 生命周期与幂等

1. T3 派发 Task，Orchestrator 创建 Task/Run，并调用 Driver。
2. Driver 先向 Runtime/Provider 请求 capability handshake；只有收到 accepted 的 `handshakeId`，才将完整 prompt、workspaceRoot、grant 引用和 handshake ID 交给 Adapter。Provider 原生协议和 Multica 窄协议尚未支持时，带 grant 的任务会稳定拒绝，不会静默降级到 full-access。
3. Adapter 返回 `runtimeTaskId` 和可选 `capabilityHandshakeId` 后，T3 保存 Run 关联；握手 ID 通过 046 迁移持久化。
4. Adapter 心跳和事件流持续回传；Projection Service 做状态机校验、事件去重和终态收口，并在首次进入终态时调用 Driver 撤销 handshake 与 grant。
5. 取消先调用 Adapter；只有 Adapter 明确接受或已终态时，T3 才写入对应状态。取消落地时同样撤销握手与 grant；网络错误保留 `cancel_requested` 语义，交由后续心跳/事件收口。
6. 进程重启后，Adapter 通过持久化的 `runtimeTaskId`、`capabilityHandshakeId` 和 Run 记录恢复订阅或执行清理；不能依赖进程内 Map 作为唯一事实源。

对于 Multica quick-create，步骤 2 的 `runtimeTaskId` 是远端返回的队列 `task_id`。由于当前 quick-create 接口缺少服务端幂等键，T3 必须把 HTTP 成功后的关联持久化视为恢复边界；transport timeout 不能自动重试创建请求，只能进入未知结果并等待人工/服务端查询确认。

## 能力与安全边界

- 未完成 runtime/IDE handshake 时只允许 probe、list 和只读状态查询。
- 未知 IDE profile 直接拒绝高权限操作，不通过“兼容模式”绕过。
- task-scoped grant 绑定 `taskId`、`runId`、`workspaceRootDigest` 和过期时间；外部 runtime 不可复用其他 Task 的 grant。
- BYOK Agent Loop 为兼容旧 capability ID 临时签发的 grant 只在本次 Loop 内使用，Loop 成功、失败或超限退出时都必须撤销；调用方预先传入的 `grant-*` 不由该服务代为撤销。
- Provider Driver 已支持 handshake 合同；当前投影的 ProviderService 适配器尚未提供握手实现，因此带 grant 的 Provider 任务会拒绝，待 Provider 原生工具或 canonical ToolBroker 桥接完成后再开放。
- Multica Adapter 已暴露稳定的 unsupported 握手结果；官方 quick-create 请求不携带 grant，真实 daemon 也尚未校验 T3 grant，因此带 grant 的 Multica 任务会拒绝。
- Adapter 日志只记录 ID、状态、版本和去敏后的错误，不记录完整 prompt、API key、用户凭据或敏感文件内容。
- 所有跨进程事件使用 sourceEventId；重复、乱序和断线重放必须是无害的。

## 错误处理

统一错误码至少包括：`runtime_offline`、`runtime_unstable`、`capability_missing`、`task_conflict`、`task_not_found`、`cancel_not_supported`、`resume_not_supported`、`transport_timeout`、`protocol_invalid`、`authorization_denied`。

Transport 错误不得直接把运行标成成功；心跳超时只允许标记 runtime 不稳定并触发恢复/重试策略。只有外部终态事实或明确的本地失败才写入 Task 终态。

## 验证

- Adapter 合同：探测、Agent 列表、心跳、派发幂等、取消、恢复能力和事件流。
- 状态机：重复派发、重复事件、乱序事件、取消竞态、终态后晚到事件。
- Multica 协议：HTTP fallback、WebSocket 断开/重连、heartbeat、task ID 关联，以及当前未支持 capability handshake 时的明确降级。
- 集成边界：Provider Driver 继续通过现有 ProviderService；Multica Driver 不绕过 Capability Registry/Tool Broker。
- 真实 daemon、真实 IDE、Web/Desktop/Mobile 多端刷新需另行进行本机 E2E；静态测试和假适配器通过不能替代这些验证。

## 未纳入本节点

- 不复制 Multica 的数据库、Web UI、账号体系或任务看板。
- 不直接启动或托管用户本机 CLI 进程；CLI 由现有 Provider/Multica daemon runtime 负责。
- 不在本节点声称 cursor-byok 的所有功能已经完成迁移；差异报告和迁移仍按能力域逐项推进。

## 迁移差异矩阵（2026-08-25）

本节以当前工作树 `E:\MyProject\code-work\t3code`、对照仓库
`E:\MyProject\cursor-byok` 和 Multica 只读提交 `8442504201b302cfd6c40c7b8eb8a508bf254d0b`
的源码、测试和设计文档为依据。这里的“已具备”只表示 T3 有可调用的实现和定向测试，
不表示已经完成 Web/Desktop/Mobile 和真实外部 Runtime 的端到端验收。

| 能力域                     | cursor-byok 现状证据                                                                                           | T3 当前状态                                                                                                                                                                                                     | 结论                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 多协议 BYOK 请求           | `internal/backend/agent/model/openai_*.go`、`anthropic.go`、`gemini.go`，包含工具参数校验和流式适配            | `byokChatClient.ts` 已支持 OpenAI/Anthropic/Gemini；`99dcc534` 已让 Agent Loop 和 Driver 协议无关                                                                                                               | 已迁移第一阶段                        |
| 统一 Agent Loop            | cursor-byok 的 provider/worker 以协议适配器承接工具调用                                                        | `ByokAgentLoop` + `ToolBroker` 已实现工具调用、幂等、结果回放、临时 grant 撤销                                                                                                                                  | 已具备，仍需真实模型 E2E              |
| Composition canonical 工具 | `internal/backend/agent/bridge/exec/exec_open_fs.go`、`exec_open_shell.go`、`exec_open_git.go`                 | `CompositionToolRegistry` + `ToolBroker` 已注册 11 个 canonical 工具，并经 Policy/Grant/Approval/Audit                                                                                                          | 已迁移第一批                          |
| MCP                        | cursor-byok 有 `mcp_registry.go`、`mcp_runtime.go`、MCP trust 和动态工具目录                                   | T3 有独立 `/mcp` Preview Toolkit 和 `McpSessionRegistry`，但 Composition ToolBroker 尚未把任意 MCP server/tool 统一纳入 canonical tool                                                                          | 部分迁移                              |
| Browser/Computer Use       | `internal/computeruse`、`computeruse_bridge.go`、IDE browser MCP                                               | T3 只有 Preview/BrowserTrace 等相邻能力，尚未提供 Composition canonical browser/computer tool                                                                                                                   | 未迁移                                |
| Cursor/VSCode IDE API      | cursor-byok 通过 Cursor 本地协议、MCP 和 Windows computer-use 访问 IDE/浏览器边界                              | T3 已有 `CompositionIdeSessionRegistry`、profile probe、task/run/agent 绑定的 handshake lease、probe allowlist 和 `ide.invoke` ToolBroker 入口；真实 Cursor/VSCode Adapter、transport 和 IDE operation 仍未接入 | 可信执行门已迁移，真实 Adapter 未迁移 |
| Cursor 原生协议代理        | `internal/mitm`、`internal/backend/agent/protocol`、`RunSSE`/`BidiAppend` 相关 forwarder 和 protobuf           | T3 没有 Cursor MITM、原生 Bidi/RunSSE 转发器，也不修改已安装 Cursor bundle                                                                                                                                      | 未迁移；属于独立 Runtime Driver       |
| 官方请求镜像与对比         | `internal/mitm/mirror.go`、`official.raw.jsonl`、`requestlab` 及 `request-comparison-lab` 设计                 | T3 有 Provider/Runtime 事件和 Trace，但没有官方请求镜像记录、exchangeId 对比实验台                                                                                                                              | 未迁移                                |
| 监督式委派                 | `internal/backend/forwarder/supervisor_coordinator.go`、`supervisor_provider.go`、`delegation_multitask.go`    | T3 已有 review 模式 checkpoint、`in_review` 投影和 approve/reject RPC；retry/reassign/escalate/circuit breaker 与 sibling failure isolation 仍未接入                                                            | 部分迁移                              |
| Worker Context Compaction  | `delegation_compaction.go`、`context_overflow.go`、tool result snip 和保留最近轮次规则                         | T3 BYOK Loop 目前只累积消息，没有 worker 预算、工具结果裁剪和 context overflow 自救                                                                                                                             | 未迁移                                |
| Delegate 运行时            | cursor-byok 有 Claude/Codex/Cursor/Gemini/Kiro/custom executor registry、failover、slot/loop limiter           | T3 Provider Driver、ACP/CLI/Multica Runtime Adapter 已有；统一 driver SPI 已具备，但 cursor-byok executor 具体语义尚未逐项迁移                                                                                  | 部分迁移                              |
| 供应商目录/模型发现        | cursor-byok 有 supplier catalog、候选 URL、custom headers、模型目录缓存、协议过滤和 pricing                    | T3 有 BYOK adapter/import/balance/discovery 服务，但尚未达到 cursor-byok 的供应商目录管理和多端页面等价                                                                                                         | 部分迁移                              |
| 余额/用量/成本             | cursor-byok 有 provider balance、usage、pricing、metrics、local cache 与 force refresh                         | T3 已有部分 BYOK balance/usage 代码；Composition 事件仍未统一产出跨 Driver 的成本/用量账本                                                                                                                      | 部分迁移                              |
| Cursor 多账户              | `internal/cursoraccount`、OAuth PKCE、Token/JSON/本机导入、切换事务、state.vscdb 回写                          | T3 没有 Cursor 官方账户 OAuth/导入/切换和客户端状态回滚能力                                                                                                                                                     | 未迁移；不应放入 Provider ToolBroker  |
| Skills/原生提示词          | cursor-byok 有 bundled skills、native prompt、custom_subagents、non_file_rules、sparse activation、AGENTS 扫描 | T3 有 Provider Skills 相关能力，但没有 cursor-byok 的原生提示词资产、custom_subagents 与统一 skill activation contract                                                                                          | 部分迁移                              |
| 运营与诊断 UI              | cursor-byok 有 ControlCenter、Diagnostics、StatsOverlay、MetricsDetail、RequestLab、SupplierDetail             | T3 有 Provider/Composition 设置和任务事件基础，但没有逐项等价的 Cursor 运营面板                                                                                                                                 | 未迁移/需重做为 T3 面板               |
| 发布与隔离 E2E             | cursor-byok 有 isolated-cursor-e2e、MITM 证书、Windows Wails 打包和 release 检查                               | T3 有 Web/Desktop/Mobile 架构与自身 dev/build 流程，但没有 Cursor 专属隔离启动器与协议证据链                                                                                                                    | 不直接迁移，改为 T3 Runtime/CI 验收   |

## 迁移边界与可达性判断

目标“使用 T3 的壳，接入多个 Agent Driver，并让每个 Driver 使用统一的 API/IDE 能力”在架构上可达，
但必须把“模型驱动”和“执行能力”分开：

```text
T3 Shell
  -> Composition Orchestrator
  -> Agent Driver Registry
       -> Provider / BYOK / ACP / CLI / Cursor-IDE / VSCode-IDE / Multica
  -> Capability Registry + task-scoped Grant + Approval
  -> Canonical ToolBroker
       -> Workspace / Terminal / Git / MCP / Browser / Computer Use / IDE API / Provider API
```

可达不等于当前已经完成。当前能真实声明的范围是：

1. Provider、BYOK 和已有 Runtime Adapter 可以共享 Composition Task、Run、事件、grant 和第一批 Workspace/Terminal/Git 工具。
2. Multica 可以作为外部 runtime 承接 T3 task，并使用窄 daemon 协议完成注册、心跳、quick-create、claim、start、progress、complete、fail、cancel 和事件投影。
3. T3 的 `CompositionRuntimeToolBridge` 已提供外部 runtime 调用 `ToolBroker` 的入口，但 Multica 官方 daemon 当前没有 T3 grant handshake 和 Tool-call RPC；因此带 T3 grant 的 Multica 任务必须拒绝或走明确的只读/无 grant 降级，不能宣称“Multica 已共享所有 T3 工具”。
4. Cursor/VSCode IDE API、Browser/Computer Use、任意 MCP server/tool 仍需要各自 Adapter 和权限合同完成后，才能被所有 Driver 共享。
5. Supervisor/Reviewer、任务重试/换人/升级/熔断和兄弟任务隔离应建在 T3 Orchestrator 上，不能把 Multica 的外部 issue 状态直接当作 T3 Run 终态。

## 后续实施批次

按“一步一提交、每批可回滚”拆分：

1. **Batch A：统一 Tool Plane 扩展。** 将 MCP tool catalog/invoke 纳入 `CompositionToolRegistry`/`ToolBroker`，补齐 canonical 参数、结果去敏、取消和审计；随后接 Browser/Computer Use。
2. **Batch B：IDE Adapter。** 实现 Cursor/VSCode profile 探测、会话握手、verified operation allowlist 和断开恢复；未知 profile 只允许 probe/list，不允许写入或执行。
3. **Batch C：监督协同。** 在 T3 中增加 review checkpoint、retry/reassign/escalate/circuit 状态和 sibling failure isolation；把 cursor-byok 的 worker context compaction 迁移为独立纯函数模块。
4. **Batch D：Multica 增强。** 增加显式 Squad/Leader/Task Graph route 同步、持久化 outbox/未知结果恢复和真实 daemon 的 Tool-call/Grant 协议协商；在官方协议未提供前，不绕过握手。
5. **Batch E：Cursor 专属能力按需接入。** 原生 Bidi/RunSSE、MITM 镜像、账户切换和 Cursor 专属运营 UI 作为独立 Runtime/桌面功能，不污染 T3 核心 Provider/ToolBroker 合同。

每个批次的验收必须分别记录：定向单测、类型/构建、模拟 Runtime、真实本机 Runtime/IDE E2E、Web/Desktop/Mobile 可达性；其中前两类不能替代后三类。

## Batch A 落地记录（2026-08-26）

Batch A 已把 T3 已有 Preview Automation 能力接入 Composition ToolBroker，当前实际开放的
canonical tool 为：

- `preview_status`：只读查询，直接复用 `PreviewAutomationTabTargetInput`。
- `preview_open`：执行操作，复用官方 `PreviewAutomationOpenInput`，默认沿用已有 `reuseExistingTab` 语义，需要首次使用审批。
- `preview_navigate`：执行操作，复用官方 `PreviewAutomationNavigateInput`，需要首次使用审批。
- `preview_snapshot`：只读查询，复用官方 `PreviewAutomationTabTargetInput`，结果仍由既有 Preview Broker 负责大小限制和远端错误归一化。

Composition Run 使用独立的 `sessionId`：`composition-browser:<taskId>:<runId>`。它不再伪装成
Provider MCP session；旧的 `providerSessionId` 在 MCP/Preview 错误合同中保留为可选兼容字段，
真实 host assignment 使用通用 `sessionId`。Runtime ID 会被规范化为 Preview scope 的稳定
`ProviderInstanceId` 别名，避免 Multica 的 `:` 等协议字符进入 T3 标识类型。

BYOK Agent Loop 和 `CompositionRuntimeToolBridge` 都会把 runtime/thread 上下文传入 ToolBroker。
缺少受信 runtime scope 时返回 `tool_scope_missing`，不会生成默认 scope 或静默降级。所有调用仍然
经过 capability registry、task grant、approval、idempotency 和 audit 链路。

本批次没有接入任意 MCP server/tool catalog、`preview_click/type/press/evaluate`、Computer Use、
Cursor/VSCode IDE API 或真实外部 daemon/IDE。当前验证覆盖 Composition Browser Context、ToolBroker、
BYOK Loop、Runtime Bridge、MCP scope 兼容和 Preview Broker 定向回归；真实 Preview Host、Multica
daemon、Cursor/VSCode、Web/Desktop/Mobile E2E 仍需独立验收，不能由本批次静态测试替代。

## Batch B 落地记录（2026-08-26）

Batch B 固定了所有真实 Cursor/VSCode Adapter 必须遵守的可信执行边界：

- `CompositionIdeSessionRegistry` 按稳定 `sessionId` 注册 Adapter，拒绝覆盖活动连接；注销时清理该 session 的全部 handshake。
- `resolve` 必须同时满足请求 profile、Adapter profile 和 probe 的 `ready` 状态；未知、离线或 profile 不匹配只返回 `unavailable`，不会猜测 IDE 类型。
- handshake 按 `taskId`、`runId`、`agentId` 绑定，保存 `acceptedGrantIds`、`verifiedOperations` 和有上限的租约；接受的 operation 必须同时属于请求范围和 probe 已报告的 allowlist。
- `ide.invoke` 作为 canonical ToolBroker 工具接入现有 Capability Registry、Grant、首次使用审批、幂等和 Audit 链路；Adapter 不能绕过 ToolBroker 获得文件、终端、Git 或其他 T3 能力。
- session 断开、handshake 不存在、过期、作用域不匹配或 operation 未验证时，调用稳定拒绝；错误不会静默降级为 full-access。

本批次没有声称已经实现 Cursor/VSCode 的真实本地协议、IDE transport、Bidi/RunSSE、MCP/Computer Use 桥接，
也没有把测试 Adapter 当作真实 IDE 完成证明。下一批仍需为 Cursor 和 VSCode 分别实现 Adapter、连接生命周期、真实 operation 合同，
再补本机 IDE E2E 与 Web/Desktop/Mobile 可达性验证。

## Batch C-1 落地记录（2026-08-26）

本节点先落地监督协同的 review checkpoint，不把 retry/reassign/escalate/circuit breaker 混入同一状态迁移：

- `CompositionTask.mode === "review"` 时，Runtime 的成功完成事件只把 Task/Run 投影为 `in_review`，不直接写入 `completed`。
- Runtime 已经报告完成后，T3 立即回收本次 Run 的 capability handshake 和 grant，避免 Worker 在等待 Reviewer 时继续调用工具。
- 新增 `server.reviewCompositionTask` RPC，只有 `in_review` 的同一 Task/Run 才能 approve 或 reject；approve 进入 `completed`，reject 进入 `failed` 并保存 `review_rejected`。
- 新 RPC 受 `AuthOrchestrationOperateScope` 保护，所有转移继续通过 Task Store 和事件流落盘，重复 Runtime 事件不会重复回收权限。

当前仍未实现 retry、reassign、escalate、circuit breaker、兄弟任务失败隔离和 Worker context compaction；这些继续拆成后续独立节点。
