# TCode 多 Agent 运行时迁移进度

## 文档目的

本文记录 `tcode` 分支把 `cursor-byok`、Code Work 原生 Provider/Tool 能力与 Multica 多 Agent 协同接入统一 Composition 运行时的实施进度。

架构差距、功能取舍和目标数据流以 [byok-multica-migration-matrix.md](./byok-multica-migration-matrix.md) 为准；本文只维护已经实施的节点、验证证据、剩余缺口和下一步顺序。

## 当前快照

| 项目 | 当前值 |
| --- | --- |
| 更新时间 | 2026-08-27 |
| 仓库 | `E:\MyProject\code-work\codework` |
| 当前分支 | `tcode` |
| 当前提交 | BYOK 恢复对外语义节点：`feat(composition): 定义 BYOK checkpoint 恢复语义` |
| 相对远端 | 领先 `origin/tcode` 29 个提交，尚未 push |
| 最新节点 | grant 下发/撤销与 BYOK resume 输出统一投影到任务历史与事件流（幂等去重） |
| 工作区边界 | 存在大量其他并行修改；本文不把这些修改计入本迁移进度，也不回滚、暂存或提交它们 |

## 证据等级

本文不使用单一百分比表达完成度。协议底座、真实产品接入和多端可用性成熟度不同，用一个数字会掩盖关键缺口。

| 等级 | 含义 |
| --- | --- |
| L1 已编码 | 实现已进入当前分支，但不能单独证明行为正确 |
| L2 聚焦测试通过 | 对应单元、集成或回归测试已通过 |
| L3 本地跨进程通过 | 使用本地子进程或协议 fixture 验证了进程边界、事件流或工具回流 |
| L4 真实产品 E2E 通过 | 使用真实 Multica daemon、真实 Cursor/VS Code、真实 Provider API 或真实多端客户端完成关键路径 |
| L5 可发布 | 完成故障演练、权限审计、升级兼容、回滚和发布前验证 |

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

仍缺：

- Goal Loop 的完成标记、预算、idle/stale pivot、验证子代理和完整跨重启 supervisor。
- Byok delegation 与 Composition Task/Run 的单一状态源收敛。
- 面向用户的恢复、冲突和失败原因展示。

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

最新验证：

- 本节点目标回归（恢复/Driver/Orchestrator/RuntimeProjector/GrantRegistry）5 文件 68/68 用例通过，其中恢复用例扩展断言了恢复投影的 payload、事件行内容与去重。
- Orchestrator 新增 grant 投影用例 2 个：下发投影带 capabilityId@grantId 摘要；旧 Run 撤销在 retryTask 时落 `revoked` 幂等行。
- 此前节点基线：进程重启级恢复测试与目标回归通过记录见 git 历史（本表只维护最新一轮）。
- 实现文件 lint 通过，19 个目标文件格式检查通过。
- `git diff --check` 通过，目标文件 TypeScript 错误为 0（新增文件的既有 suggestion 级提示不计入）。
- 包级 typecheck 仍被仓库内既有 MCP、IDE、server test 和 `local_tools` 等错误阻断，不能宣称全包类型检查通过；composition 全量套件中仅 `CompositionMcpRuntimeAdapter.e2e.test.ts` 真实 stdio E2E 失败，属既有环境问题，与本次改动无关。

仍缺：

- 使用真实 OpenAI/Anthropic/Gemini 兼容 API 的断线、重试、限流和凭据轮换 E2E。
- resume 后的"重派新 turn"编排：目前 Driver 只验证并恢复持久化输出，重新派发由上层决定，尚未接入 Orchestrator 自动续跑。
- Provider 原生 Session/Turn 的真实 capability grant 注入、撤销回执和审计闭环。
- Supplier/Profile/Account 控制中心、模型分组、权重路由、自动匹配和 failover 状态机。

### 3. IDE Agent Driver

**状态：L3，自定义 JSON-RPC bridge 已通过本地跨进程验证；真实 Cursor/VS Code 接入未完成。**

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

**状态：L3 的本地协议与进程级 HTTP 集成已闭环；真实 Multica 协同仍停留在 L1/L2。**

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

仍缺：

- Supplier/Profile/Account 的统一管理、凭据生命周期和多账号回滚。
- 余额、用量、价格、健康和路由状态的统一看板。
- Goal、Squad、Leader、运行时恢复和 capability grant 的用户操作路径。
- Web/Desktop/Mobile 关键路径的真实集成验证。
- Request Lab、通用请求镜像、脱敏回放和协议对比界面。

## 当前提交节点

当前 `tcode` 相对 `origin/tcode` 的 26 个提交按主题归并如下。

| 主题 | 提交范围 | 结果 |
| --- | --- | --- |
| IDE transport 与 ToolBroker | `7357e17e7` 至 `f4d94b81b` | 通用 JSON-RPC transport、重连、session 生命周期、Agent Driver 和事件流 |
| Run 监督与事件隔离 | `cc93318bb` 至 `d2e6e389d` | watchdog、委派事件隔离、早到事件保留和 Provider Run 失活监督 |
| 运行时恢复与归属 | `6f62ea81f` 至 `bfda2e21b` | Provider/BYOK 事件归属修复和运行时任务恢复 |
| Multica 投递可靠性 | `4a9d648fb` | 持久化 quick-create 发送意图 |
| BYOK 模型循环可靠性 | `f016bc851` 至 `c120282c5` | 取消竞争、上下文增长与溢出、安全重试和流终态校验 |
| BYOK 部分输出恢复 | `687732124` | checkpoint 持久化、确定性事件、摘要、偏移、去重和正文恢复 |
| BYOK 恢复对外语义 | `3d04a3823`（已 amend，主题不变） | `supportsResume` 启用条件、`resumeTask` 拒绝/短路语义与进程重启级恢复测试 |
| Multica outbox 收口 | `feat(composition): Multica quick-create outbox 审计与收口` | outbox 审计/settle、`X-Idempotency-Key` 出站、启动告警接线与真实 HTTP 进程级 e2e |
| Grant/resume 投影 | `feat(composition): 投影能力授权与恢复状态` | grant issued/revoked 幂等投影、BYOK resume 输出投影与对应测试 |
| 文档与回归覆盖 | `c5a709b46`、`223b90ee5` | 刷新迁移矩阵并覆盖 ACP 取消终态回归 |

## 关键结论

### 是否可以使用 T3/Code Work 的壳接多个 Agent Driver

可以。当前 Composition、Provider Service、Runtime Adapter 和 Agent Driver Registry 已经形成实现基础，Web/Desktop/Mobile 也共享统一 Server/RPC。剩余工作主要是把各 Driver 的生命周期、恢复、授权和状态展示做成同一个产品闭环。

### 每个 Driver 是否已经可以使用接入的 API 和各 IDE API

目前只能回答“部分可以”：

- BYOK Driver 已存在真实 Code Work ToolBroker 调用路径，并有聚焦测试。
- 本地 Runtime HTTP/MCP bridge 和 IDE JSON-RPC fixture 已验证跨进程工具回流。
- 真实 Provider Session/Turn、真实 Multica daemon、真实 Cursor/VS Code 尚未完成 capability grant 和官方 API E2E。
- 因此现在不能宣称所有 Driver 已经可以安全、稳定、可撤销地使用全部 Code Work API 和各 IDE API。

### 是否已经具备 Multica 多 Agent 协同

已具备 Composition 本地任务图与 Multica 窄协议接入底座，但还没有完成真实 Multica Agent/Squad/Leader 的端到端协同。真实 daemon、动态成员、权限、幂等、跨重启恢复和结果汇聚仍是上线前必做项。

## 下一最小实施顺序

1. ~~完成 BYOK 部分输出恢复的对外语义，决定 `supportsResume` 的启用条件并增加进程重启级测试。（已完成）~~
2. ~~为 Multica quick-create 增加持久化 outbox、冲突恢复和集成测试。（本地 HTTP 进程级已完成；真实 daemon 侧的幂等键语义与 by-key 查询能力确认后，收口可自动化）~~
3. 接入真实 Cursor/VS Code Adapter，完成 capability handshake、最小 IDE API 白名单和撤销测试。
4. 把 Provider、IDE、Multica 的 grant 状态统一投影到 Composition Run 和 Settings。（本地子任务已完成：grant issued/revoked 与 BYOK resume 输出均已投影为任务历史事件；剩余 = 外部 Driver 的真实 grant 回执接入与 Settings 跨端看板展示，依赖真实产品环境）
5. 收敛 Goal Loop、预算、重试、验证子代理和跨重启 supervisor。
6. 最后补齐 Supplier/Profile 控制中心与 Web/Desktop/Mobile 集成 E2E。

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
