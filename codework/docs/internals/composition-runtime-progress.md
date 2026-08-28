# TCode 多 Agent 运行时迁移进度

## 文档目的

本文记录 `tcode` 分支把 `cursor-byok`、Code Work 原生 Provider/Tool 能力与 Multica 多 Agent 协同接入统一 Composition 运行时的实施进度。

架构差距、功能取舍和目标数据流以 [byok-multica-migration-matrix.md](./byok-multica-migration-matrix.md) 为准；本文只维护已经实施的节点、验证证据、剩余缺口和下一步顺序。下一位接手请先读 [byok-ai-handoff.md](./byok-ai-handoff.md)（剩余切片、不可推翻的判断、工作区陷阱）。

## 当前快照

| 项目     | 当前值                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 更新时间 | 2026-08-28                                                                                                                                                                                                  |
| 仓库     | `E:\MyProject\code-work\codework`                                                                                                                                                                           |
| 当前分支 | `tcode`                                                                                                                                                                                                     |
| 当前提交 | BYOK 缺口补齐节点：`feat(byok): 补齐余额看板、Supplier 管理、resume 重派与 delegation 收敛`                                                                                                                 |
| 相对远端 | 领先 `origin/tcode` 104 个提交，尚未 push                                                                                                                                                                   |
| 最新节点 | BYOK 剩余缺口批量补齐：余额/用量/健康统一看板、Supplier 启停与凭据轮换操作面、resume 恢复后自动重派（含控制中心入口）、delegation 状态投影进 Composition 台账、控制中心与 Supplier 注册表的 Mobile 面板复用 |
| 范围调整 | 真实 Cursor/VS Code Adapter 接入与真实 Multica daemon 协同/输出查询列为**后期内容（本次不做，TODO 待排期）**；当前阶段仅对接 BYOK Driver，本地协议与进程级验证维持既有结论                                  |
| 上游基线 | 已并入上游 `t3code` v0.0.35（合并提交 `05d694cfa`）：PR 关联线程、Claude 旧线程压缩、git push base 分支修复等；上游迁移 042/043 因与本地 composition 迁移撞号重编为 054/055                                 |

## 证据等级

本文不使用单一百分比表达完成度。协议底座、真实产品接入和多端可用性成熟度不同，用一个数字会掩盖关键缺口。

| 等级                 | 含义                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| L1 已编码            | 实现已进入当前分支，但不能单独证明行为正确                                                   |
| L2 聚焦测试通过      | 对应单元、集成或回归测试已通过                                                               |
| L3 本地跨进程通过    | 使用本地子进程或协议 fixture 验证了进程边界、事件流或工具回流                                |
| L4 真实产品 E2E 通过 | 使用真实 Multica daemon、真实 Cursor/VS Code、真实 Provider API 或真实多端客户端完成关键路径 |
| L5 可发布            | 完成故障演练、权限审计、升级兼容、回滚和发布前验证                                           |

## 总体目标

```text
Code Work Web / Desktop / Mobile 壳
              |
              v
Composition Task / Run / Event / Lease
              |
              v
统一 Agent Driver Registry
  + Provider Driver -> Codex / Claude / OpenCode / BYOK API
  + IDE Driver      -> Cursor / VS Code Adapter
  + Runtime Driver  -> CLI / ACP / 外部进程
  + Multica Driver  -> Agent / Squad / Leader / Task Graph
              |
              v
CapabilityRegistry + ToolBroker
  -> Workspace / Terminal / Git / MCP / Browser / IDE API
```

目标不是把 Cursor 私有协议直接塞进 Code Work 核心，而是让每个 Driver 通过稳定的 Composition 合同运行，并在完成 task-scoped capability handshake 后受控调用 Code Work API、MCP、工作区工具和对应 IDE API。

## 阶段进度

### 1. Composition 统一控制面

**状态：L2，核心底座已具备，跨重启监督仍需继续完善。**

已完成：

- 已有 Composition Task、Run、Event、Dependency、Lease 和 Agent Driver Registry。
- 已加入运行时事件归属、早到事件保留、委派事件隔离和 Run 活性 watchdog。
- 已接入运行时任务恢复，并覆盖 ACP 取消后完成事件的回归场景。
- 本地 Task Graph 已能表达依赖、并行、有限重试、失败取消和结果汇聚。
- 新增 `CompositionGoalLoop` 第一切片（纯注入式运行时）：识别 `[[GOAL_COMPLETE]]`/`[[GOAL_COMPLETE: 原因]]` 完成标记与 `[[GOAL_CANCELLED]]` 显式取消标记；attempt 回调可读剩余轮数/剩余成本；支持 maxAttempts、maxCostUnits、deadlineUnixMs（注入 now）与外部 isCancelled 注入，终止判定按"取消 > 截止 > 轮数/成本预算"优先级收敛为 completed/budget_exhausted/deadline_exceeded/cancelled。
- 新增 idle/stale pivot 判定：`stalePivotRounds` 启用后，连续 N 轮无进展输出（归一化文本与上一轮相同，含空输出空转）即按 `pivot_required` 收敛并暴露 `pivot.staleRounds`/`pivot.lastCleanText`；输出变化重置计数，同轮出现完成/取消标记仍以标记为准，轮开始前的取消与轮数/成本预算判定不受影响。
- 新增验证子代理合同：`validateCompletion` 注入后，完成标记需经验证方接受才收敛为 completed；拒绝的声明记录进 `rejectedCompletions`（round + detail）并继续循环，其输出同时参与停滞判定，可与 pivot 同轮收敛；验证方错误与 attempt 共用错误通道原样上抛。合同含 round/value/cleanText/reason/history 快照上下文，真实"再派 agent 校验"的 validator 实现后续接入此接入点。
- 新增编排接线层 `CompositionGoalLoopRunner`（本节点）：在 Goal Loop 之上把循环事实以幂等 `goalloop:<task>:<run>:*` 事件行投影进任务台账——首 attempt 前落 start 行（非法配置零落账）、每轮 progress 行（仅轮次与成本，不含原始输出文本）、验证拒绝 blocker 行、终态按 completed/failed/cancelled/timed_out/blocked 映射 status 行并统计拒绝次数；attempt 由调用方对接具体 Driver（BYOK 模型循环 / Multica 远端 dispatch），契约测试以去重内存台账验证投影、幂等重放与敏感内容不落账。

- 新增跨重启监督：`CompositionGoalLoopSupervisor` 按 (taskId, runId) 作用域扫描台账行（`goalloop:*` 幂等前缀），"已开始且无终态行、无 supervisor 结算行"即判定为跨重启未收敛，并统计已完成轮次/拒绝次数；结算落幂等 `supervisor:redispatch`（blocked，待改派）或 `supervisor:abandon`（failed，放弃恢复）行，已收敛 Run 结算、重复结算、写入被抢占分别显式报 `not_interrupted`/`already_settled`。
- 新增 supervisor→编排层自动重派接线（本节点）：`settleAndRedispatchInterruptedGoalLoop` 按"纯扫描判定 → run 存在且为最新 Run 校验（失败零副作用）→ supervisor 幂等结算 → 陈旧 running 态 run/task 落 failed（failureCode=goal_loop_interrupted，满足 retryTask 仅失败可重试门槛）→ 调用 redispatch 回调"顺序执行；测试接入真实 SQLite 内存 store 与真实 orchestrator.retryTask，验证新 Run 创建、陈旧 Run 标记 `goal_loop_interrupted`、task 从 failed 回到 running。

- 新增子代理验证器实现（本节点）：`CompositionGoalValidator` 定义显式裁决标记 `[[GOAL_VALID]]`/`[[GOAL_INVALID: 理由]]`，缺标记或双标记一律 fail-closed 按拒绝处理；`composeGoalValidatorPrompt` 组装含目标/完成声明/历史轮次摘要的评审提示词（逐项截断防无界增长）；`makeSubAgentGoalValidator` 把"提示词→端口评审→标记解析"包装成 validateCompletion 注入；`makeByokSubAgentValidatorPort` 把验证子代理接到 BYOK 生产模型循环（CompositionAgentService，无工具、maxRounds=1、无 capability grant 的独立评审调用）。

- 新增 attempt 生产适配器（本节点）：`makeByokGoalLoopAttempt` 把每一轮接到 BYOK 生产模型循环（CompositionAgentService.run，提示词自动带 Goal Loop 轮次与完成标记说明，costUnits=1/轮，错误通道原样透传）；`makeMulticaGoalLoopAttempt` 把每一轮接到 Multica 远端（quick-create 派发 → 轮询 getTaskStatus 至终态，agentId/squadId 互斥校验、可注入 now/sleep、失败态与超时显式报 `multica_round_failed`/`multica_round_timeout`）。远端协议当前只回状态不回输出，完成文本依赖可选 `fetchOutput` 钩子，未提供时轮产物为空文本参与停滞判定。

- 新增 Byok delegation 状态收敛第一切片（本节点）：`ByokDelegationService.submit` 现把每次委派的 queued/running/终态迁移以幂等 `byok-delegation:<task>:<run>:<phase>` 事件行投影进 Composition 台账，并在首次落行后 upsert 合成 Task/Run（`projectId=byok-delegation`、`agentId=provider:<instanceId>`（沿用 Supplier 投影约定）、`runtimeTaskId=调度器 delegation-N`；succeeded→completed、failed→failed+errorCode、两类超时→timed_out 并区分 `delegation_queue_timed_out`/`delegation_execution_timed_out`、cancelled→cancelled），迟到低阶状态只补事件行不回退已推进的 Task/Run；taskId 用 randomUUID 而非调度器计数器（后者跨重启复用，不能当台账主键）。敏感约定：委派 prompt 只落 `sha256:` 摘要（`promptDigest`），原文与输出文本不进台账，摘要只含委派 ID/状态/错误码/输出字符数。台账经 `Effect.serviceOption(CompositionTaskStore)` 可选注入，ws.ts 零改动即生效；`submit` 重构为"同一同步 tick 内提交+订阅"以消除让出执行权后丢事件的窗口。投影 4 用例 + 服务级集成 2 用例。

- 新增 Byok delegation 跨重启收口（本节点）：`scanByokDelegationRun` / `recoverInterruptedByokDelegations` 复用 Goal Loop「无终态行即中断」扫描——`projectId=byok-delegation` 且最新 Run 仍为 queued/running、调度器内存没有对应 `runtimeTaskId`（进程重启后 live 集合为空）则幂等写入 `terminal:failed`（failureCode=`byok_delegation_interrupted`），已终态不回退，重复扫描零副作用，摘要只含委派 ID/状态/错误码。接线：Composition 运行时 boot 做一次空 live 集合扫描；`ByokDelegationService.make` 首次调用再带当前 in-flight ID 扫一次（模块级 once）。真实 SQLite 覆盖 queued/running 收口、已终态不改写、live 条目跳过、幂等重扫。
- 控制中心消费委派台账（本节点）：`projectCompositionControlCenter` 识别 `projectId=byok-delegation` 合成 Task，投影可选 `byokDelegation`（delegationId/status/attempt/failureCode），**不**套 Goal Loop 五态、不把 prompt/输出带进投影；Web/Mobile 用独立「BYOK 委派」徽标与 agentId/轮次/错误码摘要，委派行不提供 Goal Loop 重派/放弃/composition 取消。

仍缺：

- Multica 真实 daemon 的输出查询能力（`fetchOutput` 生产实现）——依赖服务端暴露输出查询接口，属外部环境缺口。
- Byok delegation 的**彻底**单一状态源收敛：台账投影已就位且可独立查询，但调度器内存仍是 `submit` 返回值与 `list` RPC 的权威来源（投影失败被降级为不中断委派），且未进入队列的拒绝快照（disabled/未配置）不落台账；彻底收敛需把 `DelegationScheduler` 队列改为读写 Composition Run。
- 控制中心委派行目前只读展示；委派取消/重试仍走调度器 RPC，未接到 composition cancel。

### 2. BYOK Provider Driver

**状态：L2，模型循环和持久化恢复路径已形成聚焦测试闭环；真实 API E2E 未完成。**

已完成：

- BYOK Provider 可通过 Composition Driver 运行模型循环并调用统一 ToolBroker。
- 修复运行时事件归属和工具审计身份，避免跨 Run 串流或审计主体不一致。
- 收紧取消终态竞争、安全重试和模型流终态校验。
- 限制上下文无界增长，并增加上下文溢出后的恢复路径。
- 文本 checkpoint 先写入 SQLite，再发布 `content.delta`。
- 部分输出使用确定性事件 ID、SHA-256 增量摘要和 UTF-8 累计字节偏移。
- 重放时可去重并恢复截断前正文；Store 失败会显式收口。
- 新增 `CompositionByokCheckpointRecovery`：跨重启按持久化事件行重构正文，逐行校验 SHA-256 摘要与 UTF-8 偏移连续性；被篡改、缺口或空集显式失败，不返回伪造正文。
- 落地 `supportsResume` 的启用条件：仅当 Driver 注入 `checkpointHistory`（`listEvents` 恢复路径）时 profile 才承诺 resume，并携带 `byok.checkpoint_recovery` 能力；未注入时 `resumeTask` 显式返回 `byok_resume_not_supported`。
- **resume 对外语义（重要）**：BYOK 的 resume = 校验并恢复"已经落盘的部分输出"，供上层展示和决定重派；不承诺续跑中断的模型流。运行中请求返回 `already_running`，已终态返回 `already_terminal`。
- 恢复结果现以两类幂等投影对外可见：任务历史新增 `byok-restore:*` 状态行（段数/字节数），事件流发布确定性 `runtime.warning`（payload 带 restoredChunks/restoredUtf8Bytes）；同一实例重复 resume 不重复投影。
- 新增 resume 后自动重派接线（本节点）：`settleAndRedispatchRecoveredByokRun` 按"纯校验（run 存在且归属一致、是最新 Run、未终态、无既有结算行、checkpoint 链完整可恢复、恢复输入存在；任一失败零副作用）→ 幂等 `byok-redispatch:<task>:<run>:settle` 结算行（重复触发与写入被抢占均报 `already_settled`）→ 陈旧 run/task 落 failed（failureCode=`byok_resume_interrupted`，满足 retryTask 仅失败可重试门槛）→ 恢复输出以 `[[BYOK_RESUME_CONTEXT]]` 标记块截断写回恢复输入 prompt（保留尾部 2000 字符，组装前剥离旧块防多次恢复无界增长）→ 调用真实 `orchestrator.retryTask` 创建新 Run 续跑"顺序执行；结算行摘要只含段数/字节数，恢复原文不落账。真实 SQLite + 真实 retryTask 测试 7 用例。
- 新增 resume 重派的 RPC 与控制中心入口（本节点）：contracts 新增 `serverControlCenterByokResumeRedispatch`（请求形状对齐既有 `serverControlCenterRedispatch`，结果只回 previousRunId/newRunId/恢复段数/恢复字节数，不含恢复正文）；授权 `AuthOrchestrationOperateScope`；ws.ts 新增 `CompositionTaskInputStore` 服务依赖与专用错误映射 `compositionByokResumeError`——共用 `compositionTaskError` 按 `_tag` 取码会把九种失败塌缩成两种，故解包 `code` 字段后逐一稳定映射（task/run missing、not_latest、run/task_terminal、already_settled、input_missing、checkpoint empty/digest_mismatch/offset_gap）。**门槛判断结论**：仅凭 `byok_resume_interrupted` failureCode 不可用作按钮门槛——该码只由本函数结算时写入，带此码的 Run 必然已有结算行，重复触发只会报 `already_settled`；故在 `projectCompositionControlCenter` 新增 `byokResume` 字段（仅当最新 Run 真实存在 `byok:` checkpoint 行时填充，含 checkpointCount/recoveredUtf8Bytes/recoverable/redispatchSettled/recoveryFailureCode），投影内跑 `recoverPersistedCheckpointText` 并把校验失败降级为 `recoverable: false` + 稳定码而非上抛，恢复正文不进投影（测试断言）。面板门槛抽为纯函数 `isByokResumeRedispatchable`（要求存在最新 Run、排除 redispatchSettled、接受 `byok_resume_interrupted` 或校验通过的可恢复链），沿用 `runRowCommand` 行操作收敛；server 侧投影/重派/授权 14 用例、Web 面板 14 用例通过。

最新验证：

- 本节点目标回归（恢复/Driver/Orchestrator/RuntimeProjector/GrantRegistry）5 文件 68/68 用例通过，其中恢复用例扩展断言了恢复投影的 payload、事件行内容与去重。
- Orchestrator 新增 grant 投影用例 2 个：下发投影带 capabilityId@grantId 摘要；旧 Run 撤销在 retryTask 时落 `revoked` 幂等行。
- 此前节点基线：进程重启级恢复测试与目标回归通过记录见 git 历史（本表只维护最新一轮）。
- 实现文件 lint 通过，19 个目标文件格式检查通过。
- `git diff --check` 通过，目标文件 TypeScript 错误为 0（新增文件的既有 suggestion 级提示不计入）。
- 包级 typecheck 仍被仓库内既有 MCP、IDE、server test 和 `local_tools` 等错误阻断，不能宣称全包类型检查通过；composition 全量套件中仅 `CompositionMcpRuntimeAdapter.e2e.test.ts` 真实 stdio E2E 失败，属既有环境问题，与本次改动无关。

仍缺：

- 使用真实 OpenAI/Anthropic/Gemini 兼容 API 的断线、重试、限流和凭据轮换 E2E（唯一阻塞项：需要真实 API 凭据，非代码缺口）。
- Provider 原生 Session/Turn 的真实 capability grant 注入、撤销回执和审计闭环。
- 模型分组、权重路由、自动匹配和 failover 状态机（Supplier/Profile 控制面见第 6 节，本节点已补齐只读看板与启停/凭据操作面）。

已清偿（本节点）：Mobile 控制中心接通 BYOK 恢复重派入口；门槛与 Web 共用 `@codework/contracts` 的 `isByokResumeRedispatchable`（存在最新 Run、排除 `redispatchSettled`，接受 `byok_resume_interrupted` 或可恢复 checkpoint 链）。Desktop 经共享 Web 设置页天然可达。

### 3. IDE Agent Driver

**状态：L3，自定义 JSON-RPC bridge 已通过本地跨进程验证；真实 Cursor/VS Code 接入列为后期内容（本次不做，TODO 待排期），当前仅对接 BYOK。**

已完成：

- 通用 IDE JSON-RPC transport。
- transport 断线重连、有界自动重连和注销关闭。
- IDE session 设置生命周期、Web 设置入口和状态查询。
- IDE Agent Driver 与 `task.start`、`task.cancel`、progress、completed 事件流。
- 本地子进程 fixture 已验证事件隔离、去敏和 IDE ToolBroker 跨进程回流。

仍缺：

- Cursor 或 VS Code 官方 Extension、IPC 或 API handshake。
- 真实 IDE 的能力版本协商、断线恢复、授权撤销和过期处理。
- IDE API 的明确白名单、用户授权界面和审计查询。
- Web、Desktop、Mobile 对 IDE session 状态的完整可达性验证。

### 4. CapabilityRegistry 与 ToolBroker

**状态：L2/L3，本地统一调用路径存在；所有 Driver 的生产授权闭环尚未完成。**

已完成：

- Code Work 原生 Workspace、Terminal、Git/Worktree、MCP、Browser/Preview 等能力可由 ToolBroker 统一承载。
- BYOK loop 和本地 Runtime bridge 已验证 HTTP/MCP 工具路径。
- IDE 子进程 fixture 已验证工具调用可以跨进程回流。
- capability handshake 合同、策略和运行时身份已经进入 Composition 设计。
- （本节点）Grant 生命周期投影：首次派发与重试签发后写入 `issued` 幂等事件行（含 capabilityId@短 grantId 摘要），撤销路径写入 `revoked` 行（含项数）；sourceEventId 形如 `capgrant:<task>:<run>:<action>`，天然防重放刷屏。

仍缺：

- Provider、Multica 和真实 IDE Adapter 的 task-scoped grant 实际下发。
- grant 的接受、拒绝、撤销、过期和断线回收回执。
- 不同 Driver 对 IDE API 与 Code Work API 的能力映射表。
- 跨端授权状态展示及高风险工具的交互式确认。

### 5. Multica Agent / Squad / Leader

**状态：L3 的本地协议与进程级 HTTP 集成已闭环；真实 Multica daemon 协同与输出查询列为后期内容（本次不做，TODO 待排期），当前仅对接 BYOK。**

最新验证（本节点）：

- 新增 outbox 审计/收口单测 4 用例、真实 HTTP 进程级 e2e 2 用例通过；Multica 协议、Adapter、Runtime Settings 回归共 52/52 通过。
- 新增/触碰文件 lint 0 错误；目标文件 typecheck 无 error 级问题（既有测试文件的 `runPromise` 类 lint 债务不计入本次）。

已完成：

- Multica daemon register、heartbeat、claim、status、complete、fail 的窄协议适配。
- 使用正式 `POST /api/issues/quick-create` 创建远端排队任务，并显式映射 `agent_id`、`squad_id`、Runtime 和 Workspace。
- quick-create 发送意图已持久化，减少本地重试状态丢失。
- 新增持久化 outbox 审计与收口（`MulticaQuickCreateOutbox`）：把 pending intent 分为可安全重派（prepared）、需人工核对收口（stale sending）、在途观察三类；提供 `settleStaleSendingIntent` 仅在 sending 态原子绑定人工核对取得的远端 task ID，重复 settle 或对 prepared settle 显式失败。
- quick-create POST 现在携带本地已持久化的幂等键头 `X-Idempotency-Key`；服务端一旦支持即可据此去重。
- Runtime Settings live 层启动时审计 outbox，发现悬挂 sending 即告警，静默丢失不可能。
- 本地 Node 子进程已验证 control 与 task-event 双通道回流。
- 新增真实 HTTP 进程级集成测试（`MulticaQuickCreateHttp.e2e.test.ts` + 独立进程 daemon fixture）：覆盖 happy path、响应丢失后拒绝重放、审计发现悬挂、查回远端 ID 收口、重派命中 accepted 恢复且全程只产生一次 POST。
- Composition 本地 Task Graph 已具备 Leader 汇聚所需的依赖调度、并行和失败处理底座。

仍缺：

- 启动真实 Multica daemon，验证真实身份、数据库、权限、heartbeat、claim 和任务回报。
- 查询真实 Agent/Squad、动态成员调度、Leader 结果映射和跨重启监督。
- 真实服务端的幂等键语义确认：当前 `X-Idempotency-Key` 已出站，但收到 4xx/忽略该头时重复创建防线依赖"拒绝重放 + 人工收口"，还不是全自动。
- 悬挂 sending 的自动查询回源接口：收口目前需要外部（人或 by-key 查询类能力）提供远端 task ID。
- 完整外部 cancel/resume 协议和断线重连演练。
- Multica Runtime 获得 Code Work ToolBroker 能力的真实授权与调用闭环。

### 6. Settings、控制中心与多端体验

**状态：L1/L2，已有入口和局部页面，尚未形成完整产品闭环。**

已完成：

- Code Work 已有 Provider Settings、Agents、IDE sessions、MCP 和 Task Graph 等入口或组件。
- Web/Desktop/Mobile 共享同一 Server/RPC 架构，具备承载统一运行时状态的基础。
- 新增控制中心统一投影：`projectCompositionControlCenter` 只读聚合——按任务输出最新 Run（runId/status/attempt/failureCode）、Goal Loop 五态投影（not_started/running/converged/supervisor_settled/interrupted，源自台账扫描 + Run 状态区分活跃与中断）、capability grant 审计摘要（事件数/撤销数/最近 outcome）、依赖任务 ID，并按调用方给定的 squadIds 展开 Squad 名册；真实 SQLite 内存 store 上验证五类任务形态与缺失 Squad 的容错。
- 控制中心 RPC 与 Web 接线：contracts 新增 `serverControlCenterProjection` 方法与请求/结果 schema；ws.ts 以 `compositionTaskStore`/`compositionGrantRegistry` 服务注入投影（Composition 不可用时显式 `composition_unavailable`）；授权沿用 `AuthOrchestrationReadScope`；client-runtime 新增 `controlCenterProjection` 查询原子；Web 设置"集成"页新增"组合控制中心"区块（任务行含状态/Goal Loop 徽标/轮次/拒绝/grant 摘要、Squad 名册、四态空错提示），i18n 双语目录（`controlCenter.*`）齐全，面板 4 用例 + i18n 静态扫描 157/157 通过。
- 控制中心自动重派操作入口：contracts 新增 `serverControlCenterRedispatch` 方法与请求/结果 schema（taskId/runId/agentId/客户端生成 newRunId/capabilityIds/可选 note）；授权要求 `AuthOrchestrationOperateScope`；ws.ts 经 `settleAndRedispatchInterruptedGoalLoop`（supervisor 结算 + 陈旧 Run 落 failed）回调真实 `compositionOrchestrator.retryTask` 创建新 Run，错误经 `compositionTaskError` 统一映射；client-runtime 新增 `controlCenterRedispatch` 命令原子（按 taskId+runId singleFlight）；面板为 `interrupted`/`supervisor_settled` 且存在最新 Run 的任务行渲染"自动重派"按钮与共享 capabilityIds 输入（逗号拆分、`t3-redispatch-<uuid>` 新 RunId），成功后刷新投影、失败经 `squashAtomCommandFailure` 展示；面板 7 用例（按钮仅 actionable 行、输入构建纯函数、四态空错回归）+ i18n 静态扫描通过。
- 控制中心取消操作入口：复用既有 `serverCancelCompositionTask` 四层接线（contracts/ws/`AuthOrchestrationOperateScope`/client-runtime `cancelCompositionTask` 命令原子均已就位），面板为最新 Run 处于活跃状态（queued/dispatched/resuming/running/waiting_approval/waiting_input/in_review，与服务端投影 `RUN_ACTIVE_STATUSES` 一致）的任务行渲染"取消"按钮，reason 取 `controlCenter.cancelReasonDefault` 双语缺省文案；行操作统一收敛为 `runRowCommand`（pending 守卫、失败 `squashAtomCommandFailure` 展示、成功刷新投影）；面板 8 用例（取消按钮仅活跃 Run 行、终态 failed/completed/cancelled 与无 Run 行不渲染）+ i18n 静态扫描通过。
- 控制中心审批操作入口：复用既有 `serverReviewCompositionTask` 四层接线（contracts/ws/`AuthOrchestrationOperateScope`/client-runtime `reviewCompositionTask` 命令原子均已就位），面板为 `task.status === "in_review"` 且存在最新 Run 的任务行渲染"通过/驳回"按钮（与 TaskGraphPanel 的审批门槛一致，后端对非 in_review 任务显式报错），decision 取 `approve`/`reject` 字面量、reason 分别取 `controlCenter.approveReasonDefault`/`rejectReasonDefault` 双语缺省文案；面板 9 用例（通过/驳回仅 in_review 行、running 行与无 Run 行不渲染、in_review 行取消入口并存）+ i18n 静态扫描通过。
- 控制中心放弃结算操作入口：服务端从 `settleAndRedispatchInterruptedGoalLoop` 抽出共用结算流程，新增 `settleAndAbandonInterruptedGoalLoop`——同一"纯扫描 → run/task/最新 Run 校验（失败零副作用）→ supervisor 幂等结算"流程落 `supervisor:abandon`（failed）结算行并把陈旧 run/task 落 failed（failureCode=`goal_loop_abandoned`），**不创建新 Run**，2 新用例（放弃结算落行与不新建 Run、已收敛循环拒绝且零副作用，全家 49/49）；contracts 新增 `serverControlCenterAbandon` 方法与请求/结果 schema（abandonedRounds 返回中断轮次）；授权 `AuthOrchestrationOperateScope`；ws.ts 仅依赖 `compositionTaskStore`（无需 orchestrator）；client-runtime 新增 `controlCenterAbandon` 命令原子（singleFlight）；面板为 goalLoop `interrupted` 且存在最新 Run 的行渲染"放弃结算"按钮（supervisor_settled 行已有结算行会被服务端拒绝，不提供入口），与"自动重派"构成 interrupted 行的两种收敛选择；面板 10 用例 + i18n 静态扫描通过。
- Supplier/Profile/Account 统一只读投影：contracts 新增 `CompositionSupplierRegistryEntry/Result` schema；新增 `projectCompositionSupplierRegistry` 纯投影——把每个 Provider 实例（`ProviderInstanceRegistry` 适配输入）映射为一个 Supplier 条目（continuationKey 账号锚点、启用态、默认模型），按代码库既有 `provider:<instanceId>` agentId 约定挂上派生的 Agent Driver 档案摘要（runtimeId/status/supportsResume），`provider:` 前缀但无实例的档案识别为孤儿（实例移除后未回收的 Driver，多账号回滚关注对象），非实例派生档案（acp/cli）不参与投影；3 用例（约定挂档与字段透传、孤儿与非参与档案、无档案实例），全家 388/388。
- Supplier 注册表 RPC 与 Web 接线：contracts 新增 `serverSupplierRegistry` 方法与请求/结果 schema；授权 `AuthOrchestrationReadScope`；ws.ts 以 `providerInstanceRegistry`/`compositionAgentDrivers` 服务注入（均缺失时显式 `composition_unavailable`），把 `listInstances`/`listProfiles` 适配为纯投影输入（instanceId/driverKind/displayName/enabled/continuationKey/defaultModelId）；client-runtime 新增 `supplierRegistry` 查询原子（5s stale）；Web 设置"集成"页在组合控制中心下新增"Supplier 注册表"只读区块（条目含名称/驱动类型/启用态/账号锚点/默认模型/档案摘要，孤儿档案独立警示行），i18n 双语目录（`supplierRegistry.*`）齐全，面板 5 用例（字段渲染、孤儿提示有无、四态空错回归）+ i18n 静态扫描通过。
- 类型与 Effect 规则基线修正（本节点）：修复 contracts `settings.test.ts` 品牌化 `CompositionMcpServerId` 索引（显式收窄）后，vp typecheck 短路逐包剥出 committed 代码既有隐性违例并全部清偿——shared `relayClient.test.ts` `node:path` 改 `effect/Path` 服务；web 两个设置面板移除 `SettingsSection` 不存在的 `description` prop、控制中心行命令参数改用导入的 `EnvironmentId`（原 `typeof` 循环引用）、TaskGraphPanel 补 `resuming` 状态标签；desktop 早期启动恢复 `resolvePreferredEnv` 的 `T3CODE_HOME` 遗失环境名（批量改名工具合并重复参数所致）、两个后端测试去 `node:path`、`DesktopWslEnvironment` 改 `Effect.fn` 形态、backend pool 空实例测试改 `Effect.exit` 断言；web `persistenceStorage` 恢复被改名工具破坏的 `t3code:`→`codework:` 迁移键并重写 7 用例；marketing schema 调用点跟随导出改名；scripts 构建脚本合并双重 `catchTag` 为 `catchTags`、移除未用导入；mobile `app.config.ts` 消除无用数组展开；server `serverSettings.test.ts` 品牌 key 收窄 + 补齐 `schemaVersion/enabled/trusted` 必填字段（23/23 回归）、ws.ts 控制中心/Supplier 处理器 `Date.now()` 全部改 `Clock.currentTimeMillis`、投影入参按 exactOptionalPropertyTypes 改条件展开。contracts/shared/client-runtime/web/desktop/marketing/scripts 类型检查与触及文件 lint/format 全部 0 错误 0 警告。

- BYOK 余额/用量/健康统一看板（本节点）：contracts 新增 `serverByokBalanceDashboard` 方法与请求/结果 schema——适配器健康四态 `ok/empty/unsupported/error`，其中 **`empty` 仅在查询成功且余额耗尽时出现、`error` 一律保留原始错误码与消息，两态严格区分不吞错误**；实例级聚合五态含 `degraded/failed`。服务端新增纯聚合投影 `ByokBalanceDashboardCore` 与 `ByokBalanceService.dashboard`（枚举全部 byok 实例适配器、复用既有 balance 查询与正负缓存）；授权 `AuthOrchestrationReadScope`；client-runtime 新增 `byokBalanceDashboard` 查询原子（30s stale）；Web 设置"集成"页在 Supplier 注册表下新增 BYOK 余额看板区块（总计行 + 实例卡片 + 适配器行：健康徽标/余额摘要/错误消息/缓存标记），i18n 双语 `byokBalance.*` 齐全；投影 6 用例 + 服务聚合用例（含密钥零泄漏断言）+ 面板 5 用例通过。
- Supplier 管理操作入口（本节点，第一切片：启用态与凭据生命周期）：contracts 新增 `serverSupplierSetInstanceEnabled`/`serverSupplierUpdateCredential` 与 `SupplierAdminRpcError`（五类稳定失败码）；服务端新增纯函数 `SupplierAdminCore`，在 `providerInstances` 整图上切换 envelope enabled（`resolveProviderInstanceEnabled` 最严格优先语义，同步 config 旧 enabled 标志）、轮换 BYOK 适配器 apiKey/balanceAccessToken 与实例敏感环境变量（写入即清除 `*Redacted` 占位标志，避免持久化层把新密钥误判为占位符），经 `ServerSettingsService.updateSettings` 落盘并复用既有 registry 热加载，无需改 `ProviderInstanceRegistry`；授权 `AuthOrchestrationOperateScope`；**敏感字段合同：结果与错误 detail 只含定位信息（实例/适配器/变量名/字段名），凭据值零回显、不进投影不入日志**（专门测试断言）；client-runtime 新增两个命令原子（按 instanceId singleFlight）；Web Supplier 注册表面板每行新增启用/禁用切换与懒展开凭据表单（password 输入），面板扩至 7 用例；核心 6 用例 + RpcAuthorization 6 用例通过。
- 控制中心与 Supplier 注册表 Mobile 面板复用（本节点）：移动端设置主屏新增"集成"分组入口，`SettingsContentStack` 注册 `SettingsControlCenter`/`SettingsSupplierRegistry` 两个路由屏（linking `settings/control-center`、`settings/supplier-registry`），复用 client-runtime 既有 `controlCenterProjection`/`supplierRegistry` 查询原子与 `controlCenterRedispatch`/`cancelCompositionTask`/`reviewCompositionTask`/`controlCenterAbandon` 命令原子，无新增服务端接口；任务行含状态/Goal Loop 五态徽标/轮次/拒绝/grant 摘要与 Squad 名册，Supplier 条目含名称/驱动/启用态/continuationKey 账号锚点/默认模型/档案摘要与孤儿档案警示，四态空错与下拉刷新齐全；五个操作入口全部接通，行渲染门槛与 Web 一致并抽成 `*.logic.ts` 纯函数（重派在移动端不暴露 capabilityIds 输入，固定空数组，不重发 capability grant）；i18n 新增 `integrations`/`controlCenter.*`/`supplierRegistry.*` 键组，en/zh-CN 双语齐全；logic 测试 23/23 通过。Desktop 经共享 web 设置"集成"页天然可达（`/settings/integrations` 为侧栏无条件导航项，页内唯一 `isElectron` 分支只影响浏览器预览默认值），无需单写面板。

仍缺（本次范围，按对 BYOK 闭环的价值排序）：

- BYOK 真实 API 生产验证（真实 key 走通模型循环、resume、余额查询的 E2E）——**当前唯一的非代码阻塞项，需要真实凭据**。
- 多账号与账号级凭据回滚：本节点已补启用态与凭据轮换，但账号级 profile 回滚未实现——Code Work 没有独立 Account Profile 存储（迁移矩阵第 1、6 节明确 Provider Instance ≠ Cursor 账户），回滚需先落"凭据版本历史/账号快照"持久化合同（建议 secret store 侧保留上一版本 + `rollbackCredential` RPC，以 `updatedFields` 审计行为依据），记为独立切片。
- 模型分组、权重路由、自动使用匹配与 failover 状态机（仍为"只有底层零件"）。
- Request Lab、通用请求镜像、脱敏回放和协议对比界面。
- 多端真实集成 E2E（Web/Desktop/Mobile 面板已接通，真实多端刷新与凭据链路验证未做）。

已清偿（本节点）：

- 委派台账的消费端 UI：控制中心投影新增可选 `byokDelegation`，Web/Mobile 用独立徽标/摘要区分 Goal Loop 与 BYOK 委派，空态文案同步；委派行不套 Goal Loop 五态扫描与操作入口。

已清偿（前节点遗留）：

- apps/server 包整体 typecheck：前节点记录的约 520 处既有隐性错误已全部清零，`server.test.ts` 路由层 133/133 通过（含本节点新增的 4 个 ws handler）。Mobile 端剩余 17 处错误全部位于用户并行未提交的 ComposerEditor/T3ComposerEditor 改名级联文件，按工作区边界不计入本进度。
- web 端 i18n 门禁：上游 v0.0.35 合并带入的 20 处英文硬编码文案（Claude 压缩提示、PR 关联菜单、用量页明细）已补齐双语，`node scripts/check-ui-i18n.mjs` 对 web/mobile/desktop 三端全绿。

后期内容（本次不做，TODO 待排期）：

- 真实 Cursor/VS Code Adapter 接入（capability handshake、最小 IDE API 白名单、撤销测试）——依赖真实 IDE 环境。
- 真实 Multica daemon 协同与输出查询的生产实现——依赖真实 daemon 服务端能力。
- 依赖真实 IDE/Multica 环境的多端真实集成 E2E；BYOK 路径的多端验证仍在本次范围。

## 当前提交节点

当前 `tcode` 相对 `origin/tcode` 的 46 个提交按主题归并如下。

| 主题                         | 提交范围                                                                 | 结果                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IDE transport 与 ToolBroker  | `7357e17e7` 至 `f4d94b81b`                                               | 通用 JSON-RPC transport、重连、session 生命周期、Agent Driver 和事件流                                                                                                                                                                                                                                           |
| Run 监督与事件隔离           | `cc93318bb` 至 `d2e6e389d`                                               | watchdog、委派事件隔离、早到事件保留和 Provider Run 失活监督                                                                                                                                                                                                                                                     |
| 运行时恢复与归属             | `6f62ea81f` 至 `bfda2e21b`                                               | Provider/BYOK 事件归属修复和运行时任务恢复                                                                                                                                                                                                                                                                       |
| Multica 投递可靠性           | `4a9d648fb`                                                              | 持久化 quick-create 发送意图                                                                                                                                                                                                                                                                                     |
| BYOK 模型循环可靠性          | `f016bc851` 至 `c120282c5`                                               | 取消竞争、上下文增长与溢出、安全重试和流终态校验                                                                                                                                                                                                                                                                 |
| BYOK 部分输出恢复            | `687732124`                                                              | checkpoint 持久化、确定性事件、摘要、偏移、去重和正文恢复                                                                                                                                                                                                                                                        |
| BYOK 恢复对外语义            | `3d04a3823`（已 amend，主题不变）                                        | `supportsResume` 启用条件、`resumeTask` 拒绝/短路语义与进程重启级恢复测试                                                                                                                                                                                                                                        |
| Multica outbox 收口          | `feat(composition): Multica quick-create outbox 审计与收口`              | outbox 审计/settle、`X-Idempotency-Key` 出站、启动告警接线与真实 HTTP 进程级 e2e                                                                                                                                                                                                                                 |
| Grant/resume 投影            | `feat(composition): 投影能力授权与恢复状态`                              | grant issued/revoked 幂等投影、BYOK resume 输出投影与对应测试                                                                                                                                                                                                                                                    |
| Goal Loop 第一切片           | `feat(composition): Goal Loop 完成标记与预算控制`                        | 完成/取消标记解析（cleanText 剥离 + reason）、maxAttempts/maxCostUnits/deadline 预算收敛、cancelled 优先级与 attempt 剩余预算上下文，10 单测通过                                                                                                                                                                 |
| Goal Loop 停滞 pivot         | `feat(composition): Goal Loop 停滞 pivot 判定`                           | stalePivotRounds 连续无进展检测（归一化文本 + 空输出空转）、`pivot_required` 终态与 pivot 结果字段，16 单测通过                                                                                                                                                                                                  |
| Goal Loop 验证子代理合同     | `feat(composition): Goal Loop 验证子代理合同`                            | validateCompletion 验收/拒绝语义、rejectedCompletions 审计、拒绝输出参与停滞判定与错误通道上抛，20 单测通过                                                                                                                                                                                                      |
| Goal Loop 台账编排接线       | `feat(composition): Goal Loop 接入任务台账编排`                          | CompositionGoalLoopRunner：start/每轮/拒绝/终态幂等投影与状态映射、敏感输出不落账、重放幂等，契约测试 5 用例（全家 25/25）                                                                                                                                                                                       |
| Goal Loop 跨重启监督         | `feat(composition): Goal Loop 跨重启监督结算`                            | 未收敛扫描（scope 过滤 + 轮次/拒绝统计）与幂等 redispatch/abandon 结算行、显式错误合同，6 用例（全家 31/31）                                                                                                                                                                                                     |
| Goal Loop 自动重派接线       | `feat(composition): Goal Loop 自动重派接线`                              | supervisor 结算 → 陈旧 run/task 落 failed → 真实 retryTask 自动重派；校验失败零副作用，4 用例（全家 35/35）                                                                                                                                                                                                      |
| Goal Loop 子代理验证器       | `feat(composition): Goal Loop 子代理验证器实现`                          | GOAL_VALID/GOAL_INVALID fail-closed 裁决协议、评审提示词组装与 BYOK agentService 生产端口，6 用例（全家 41/41）                                                                                                                                                                                                  |
| Goal Loop attempt 生产适配器 | `feat(composition): Goal Loop attempt 生产适配器`                        | BYOK=CompositionAgentService.run 每轮一次模型循环；Multica=quick-create 派发+状态轮询+可选输出钩子，6 用例（全家 47/47）                                                                                                                                                                                         |
| 控制中心统一投影             | `feat(composition): 控制中心统一状态投影`                                | projectCompositionControlCenter：Run/Goal Loop 五态/grant 审计/依赖/Squad 只读聚合（第 6 项第一切片），附带 supervisor start 分支修复                                                                                                                                                                            |
| 控制中心 RPC 与 Web 接线     | `feat(composition): 控制中心投影接入 Server RPC 与 Web 设置`             | serverControlCenterProjection 四层接线（contracts/ws/授权/客户端原子）+ 设置页组合控制中心区块与双语 i18n，面板 4 用例                                                                                                                                                                                           |
| 控制中心自动重派入口         | `feat(composition): 控制中心自动重派操作入口`                            | serverControlCenterRedispatch 四层接线（OperateScope 授权）→ settleAndRedispatchInterruptedGoalLoop + 真实 retryTask；面板 interrupted/supervisor_settled 行重派按钮与 capabilityIds 输入，面板 7 用例                                                                                                           |
| 控制中心取消入口             | `feat(composition): 控制中心取消操作入口`                                | 复用 serverCancelCompositionTask 四层接线（OperateScope）；活跃 Run 行取消按钮 + runRowCommand 统一行操作收敛，面板 8 用例                                                                                                                                                                                       |
| 控制中心审批入口             | `feat(composition): 控制中心审批操作入口`                                | 复用 serverReviewCompositionTask 四层接线（OperateScope）；in_review 行通过/驳回按钮与双语缺省 reason，面板 9 用例                                                                                                                                                                                               |
| 控制中心放弃结算入口         | `feat(composition): 控制中心放弃结算操作入口`                            | 新增 settleAndAbandonInterruptedGoalLoop（supervisor abandon 结算 + goal_loop_abandoned，不新建 Run）+ serverControlCenterAbandon 四层接线；interrupted 行放弃按钮与重派并存，Goal Loop 49 单测、面板 10 用例                                                                                                    |
| Supplier 统一投影            | `feat(composition): Supplier/Profile 统一只读投影`                       | projectCompositionSupplierRegistry：Provider 实例 → Supplier 条目（continuationKey 账号锚点）+ provider:\<instanceId\> 档案挂接 + 孤儿档案识别，3 用例                                                                                                                                                           |
| Supplier 注册表接线          | `feat(composition): Supplier 注册表接入 RPC 与 Web 设置`                 | serverSupplierRegistry 四层接线（ReadScope）+ 设置页只读区块与双语 i18n，面板 5 用例                                                                                                                                                                                                                             |
| 类型与 Effect 规则基线修正   | `feat(composition): 修复类型与 Effect 规则基线`                          | 品牌 key 显式收窄、`effect/Path` 服务化、`t3code:` 存储迁移键与 `T3CODE_HOME` 恢复、`Clock` 替换 `Date.now`、exactOptional 条件展开、lint/format 清零；server 包既有约 520 处隐性错误记为独立后续切片                                                                                                            |
| server typecheck 清偿        | `feat(composition): 清空 server 包 typecheck 错误`（及前两波记录提交）   | 按文件聚类清偿约 520 处既有隐性错误至 0；`server.test.ts` store 形状漂移与 composition 测试品牌化收窄                                                                                                                                                                                                            |
| 上游 v0.0.35 同步            | `05d694cfa`（merge）                                                     | subtree 合并上游 34 提交/165 文件：PR 关联线程、Claude 压缩、git push base 分支修复；34 个冲突以"保留本地品牌与 i18n、采纳上游功能"解决，上游迁移 042/043 重编为 054/055，`editorLabels` 集中本地化                                                                                                              |
| BYOK 缺口批量补齐            | `feat(byok): 补齐余额看板、Supplier 管理、resume 重派与 delegation 收敛` | 余额看板四层接线 + Supplier 启停/凭据轮换（凭据零回显）+ resume 重派编排与控制中心入口（含投影新增 `byokResume` 字段与九码错误映射）+ delegation 台账投影 + Mobile 面板复用 + 上游遗留 20 处文案双语补齐；六包 typecheck（mobile 除既有基线）0 错误，新增/回归测试 server 46、web 62、mobile 23、路由层 133 全过 |
| 文档与回归覆盖               | `c5a709b46`、`223b90ee5`                                                 | 刷新迁移矩阵并覆盖 ACP 取消终态回归                                                                                                                                                                                                                                                                              |

## 关键结论

### 是否可以使用 T3/Code Work 的壳接多个 Agent Driver

可以。当前 Composition、Provider Service、Runtime Adapter 和 Agent Driver Registry 已经形成实现基础，Web/Desktop/Mobile 也共享统一 Server/RPC。剩余工作主要是把各 Driver 的生命周期、恢复、授权和状态展示做成同一个产品闭环。

### 每个 Driver 是否已经可以使用接入的 API 和各 IDE API

目前只能回答“部分可以”：

- BYOK Driver 已存在真实 Code Work ToolBroker 调用路径，并有聚焦测试；本轮补齐后其控制面（余额/健康看板、Supplier 启停与凭据轮换）、恢复路径（resume 校验恢复 + 自动重派入口）与状态可观测性（delegation 台账投影）也已闭环，但仍未使用真实凭据验证。
- 本地 Runtime HTTP/MCP bridge 和 IDE JSON-RPC fixture 已验证跨进程工具回流。
- 真实 Provider Session/Turn、真实 Multica daemon、真实 Cursor/VS Code 尚未完成 capability grant 和官方 API E2E。
- 因此现在不能宣称所有 Driver 已经可以安全、稳定、可撤销地使用全部 Code Work API 和各 IDE API。

### 是否已经具备 Multica 多 Agent 协同

已具备 Composition 本地任务图与 Multica 窄协议接入底座，但还没有完成真实 Multica Agent/Squad/Leader 的端到端协同。真实 daemon、动态成员、权限、幂等、跨重启恢复和结果汇聚仍是上线前必做项。

## 下一最小实施顺序

1. ~~完成 BYOK 部分输出恢复的对外语义，决定 `supportsResume` 的启用条件并增加进程重启级测试。（已完成）~~
2. ~~为 Multica quick-create 增加持久化 outbox、冲突恢复和集成测试。（本地 HTTP 进程级已完成；真实 daemon 侧的幂等键语义与 by-key 查询能力确认后，收口可自动化）~~
3. ~~接入真实 Cursor/VS Code Adapter，完成 capability handshake、最小 IDE API 白名单和撤销测试。~~（**后期内容：本次不做，TODO 待排期**——依赖真实 IDE 环境；本地 JSON-RPC bridge、capability handshake 合同与 fixture 级验证维持既有结论）
4. 把 Provider、IDE、Multica 的 grant 状态统一投影到 Composition Run 和 Settings。（本地子任务已完成：grant issued/revoked 与 BYOK resume 输出均已投影为任务历史事件；剩余 = 外部 Driver 的真实 grant 回执接入与 Settings 跨端看板展示，其中**真实回执接入随真实 IDE/Multica 接入一并列为后期内容**，跨端看板展示仍在本次范围）
5. ~~收敛 Goal Loop、预算、重试、验证子代理和跨重启 supervisor。~~（本地切片全部完成：完成标记/预算/停滞 pivot/验证合同与子代理验证器、任务台账编排接线、跨重启监督结算、编排层自动重派接线、BYOK/Multica attempt 生产适配器，共 47 单测；剩余缺口 = Multica 输出查询的生产实现，**已列为后期内容（本次不做，TODO 待排期）**，依赖真实 daemon 服务端能力）
6. ~~最后补齐 Supplier/Profile 控制中心与 Web/Desktop/Mobile 集成 E2E。~~（本轮已补齐：控制中心统一投影与四个操作入口（重派/取消/审批/放弃结算）、Supplier/Profile 只读投影与注册表区块、**BYOK 余额/用量/健康看板**、**Supplier 启停与凭据轮换操作面**、**resume 恢复重派入口**、**Mobile 面板复用**（Desktop 经共享 web 页天然可达）；剩余 = 多账号 profile 回滚（依赖凭据版本历史合同）、模型分组/权重路由/failover、Request Lab、委派台账消费端 UI、多端真实集成 E2E）
7. ~~清偿 apps/server 包整体 typecheck 既有隐性错误基线。~~（已完成：约 520 处清零，`server.test.ts` 路由层 133/133 通过）
8. BYOK 真实 API 生产验证：用真实 OpenAI/Anthropic/Gemini 兼容凭据走通模型循环、resume 恢复重派与余额看板查询的 E2E。**这是当前 BYOK 主线唯一的非代码阻塞项**——协议、编排、恢复、控制面与多端展示均已形成测试闭环，只差真实凭据下的断线、重试、限流与凭据轮换验证。

## 风险与回滚

- 当前分支尚未 push；回滚应按单个主题提交进行，不应覆盖工作区中的并行修改。
- 在真实 Multica 服务端幂等能力确认前，不应开放无条件自动重试 quick-create。
- 在 capability grant 能够撤销、过期和审计前，不应让外部 Runtime 获得宽泛宿主机权限。
- 在真实 IDE E2E 前，自定义 JSON-RPC fixture 只能作为协议证据，不能作为 Cursor/VS Code 已接入的发布证据。
- 本文档本身可通过删除新增文件回滚，不涉及数据库、运行时配置或生产数据。

## 更新约定

每完成一个可独立验证的迁移节点，更新以下内容：

1. 当前提交和相对远端状态。
2. 对应阶段的证据等级。
3. 实际运行的测试及结果。
4. 真实产品 E2E 是否完成。
5. 新增风险、回滚边界和下一最小节点。

任何“已完成”都必须附带对应代码、测试或真实运行证据；不得把静态实现、fake transport、本地 fixture 或类型检查结果描述成真实外部产品已经可用。
