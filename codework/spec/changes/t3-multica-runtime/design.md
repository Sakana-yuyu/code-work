# Code Work 统一 Runtime Adapter 与 Multica 协同设计

## 目标

在不把 Multica 的数据库、页面或内部任务模型嵌入 Code Work 的前提下，让 Code Work 统一管理 Provider、CLI、IDE 和 Multica runtime。Code Work 保留任务、运行、事件、授权和能力控制面；外部 runtime 只负责执行，并通过 Adapter 回传可幂等归属的事件。

本设计覆盖服务端适配层、Composition Driver 接入、Multica daemon 协议边界，以及 Web/Desktop/Mobile 后续消费的稳定接口。真实 Multica daemon、真实 IDE 和多端 E2E 不在本设计阶段宣称完成。

## 现状依据

- `apps/server/src/composition/CompositionOrchestrator.ts` 已定义 Composition Task/Run 派发和取消，但 Driver 只有启动、取消和运行时事件归属能力。
- `apps/server/src/composition/CompositionProbeRegistry.ts` 已定义 runtime、IDE、Multica 的探测结果，但尚未由统一 Adapter 提供探测和生命周期操作。
- `apps/server/src/composition/CompositionProviderAgentDriver.ts` 已将 Code Work Provider Session/Turn 映射为 Composition Agent Driver。
- `packages/contracts/src/compositionRuntime.ts` 已定义 runtime probe、IDE profile、Multica probe 和事件信封合同。
- `packages/contracts/src/providerRuntime.ts` 已定义 Code Work 统一 `ProviderRuntimeEvent`，Composition Task Runtime Projector 已能将 Provider 事件投影到 Task。
- Multica 官方 daemon 采用注册、心跳、任务派发/进度/完成和 WebSocket 控制连接；HTTP claim/heartbeat 仍是正确性路径，WebSocket 主要用于控制、唤醒和 RPC。

## 架构

```text
Web / Desktop / Mobile
          |
          v
Code Work Composition RPC + Capability Policy
          |
          v
Composition Orchestrator + Task/Run/Event Store
          |
          v
Composition Agent Driver Registry
          |
          +--> Provider Agent Driver --> Code Work ProviderService --> Codex/Claude/OpenCode/Byok/ACP
          |
          +--> Multica Agent Driver --> Multica Runtime Adapter --> HTTP + WebSocket daemon protocol
          |
          +--> IDE Agent Driver ------> IDE Adapter handshake + Code Work Tool Broker
          |
          +--> CLI/other Runtime Adapter
                                  |
                                  v
                         ProviderRuntimeEvent / CompositionEventEnvelope
                                  |
                                  v
                         Composition Task Runtime Projector
```

Adapter 不直接写 Composition 数据库。所有状态变更通过 Driver、事件投影器和持久化 Store 完成，避免外部协议的重试把 Code Work 状态写坏。

当 `CompositionTaskDispatchRequest.assigneeKind` 为 `squad` 时，`assigneeId` 是持久化的 `CompositionSquad.squadId`；Orchestrator 读取该 Squad 的 `leaderAgentId`，使用 Leader 对应的 Agent Driver 执行，Task 仍保留 Squad 归属，Run 记录实际 Leader Agent。Leader 不存在时拒绝派发，不把 Squad ID 猜测成普通 Agent ID。

## Interfaces

### Canonical Tool Plane

Composition 的工具入口采用“描述符 + 执行器”注册模型。`ToolBroker` 只负责统一的幂等、取消、Capability Policy、Grant 校验、审批、审计、结果去敏和错误归一化；具体工具通过注册的 handler 访问现有 Code Work 服务。这样 Provider、BYOK、ACP、CLI、IDE 和 Multica 不需要分别实现文件、终端、Git 或 MCP 的安全边界。

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
- Adapter 不获得 Code Work 工具的隐式权限；文件、终端、Git、MCP、浏览器和 IDE 操作仍通过 Capability Registry/Tool Broker 授权。
- `capabilityGrantIds` 是 Code Work 内部的 task-scoped 授权引用，不等于外部 runtime 已完成授权握手。Adapter 只有在外部协议明确支持并完成校验后，才可以声称 grant 已注入；否则必须保留明确的未支持边界。
- 带 grant 的 Runtime dispatch 必须先完成 `CompositionRuntimeCapabilityHandshake`，并把返回的 `handshakeId` 带入派发；握手状态为 `unsupported` 或 `rejected` 时不得创建外部任务。

### MulticaAdapter

Multica 适配器使用 daemon 的 HTTP 注册/心跳/任务控制路径和 WebSocket 控制路径。WebSocket 断开时，Adapter 必须退回 HTTP 探测和心跳；重连后只能补发幂等控制，不得重复创建 Code Work Run。

任务创建使用 Multica 官方的 `POST /api/issues/quick-create`，而不是把 daemon 的 claim 接口当作 dispatch：

```text
Code Work Agent/Squad 映射
    -> X-Workspace-ID + agent_id/squad_id + prompt
    -> Multica quick-create
    -> queued task_id
    -> daemon claim
    -> start/progress/complete/fail
```

Adapter 配置必须显式提供以下映射：

```ts
type MulticaTaskAssigneeRoute = {
  readonly codeworkAgentId: string;
  readonly workspaceId: string;
  readonly multicaAgentId?: string;
  readonly multicaSquadId?: string;
};
```

每一条 route 只能指定一个远端归属。缺少映射时 dispatch 失败，不根据名称、前缀或本地 ID 猜测 Multica UUID。Code Work 的 Squad 可以通过一个以 Squad ID 为稳定 Driver key 的 route 映射到 `multicaSquadId`；后续若要支持动态 Squad 列表，应把列表同步和 route 持久化作为独立节点。

quick-create 的返回值只保证返回异步队列 `task_id`。当前官方接口没有与 Code Work `runId` 等价的幂等键，因此 Adapter 只在进程内按 `idempotencyKey` 复用已接受结果；网络请求成功但响应丢失后重启仍可能产生重复创建，不能宣称跨进程 exactly-once。生产级自动重试需要后续的持久化 outbox、服务端幂等能力或冲突校验。

Multica runtime 映射为：

- `runtimeId`: `multica:<daemonId>:<runtimeId>`。
- `agentId`: `multica:<daemonId>:<agentId>` 或 runtime profile 的稳定 ID。
- `runtimeTaskId`: Multica 返回或事件中的 task ID。
- `CompositionMulticaProbeResult`: 由 daemon 版本、capability、Squad/Leader/Task Graph 能力组成。

Task 事件映射：

| Multica 事件            | Code Work ProviderRuntimeEvent                     | Composition 状态                         |
| ----------------------- | ------------------------------------------- | ---------------------------------------- |
| `daemon:task_available` | `task.updated`                              | 不直接改变终态，只触发重新探测/拉取      |
| `task:dispatch`         | `task.started`                              | `running`                                |
| `task:progress`         | `task.progress`                             | `progress`                               |
| `task:completed`        | `task.completed` 或 `turn.completed`        | `completed`                              |
| `task:failed`           | `runtime.error` 或 `turn.completed`(failed) | `failed`                                 |
| daemon 断线/恢复        | `runtime.warning`                           | 保留运行状态，直到心跳超时或终态事件确认 |

不能从“收到派发”推断任务完成，也不能把 WebSocket 唤醒帧当成任务事实；任务事实必须来自 HTTP claim/状态或带稳定事件 ID 的事件。

## 生命周期与幂等

### Multica seq、event_id 与 Code Work sequence 的三层语义

Multica 的三个顺序/身份字段不能合并为一个本地序号：

- `TaskMessagePayload.seq` 只表示同一个 Multica Task 的 `task:message` 消息顺序。它不能给 `task:progress`、`task:completed` 或其他来源的事件排序，也不能跨 Task、跨 Agent 或跨 Runtime 比较。
- WebSocket 顶层 `event_id` 是 Multica realtime relay 为一次事件投递提供的稳定身份。它用于跨节点、断线重连和 Redis replay 场景下的事件去重；即使两个事件的 payload 完全相同，只要顶层 `event_id` 不同，也必须视为两个独立事件。
- Code Work `CompositionTaskEvent.sequence` 是本地 Run 审计流的落库顺序，由 Store 原子分配。它只反映 Code Work 实际接收和写入的顺序，不代表远端 `seq`，也不应被用于推断远端事件发生顺序。

Multica Adapter 将 `runtimeId` 和 `runtimeTaskId` 写入 `ProviderRuntimeEvent.raw` 的明确 T3 correlation metadata；这两个字段不是 Multica 官方 payload 字段。Driver Registry 在线时优先使用 Driver 自己的活动/历史绑定；Driver 注销后只有在这两个 metadata 均存在，且持久化查询得到唯一 `(runtime_id, runtime_task_id)` Run 时，才允许恢复归属。零命中记录 `unknown_binding` 并丢弃，多命中记录 `ambiguous_binding` 并丢弃，绝不只凭 `task_id`、`threadId` 或名称猜测。

断线重连或 Redis replay 收到旧事件时，Projector 以 `(task_id, run_id, source_event_id)` 做原子幂等；其中 `source_event_id` 优先使用顶层 `event_id`。没有显式 `event_id` 的旧 fixture 才允许使用明确标记的帧内容 SHA-256 降级，这种降级不能把相同 payload 的两次真实投递可靠地区分开。事件乱序时，只有同一 Run 的状态机和终态锁定规则可以改变投影；终态、`in_review`、取消或超时之后的迟到事件只能追加审计，不能回退状态、覆盖结果、重复释放 grant 或重复触发重试/汇聚。

1. Code Work 派发 Task，Orchestrator 创建 Task/Run，并调用 Driver。
2. Driver 先向 Runtime/Provider 请求 capability handshake；只有收到 accepted 的 `handshakeId`，才将完整 prompt、workspaceRoot、grant 引用和 handshake ID 交给 Adapter。Provider 原生协议和 Multica 窄协议尚未支持时，带 grant 的任务会稳定拒绝，不会静默降级到 full-access。
3. Adapter 返回 `runtimeTaskId` 和可选 `capabilityHandshakeId` 后，Code Work 保存 Run 关联；握手 ID 通过 046 迁移持久化。
4. Adapter 心跳和事件流持续回传；Projection Service 做状态机校验、事件去重和终态收口，并在首次进入终态时调用 Driver 撤销 handshake 与 grant。
5. 取消先调用 Adapter；只有 Adapter 明确接受或已终态时，Code Work 才写入对应状态。取消落地时同样撤销握手与 grant；网络错误保留 `cancel_requested` 语义，交由后续心跳/事件收口。
6. 进程重启后，Adapter 通过持久化的 `runtimeTaskId`、`capabilityHandshakeId` 和 Run 记录恢复订阅或执行清理；不能依赖进程内 Map 作为唯一事实源。

对于 Multica quick-create，步骤 2 的 `runtimeTaskId` 是远端返回的队列 `task_id`。由于当前 quick-create 接口缺少服务端幂等键，Code Work 必须把 HTTP 成功后的关联持久化视为恢复边界；transport timeout 不能自动重试创建请求，只能进入未知结果并等待人工/服务端查询确认。

## 能力与安全边界

- 未完成 runtime/IDE handshake 时只允许 probe、list 和只读状态查询。
- 未知 IDE profile 直接拒绝高权限操作，不通过“兼容模式”绕过。
- task-scoped grant 绑定 `taskId`、`runId`、`workspaceRootDigest` 和过期时间；外部 runtime 不可复用其他 Task 的 grant。
- BYOK Agent Loop 为兼容旧 capability ID 临时签发的 grant 只在本次 Loop 内使用，Loop 成功、失败或超限退出时都必须撤销；调用方预先传入的 `grant-*` 不由该服务代为撤销。
- Provider Driver 已支持 handshake 合同；当前投影的 ProviderService 适配器尚未提供握手实现，因此带 grant 的 Provider 任务会拒绝，待 Provider 原生工具或 canonical ToolBroker 桥接完成后再开放。
- Multica Adapter 已暴露稳定的 unsupported 握手结果；官方 quick-create 请求不携带 grant，真实 daemon 也尚未校验 Code Work grant，因此带 grant 的 Multica 任务会拒绝。
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

## Multica 外部依据与许可边界（2026-08-26）

- 官方 README 将 Multica 定位为可自托管的 Agent workspace：由 runtime 驱动已安装并已认证的 Agent CLI，提供 Agent、Squad、Skill、任务执行记录、Review、Retry/Timeout 等协同能力；它不是模型提供商本身。
- Code Work 采用外部 `MulticaDaemonRuntimeAdapter` 连接 daemon，只复用公开 HTTP/WebSocket 协议和任务结果，不复制 Multica 的 Web、数据库、账号或内部 issue 模型。
- 官方 `LICENSE` 在 Apache 2.0 文本之外增加了 hosted service、商业嵌入、品牌和归属条件。若未来从 Multica 源码直接派生、重新分发 daemon/backend/UI 或把其作为商业产品组件提供，必须由发布前的法务与许可证审查确认适用条件；本设计优先采用协议级适配以保持 Code Work 与 Multica 的发布边界分离。
- 外部来源：`https://github.com/multica-ai/multica` 的 `README.md`、`CLI_AND_DAEMON.md` 与 `LICENSE`，访问日期为 2026-08-26，官方 `main` HEAD 为 `09a2410e882be8435bd6c4a26e03f7e288038203`；采用官方仓库而非二手文章，因为 Agent/Runtime/Squad、daemon、MCP 下发能力和许可证条款都属于项目自身的权威事实。

## 迁移差异矩阵（2026-08-26）

本节以当前工作树 `E:\MyProject\code-work\codework`、对照仓库
`E:\MyProject\cursor-byok` 和 Multica 只读提交 `8442504201b302cfd6c40c7b8eb8a508bf254d0b`
的源码、测试和设计文档为依据。这里的“已具备”只表示 Code Work 有可调用的实现和定向测试，
不表示已经完成 Web/Desktop/Mobile 和真实外部 Runtime 的端到端验收。

| 能力域                     | cursor-byok 现状证据                                                                                           | Code Work 当前状态                                                                                                                                                                                                     | 结论                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 多协议 BYOK 请求           | `internal/backend/agent/model/openai_*.go`、`anthropic.go`、`gemini.go`，包含工具参数校验和流式适配            | `byokChatClient.ts` 已支持 OpenAI/Anthropic/Gemini；`99dcc534` 已让 Agent Loop 和 Driver 协议无关                                                                                                               | 已迁移第一阶段                        |
| 统一 Agent Loop            | cursor-byok 的 provider/worker 以协议适配器承接工具调用                                                        | `ByokAgentLoop` + `ToolBroker` 已实现工具调用、幂等、结果回放、临时 grant 撤销                                                                                                                                  | 已具备，仍需真实模型 E2E              |
| Composition canonical 工具 | `internal/backend/agent/bridge/exec/exec_open_fs.go`、`exec_open_shell.go`、`exec_open_git.go`                 | `CompositionToolRegistry` + `ToolBroker` 已注册 11 个 canonical 工具，并经 Policy/Grant/Approval/Audit                                                                                                          | 已迁移第一批                          |
| MCP                        | cursor-byok 有 `mcp_registry.go`、`mcp_runtime.go`、MCP trust、动态工具目录和连接控制 UI                       | Code Work 已完成 stdio/Streamable HTTP/SSE 的 Runtime reconcile、catalog 注册、JSON Schema 校验、结果去敏、取消、ToolBroker 动态 capability、Settings/WS/client-runtime 控制；跨 Driver 真实 E2E 仍缺                  | 服务端闭环已具备，产品级 E2E 未完成   |
| Browser/Computer Use       | `internal/computeruse`、`computeruse_bridge.go`、IDE browser MCP                                               | Code Work 已有 Preview canonical tools（status/open/navigate/snapshot）和受限 Browser Context；完整 click/type/press/evaluate、Computer Use 会话、审批和取消闭环仍未接入                                               | Preview 已迁移，完整能力未迁移        |
| Cursor/VSCode IDE API      | cursor-byok 通过 Cursor 本地协议、MCP 和 Windows computer-use 访问 IDE/浏览器边界                              | Code Work 已有 `CompositionIdeSessionRegistry`、profile probe、task/run/agent 绑定的 handshake lease、probe allowlist 和 `ide.invoke` ToolBroker 入口；真实 Cursor/VSCode Adapter、transport 和 IDE operation 仍未接入 | 可信执行门已迁移，真实 Adapter 未迁移 |
| Cursor 原生协议代理        | `internal/mitm`、`internal/backend/agent/protocol`、`RunSSE`/`BidiAppend` 相关 forwarder 和 protobuf           | Code Work 没有 Cursor MITM、原生 Bidi/RunSSE 转发器，也不修改已安装 Cursor bundle                                                                                                                                      | 未迁移；属于独立 Runtime Driver       |
| 官方请求镜像与对比         | `internal/mitm/mirror.go`、`official.raw.jsonl`、`requestlab` 及 `request-comparison-lab` 设计                 | Code Work 有 Provider/Runtime 事件和 Trace，但没有官方请求镜像记录、exchangeId 对比实验台                                                                                                                              | 未迁移                                |
| 监督式委派                 | `internal/backend/forwarder/supervisor_coordinator.go`、`supervisor_provider.go`、`delegation_multitask.go`    | Code Work 已有 review 模式 checkpoint、`in_review` 投影、approve/reject RPC，以及失败/超时 Run 的显式重试；reassign/escalate/circuit breaker、兄弟任务隔离仍未接入                                                     | 部分迁移                              |
| Worker Context Compaction  | `delegation_compaction.go`、`context_overflow.go`、tool result snip 和保留最近轮次规则                         | Code Work BYOK Loop 目前只累积消息，没有 worker 预算、工具结果裁剪和 context overflow 自救                                                                                                                             | 未迁移                                |
| Delegate 运行时            | cursor-byok 有 Claude/Codex/Cursor/Gemini/Kiro/custom executor registry、failover、slot/loop limiter           | Code Work Provider Driver、ACP/CLI/Multica Runtime Adapter 已有；统一 driver SPI 已具备，但 cursor-byok executor 具体语义尚未逐项迁移                                                                                  | 部分迁移                              |
| 供应商目录/模型发现        | cursor-byok 有 supplier catalog、候选 URL、custom headers、模型目录缓存、协议过滤和 pricing                    | Code Work 有 BYOK adapter/import/balance/discovery 服务，但尚未达到 cursor-byok 的供应商目录管理和多端页面等价                                                                                                         | 部分迁移                              |
| 余额/用量/成本             | cursor-byok 有 provider balance、usage、pricing、metrics、local cache 与 force refresh                         | Code Work 已有部分 BYOK balance/usage 代码；Composition 事件仍未统一产出跨 Driver 的成本/用量账本                                                                                                                      | 部分迁移                              |
| Cursor 多账户              | `internal/cursoraccount`、OAuth PKCE、Token/JSON/本机导入、切换事务、state.vscdb 回写                          | Code Work 没有 Cursor 官方账户 OAuth/导入/切换和客户端状态回滚能力                                                                                                                                                     | 未迁移；不应放入 Provider ToolBroker  |
| Skills/原生提示词          | cursor-byok 有 bundled skills、native prompt、custom_subagents、non_file_rules、sparse activation、AGENTS 扫描 | Code Work 有 Provider Skills 相关能力，但没有 cursor-byok 的原生提示词资产、custom_subagents 与统一 skill activation contract                                                                                          | 部分迁移                              |
| 运营与诊断 UI              | cursor-byok 有 ControlCenter、Diagnostics、StatsOverlay、MetricsDetail、RequestLab、SupplierDetail             | Code Work 有 Provider/Composition 设置和任务事件基础，但没有逐项等价的 Cursor 运营面板                                                                                                                                 | 未迁移/需重做为 Code Work 面板               |
| 发布与隔离 E2E             | cursor-byok 有 isolated-cursor-e2e、MITM 证书、Windows Wails 打包和 release 检查                               | Code Work 有 Web/Desktop/Mobile 架构与自身 dev/build 流程，但没有 Cursor 专属隔离启动器与协议证据链                                                                                                                    | 不直接迁移，改为 Code Work Runtime/CI 验收   |

## 迁移边界与可达性判断

目标“使用 Code Work 的壳，接入多个 Agent Driver，并让每个 Driver 使用统一的 API/IDE 能力”在架构上可达，
但必须把“模型驱动”和“执行能力”分开：

```text
Code Work Shell
  -> Composition Orchestrator
  -> Agent Driver Registry
       -> Provider / BYOK / ACP / CLI / Cursor-IDE / VSCode-IDE / Multica
  -> Capability Registry + task-scoped Grant + Approval
  -> Canonical ToolBroker
       -> Workspace / Terminal / Git / MCP / Browser / Computer Use / IDE API / Provider API
```

可达不等于当前已经完成。当前能真实声明的范围是：

1. BYOK 和已经完成 Tool Bridge handshake 的 Runtime 可以共享 Composition Task、Run、事件、grant 和第一批 Workspace/Terminal/Git/MCP 工具；普通 Provider 当前仍只共享会话/模型能力，不能宣称已经共享 ToolBroker。
2. Multica 可以作为外部 runtime 承接 Code Work task，并使用窄 daemon 协议完成注册、心跳、quick-create、claim、start、progress、complete、fail、cancel 和事件投影。
3. Code Work 的 `CompositionRuntimeToolBridge` 已提供外部 runtime 调用 `ToolBroker` 的入口，但 Multica 官方 daemon 当前没有 Code Work grant handshake 和 Tool-call RPC；因此带 Code Work grant 的 Multica 任务必须拒绝或走明确的只读/无 grant 降级，不能宣称“Multica 已共享所有 Code Work 工具”。
4. MCP 服务端工具面已接入 Code Work ToolBroker；Cursor/VSCode IDE API、完整 Browser/Computer Use、以及 Provider/ACP/CLI 对 ToolBroker 的真实调用桥仍需要各自 Adapter 和权限合同完成后，才能被所有 Driver 共享。
5. Supervisor/Reviewer、任务重试/换人/升级/熔断和兄弟任务隔离应建在 Code Work Orchestrator 上，不能把 Multica 的外部 issue 状态直接当作 Code Work Run 终态。

## 后续实施批次

按“一步一提交、每批可回滚”拆分：

1. **Batch A（服务端基本完成）：统一 Tool Plane 扩展。** MCP catalog/invoke、Preview canonical tools、参数校验、结果去敏、取消和审计已经接入；下一节点是 Browser/Computer Use 的完整 canonical session。
2. **Batch B（可信执行门已完成，真实 Adapter 未完成）：IDE Adapter。** 已有 Cursor/VSCode profile 探测、会话握手、verified operation allowlist 和断开拒绝边界；仍需真实 Cursor/VSCode transport、operation 和断线恢复。
3. **Batch C（部分完成）：监督协同。** review checkpoint、approve/reject、失败/超时重试已经接入；仍需 reassign/escalate/circuit、兄弟任务失败隔离和 worker context compaction。
4. **Batch D（协议接入门已完成，真实 Runtime 未完成）：Multica 增强。** 已有显式 Squad/Leader/Task Graph route、任务上下文和 Code Work Runtime Tool Bridge 合同；仍需持久化未知结果恢复、真实 daemon extension、Tool-call/Grant 协商和跨进程 E2E。
5. **Batch E（已完成 Provider/ACP 主链）：Provider/ACP/CLI 统一 ToolBroker。** Provider/ACP 已具备真实工具调用桥、严格 handshake、在途取消与终端资源清理；独立 CLI Driver、真实 Cursor CLI 现场链和所有 Code Work API/IDE API 仍需后续批次完成。
6. **Batch F（独立可选）：Cursor 专属能力。** 原生 Bidi/RunSSE、MITM 镜像、账户切换和 Cursor 专属运营 UI 作为独立 Runtime/桌面功能，不污染 Code Work 核心 Provider/ToolBroker 合同。

每个批次的验收必须分别记录：定向单测、类型/构建、模拟 Runtime、真实本机 Runtime/IDE E2E、Web/Desktop/Mobile 可达性；其中前两类不能替代后三类。

## Batch A 落地记录（2026-08-26）

Batch A 已把 Code Work 已有 Preview Automation 能力接入 Composition ToolBroker，当前实际开放的
canonical tool 为：

- `preview_status`：只读查询，直接复用 `PreviewAutomationTabTargetInput`。
- `preview_open`：执行操作，复用官方 `PreviewAutomationOpenInput`，默认沿用已有 `reuseExistingTab` 语义，需要首次使用审批。
- `preview_navigate`：执行操作，复用官方 `PreviewAutomationNavigateInput`，需要首次使用审批。
- `preview_snapshot`：只读查询，复用官方 `PreviewAutomationTabTargetInput`，结果仍由既有 Preview Broker 负责大小限制和远端错误归一化。

Composition Run 使用独立的 `sessionId`：`composition-browser:<taskId>:<runId>`。它不再伪装成
Provider MCP session；旧的 `providerSessionId` 在 MCP/Preview 错误合同中保留为可选兼容字段，
真实 host assignment 使用通用 `sessionId`。Runtime ID 会被规范化为 Preview scope 的稳定
`ProviderInstanceId` 别名，避免 Multica 的 `:` 等协议字符进入 Code Work 标识类型。

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
- `ide.invoke` 作为 canonical ToolBroker 工具接入现有 Capability Registry、Grant、首次使用审批、幂等和 Audit 链路；Adapter 不能绕过 ToolBroker 获得文件、终端、Git 或其他 Code Work 能力。
- session 断开、handshake 不存在、过期、作用域不匹配或 operation 未验证时，调用稳定拒绝；错误不会静默降级为 full-access。

本批次没有声称已经实现 Cursor/VSCode 的真实本地协议、IDE transport、Bidi/RunSSE、MCP/Computer Use 桥接，
也没有把测试 Adapter 当作真实 IDE 完成证明。下一批仍需为 Cursor 和 VSCode 分别实现 Adapter、连接生命周期、真实 operation 合同，
再补本机 IDE E2E 与 Web/Desktop/Mobile 可达性验证。

## Batch C-1 落地记录（2026-08-26）

本节点先落地监督协同的 review checkpoint，不把 retry/reassign/escalate/circuit breaker 混入同一状态迁移：

- `CompositionTask.mode === "review"` 时，Runtime 的成功完成事件只把 Task/Run 投影为 `in_review`，不直接写入 `completed`。
- Runtime 已经报告完成后，Code Work 立即回收本次 Run 的 capability handshake 和 grant，避免 Worker 在等待 Reviewer 时继续调用工具。
- 新增 `server.reviewCompositionTask` RPC，只有 `in_review` 的同一 Task/Run 才能 approve 或 reject；approve 进入 `completed`，reject 进入 `failed` 并保存 `review_rejected`。
- 新 RPC 受 `AuthOrchestrationOperateScope` 保护，所有转移继续通过 Task Store 和事件流落盘，重复 Runtime 事件不会重复回收权限。

当前仍未实现 retry、reassign、escalate、circuit breaker、兄弟任务失败隔离和 Worker context compaction；这些继续拆成后续独立节点。

## Batch C-2 落地记录（2026-08-26）

本节点增加失败任务的显式重试生命周期，重试不会覆盖旧 Run：

- 新增 `CompositionTaskRetryRequest` / `CompositionTaskRetryResult` 合同，调用方必须提供新的 `runId`、旧的 `previousRunId`、重试原因和本次重新申请的 `capabilityIds`。
- 只有 Task 状态为 `failed` 或 `timed_out`，且 `previousRunId` 是该 Task 最新 Run、Run 同样处于失败终态时才允许重试；已完成、运行中、待审核和旧 Run 均稳定拒绝。
- 重试从 `CompositionTaskInputStore` 恢复完整 prompt、workspaceRoot、workspaceRootDigest 和 model；恢复输入缺失时不会创建新 Run。
- 旧 Run 的 `failureCode`、`resultSummary` 和状态保持不变；新 Run 使用 `attempt + 1`、新的 capability grant 和新的 Runtime task 关联。
- 重试前撤销旧 Run 的 grant；新 Driver 启动失败时把新 Run 置为 `failed` 并回收新 grant，避免权限或运行记录泄漏。
- 新增 `server.retryCompositionTask` RPC，并纳入 `AuthOrchestrationOperateScope`。

本节点已通过 Composition contract、Orchestrator、server 与 contracts typecheck，以及 27 个定向测试和格式检查。验证仍属于本地持久化层与测试 Driver；真实 Provider、Cursor/VSCode、Multica daemon 和 Web/Desktop/Mobile E2E 不由本节点替代。

## Batch D-1 落地记录（2026-08-26）

本节点补齐 Multica 协同接入中不会改变官方窄协议边界的元数据传递：

- `CompositionRuntimeTaskInput` 现在携带 `projectId`、`parentTaskId`、`dependsOnTaskIds`、执行模式和原始 assignee 信息，所有 Runtime Driver 可以观察同一份 Code Work Task Graph 上下文。
- Multica quick-create 发送 `project_id`；Code Work 仍在 Orchestrator 内负责依赖阻塞与恢复，不把 Code Work 的 task ID 直接伪装成 Multica issue ID，也不声称官方 quick-create 已支持任意依赖边同步。
- Multica `probe`/`probeMultica` 合并本地配置与 heartbeat 返回的能力目录；在没有显式配置覆盖时，heartbeat 的 `squad`、`leader`、`task-graph` 能力会被准确暴露，未知能力不会被猜测。

本节点验证覆盖 Runtime Agent Driver 与 Multica Adapter 的 14 个定向测试、server/contracts typecheck、格式检查和 `git diff --check`。这仍是协议适配层验证，不能替代真实 Multica daemon、真实 Squad 路由、Web/Desktop/Mobile 或 Code Work capability Tool-call handshake E2E。

## Batch D-2 落地记录（2026-08-26）

本节点补了一条可验证的 Code Work 壳到 Multica Squad 的模拟执行链：

- `CompositionOrchestrator` 仍以 Code Work `CompositionSquad.leaderAgentId` 选择 Driver，同时保留 Task 的 `assigneeKind=squad` 和 `assigneeId`。
- Runtime Driver 把 squad 任务送入 Multica Adapter；Adapter 依据显式 assignee route 将 leader Agent 映射到远端 `squadId`，并把 `projectId`、prompt 发送给 quick-create。
- 该链路没有猜测远端 UUID，也没有把 Code Work 的 `squadId` 当成 Multica 的 UUID；缺少 route 时仍返回 `assignee_mapping_missing`。

新增的定向集成测试实际断言了 `Code Work Squad -> Leader Driver -> Multica remote squadId -> project_id/prompt`，本批次累计 30 个相关测试通过。它是本地模拟协议证明，不等价于真实 Multica Server、真实 daemon、真实 Squad 成员协作或 capability Tool-call handshake。

## Batch D-3 落地记录（2026-08-26）

本节点把 Multica assignee route 从隐式 leader 路由扩展为显式 Squad 路由：

- `CompositionMulticaAssigneeRoute` 增加可选 `codeworkSquadId`；Adapter 同时维护 Agent 路由和 Squad 路由索引。
- `assigneeKind=squad` 的任务优先按 Code Work `assigneeId` 查找 Squad 路由，选择对应的远端 `multicaSquadId`；未配置 Squad 专属路由时才兼容回退到 leader Agent 路由。
- 同一 leader 可以映射多个不同 Code Work Squad；重复 Squad ID 或重复无 Squad 的 Agent 路由会稳定拒绝。Settings 投影只注册一次 leader Driver，不会因为多个 Squad 映射产生重复 Driver。

本节点通过 contracts/server typecheck、5 个相关测试文件共 36 个测试、格式检查和 `git diff --check`。真实远端 Squad 成员调度、路由刷新后的 daemon 现场探测和 Web/Desktop/Mobile E2E 仍未完成。

## Batch D-4 落地记录（2026-08-26）

本节点把多个 Agent Driver 的可发现能力统一投影到跨端合同，避免 UI、调度器和安全策略从
Driver 字段自行猜测能力：

- 新增 `CompositionAgentDriverProfile`，统一返回 `agentId`、`runtimeId`、Driver 类型、Provider 类型、
  在线状态、声明能力、ToolBroker/handshake、Workspace/Terminal/Git/MCP/Browser/IDE/Provider API、
  Resume 和 Multica Squad/Leader/Task Graph 能力。
- `CompositionAgentDriverRegistry` 新增 `listProfiles`；没有显式能力投影的旧 Driver 返回
  `unknown` 和 `driver_profile_missing` 降级状态，不会被猜测成 Provider 或外部 Runtime。
- Provider Driver 只声明已验证的 Provider Session/Turn/Cancel 和 Provider API；因为当前 Provider
  原生会话没有接入 Code Work ToolBroker，统一能力目录明确显示 `provider_toolbroker_bridge_unavailable`。
- Runtime Driver 只有在 Runtime 明确声明 `t3.toolbroker` 与 `t3.capability_handshake` 且提供 capability handshake 时，才把
  ToolBroker 和 Workspace/Terminal/Git/Browser/IDE/Provider API 标为可用；Multica 的 Squad/Leader/
  Task Graph 可以单独显示为已支持，但窄协议仍显示 ToolBroker 降级。
- 新增 `server.listCompositionAgentDrivers` RPC、client-runtime 查询状态和 Web Integrations 设置只读面，
  Web/Desktop/Mobile 可共享同一份服务端能力投影，不复制推断逻辑。

本节点验证覆盖 3 个服务端 Driver 投影测试文件共 9 个测试、contracts Agent Driver 合同测试、Web 和
client-runtime 定向 TypeScript 检查、格式检查和 `git diff --check`。真实 Provider 原生 ToolBroker、
真实 Cursor/VSCode Adapter、真实 Multica daemon Tool-call/Grant handshake 及多端点击验收仍未完成。

## Batch A-2 落地记录（2026-08-26）

本节点把任意受信 MCP Tool 的 catalog/invoke 合同接入 Composition ToolBroker，但没有把
cursor-byok 的 MCP 进程发现或凭据配置直接复制进 Code Work：

- 新增 `CompositionMcpToolRegistry`，以 `mcp.<serverId>.<toolName>` 生成唯一 canonical tool 名称，保存 server/tool、JSON Schema、operation、trust/status、source 和 handler。
- 注册时校验标识符、描述、JSON Schema 形状、schema 大小和单次调用超时；重复 canonical tool、非法 schema、未信任工具不会静默覆盖或降级。
- `CapabilityRegistry` 投影动态 MCP capability；`ToolBroker` 在同一共享 registry 上解析动态 handler，继续经过 Capability Registry、task-scoped Grant、Approval、幂等和 Audit。
- 调用参数按注册 JSON Schema 做最小递归校验，并限制输入/结果 payload；结果只保留去敏后的 JSON，超限时返回截断结构，handler 超时返回 `mcp_timeout`。
- 未注册、未信任、参数错误、超限、handler 异常和超时分别保留稳定错误码；MCP handler 不直接获得 Workspace、Terminal、Git 或 IDE 权限。

本节点验证覆盖 7 个 MCP registry 测试、11 个 ToolBroker 回归测试、server/contracts typecheck、格式检查和
`git diff --check`。当前仍未完成真实 MCP stdio/HTTP/SSE runtime adapter、MCP server trust 持久化、动态 catalog
刷新 RPC、Browser/Computer Use、真实 Cursor/VSCode transport、Multica Tool-call/Grant handshake，以及
Web/Desktop/Mobile 和真实 daemon E2E；本节点的 handler 使用仍属于 Code Work 内部模拟/适配合同证明。

## Batch A-3 落地记录（2026-08-26）

本节点把 MCP 合同接到官方 MCP SDK 的真实 runtime client，但仍保持安全边界集中在 Code Work：

- 新增 `CompositionMcpRuntimeAdapter`，支持官方 SDK 的 `stdio`、Streamable HTTP 和 SSE transport；
  stdio 由 adapter 创建受控子进程，HTTP/SSE 只接收显式配置，不把 headers、env 或 URL 凭据写入状态投影。
- server 必须同时满足 `enabled` 和 `trusted` 才能连接；未信任 server 在 client factory 之前拒绝，不启动进程，
  连接失败、catalog 失败、catalog 注册失败分别保留稳定错误码，并在失败路径注销工具和关闭 client。
- 连接成功后执行真实 `initialize -> listTools`，把 MCP tool 的 `readOnlyHint`/`destructiveHint` 投影为
  `read`/`mutate`/`execute`，使用 `mcp.<serverId>.<toolName>` 作为 canonical tool ID；调用仍经过
  `CompositionMcpToolRegistry` 的 JSON Schema、payload、结果去敏、超时，以及后续 ToolBroker 的 grant、审批、
  幂等和审计链路。
- 每个幂等键绑定 `AbortController`；取消既能中断进行中的 SDK call，也能标记尚未开始的调用，取消键集合有上限，
  disconnect/unregister 会中止该 server 的活动调用并撤销其 catalog。
- 新增注入式 client factory 以便无凭据测试，同时新增真实本地 stdio MCP 子进程 E2E，覆盖 spawn、initialize、
  tool discovery、canonical invoke 和 close。测试 server 仅使用本地固定脚本，不访问网络、不使用用户配置或 API key。

本节点验证覆盖 5 个 Composition 测试文件共 27 个测试、真实 stdio MCP E2E、server/contracts typecheck、
`pnpm install --filter codework --frozen-lockfile --offline`、格式检查和 `git diff --check`。仍未完成 MCP server
配置发现与 trust 持久化、动态 catalog 刷新 RPC、Browser/Computer Use、真实 Cursor/VSCode transport、Multica
Tool-call/Grant handshake，以及 Web/Desktop/Mobile、真实 Multica daemon 和真实外部 MCP server E2E；因此本节点
证明的是 Code Work runtime adapter 与官方 SDK 的本地可运行链路，不宣称用户设置页和跨端产品功能已经可用。

## Batch D-5 落地记录（2026-08-26）

本节点把 Composition Task Graph 的控制面状态入口补到共享 `client-runtime`，让 Web、Desktop 和 Mobile 可以消费同一套 RPC 绑定，避免各端复制协议调用：

- 新增 `listCompositionTasks` 和 `listCompositionTaskEvents` 查询状态，分别按项目和 Task/Run 查询持久化投影；查询使用短 stale time，适配任务运行中的状态刷新。
- 新增 `cancelCompositionTask`、`reviewCompositionTask` 和 `retryCompositionTask` 命令；每个命令按 `environmentId + taskId + runId` single-flight，避免同一运行被重复取消、审核或重试。
- 本节点没有改变服务端状态机、Runtime Driver 或 Multica 协议；取消、审核、重试仍由服务端 `CompositionOrchestrator` 和 `TaskStore` 决策并落盘。

本节点已通过 Composition/Orchestrator/Task Graph 定向测试 31 个、`client-runtime` 定向 TypeScript 检查、格式检查和 `git diff --check`。`client-runtime` 检查仅保留既有 `relay/discovery.ts` 的 Effect 建议项。Web/Desktop/Mobile 产品入口、真实 WebSocket 集成、真实 Provider/IDE/Multica daemon E2E 仍未完成。

## Batch D-6 落地记录（2026-08-26）

本节点把 Task Graph 控制面接入 Web Settings，并修复刷新后控制操作依赖内存状态的问题：

- `CompositionTaskListResult.tasks` 现在返回 `CompositionTaskSnapshot`，每个快照携带持久化 Store 中的最新 Run；页面刷新后仍能准确获得 `runId`，取消、审核和重试不会依赖前端猜测。
- Web Settings 新增 Task Graph 面板，支持项目/工作区、Leader Driver、串行/并行子任务、最多四个子节点、依赖前一节点、任务列表、Run/事件查看、取消、Leader approve/reject 和失败/超时重试。
- Web、Desktop 和 Mobile 共用的 `client-runtime` RPC 绑定继续作为唯一客户端入口；本批次实际挂载的是 Web Settings，Desktop 通过 Web 壳复用代码，Mobile 尚未提供产品导航入口。
- 面板只把 Driver profile 的 `supportsToolBroker` 与 `supportsCapabilityHandshake` 同时为真时显示为已验证共享工具面；普通 Provider、Multica 或未完成握手的 Driver 仍可以执行任务图，但不会被自动授予 Code Work Workspace、Terminal、Git、MCP 或 IDE 权限。
- 查询首帧会从已返回的 Driver/Task 快照推导默认 Leader、子任务和选中任务，避免等待 React effect 时出现空图或无法控制任务的短暂窗口；状态更新仍由持久化 RPC 和服务端状态机负责。
- 新增 Web 面板定向渲染测试，覆盖无环境、无握手降级、待审核操作、终态不可取消和无 capability ID 不可重试。

本节点验证通过 Web 面板 5 个定向测试、Web typecheck、client-runtime typecheck、格式检查和 `git diff --check`。Web typecheck 仅保留既有 `apps/web/src/cloud/dpop.ts` 的 Effect 建议；Contracts 与 Server 全量 typecheck 仍被本批次之前的 settings/MCP/Effect 诊断阻断。真实 WebSocket client-server 点击链路、Desktop/Mobile 入口、Provider 原生 ToolBroker、Cursor/VSCode transport 和 Multica daemon/Tool-call/Grant handshake E2E 仍未完成。

## Batch D-7 落地记录（2026-08-26）

本节点把“外部 Runtime 调用 Code Work canonical tools”的边界从内部 WS RPC 扩展为独立、可复用的 HTTP Bridge，同时保留 Multica 官方窄协议的拒绝语义：

- 新增 `CompositionRuntimeToolCancellation` 合同和 `server.cancelCompositionRuntimeTool` WS RPC，使调用和取消使用同一组 Task/Run/Agent/Handshake/Grant/幂等身份。
- 新增 `t3-composition-runtime/1` HTTP Bridge，提供 `/api/composition/runtime/tools/invoke` 和 `/api/composition/runtime/tools/cancel`。请求受现有 orchestration operate scope 保护，服务端不信任外部 `workspaceRoot`，仍从 `CompositionTaskInputStore` 恢复工作区并调用 `CompositionRuntimeToolBridge`。
- 新增可供外部 TypeScript Runtime 使用的 Bridge client，固定协议头、幂等键、canonical result 解码、非 2xx/非法 JSON/超时错误收敛；客户端不记录 token、prompt 或 arguments 日志。
- Multica Adapter 增加显式 `capabilityBridge` 扩展点。未提供扩展时，带 grant 的派发仍返回 `capability_handshake_unsupported`；提供扩展时，必须先接受同一组 grant，并在派发时再次校验 Task/Run/Agent/Grant 与 handshake 的绑定，撤销后不能继续借用。

本节点验证覆盖 4 个 Composition/Contracts 定向测试文件共 33 个测试、`git diff --check`。当前仍未完成真实 Multica daemon extension 的实现、真实 HTTP server + 外部子进程 E2E、Cursor/VSCode transport、Browser/Computer Use 完整闭环和 Web/Desktop/Mobile 多端验收；因此本节点证明的是可执行的 Code Work Bridge 合同与 Multica 接入门，不宣称官方 Multica daemon 已经原生获得 Code Work 工具权限。

## Batch E 落地记录（2026-08-26）

本节点把 Provider/ACP 从“只声明 ToolBroker 能力”推进为可撤销的真实工具回调链路：

- 新增 `CompositionProviderToolBrokerBridge`，Provider 只能提交 `toolCallId`、canonical tool、参数和幂等键；Task、Run、Agent、Workspace、Grant、Handshake 和 Thread 身份全部来自 Code Work 保存的可信上下文。Registry 只保存 Driver 已返回并通过验证的 handshake，不自行生成或伪造授权结果。
- Provider Driver 只有在 Runtime Tool Bridge、configure/clear、handshake/revoke 和非空 canonical tool 列表同时存在时才报告 ToolBroker 可用，并按真实目录投影 Workspace、Terminal、Git、MCP、Browser、IDE 和 Provider API 能力。Driver 会校验 `runtimeId`、`taskId`、`runId`、`agentId`、Grant 集合完全一致且无重复，并使用 `Clock` 拒绝过期 handshake。
- Cursor Adapter 为 pending binding 设置有限 TTL，`startSession` 只能消费同一 Adapter 代次产生的 handshake；还会校验 ACP `sessionId`。Adapter 重建、移除、启动失败、发送失败、取消和终态清理都会先使 binding 失效，再取消在途 Bridge 调用、关闭未 release 的 owned terminal 并撤销 handshake；即使 interrupt 失败，也继续 stop、clear、revoke 和 active Run 清理。
- Cursor ACP 初始化只在真实 binding 存在时声明文件和终端能力，并实现 `fs/read_text_file`、`fs/write_text_file`、`terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/kill` 和 `terminal/release` 回调。每次调用都会重新读取 active binding，撤销期间完成的结果不能继续返回 ACP。
- ACP 绝对路径会转换为可信 workspaceRoot 内的相对路径并拒绝越界；Workspace 文件系统还会以 `realpath` 拒绝通过文件或目录符号链接写出工作区。
- `terminal/create` 映射到 canonical `terminal.exec`，直接把 executable 与 argv 交给 PTY Adapter，不向未知 PowerShell、cmd 或 POSIX 交互 shell 注入命令文本。`terminal.kill` 只终止进程并保留 session、history 和 snapshot，`terminal.release` 才映射 `terminal.close` 释放 handle；创建失败会补偿关闭。
- Terminal ToolBroker 使用 `runId` 隔离 handle，同一 Task 的后续 Run 即使知道旧 `terminalId` 也不能访问旧 Run 终端。有限命令进程使用退出时持久化，避免 output 与 exit 紧邻时最终 transcript 尚未落盘的竞争。

本节点验证覆盖 10 个核心测试文件共 132 个测试，以及 6 个 ProviderService 生命周期测试文件共 126 个测试；TerminalManager 服务合同扩展后的 `ProjectSetupScriptRunner` 夹具另有 1 个测试文件共 3 个测试通过。

第一条跨进程证据会启动真实本地 ACP mock 子进程，由子进程通过 JSON-RPC 发起文件和终端请求，依次经过 Cursor Adapter、Provider ToolBroker Bridge、Runtime Tool Bridge 和真正的 Code Work ToolBroker。第二条终端证据通过真实 `node-pty` 启动 `process.execPath` 与临时命令脚本，验证输出、非零退出码、最终 snapshot 和 release 后 handle 失效。这两条证据分别证明 ACP 协议回调链和真实 PTY 命令进程可运行，尚未组成用户机器上“真实安装 Cursor CLI -> ACP -> ToolBroker -> PTY”的产品现场 E2E，也不证明其他 Provider、独立 CLI Driver、Cursor/VSCode IDE transport 或 Multica daemon 已获得同等能力。

触及文件 TypeScript 过滤检查没有本批新增错误，仅保留 `ToolBroker.test.ts` 的一条 Effect 风格建议；格式检查和 `git diff --check` 需在最终格式化后再次执行。`t3` 全量 typecheck 仍有 312 条既有错误，主要来自 MCP Adapter 类型、Server 测试 Layer 和 branded MCP server ID 等基线问题；这些错误没有通过删除测试、`any` 或缩窄合同掩盖，后续需要按独立主题修复。真实 Cursor CLI、Cursor/VSCode transport、Multica daemon Tool-call/Grant handshake 和双 Agent 跨进程 E2E 仍未完成。

## Batch F1 落地记录：Multica Agent MCP Tool Bridge（2026-08-26）

当前 Multica 官方 daemon 已将 Agent 的 `mcp_config` 作为公开扩展点下发给受支持的 CLI/ACP 运行时。Code Work 因此不向 Multica 私有 prompt 注入身份或密钥，也不要求修改其 daemon 源码，而是增加独立的 Runtime MCP 工具面：

- 新增 `/mcp/composition-runtime` Streamable HTTP MCP endpoint，提供 `t3_runtime_invoke` 和 `t3_runtime_cancel`。Agent 只能提交 canonical tool 名、参数、`toolCallId` 与幂等键；`runtimeId`、Task、Run、Agent、Handshake 和 Grant 全部由 Bearer token 的服务端绑定注入，再进入 `CompositionRuntimeToolBridge` 和 `ToolBroker`。
- `CompositionMulticaAssigneeRoute.codeworkMcpCredentialEnvironmentVariable` 只保存环境变量名。token 通过既有 provider environment/secret 物化，并需要由管理员配置到对应 Multica Agent 的官方 `mcp_config`；`settings.json` 和 Multica 配置合同不保存 token 明文。
- Registry 只保存 token 的 SHA-256 哈希。handshake 使用 24 小时硬上限租约把 token 绑定到唯一 Runtime/Task/Run/Agent/Grant；每次调用仍要求对应 Task/Run 处于 running，终态或撤销 handshake 后立即解绑。重复 Grant、过期绑定、两个 Agent 共用 token、同一 token 在旧 Run 有效时绑定新 Run 都会 fail closed。
- 只有配置了 Agent MCP credential 且 Runtime MCP Registry 可用时，Multica Adapter 才接受 capability handshake；静态 token 本身不会自动把 Driver 标记为已验证的 `t3.toolbroker`、`t3.capability_handshake` 或 MCP Driver，必须由 Runtime probe/配置明确声明远程 MCP 能力。未配置、服务未启动、凭据冲突或远程 MCP 能力未声明时明确拒绝或保持 degraded，不降级为 full-access。
- 定向验证覆盖合同、Registry、真实 HTTP MCP transport、Settings、Multica Adapter/Protocol 和 Runtime Tool Bridge。真实 HTTP 测试使用官方 `@modelcontextprotocol/sdk` Client 完成 initialize、session 管理和 `tools/call`，并验证无 token 返回 401。

F1 审查修复补充：

- Settings fingerprint 包含已物化 environment 的摘要；Agent MCP token 轮换会重建 Adapter，并按 Runtime 撤销旧 binding。删除、禁用或替换 Runtime 不能留下仍可使用的旧 Bearer binding。
- Registry 作为显式 Layer 依赖传入 Settings 和 MCP route，不再通过模块级单例变量在不同 Layer 之间传递。handshake、Run、Runtime 和全量撤销都会通知在途 watcher。
- `t3_runtime_cancel` 只能取消同一 Runtime/Task/Run/Agent/Handshake/Grant scope 中已经登记的在途 invocation；未知 key 或其他 scope 不会写入全局取消集合。Bridge 使用可中断的 Effect fiber 竞争实际 ToolBroker 调用和 cancellation signal。
- MCP handler 会同时监听 handshake 撤销/租约到期信号；已经通过 HTTP 鉴权的调用在撤销后也会被中断，而不是只影响下一次请求。

本节点证明的是“Multica Agent 可通过官方 MCP 配置接入 Code Work ToolBroker”的 Code Work 侧真实 HTTP 工具面和授权绑定。它尚未证明真实 Multica daemon 已加载该配置、两个真实 Agent 已并行执行 Task Graph，或 Leader 已完成失败重试、结果汇聚和 Review checkpoint；这些仍是 Batch F2 的跨进程验收目标。

官方当前实现进一步限定了 F1 与 F2 的边界：

- 普通 `agent.mcp_config` 是 Agent 级持久配置；官方 CLI 可以通过 `multica agent update --mcp-config` 更新，产品 REST 使用 `PUT /api/agents/{id}`，但版本化 Public API v1 当前没有 Agent/MCP 管理合同。因此 F1 只能要求管理员预先配置每个 Agent 的 endpoint/token，不能在每次 Run 前依赖一个稳定 Public API 动态改写 Agent 配置。
- Server 在每次 claim 时会把 Agent MCP、Workspace MCP binding 和内部 `runtime_mcp_overlay` 合并；daemon 还会合并 Runtime 本地 MCP、task-local Remote MCP 和 Plugin Hook MCP。普通外部调用方没有公开的任意 task overlay API，所以 F1 的静态 Agent token 明确限制为“同一 Agent 同时只绑定一个活动 Code Work Run”，不同 Agent 必须使用不同 token。
- 真正的每 Run 短期 token 和同一 Agent 并发 Run 需要 F2 daemon extension：在 claim/start 阶段创建 task-local MCP entry，或复用官方 Remote MCP broker 的 task ID 绑定、approved tools、调用/并发限制、schema digest 和凭据即时解析模式。不得通过并发调用 `agent update` 轮换静态 header。
- ACP Runtime 只有在 initialize 中声明 HTTP/SSE MCP capability 时才能保留 remote MCP entry；不支持该能力的 Driver 必须 fail closed，不能因 stdio 或个别 Runtime 的兼容例外而对所有 ACP Driver 宣称可用。

本轮官方源码核验路径包括 `server/cmd/server/router.go`、`server/internal/handler/daemon.go`、`server/internal/daemon/client.go`、`server/internal/daemon/types.go`、`server/internal/daemon/daemon.go`、`server/internal/daemon/runtime_mcp.go`、`server/internal/daemon/remote_mcp_broker.go`、`server/internal/handler/mcp_overlay.go`、`server/pkg/agent/{claude,codex,hermes}.go`、`server/cmd/multica/cmd_agent*.go` 和 `server/pkg/publicapi/v1/openapi.yaml`。

## Batch F2：claim/start 的每 Run MCP Lease 注入合同

本节点把 F1 的每 Run Lease 从“可以生成并由 Adapter 读取”推进到 Adapter 的实际 claim/start 执行边界：

- 新增 `MulticaDaemonTaskExecutionBridge` 扩展合同。Multica Adapter 在 `dispatchTask` 成功后只保存远端 task ID 到 Code Work `taskId`、`runId`、`agentId`、grant 集合和可选 handshake ID 的非敏感绑定，不保存 raw token。
- `claimTask` 会保存远端任务事实；`startTask` 在调用 Multica 官方 `start` 协议之前，按远端 task 解析 Code Work 绑定，并通过 `taskMcpLeaseBridge` 重新读取每 Run Lease。
- Lease 必须同时满足未过期、`runtimeId`、`taskId`、`runId`、`agentId` 和 grant 集合完全匹配；失败时返回稳定的 `task_execution_context_missing`、`task_execution_binding_missing`、`task_mcp_lease_unavailable` 或 `task_mcp_lease_mismatch`，不会调用 Multica `startTask`。
- 只有 Lease 通过校验后，Adapter 才把 canonical `mcpConfig` 交给 `injectTaskStart` 扩展；扩展成功后才把远端任务标记为 running。raw token 只存在于这次进程内回调参数，不进入 settings、日志或审计正文。
- 终态回报会清理远端 task 的本地 claim 事实和执行绑定；重复 grant、重复绑定和非法输入在 quick-create 之前拒绝，避免创建远端孤儿任务。
- 没有 `taskExecutionBridge` 时，Adapter 保持原有官方窄协议行为；没有 `taskMcpLeaseBridge` 时，带 task-local handshake 的执行明确拒绝，不降级为静态 token 或 full access。

本节点的定向验证覆盖 `serverSettings`、Multica Adapter、Composition Runtime Settings、Task MCP Lease 和 contracts 共 5 个文件、56 个测试；格式检查和 `git diff --check` 通过；服务端 TypeScript 过滤检查没有本节点新增 error，仅保留仓库既有 Effect 风格 suggestions。

这仍然不是官方 Multica daemon 的真实跨进程 E2E。官方当前没有稳定的外部 task-local MCP overlay Public API，因此 `taskExecutionBridge` 是 Code Work 侧显式 daemon extension 边界；只有将该扩展接到真实 daemon/runtime start 入口并在有 Server、Workspace、两个 Agent 的环境中验证，才能宣称真实 Multica Agent 已获得每 Run Code Work ToolBroker 能力。未安装扩展、扩展无法解析绑定、Lease 过期或 scope 不匹配时保持 fail closed。
