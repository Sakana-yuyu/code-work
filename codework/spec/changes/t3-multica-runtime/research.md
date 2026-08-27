# Research: t3-multica-runtime

## Practices

- Cursor BYOK 的普通执行会按稳定 `exec_id` 保留 pending 状态；缺失终态时只注入明确标识的合成失败结果，并继续等待或恢复后续流，不能把无事件解释为成功。来源：`E:\MyProject\cursor-byok\internal\backend\forwarder\exec_watchdog.go`、`shell_recovery.go`；该模式适合 Composition Run 的受控超时收口。
- Cursor BYOK 的 turn-stale 看门狗先给真实结果宽限，再只回收普通 pending exec；`subagent` 和 `delegation_aggregate` 等长任务由自己的 watchdog 管理。来源：`E:\MyProject\cursor-byok\internal\backend\forwarder\turn_stale.go`；因此 Composition 的第一节点仅扫描已进入 `running` 的最新 Run，不把等待审批、等待输入或旧 Run 当成失活。

## Constraints

- `CompositionTaskRuntimeProjector` 已按 `(taskId, runId, sourceEventId)` 原子去重，并在旧 Run、终态和 `in_review` 状态下只追加审计，不能绕过该投影器直接更新 Task/Run。违反后果：重放或晚到事件可能复活已终态任务，或覆盖新 Run。
- `CompositionTask.updatedAtUnixMs` 会由运行时事件投影刷新，`CompositionTaskRun` 已持久化 `runtimeId`、`runtimeTaskId`、grant 和 handshake 身份。违反后果：只依赖 Driver 内存 Map 时，进程重启后无法发现失活 Run。
- 当前 `cancel_requested` 只写入审计消息，未持久化请求时间。违反后果：服务重启后无法区分刚提交的取消和已经超过确认宽限的取消。
- Provider Runtime 的 `task.completed` 尚不表示 `timed_out`。违反后果：watchdog 无法通过现有 Projector 写入合法的 `timed_out` 终态，只能错误映射成失败或绕过投影。
- 当前 Store 可以列出 Task 并读取每个 Task 的最新 Run。第一节点可基于此扫描，避免新增全表 Run 查询和不必要的持久化接口。
- Driver 可能因 runtime 热替换或进程重启而不在 Registry 中；watchdog 的本地事件必须携带受信任的 Task/Run 关联，并且只在持久化身份与 Run 一致时被接受。违反后果：不能用外部 payload 猜测本地归属。

## Open [TBD]

- 无。本节点的超时阈值采用服务内可注入配置和保守默认值；产品级 Settings/UI 暴露在后续配置主题中决定。

## Decided

- [DEC-1] Watchdog 通过本地受信任的 ProviderRuntimeEvent 进入既有 Projector，而不是直接更新 Task 表 | source: 运行时投影和 sourceEventId 约束 | rationale: 保留幂等、旧 Run 隔离、终态锁定、grant 回收和审计的一条事实链。
- [DEC-2] 取消请求时间写入 `CompositionTaskRun`，确认宽限到期后仅收口为 `timed_out`，绝不伪造成功 | source: cancel_requested 不能表示终态 | rationale: 取消确认和真正终态分离，支持进程重启后的确定性恢复。
- [DEC-3] 第一节点只扫描最新且 `running` 的 Run，跳过等待审批、等待输入、review、终态及旧 Run | source: Cursor BYOK 长任务/等待态保护语义 | rationale: 避免把正常等待或重试中的历史执行误判成孤儿。
