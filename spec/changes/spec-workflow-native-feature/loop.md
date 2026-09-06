---
status: done
max_rounds: 10
no_progress_fuse: 3
---

# Spec Workflow 内建能力 Goal Ledger

本 ledger 是本次 Goal 的唯一验收记录。每轮只推进一个连贯增量；只有在有可复现证据后才勾选验收项。

## Acceptance

- [x] A1 建立内建能力合同和关闭闸门：默认关闭、Server 可读写并订阅状态；普通需求不进入工作流、不写 `spec/` 产物。
- [x] A2 建立工作流状态机、事件投影和 `spec/` 产物适配器。
- [x] A3 建立类型化意图路由，并能纠正用户误选入口。
- [x] A4 接入 Composition，具备独立验证、暂停/恢复和幂等控制。
- [x] A5 完成 Web/Desktop 的加号入口、状态展示、菜单文案和 i18n，包括启用/禁用、查看阶段、批准/拒绝、暂停/恢复。
- [x] A6 完成 Mobile/remote/provider 边界和不支持时的可解释降级。
- [x] A7 完成 fix/ship/loop/verifier/archive 全部阶段唤醒与闭环。
- [x] A8 完成独立审计、文档、回滚方案和真实可达性验证。

## Rounds

### Round 1 — A1 基础合同与关闭闸门

#### Plan

- 复用 Thread Goal 的 RPC、授权、SQLite migration、Store 和 PubSub 模式。
- 新增线程级 Spec Workflow 能力状态，默认返回 disabled；不修改普通对话 dispatch 路径。
- 用合同、迁移、Store 和纯关闭闸门测试证明默认关闭及状态订阅边界。

#### Act

- 新增 `packages/contracts/src/specWorkflow.ts` 及 RPC 方法：线程级能力状态、显式 enabled、expectedRevision、typed 更新事件和错误合同。
- 新增 migration 075、`SpecWorkflowCapabilityStore` 及 PubSub 订阅；无记录的 `get` 返回 `{ enabled: false, revision: 0, updatedAt: 0 }`，不写数据库记录。
- 将 get/set/subscribe RPC 接入 Server，并按 read/operate scope 接入 RPC 授权；普通 orchestration dispatch 没有新增 Spec Workflow 分支。
- 新增 `evaluateSpecWorkflowAccess` 作为后续路由唯一闭闸，并建立本轮 ledger。

#### Verify

- `.\\node_modules\\.bin\\vp.ps1 test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow/SpecWorkflowGate.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：5 个文件、19 个测试全部通过。
- `.\\node_modules\\.bin\\tsgo.CMD --noEmit -p packages/contracts/tsconfig.json`：通过。
- 同范围 `apps/server/tsconfig.json` typecheck 的退出码仍为 1，但输出没有本轮 Spec Workflow 文件、Store、migration、授权或 Server handler 的错误；失败来自仓库已有 Provider/Settings 等类型错误，另有既有 `ws.ts` Effect suggestions，未将其伪装为本轮通过。
- `git diff --check`：本轮所有新增/修改文件通过。
- Store 测试证明：未设置时返回 disabled 且 SQLite 行数为 0；显式开启 revision 从 0 到 1；相同输入幂等；旧 revision 被拒绝；更新事件可订阅；文件重建后状态可恢复。关闭闸门测试证明 disabled 不进入 workflow。

#### Retrospect

- A1 已完成。下一轮应实现状态机/事件投影和 `spec/` 产物适配器，但必须继续经过本轮已建立的 capability gate；本轮没有接入普通消息路由和 UI，因此尚未声称用户可从加号启用。

### Round 2 — A2 状态机、事件投影与产物适配器

#### Plan

- 仅实现 A2 的领域闭环：补齐主流程阶段、门禁状态和 typed snapshot/event 合同。
- 用纯 Decider/Projector 保证合法转换与非法跳转都可验证，不把阶段逻辑复制到 Router 或 UI。
- 新增安全的 `spec/changes/<change-name>/` Artifact Store，使用现有 WorkspacePaths 和原子写入，支持创建、更新、读取、列出和恢复。

#### Act

- 扩展 `packages/contracts/src/specWorkflow.ts`：新增 mode、stage、status、proposal/verification/acceptance 状态、snapshot、typed commands、state events 和 artifact contracts。
- 新增 `SpecWorkflowDecider.ts`：实现 research/TBD/ask/design/propose/awaitingApproval/revise/apply/verify/acceptance/archive 主流程，以及方案批准、实施完成、验证结果、验收和暂停/恢复门禁。
- 新增 `SpecWorkflowProjector.ts`：校验 started 前置、workflow/thread 一致性和连续 revision，并支持事件重放恢复当前 snapshot。
- 新增 `SpecWorkflowArtifactStore.ts`：仅允许固定 Markdown 产物名和安全 kebab-case changeName，复用 WorkspacePaths 越界校验与 `writeFileStringAtomically`。
- 新增状态机、投影、合同和 Artifact Store targeted tests；没有接入 Router、Composition 或客户端入口。

#### Verify

- `.\\node_modules\\.bin\\vp.ps1 test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow/SpecWorkflowGate.test.ts apps/server/src/specWorkflow/SpecWorkflowDecider.test.ts apps/server/src/specWorkflow/SpecWorkflowArtifactStore.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：7 个文件、24 个测试全部通过。
- `.\\node_modules\\.bin\\tsgo.CMD --noEmit -p packages/contracts/tsconfig.json`：通过。
- `apps/server/tsconfig.json` typecheck 的过滤结果没有本轮 Spec Workflow 文件错误；完整命令仍受仓库已有 Provider/Settings 类型错误影响，另有新 Artifact Store 的 Effect 风格 suggestion，不将其伪装为全仓库通过。
- `git diff --check`：本轮涉及的合同、领域、产物、测试、ledger 和接线文件通过。
- 状态机测试证明：TBD 未清空不能进入 design/propose；未批准 proposal 不能 apply；未完成实施不能 verify；verify 失败只能回到 apply；verify 通过后才能 acceptance；未完成 acceptance 不能 archive；最终 archive 状态为 completed。
- Projector 测试证明：缺少 started、重复 started、workflow/thread 不一致和 revision 跳跃都会显式拒绝。
- Artifact Store 测试证明：临时 workspace 中可创建/更新/读取/列出产物；同一文件可在 Store 重建后恢复读取；`../outside` changeName 被拒绝，未写出 workspace root。

#### Retrospect

- A2 已完成。状态机和产物适配器保持在 Server 领域层，尚未被普通 dispatch 或 UI 隐式调用；这保留了 A1 的默认关闭边界。下一轮只做 A3：建立 typed intent Router，根据当前 snapshot 和门禁纠正用户误选入口，再为四类错误入口补测试。

### Round 3 — A3 typed intent 路由与误选纠正

#### Plan

- 只实现 Router 领域逻辑，输入必须是 typed capability、snapshot 和 intent，输出必须是可执行的 typed route，不直接执行命令。
- 复用 A2 的 `isSpecWorkflowStageAllowed`，避免 Router 重新维护一套阶段转换规则。
- 覆盖四类错误入口：TBD 未清空时 propose、方案未批准时 apply、实施未完成时 verify、验证失败时 archive；同时证明 disabled 是 pass-through。

#### Act

- 扩展 `packages/contracts/src/specWorkflow.ts`：新增 intent name、route action、稳定 reason code 和 route snapshot 合同。
- 导出 A2 Decider 的阶段可达性判断，并新增 `SpecWorkflowRouter.ts`：根据当前状态选择下一入口或返回明确的 show-status/pass-through 结果。
- 新增 Router targeted tests，确认错误选择被纠正且不会直接绕过 Decider；未启用时不介入。
- 没有修改普通对话 dispatch、没有调用 Composition、没有新增客户端 UI 行为。

#### Verify

- `.\\node_modules\\.bin\\vp.ps1 test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow/SpecWorkflowGate.test.ts apps/server/src/specWorkflow/SpecWorkflowDecider.test.ts apps/server/src/specWorkflow/SpecWorkflowArtifactStore.test.ts apps/server/src/specWorkflow/SpecWorkflowRouter.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：8 个文件、28 个测试全部通过。
- `.\\node_modules\\.bin\\tsgo.CMD --noEmit -p packages/contracts/tsconfig.json`：通过。
- `apps/server/tsconfig.json` typecheck 过滤结果没有本轮 Spec Workflow 文件错误；完整命令仍受仓库已有 Provider/Settings 类型错误影响，只有 Artifact Store 的 Effect 风格 suggestion 属于非阻断建议。
- `git diff --check`：本轮合同、Router、Decider、测试、ledger 和既有接线文件通过。
- Router 测试证明：disabled 返回 `pass-through/not-enabled`；TBD、未批准 proposal、未完成实施、验证失败四类误选分别纠正到 ask、awaitingApproval、apply、apply；合法阶段仍可返回 advance；Router 不执行状态变更。

#### Retrospect

- A3 已完成。Router 只做选择和解释，Decider 继续负责最终状态门禁，避免用户误选导致越权推进。下一轮只做 A4：把 capability、snapshot/事件和 Router 接到 Server workflow service，并接入 Composition 的真实 Task、暂停/恢复和幂等控制；A3 当前尚未接入客户端入口，A5 再处理“+”菜单和 i18n。

### Round 4 — A4 Composition 适配边界

#### Plan

- 只推进 A4 的 Server 领域增量，复用现有 `CompositionOrchestratorService`，不新增第二套 Task 调度器。
- 将 capability gate、typed Router、Decider state event 和 Composition `apply/verify` Task 派发收敛到一个适配边界。
- 用稳定的 workflow/stage/revision 生成 Task/Run 身份；重复派发必须核对任务快照后复用，verify 必须使用不同于实施者的独立执行者，暂停/恢复继续由 Decider 产生事件。

#### Act

- 新增 `apps/server/src/specWorkflow/SpecWorkflowCompositionBridge.ts`：未启用直接拒绝；合法进入 apply/verify 才调用 Composition；不合法路由显式拒绝；派发返回待持久化 state event 和 Composition Task/Run。
- 新增稳定幂等身份 `spec-workflow:<workflowId>:<stage>:<nextRevision>`；Composition 报告任务已存在时，按 project/thread/assignee/promptDigest/Run 身份核验后复用，不一致报 `idempotency-conflict`。
- 新增独立 verify 执行者校验和“独立验证”派发约束；新增暂停/恢复闭闸函数，继续复用 A2 Decider。
- 新增 `SpecWorkflowCompositionBridge.test.ts`，没有修改普通对话 dispatch 或客户端入口。

#### Verify

- `.\node_modules\.bin\vp.cmd test run apps/server/src/specWorkflow/SpecWorkflowCompositionBridge.test.ts`：1 个文件、4 个测试通过。
- `.\node_modules\.bin\vp.cmd test run apps/server/src/specWorkflow packages/contracts/src/specWorkflow.test.ts`：6 个文件、17 个测试通过。
- `.\node_modules\.bin\vp.cmd run --filter codework typecheck` 的过滤结果没有本轮 Bridge 的类型错误；完整 Server typecheck 仍被仓库已有 Provider/Settings 测试类型错误阻断，且已有 Artifact Store Effect suggestion，不将其伪装为本轮全包通过。
- `git diff --check`：已纳入 Git diff 的变更无输出；四个本轮相关未跟踪文件另用 `rg -n '[ \\t]+$'` 检查，无尾随空白。
- 适配器测试证明：合法 apply/verify 会调用 Composition 并返回真实派发合同；verify 不能复用实施者；Composition 已存在时不会产生第二个派发；disabled 时调用次数为 0；暂停/恢复产生 active/paused 状态事件。
- A4 仍不勾选：本轮尚未提供持久化 workflow service/RPC、Server 重启或客户端断线重连实证，也没有接入 Goal Loop；这些是下一轮 A4 的剩余范围。

#### Retrospect

- Router/Decider/Composition 已有一个清晰的 Server 适配边界，后续服务层不应再次判断阶段或直接生成 Task ID。
- 本轮选择“返回事件、由服务层持久化”的边界，保留了事件溯源责任，但也明确暴露出下一步缺口：当前 Bridge 尚未被 workflow service/RPC 调用，不能提前声称用户可达或跨重启恢复。
- 下一轮仍只做 A4：新增最小的 Server workflow service，持久化 snapshot/event，接入现有 Composition service 和 RPC；优先实现 start/get/dispatch/pause/resume 的真实调用链，再补恢复与幂等测试。

### Round 5 — A4 Server workflow service 与持久化 RPC

#### Plan

- 继续只推进 A4，复用 Round 4 Bridge、现有 SQLite/PubSub 模式和 `CompositionOrchestratorService`，不在 WS 层重新实现工作流状态机。
- 新增持久化的 workflow state event store，保证 start/get/dispatch/pause/resume 在 Server service 中具备连续 revision、重复事件幂等和重建恢复能力。
- 为后续“+”入口提供最小 typed RPC 出口，并按 read/operate scope 维护授权边界；本轮不做 Web/Mobile UI。

#### Act

- 新增 `SpecWorkflowStateStore` 及 migration 076：以 `thread_id + revision` 保存 state event、事件 JSON 和最新 state JSON，支持读取、列出、订阅、连续 revision 校验、重复事件幂等和 SQLite 文件重建恢复。
- 新增 `SpecWorkflowService`：在 capability 开启后负责 start/get/dispatch/pause/resume/subscribe；dispatch 复用 Round 4 Bridge，状态转换和 Task 派发不在 RPC handler 中复制。
- 扩展 `packages/contracts/src/specWorkflow.ts` 和 `orchestration.ts`：新增状态读取、派发、暂停、恢复和状态订阅的 typed 输入/输出及稳定错误码。
- 扩展 `packages/contracts/src/rpc.ts`、`apps/server/src/ws.ts` 和 `apps/server/src/auth/RpcAuthorization.ts`：接入新的 Server service RPC，并保持状态读取与生命周期变更分别使用 read/operate scope。
- 扩展 `apps/server/src/server.ts` 的 persistence/runtime layer 接线；新增 migration、state store、service、授权和 service focused tests。

#### Verify

- `.\node_modules\.bin\vp.cmd test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Migrations/076_SpecWorkflowEvents.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/persistence/Layers/SpecWorkflowStateStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：12 个文件、38 个测试通过。
- `.\node_modules\.bin\vp.cmd run --filter @codework/contracts typecheck`：通过。
- `.\node_modules\.bin\vp.cmd run --filter codework typecheck` 的本轮范围过滤没有发现 `SpecWorkflowStateStore`、`SpecWorkflowService`、新 RPC、Server layer 或授权映射的错误；完整 Server typecheck 仍受仓库既有 Provider/Settings 类型错误和既有 Effect suggestions 影响，退出码不能作为全包通过证据。
- Store/migration 测试证明：076 表与索引可重复迁移；事件按 revision 写入；同一事件重复提交不重复插入；过期 revision 被拒绝；同一 SQLite 文件重建 Store 后 snapshot/event 可恢复。
- Service 测试证明：Server service 能先启动 workflow，再按合法门禁调用 Composition 派发；重复 apply 不产生第二次派发；pause/resume 状态可持久化并从 service 读取。
- `git diff --check`：已纳入 Git diff 的变更无输出；本轮相关未跟踪文件另用尾随空白检查，无尾随空白。
- `node_modules/.bin/vp.cmd fmt --check`：对本轮相关路径执行定向检查，输出 `All matched files use the correct format.`；全仓检查仍包含既有的其他格式问题，未扩大修复范围。
- A4 仍不勾选：service 测试使用 Composition service contract double，尚未完成真实 runtime driver 的端到端 Task 生命周期回写、失败/取消恢复、客户端重连可观察性和 Goal Loop 接线。

#### Retrospect

- A4 现在有唯一的 Server service 调用边界：RPC 只负责授权、线程存在性和错误映射；Bridge 负责路由/Decider/Composition；StateStore 负责 event persistence，三者职责不能互相渗透。
- SQLite 事件表把“重启后状态不丢”从内存假设变成了可重建证据，但服务测试仍用 Composition contract double，不能把接口调用等同于真实 Provider/Runtime 已完成。
- 下一轮仍只做 A4：给现有 Composition runtime 增加一个最小真实集成测试，并接入任务完成/失败/取消到 workflow state 的单向事件回写；不提前进入 Web/Mobile UI。

### Round 6 — A4 Runtime 终态回写

#### Plan

- 继续只推进 A4，复用现有 `CompositionTaskRuntimeProjectionService.awaitTaskCompletion`，不新增轮询器或第二套 Composition 状态机。
- 给 `apply/verify` 派发事件绑定稳定 `activeTaskId`，由 Decider 接收 Composition Task 的完成、失败、取消和超时结果并生成单向 workflow state event。
- 增加最小真实 Runtime Adapter/Driver/Orchestrator/Projector 集成检查，并验证重复终态事件不重复落账；不进入 Web/Mobile UI 或 Goal Loop。

#### Act

- 扩展 `SpecWorkflowAdvanceInput`，由 Composition Bridge 在阶段推进时把稳定 Task ID 写入 workflow snapshot。
- 扩展 Decider 的 `record-task-result` 命令：apply 完成标记实施完成，verify 完成标记验证通过；失败、取消和超时清除 active Task 并保留可重试阶段及稳定错误信息。
- 在 `SpecWorkflowService` 中注册每个 Task/Run 的一次性终态等待，复用 Runtime Projection Service；回写继续经过 Decider 和 StateStore 的 revision/幂等约束。
- 在现有 `CompositionTaskRuntimeProjector.test.ts` 增加真实 InMemory Runtime Adapter → Agent Driver → Orchestrator → Projector 链路测试；在 `SpecWorkflowService.test.ts` 增加完成、失败、取消回写测试。

#### Verify

- `node_modules/.bin/vp.cmd test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow apps/server/src/composition/CompositionTaskRuntimeProjector.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Migrations/076_SpecWorkflowEvents.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/persistence/Layers/SpecWorkflowStateStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：13 个文件、69 个测试全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/contracts typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter codework typecheck` 的本轮范围过滤没有发现 `SpecWorkflowService`、Decider、Composition Bridge、Runtime Projector 或 Server layer 的新增类型错误；完整 Server typecheck 仍受仓库既有 Provider/Settings 类型错误和 Effect suggestions 影响，退出码不能作为全包通过证据。
- `node_modules/.bin/vp.cmd fmt --check`：对本轮相关路径执行定向检查，输出 `All matched files use the correct format.`；全仓其他既有格式问题未扩大修复。
- `git diff --check` 及本轮相关未跟踪文件尾随空白检查：无输出。
- Runtime 集成测试证明：真实 Runtime Adapter/Driver 能派发 Composition Task，终态事件能更新 Task/Run，重复终态事件不会新增台账事件。
- Workflow service 测试证明：apply 完成会设置 `implementationCompleted`，verify 失败会设置 `verificationStatus=failed` 和错误信息，重试后取消会清除 `activeTaskId` 且保持可重试；所有结果均由 StateStore 产生单条 revision 事件。
- A4 仍不勾选：尚未完成 Server 重启后的 workflow/Task 关联恢复、客户端重连可观察性和 Goal Loop 接线。

#### Retrospect

- 真实 Composition runtime 的 Task/Run 终态已经有现成投影和等待合同，Spec Workflow 只需复用该结果并经 Decider 回写；继续增加独立轮询或第二个 Task 状态源会制造竞态。
- `activeTaskId` 是 workflow 与 Composition 之间必要的相关键；没有它，终态回写只能凭 project/thread 猜测，无法安全拒绝迟到或错配结果。
- 本轮完成了 A4 的最小 runtime 闭环，但重启恢复仍需要扫描持久化 active Task 并重新绑定，而不是依赖进程内等待器。下一轮仍只做 A4：补充重启/重连后的关联恢复与幂等回写证据，不提前进入 UI。

### Round 7 — A4 持久化关联恢复与关闭闸门

#### Plan

- 只补 A4 的最后一个 Server 增量：从持久化 StateStore 扫描仍有 `activeTaskId` 的 workflow，按 project/thread/task 身份精确找回 Composition 最新 Run。
- 终态 Run 直接复用现有 Decider 与 StateStore revision/事件幂等写回；运行态 Run 重新挂回现有 `awaitTaskCompletion`，不增加轮询器或第二套状态源。
- 恢复流程继续经过 capability gate；能力关闭、Task/Run 缺失或身份不一致时显式告警并跳过，不猜测、不创建替代任务；本轮不进入 Web/Mobile/Goal Loop。

#### Act

- 为 `SpecWorkflowStateStore` 增加 `listStates`，按每个线程只返回最新 snapshot，支持从同一 SQLite 文件重建后的启动扫描。
- 为 `SpecWorkflowService` 增加 `recover`：扫描 active workflow，核对 capability、project、thread、Task 和最新 Run；终态经 `record-task-result` 回写，运行态重新绑定一次性等待器。
- 在 `serverRuntimeStartup` 的 command-ready 前接入 Spec Workflow 恢复；缺少该服务的精简启动测试仍保持可运行，生产运行时则使用已提供的服务层。
- 放开暂停 workflow 对其已绑定 Task 终态回写的系统事件门禁，避免暂停期间完成的 Task 因用户态暂停而永久悬挂。
- 补充 SQLite 最新状态列表、重启终态幂等回写、运行态等待器重绑定、能力关闭不恢复以及暂停态终态回写测试。

#### Verify

- `node_modules/.bin/vp.cmd test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow apps/server/src/composition/CompositionTaskRuntimeProjector.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Migrations/076_SpecWorkflowEvents.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/persistence/Layers/SpecWorkflowStateStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：13 个文件、73 个测试全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/contracts typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter codework typecheck`：退出码仍为 1，但按本轮范围过滤没有 `SpecWorkflow`、`serverRuntimeStartup` 或启动集成测试错误；剩余为仓库已有 Provider/Settings 类型错误和 `SpecWorkflowArtifactStore` 的非阻断 Effect suggestion，不将其伪装为全包通过。
- 本轮 9 个相关文件 `vp fmt --check`：全部通过；`git diff --check` 与本轮相关文件尾随空白检查：无输出。
- `node_modules/.bin/vp.cmd test run apps/server/src/serverRuntimeStartup.test.ts -t "Spec Workflow recovery gate"`：新增启动闸门测试 1 个通过、其余 17 个跳过；完整 `serverRuntimeStartup.test.ts` 为 17 个通过、1 个既有失败，失败测试 `goal loop retry recovery failure fails command readiness and aborts startup` 仍期待 helper 抛错，与本轮新增恢复路径无关。
- Service 测试证明：用持久化 active Task 重启扫描后，已完成 Run 只写一条 `record-task-result` 事件，重复扫描不重复落账；运行中 Run 能重新挂回终态等待器；能力关闭时不读取 Composition 快照、不启动等待器。
- Decider 测试证明：暂停 workflow 不拦截已绑定 Task 的 completed 结果，仍清除 `activeTaskId` 并保留暂停状态；此前独立 verify、Composition Runtime Adapter/Driver/Orchestrator/Projector 链路和重复终态事件检查仍由累积 suite 覆盖。
- A4 已完成：Composition、独立验证约束、暂停/恢复、关闭闸门、重启关联恢复和幂等回写均有代码与 focused evidence；A5–A8 仍未勾选。

#### Retrospect

- 启动恢复的最小可靠模型是“持久 workflow snapshot → 精确 Task → 最新 Run → 现有 Runtime Projection 等待器”；不需要额外的 recovery 表、后台轮询器或新的任务状态源。
- `listStates` 只返回每线程最新状态，配合 `activeTaskId` 和 Task 的 project/thread 校验，能够覆盖进程内等待器丢失的重启窗口，同时拒绝错配关联。
- “能力后来被关闭”必须在恢复路径重新检查，不能因为历史 workflow 曾启用就绕过用户当前选择；缺失关联保留在持久状态中，下一次启用或启动仍可继续人工处理。
- 下一轮应只推进 A5：实现 Web/Desktop 加号入口、状态展示、菜单命名和 i18n，并让客户端显式启用后才调用 Server workflow RPC；不要在客户端入口阶段重写 Router/Decider。

### Round 8 — A5 Web/Desktop 加号入口、状态展示与 i18n

#### Plan

- 只实现 A5 的客户端入口增量：复用现有 Composer `+` Popover 和 environment RPC atom 模式，加入线程级 Spec Workflow capability 的查询、实时更新订阅和串行设置命令。
- 只有用户在 `+` 菜单点击“Spec Workflow/规格工作流”后才调用 set RPC；普通消息发送路径不新增 workflow dispatch，草稿线程和状态读取失败时保持禁用。
- Desktop 不复制 Composer：确认 Electron 主窗口加载同一 Web UI，依靠 Web bundle 覆盖桌面入口；本轮不新增原生菜单或 Electron IPC。

#### Act

- 在 `packages/client-runtime/src/state/spec-workflow.ts` 增加共享的 capability get/events/set 原子，使用线程维度串行调度；在 `packages/client-runtime/src/rpc/client.ts` 注册 Spec Workflow 能力与状态订阅方法。
- 在 `apps/web/src/state/specWorkflow.ts` 增加 capability snapshot、事件覆盖、错误/加载状态和带 `expectedRevision` 的显式 toggle controller；未绑定服务端线程时不发 RPC。
- 在 `ComposerAddMenu` 增加“内建工作流/规格工作流”区块、启用状态勾选、`aria-pressed` 和失败/加载/草稿提示；在 `ChatComposer` 仅对 server thread 绑定该控制器。
- 在英文和简体中文 catalog 增加稳定的菜单、状态和边界提示文案；Desktop 继续通过 `apps/desktop/vite.config.ts` 的 `codework#build` 依赖加载这套 Web UI。

#### Verify

- `node_modules/.bin/vp.cmd fmt --check`：本轮 7 个相关文件全部通过；`git diff --check`：无输出。
- `node_modules/.bin/vp.cmd run --filter @codework/client-runtime typecheck`：通过。
- `node_modules/.bin/vp.cmd test run packages/client-runtime/src/state/spec-workflow.test.ts packages/client-runtime/src/state/threadGoal.test.ts packages/contracts/src/specWorkflow.test.ts`：3 个文件、6 个测试全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/web build`：通过，`4827 modules transformed`；仅有既有的 route-test 文件警告、超大 chunk 和 i18n 文件体积提示。
- `node_modules/.bin/vp.cmd run --filter @codework/desktop typecheck`：通过，证明 Desktop 包装层仍可消费共享 runtime；Electron 没有第二套 Composer 入口。
- `node_modules/.bin/vp.cmd run --filter @codework/web typecheck`：退出码为 1，但输出仅包含既有 `UsageActivityHeatmap.test.tsx` 的 3 个 `unknown -> ReactNode` 错误和两个非阻断 Effect suggestions；没有本轮 Spec Workflow 文件错误。
- 本轮只完成 A5 的 capability 子增量：Web Composer `+` 入口、线程 capability 状态显示、显式启用/禁用、i18n 和 Desktop 共享 bundle 均已接线；阶段查看、批准/拒绝、暂停/恢复菜单控制尚未接线，浏览器/打包桌面实机点击验收留给 A8，当前按仓库规则未擅自启动浏览器或 Electron。

#### Retrospect

- A5 的最小模型是“一个线程 capability + 一个共享 atom family + 一个 Composer toggle”；不需要单独的 Desktop UI、全局开关或前端第二套状态源。
- capability 订阅只覆盖用户显式启用后的状态展示，toggle 仍使用服务端 `expectedRevision` 与 client-runtime 串行命令；普通发送路径没有接触 Spec Workflow，因此关闭时仍是零介入。
- 查询失败、草稿线程和加载中状态都在菜单层明确禁用，不把“未能确认已启用”误当成可 dispatch；状态事件仅覆盖已确认的 capability snapshot。
- 下一轮仍只推进 A5：复用现有 Spec Workflow state get/subscribe 与 pause/resume RPC，在 `+` 菜单补齐阶段状态、批准/拒绝、暂停/恢复控制，并保持所有操作受服务端 revision/状态门禁约束；不在下一轮进入 Mobile、remote/provider 或 Goal Loop。

### Round 9 — A5 阶段状态、方案审批与暂停恢复控制

#### Plan

- 只完成 A5 剩余的 Web/Desktop 控制闭环：复用已有 state get/subscribe 和 `client-runtime` atom family，在 Composer “+” 菜单展示阶段/状态并提供批准、拒绝、暂停、恢复。
- 新增最小 typed proposal-review RPC，把用户操作映射到既有 Decider 命令；所有控制继续使用服务端 `expectedRevision` 和阶段门禁，不在 UI 复制状态机。
- 保持 capability 关闭时不读取 workflow state、不订阅 state event、不发送工作流控制命令；Desktop 继续消费同一 Web bundle。本轮不进入 Mobile、remote/provider 或 Goal Loop。

#### Act

- 扩展 `packages/contracts/src/orchestration.ts`、`packages/contracts/src/specWorkflow.ts` 和 `packages/contracts/src/rpc.ts`，新增 `reviewSpecWorkflowProposal` 的 approve/reject 输入与状态返回合同。
- 在 `SpecWorkflowService.reviewProposal`、`apps/server/src/ws.ts` 和 `RpcAuthorization.ts` 接入服务端审批控制；服务层只读取当前状态、映射 Decider 命令并持久化事件，未新增第二套状态转换逻辑。
- 扩展 `packages/client-runtime/src/state/spec-workflow.ts`，加入 state/stateEvents/reviewProposal/pause/resume 原子；扩展 Web controller，使关闭或未确认状态时不启动状态查询，控制命令按线程串行并带 revision。
- 在 `ComposerAddMenu` 增加阶段、状态、错误提示和条件控制按钮；英文/简体中文 catalog 增加全部阶段、状态和操作文案；`ChatComposer` 只为 server thread 绑定，Desktop 继续复用 Web UI。
- 服务端测试把批准路径改为调用真实 `reviewProposal`，并新增拒绝路径测试。

#### Verify

- `node_modules/.bin/vp.cmd fmt --check`：本轮 12 个合同、Server、client-runtime、Web 相关文件全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/contracts typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter @codework/client-runtime typecheck`：通过。
- `node_modules/.bin/vp.cmd test run packages/contracts/src/specWorkflow.test.ts packages/client-runtime/src/state/spec-workflow.test.ts apps/server/src/specWorkflow/SpecWorkflowService.test.ts apps/server/src/specWorkflow/SpecWorkflowDecider.test.ts apps/server/src/auth/RpcAuthorization.test.ts`：5 个文件、27 个测试全部通过；覆盖 approve/reject、revision、pause/resume、state atom 隔离和授权映射。
- `node_modules/.bin/vp.cmd run --filter @codework/web build`：通过，`4827 modules transformed`；仅有既有 route-test、i18n 体积、超大 chunk 和 dynamic import 警告。
- `node_modules/.bin/vp.cmd run --filter @codework/desktop typecheck`：通过；Desktop 仍通过共享 Web bundle 消费 Composer 入口。
- `git diff --check`：无输出。
- `node_modules/.bin/vp.cmd run --filter @codework/web typecheck`：通过；仅有仓库既有 `dpop.ts` 和 `IdeSessionsSettings.logic.ts` 的非阻断 Effect suggestions。`node_modules/.bin/vp.cmd run --filter codework typecheck` 仍被仓库已有 Provider/Settings 测试类型错误阻断；输出没有本轮 Spec Workflow 文件错误。
- 代码级 A5 验收已勾选：菜单具备启用/禁用、阶段/状态查看、批准/拒绝、暂停/恢复，并受 capability、状态和 revision 约束；真实浏览器/Electron 点击可达性留给 A8 独立审计，按仓库规则本轮未启动。

#### Retrospect

- A5 的控制面可以保持很小：一个线程级 controller 组合 capability 与 workflow state，菜单只根据返回状态渲染操作；不需要 Desktop 再做一套 IPC 或全局工作流状态。
- proposal review 不能复用普通 dispatch intent，因为批准/拒绝是等待审批阶段的状态命令；新增一个 typed RPC 反而比在 handler 中拼装隐式 intent 更容易保留授权、revision 和审计边界。
- “启用后才读状态”是关闭闸门在客户端的对应物：capability 未确认 enabled 时不创建 state query/subscription，避免 UI 误把未加载状态当作已启用。
- 下一轮只推进 A6：核对 Mobile、remote/relay/tunnel 和各 provider adapter 的支持边界，提供不支持时的稳定降级说明；不要扩大 A5 的 UI 结构或提前接 Goal Loop。

### Round 10 — A6 Mobile、远程连接与 Provider 边界

#### Plan

- 只推进 A6：复用现有 `client-runtime` Spec Workflow atoms、移动端环境连接投影和 Composition Agent Driver，不新增 Mobile 专用 RPC、Provider 调度器或远程协议。
- 在线程页提供状态查看、启用/停用、方案批准/拒绝、暂停/恢复；工作流状态只在 capability 已确认启用后查询和订阅，连接未 `connected` 时禁用控制并解释原因。
- 明确 Primary、本地 Bearer、Relay/托管 Tunnel、SSH 连接和现有 Provider/Runtime Driver 的支持/降级边界；缺失或不可用 Driver 保留当前阶段并返回稳定 `composition-unavailable`。

#### Act

- 新增 `apps/mobile/src/state/specWorkflow.ts`，复用 `createEnvironmentSpecWorkflowAtoms(connectionAtomRuntime)`，实现线程级 capability/state 快照、事件订阅、revision 串行控制和显式启用/停用、审批、暂停/恢复命令。
- 新增 `apps/mobile/src/features/threads/SpecWorkflowMobileControls.tsx`，接入 Thread Route；显示阶段、状态、阻塞/任务错误、连接方式，并提供可访问的控制按钮。未启用时不读取 workflow state；未连接时不发送控制命令。
- 新增 `specWorkflowMobilePresentation.ts` 及 focused test，覆盖本地、远程、Relay/Tunnel、SSH 目标映射和非 connected 禁止控制。
- 补齐 Mobile en/zh-CN 文案；复用现有 Composition `assigneeId`/Agent Driver 边界。WS 对 Provider/Runtime 的 unavailable/unsupported/agent-driver 错误统一归一为 `composition-unavailable`，不跳过阶段、不创建替代任务。
- 同步 `docs/internals/spec-workflow-native-feature.md` 的 A4-A6 状态、连接/Provider 边界说明和当前交付状态；未修改、重置、清理无关脏文件，未提交或推送。

#### Verify

- `node_modules/.bin/vp.CMD fmt` 对本轮 Mobile、Server 和文档相关文件通过；初次 `vp` 不在当前 PowerShell PATH，`pnpm exec vp` 因 workspace 的 `@distilled.cloud/aws@0.30.2` 镜像缺包触发安装失败，随后改用已存在的本地 runner，未改动依赖。
- `node_modules/.bin/vp.CMD test run apps/mobile/src/features/threads/specWorkflowMobilePresentation.test.ts`：1 个文件、2 个测试通过。
- `node_modules/.bin/vp.CMD run --filter @codework/mobile typecheck`：通过；曾发现并修复 1 个可空 i18n 参数错误后重跑通过。
- `node_modules/.bin/vp.CMD test run packages/client-runtime/src/state/spec-workflow.test.ts packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow`：client-runtime 1 个测试、Contracts 4 个测试、Server Spec Workflow 6 个文件 21 个测试均通过。
- 连接边界测试证明同一套 state atoms 按 `environmentId + threadId` 隔离，四种连接目标只改变连接准备/展示，不改变 workflow RPC；Mobile 控件仅在 `connected` 时允许变更。
- Composition Driver Registry 已有 `driver_profile_missing -> degraded` 证据；WS 新映射覆盖 `agent_driver_*`、`provider_*`、`runtime_agent_*` 以及明确的 unavailable/unsupported 错误，输出稳定 `composition-unavailable`。A6 未新增 Provider 协议或静态“全部可用”声明。
- `node_modules/.bin/vp.CMD test run apps/server/src/composition/CompositionProviderAgentDriver.test.ts apps/server/src/composition/CompositionByokAgentDriver.test.ts apps/server/src/composition/CompositionAgentDriverRegistry.test.ts`：3 个文件、39 个测试通过，补充 Provider/ BYOK Driver Profile、启动边界和缺失 Driver 降级证据。
- 未运行真实移动设备、断网/重连、Relay/Tunnel 公网切换或 Browser/Electron 点击验收：本轮遵守仓库“未获授权不启动 browser/computer use”的边界；这些真实路径保留到 A8，不能由 typecheck 代替。
- A6 勾选：代码级 Mobile 控制、连接目标一致性和 Provider 可解释降级均有实现及 focused evidence；A7、A8 仍未完成。

#### Retrospect

- Mobile 不需要另一套工作流状态源；把 `environmentId + threadId` 作为 atom family 键并复用连接 runtime，已经把本地、远程、Relay/Tunnel 和 SSH 的一致性约束收敛到现有基础设施。
- 用户控制和普通消息仍是两条边界：Mobile 只能显式启用或控制，启用前不建立 state subscription；Server 继续负责 revision、阶段门禁和 Task 恢复。
- Provider 兼容性应由现有 Composition Driver/Adapter 事实决定；缺少驱动或运行时不可用时保留 workflow 阶段并返回可翻译的稳定错误，比新增 Provider 矩阵和第二套探测器更小且更可靠。
- 下一轮只推进 A7：核对并补齐 fix、ship、loop、independent verifier、acceptance/archive 的阶段唤醒和回退闭环；继续复用现有 Goal Loop/Verifier/Archive 能力，不改 A6 的移动端结构。

### Round 11 — A7 生命周期意图与闭环

#### Plan

- 只推进 A7：把 `fix`、`ship`、`loop`、独立验证、最终验收和归档收口到同一套 Server Router/Decider/Composition 边界。
- 复用现有 Goal Loop Automation Runner 的预算、独立 reviewer、取消和持久台账，不新增第二个循环器；恢复时继续使用 StateStore revision 和稳定 Task/Run 身份。
- 补足一个实际崩溃窗口：Loop 状态已持久化但父 Task 尚未落库时，重启不能因为暂时找不到 Task 就永久跳过；普通 Task 恢复路径保持不变。

#### Act

- Router 将 `fix` 映射到无活动任务的 `apply` 重试，将 `loop` 映射到带预算的 `apply`，将 `ship` 映射到 `archive`；验证通过后先进入 `acceptance`，不允许 ship 直接绕过最终验收。
- Decider 增加 `apply` 的可重试门禁，Loop 终态统一通过 `record-task-result` 清理活动任务、预算和错误；Server Service 新增 acceptance 完成 RPC，并在已批准方案后调用现有 Goal Loop Runner。
- Loop 以 `spec-workflow:<workflowId>:loop:<revision>` 生成稳定身份；预算配置、加密输入、取消回调和 reviewer 约束均由 Server 传入现有 Runner，重复运行由 Runner/台账身份收敛。
- 为 `CompositionTaskRecoveryInput` 增加可选执行者身份；当 Loop 父 Task 尚未创建但状态、加密输入和能力仍存在时，启动恢复按稳定 `taskId/runId` 重派，已有 Task/Run 仍走原有精确匹配和终态幂等回写。
- 保留当前工作树中的其他脏改动，未提交、未推送、未运行浏览器或 Electron 实机验收。

#### Verify

- `node_modules/.bin/vp.cmd test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow apps/server/src/persistence/Layers/CompositionTaskStore.test.ts apps/server/src/composition/CompositionGoalLoop.test.ts apps/server/src/composition/CompositionGoalLoopRunner.test.ts apps/server/src/composition/CompositionGoalLoopAutomationRunner.test.ts apps/server/src/composition/CompositionGoalLoopAttemptAdapters.test.ts apps/server/src/composition/CompositionGoalLoopRetryStartupRecovery.test.ts apps/server/src/composition/CompositionGoalLoopRedispatch.test.ts apps/server/src/composition/CompositionGoalLoopSupervisor.test.ts`：15 个文件、109 个测试全部通过。
- 服务层 focused evidence 覆盖：`fix` 在 apply 无活动任务时重新派发；`loop` 使用 `maxAttempts` 和独立 reviewer，暂停会向 Runner 发出取消并回写 paused 终态；父 Task 尚未落库时可用加密输入恢复；`ship` 必须先完成 acceptance 才能 archive；verify 失败仍回到 apply。
- Goal Loop 累积测试证明预算耗尽、取消、停滞熔断、独立 reviewer 拒绝后继续、跨重启台账恢复和重复终态不重复落账；CompositionTaskStore 18 个测试证明新增可选输入字段兼容旧密文。
- `node_modules/.bin/vp.cmd run --filter codework typecheck`：退出码仍为 1，但没有本轮 `SpecWorkflow` 或 Loop 恢复新增错误；剩余错误来自当前工作树已有 Provider/Settings 测试与 BYOK 调试文件，另有既有 Effect suggestions，未将其伪装成全包通过。
- `node_modules/.bin/vp.cmd fmt --check` 对本轮 17 个合同、Server、Composition、持久化和测试文件全部通过；`git diff --check` 及相关未跟踪文件尾随空白检查无输出。
- 本轮未运行浏览器、Electron、真实 Provider 网络和移动设备验收；这些属于 A8 的最终独立审计，不用代码级 mock/typecheck 冒充真实可达性。

#### Retrospect

- A7 已完成代码级闭环：`fix/ship/acceptance/archive` 都由 Server Router/Decider 门禁收口，`loop` 复用既有 Goal Loop Runner，独立验证由不同执行者/reviewer 约束，验证失败和任务取消保留可重试阶段。
- 之前的恢复模型只在“已有 Composition Task”时可恢复；把 Loop 的执行者身份纳入加密输入后，状态先落库、父 Task 后落库的崩溃窗口也能按稳定身份重派，且没有污染普通 Task 恢复。
- A8 仍是唯一未完成项：需要新的独立上下文重新审计 A1-A7，补真实 Web/Desktop/Mobile/remote 可达性、最终文档和禁用开关回滚证明；本轮没有把未获授权的 UI/网络实测写成通过。

### Round 12 — A8 阶段终态 Reactor 唤醒

#### Plan

- 只补 A8 审计中确认的一个实质缺口：Composition Task 终态回写后，普通 `apply` 成功不能只停在状态更新，必须在合法条件下自动唤醒独立 `verify`；验证成功后自动进入人工 `acceptance`。
- 复用现有 `SpecWorkflowService`、`SpecWorkflowDecider`、Composition Runtime 等待器和加密输入存储，不新增调度器；Reactor 只做下一动作判断，实际派发仍回到 Service/Router/Decider。
- 保持关闭闸门：反应前重新读取 capability；暂停、失败、取消、超时、缺失独立验证者或缺失恢复输入时不自动启动后续任务。

#### Act

- 新增 `SpecWorkflowReactor.ts`，用纯函数判断 `apply` 成功→`verify` 派发、`verify` 成功→`acceptance`，并覆盖暂停和独立验证者缺失分支。
- `SpecWorkflowService` 在终态事件持久化成功后调用 Reactor；普通阶段派发保存加密 handoff（提示摘要、执行者和独立验证者），以便重启后继续自动唤醒；能力关闭时 Reactor 跳过后续派发。
- 扩展 `CompositionTaskInputStore` 的可选加密字段以保存工作流 handoff，旧密文仍可读取；补充 Reactor 单测和 Service 真实等待器闭环测试。
- 文档同步说明 `fix.md`、终态 Reactor 行为、人工 acceptance 边界和回滚时停止后续唤醒的语义；未提交、未推送、未改动无关脏文件。

#### Verify

- `node_modules/.bin/vp.cmd test run apps/server/src/specWorkflow/SpecWorkflowReactor.test.ts apps/server/src/specWorkflow/SpecWorkflowService.test.ts apps/server/src/persistence/Layers/CompositionTaskStore.test.ts`：3 个文件、30 个测试全部通过。
- Service 测试证明：apply 完成后自动产生 verify 派发和新的状态事件；verify 完成后自动进入 acceptance，未自动替用户完成验收；既有失败/取消/暂停路径仍保持不继续推进。
- 加密输入测试覆盖新增 `promptDigest`、实施者和独立验证者字段往返；旧版缺少可选字段的输入仍可读取。
- `node_modules/.bin/vp.cmd run --filter codework typecheck`：本轮新增 Spec Workflow、Reactor 和 CompositionTaskInputStore 没有错误；命令仍因工作树已有 Provider/Settings/BYOK 测试类型错误退出 1，未将其伪装成全包通过。
- `node_modules/.bin/vp.cmd fmt --check`：本轮相关 7 个文件通过；`git diff --check`：无输出。
- A8 仍未勾选：尚未获得浏览器、Electron、真实移动设备和远程 Provider 网络操作授权，也尚未完成新上下文的全量独立审计；本轮只关闭了代码级阶段唤醒缺口。

#### Retrospect

- “事件驱动”必须有可观察的后继动作：仅把 Task 终态写回 StateStore 不足以称为阶段互相唤醒。本轮把普通 apply/verify 的后继行为收敛到纯 Reactor，保留用户验收硬门禁。
- 自动 verify 的最低安全条件是 capability 仍开启、工作流仍 active、实施成功且独立验证者身份可证明；缺一项就停在当前状态，交给用户重新选择或补充配置。
- 重启自动唤醒不能依赖内存闭包，因此 handoff 必须随 Task 输入加密持久化；旧输入缺少摘要或独立验证者时应降级为不自动唤醒，而不是猜测。
- 下一轮仍只推进 A8：在不启动未授权浏览器/设备的前提下，做新上下文代码独立审计、补最终回滚检查，并确认是否还存在自然语言 Agent 路由、fix 批次归档等未覆盖要求。

### Round 13 — A8 最终验收入口

#### Plan

- 只推进 A8 审计中确认的一个连贯增量：补齐 Web/Mobile 从 `acceptance` 到 `archive` 之前的“完成最终验收”用户控制路径。
- 复用现有共享 runtime command、Server `completeSpecWorkflowAcceptance` RPC、revision 和 Decider 门禁，不在客户端复制状态转换，也不新增 Desktop 专用实现。
- 保持关闭闸门和可回滚边界：工作流未启用、非 active、非 acceptance、验收非 pending 或 revision 失配时，客户端不应成功提交，Server 仍是最终裁决者。

#### Act

- `packages/client-runtime/src/state/spec-workflow.ts` 新增 `completeAcceptance` command，并更新共享 atom 导出测试。
- `apps/web/src/state/specWorkflow.ts`、`apps/web/src/components/chat/ComposerAddMenu.tsx` 和 `apps/web/src/components/chat/ChatComposer.tsx` 接入最终验收控制；仅在 active acceptance pending 时显示和提交。
- `apps/mobile/src/state/specWorkflow.ts`、`apps/mobile/src/features/threads/SpecWorkflowMobileControls.tsx` 接入相同控制路径；Web/Mobile 均使用新增 i18n 文案“完成最终验收”。
- `docs/internals/spec-workflow-native-feature.md` 同步 UI 验收路径和 A5/A6 证据引用；保留 A8 未完成状态。

#### Verify

- `node_modules/.bin/vp.cmd test run packages/client-runtime/src/state/spec-workflow.test.ts packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow/SpecWorkflowService.test.ts apps/server/src/specWorkflow/SpecWorkflowReactor.test.ts`：4 个文件、17 个测试全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/client-runtime typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter @codework/mobile typecheck`：退出码为 1，错误来自现有 Settings 诊断、Runtime Settings 和 `packages/shared/src/multicaRuntimeSettings.ts` 类型问题；没有本轮 `SpecWorkflowMobileControls` 或 `specWorkflow` 新增错误。
- `node_modules/.bin/vp.cmd run --filter @codework/web typecheck`：退出码为 1，错误来自现有 `packages/shared/src/multicaRuntimeSettings.ts` 类型问题，另有既有 `dpop.ts` suggestion；没有本轮 Spec Workflow 文件错误。
- `node_modules/.bin/vp.cmd fmt` 已作用于本轮客户端文件；随后仍需完成 `fmt --check`、空白检查及必要的 Desktop typecheck 记录。未运行浏览器、Electron、真实移动设备或远程 Provider 网络验收，不能以静态检查替代真实可达性。

#### Retrospect

- acceptance 之前的 Server 自动推进和人工验收边界现在有对应的 Web/Mobile 可达控制，`completeAcceptance` 的 guard、revision 和 capability 仍由既有服务链路收敛。
- 本轮没有把 A8 勾选：新的独立审计仍发现自然语言 Agent 意图尚未接入 typed intent 执行链，`fix/ship` 也仍需对照原仓库确认批次语义；同时真实 UI/远程路径尚未获授权执行。
- 下一轮只继续 A8 的一个最小缺口，优先追踪自然语言输入如何安全调用现有 typed intent RPC；若无法在不绕过关闭闸门的前提下落地，则记录为阻塞和回滚方案，不用 Prompt 注入冒充自动路由。

### Round 14 — A8 Provider typed intent 路由承载

#### Plan

- 只推进 A8 审计确认的一个缺口：让已启用线程的普通 Provider 回合可以安全承载自然语言阶段判断，并回到现有 typed Router/Service。
- 复用当前 ProviderCommandReactor、ProviderRuntimeIngestion、Composition Agent Driver Registry 和 SpecWorkflowService；不新增自由文本命令执行器，不把 Prompt 当作服务端门禁。
- 保持关闭闸门：能力未确认启用时不初始化 workflow state、不注入阶段协议、不解析或派发工作流意图；最终验收和独立验证身份仍由现有服务/Reactors 控制。

#### Act

- 新增 `apps/server/src/specWorkflow/SpecWorkflowAgentProtocol.ts`，提供当前阶段上下文格式化、唯一合法 marker 解析和用户可见文本剥离；未知或重复 marker 不形成可执行意图。
- `ProviderCommandReactor` 在 capability 已启用时初始化线程级 workflow state，并把状态协议注入 Provider 输入；关闭态保持原始普通输入。
- `ProviderRuntimeIngestion` 在终帧解析并剥离 marker，使用稳定 prompt digest 回调已有 `SpecWorkflowService.dispatch`；`apply/fix` 记录当前 Provider 实施者并复用现有 Registry 查找不同的可用 Driver，路由纠偏原因写入线程 activity。
- 未直接由模型自然语言伪造 `verify` 的独立身份；apply 成功后的持久化 Reactor 仍是自动唤醒独立 verify 的唯一入口。同步更新内建能力文档和 Goal 提示词说明。

#### Verify

- `node_modules/.bin/vp.cmd test run apps/server/src/specWorkflow/SpecWorkflowAgentProtocol.test.ts packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow/SpecWorkflowService.test.ts`：3 个文件、17 个测试通过。
- `node_modules/.bin/vp.cmd run --filter @codework/client-runtime typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter @codework/desktop typecheck`：通过。
- `node_modules/.bin/vp.cmd run --filter codework typecheck`：退出码为 1；输出没有本轮新增 SpecWorkflow 类型错误，剩余为工作树已有 Provider/Settings/BYOK 测试类型错误以及既有 Effect suggestions。
- 本轮未运行浏览器、Electron、真实 Provider 网络或移动设备；未修改、重置、清理无关脏文件，未提交或推送。

#### Retrospect

- 自然语言现在有了可验证的“Provider 输出 → 严格 marker → typed dispatch → Router/Decider”承载链，且关闭 capability 时无 workflow prompt、state 初始化和 dispatch 副作用。
- 本轮没有勾选 A8：真实 Provider 是否按协议返回 marker、Web/Desktop/Mobile/remote 的真实可达性、fix 批次与 `ship` 的原仓库语义对照，以及新的独立全量审计仍未完成。
- 下一轮只能继续 A8 的独立审计与回滚证明；若要把 marker 失效重试、真实 UI 点击或远程 Provider 验收写成通过，必须先获得相应的浏览器、设备或网络操作授权。

### Round 15 — A8 fix/ship 批次语义收紧

#### Plan

- 只补 A8 独立审计确认的一个缺口：让 `fix`/`ship` 不再只是 full workflow 的阶段别名，而具备可验证的轻量修复批次语义。
- 复用现有 `SpecWorkflowState`、`SpecWorkflowArtifactStore`、Composition Bridge 和 Reactor，不增加第二套批处理状态源；`mode=fix` 使用同一 change 的 `fix.md` 作为批次可见记录。
- Server 必须拒绝空批次，修复项完成后等待 `ship` 再进行一次独立 verify；验证失败保留批次并允许继续 fix，普通 full workflow 的自动 verify 行为不改变。

#### Act

- `startSpecWorkflow` 让 `mode=fix` 从 `apply` 起步；Decider 允许同一批次连续进入 apply，并在下一项修复开始时重置本轮实施/验证状态。
- Router 增加 fix 模式的连续修复和 `ship → verify` 纠偏；verify 失败也能由 `ship` 回到 apply，full workflow 原有 fix 重试保持兼容。
- `SpecWorkflowReactor` 对 fix 模式的修复终态停止自动逐项 verify，等待 `ship` 触发批次级独立验证；Service 选择已声明的独立验证者作为 verify Task 执行者。
- `SpecWorkflowService` 在 fix 模式的 ship/archive 派发前读取并检查当前 change 的 `fix.md`，缺少产物或内容为空时拒绝操作；生产 Server layer 接入现有 `SpecWorkflowArtifactStoreLive`。
- Agent 协议和内建文档补充 fix.md、一次批次 verify、失败保留和最终 acceptance 约束；没有改动无关脏文件，没有提交或推送。

#### Verify

- `node_modules/.bin/vp.cmd test run apps/server/src/specWorkflow/SpecWorkflowDecider.test.ts apps/server/src/specWorkflow/SpecWorkflowRouter.test.ts apps/server/src/specWorkflow/SpecWorkflowReactor.test.ts apps/server/src/specWorkflow/SpecWorkflowService.test.ts apps/server/src/specWorkflow/SpecWorkflowAgentProtocol.test.ts packages/contracts/src/specWorkflow.test.ts`：6 个文件、36 个测试全部通过。
- Service 测试证明：fix 模式首个请求会创建 apply Task；首个修复完成后可再次派发 fix；ship 读取非空 `fix.md` 后只派发一次 verify，执行者切换为独立 verifier；空 `fix.md` 在调用 verify 前由 Server 拒绝。
- Router/Decider/Reactor 测试证明：full workflow 的 fix 重试仍可用；fix 模式从 apply 起步、可连续累积；修复终态等待 ship；ship 纠正至 verify；验证失败仍保留可修复路径。
- `node_modules/.bin/vp.cmd fmt --check` 对本轮合同、Decider、Router、Reactor、Agent Protocol、Service、Server 和测试文件通过；`git diff --check` 通过。
- `node_modules/.bin/vp.cmd run --filter codework typecheck` 仍退出 1，但输出没有本轮 Spec Workflow 文件新增错误；剩余为工作树已有 Provider/Settings/BYOK 类型错误和既有 Effect suggestions，未伪装为全包通过。
- 本轮未运行浏览器、Electron、真实 Provider 网络、远程切换或移动设备；A8 的真实可达性与最终独立审计仍未完成。

#### Retrospect

- 原先 `fix`/`ship` 仅能在 full workflow 中表达 apply 重试和 acceptance 前置，不能证明“多项轻量修复累积后一次审计”；现在该语义由 `mode=fix + fix.md + ship→verify` 的 Server 路径收口。
- `fix.md` 是批次记录，StateStore 是执行控制面，二者职责分离；空产物只能阻止 ship/archive，不能删除用户已有代码或批次记录。
- 普通 full workflow 不改变：apply 成功仍可在有独立验证者时由 Reactor 自动唤醒 verify；只有 fix 模式等待显式 ship，避免批次被逐项提前收口。
- A8 仍未勾选。下一轮继续做最终独立审计与回滚开关验证，重点确认启用/禁用、Provider marker、Server RPC、Web/Mobile 状态更新和该批次路径之间没有旁路。

### Round 16 — A8 最终独立审计、回滚和真实入口验证

#### Plan

- 在不派发子代理的前提下重新读取本 ledger、内建能力文档和关键合同/Server/UI 代码，按 A1-A7 的验收边界重新执行相关 focused tests、定向 typecheck、i18n、构建和格式检查。
- 在隔离 `CODEWORK_HOME` 中重新走 Web 真实路径：创建一次性项目和线程，验证“+ → 规格工作流”的启用、状态显示、关闭回滚；启用和关闭后各发送一次只读 Provider 请求，并确认一次性项目没有产生 `spec/` 产物。
- 以同一隔离目录重新构建并启动 Desktop 冒烟；记录当前环境没有 Android 设备，因此 Mobile 只以已有真实合同/Presentation 测试和 typecheck 作为证据，不把不可执行的真机路径写成通过。

#### Act

- 独立复核发现 `SpecWorkflowService.test.ts` 的完成 Run 对象在展开后被推宽为 `string`，已用显式 `CompositionTaskRun` 变量收窄；同时将 Artifact Store 的无错误分支改为 `Effect.void`，没有改动无关脏文件。
- 重新确认关闭闸门贯穿 Router、Service、Reactor、Provider Runtime Ingestion 和客户端 state：未启用时不解析 marker、不派发工作流 Task、不启动后续 Reactor、不查询 workflow state；禁用不删除既有产物或用户代码。
- 完成 Web 隔离线程的启用/关闭点击；Desktop 使用隔离 `CODEWORK_HOME` 完成构建后的启动冒烟；Android `adb devices` 返回空设备列表。

#### Verify

- `node_modules/.bin/vp.cmd test run packages/contracts/src/specWorkflow.test.ts apps/server/src/specWorkflow apps/server/src/composition/CompositionTaskRuntimeProjector.test.ts apps/server/src/persistence/Migrations/075_SpecWorkflowCapabilities.test.ts apps/server/src/persistence/Migrations/076_SpecWorkflowEvents.test.ts apps/server/src/persistence/Layers/SpecWorkflowCapabilityStore.test.ts apps/server/src/persistence/Layers/SpecWorkflowStateStore.test.ts apps/server/src/auth/RpcAuthorization.test.ts packages/client-runtime/src/state/spec-workflow.test.ts apps/mobile/src/features/threads/specWorkflowMobilePresentation.test.ts`：17 个文件、96 个测试全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/contracts typecheck`、`@codework/client-runtime typecheck`、`@codework/web typecheck`、`@codework/mobile typecheck`、`@codework/desktop typecheck`：全部通过；Web 只有既有 `src/cloud/dpop.ts` Effect 风格 suggestion。
- `node_modules/.bin/vp.cmd run --filter codework typecheck`：退出 1，剩余错误只在工作树已有 Provider/Settings/BYOK 测试；本功能 `apps/server/src/specWorkflow` 不再有 type error，之前本功能测试的类型错误已修复。
- `node_modules/.bin/vp.cmd fmt --check` 相关 26 个文件及 `git diff --check`：通过；`node scripts/check-ui-i18n.mjs`：Web、Mobile、Desktop 全部通过。
- `node_modules/.bin/vp.cmd run --filter @codework/web build` 以及 `node_modules/.bin/vp.cmd run --filter @codework/desktop --filter codework build`：通过；只出现既有路由、source map、chunk size 和动态导入警告。隔离 `CODEWORK_HOME=...codework-spec-workflow-desktop-test-20260903 node apps/desktop/scripts/smoke-test.mjs`：`Desktop smoke test passed.`
- Web 真实路径：未建线程时菜单曾显示“创建线程后才能启用规格工作流”；创建隔离线程后菜单显示“规格工作流 仅在需要结构化项目流程时启用”，点击后显示“规格工作流 已为此线程启用”和“工作流尚未开始”，再次点击后恢复未启用文案；关闭后发送安全 Provider 请求只返回“收到”，没有 workflow 状态旁路；隔离项目 `specExists=false` 且无文件。
- 回滚证明：Server 的 disabled Router/Bridge/Service/Reactor/恢复测试全部包含在上述 17 个文件中；真实 Web 点击关闭也已完成。回滚语义是停止新路由、Task 和 Reactor，不删除已有 `spec/`、用户代码或批次记录。
- 独立审计结论：A1-A7 的合同、门禁、路由、Composition/Runtime、客户端入口、i18n、Provider marker、Mobile state 和 fix/ship/loop 证据均重新通过；A8 的 Web/Desktop 真实入口和回滚证据通过。Android 真机及真实 Relay/Tunnel 切换因当前环境无设备/远端连接目标未运行，已明确记录为环境边界，不冒充通过。

#### Retrospect

- A8 的最终审计不再依赖上一轮“测试通过”文字，而是重新执行了跨合同、Server、客户端、构建和真实 Web/Desktop 入口的证据链；本次唯一发现的本功能问题已在审计中修复并回归通过。
- 关闭能力后的最小安全边界已经得到两层证明：Server 测试阻断所有工作流副作用，真实 Web 关闭后仍可正常发送普通 Provider 请求且一次性项目没有 `spec/` 写入。
- Mobile 真机和 Relay/Tunnel 的未运行原因是设备/远端目标缺失，不是代码静默失败；客户端共享 state、连接状态禁用控制和 Provider 降级已有 focused 证据。该环境边界保留在文档风险项中。
- A1-A8 已满足当前仓库可执行范围的最终验收，下一步只需由维护者在有 Android 设备或真实 Relay/Tunnel 环境时补做跨设备验收，不应为此扩大当前变更或修改无关工作树。

## Lessons

- L-1：能力授权、工作流阶段状态和项目可见产物必须分层；`enabled=false` 是进入 Router 的硬前置，状态事件不能取代文件产物，文件产物也不能取代服务端状态。
- L-2：Router 只能返回下一步和原因，不能代替 Decider 执行转换；错误入口纠正必须通过稳定 reason code 交给后续 UI 做 i18n，不能把中文展示文案硬编码进领域判断。
- L-3：RPC、workflow service、Composition Bridge 和 StateStore 必须各自保持单一职责；事件持久化解决重启恢复，但不能把 contract double 的调用测试误当成真实 Provider/Runtime 生命周期验收。
- L-4：workflow 与 Composition 的终态回写必须依赖持久化 `activeTaskId` 相关，不能凭 project/thread 猜测；等待器复用 Runtime Projection 的终态合同，重启恢复则必须另做持久化扫描。
- L-5：启动恢复必须再次经过当前 capability gate，并按 project/thread/task/run 身份逐层核对；可恢复的终态走同一 Decider/StateStore 幂等写回，缺失或错配只告警留待后续处理，不能静默猜测或补造任务。
- L-6：审批控制要通过独立 typed review RPC 映射既有 Decider 命令；客户端只有在 capability 已确认开启后才查询 workflow state，防止关闭状态下产生隐式订阅或控制副作用。
- L-7：Mobile 与远程一致性应依赖既有 `environmentId + threadId` state atoms 和连接 runtime；Provider 降级应在 Composition Driver 边界归一为稳定错误并保留当前阶段，不能在客户端猜测或替换 Provider。
