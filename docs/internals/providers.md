# Provider architecture

同一线程可在回合结束后切换 Provider 实例。切换时 `ProviderCommandReactor` 重新创建目标实例的会话，以已落库的线程消息构建限长历史交接，并排除当前及尚未执行的排队消息。交接还包含最近已完成工具调用的短结果摘要，标记为历史参考；没有结果的旧命令不会进入交接。消息与工具活动都按本轮请求的事件日志边界排除后续排队内容，整个交接不超过 64,000 字符。`ProviderService` 只在目标实例没有兼容续聊游标时将这段历史附在首次普通请求前；原生控制命令不消费交接历史。运行中的回合保持路由锁定。助手消息事件在生成时写入 `providerInstanceId`，内存、数据库与客户端都从事件读取归属，供同一时间线展示来源；旧消息缺少此字段时保持无来源标识。

消息投影保存首次 `thread.message-sent` 事件序号；同一时间戳的消息从数据库快照恢复时按该序号排序。迁移会从事件日志回填旧投影，流式更新继续保留首次序号，使重启前后的交接顺序一致。

> For maintainers. Using Code Work? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Code Work supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with eleven entries:

| Driver kind   | Driver source                                 |
| ------------- | --------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]             |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]           |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]           |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]               |
| `kimi`        | [`Drivers/KimiDriver.ts`][kimi]               |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity] |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]       |
| `piAgent`     | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `ompAgent`    | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `acpAgent`    | [`Drivers/GenericAcpDriver.ts`][genericacp]   |
| `byok`        | [`Drivers/ByokDriver.ts`][byok]               |

Pi and OhMyPi share a BYOK-only architecture — see [pi-family-providers.md](./pi-family-providers.md); the user-configured ACP entry is covered in [generic-acp-provider.md](./generic-acp-provider.md).

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

Conversation rollback is fail-closed: an adapter must declare `threadRollback: true` only when it
restores the provider's real conversation context. Codex is currently the only built-in adapter that
does so. Before changing files, `CheckpointReactor` excludes active work in the same Git worktree and
captures a recovery checkpoint plus the original Git index. Provider rollback and the local history
commit cannot form one transaction, so failures keep the recovery references and require the caller
to verify provider context before retrying.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

### 会话错误与部分回复

`session.state.changed(error)` 表示运行中的会话已失败。接入层先把会话和当前回合标为错误，再冲刷该回合尚在缓冲的助手文字并结束已投影消息的流式状态，保留可读的部分回复。带有旧回合 ID 的状态事件不能覆盖新回合；仅 `runtime.error` 活动仍可能先于正式终态到达，不能据此提前清除正文缓存。重试以新的回合开始，历史失败记录仍可查看。

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[kimi]: ../../apps/server/src/provider/Drivers/KimiDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[pifamily]: ../../apps/server/src/provider/Drivers/PifamilyDrivers.ts
[genericacp]: ../../apps/server/src/provider/Drivers/GenericAcpDriver.ts
[byok]: ../../apps/server/src/provider/Drivers/ByokDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
