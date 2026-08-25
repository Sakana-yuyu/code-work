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

## Interfaces

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
