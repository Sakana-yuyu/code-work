# Paseo、cursor-byok、Code Work 与 Multica clean-room 迁移矩阵

## 文档目的

本文把 `E:\MyProject\cursor-byok` 的能力盘点与 Code Work 当前实现对齐，回答两个问题：

1. Paseo、`cursor-byok` 与 Multica 已有，但 Code Work 尚未迁移、或只实现了底层零件的能力是什么。
2. Code Work 是否可以作为统一 Web/Desktop/Mobile 壳，接入多个 Provider、BYOK API、CLI/IDE Runtime，并原生承载多 Agent 协同、Automation 与 Workspace Scripts。

本文是架构和迁移边界文档，不把静态代码、fake transport 或类型检查描述成真实 Multica daemon、真实 IDE 或多端 E2E 已通过。

## 证据范围

- 对比仓库：`E:\MyProject\cursor-byok`，本轮只读审计基线为 `c25ecc44`。该仓库存在用户未提交的前端修改，本文不修改其文件。
- Code Work 仓库：`E:\MyProject\code-work\codework`，当前唯一工作分支为 `main`；2026-08-29 刷新时 HEAD 为 `731587aa8`，相对 `origin/main` 领先 77 个提交，并存在大量用户并行修改。
- Paseo 参考仓库：`E:\MyProject\paseo`，固定提交 `ed628ff82e1777f6a46f5f8963db6b4ac3ee2ce3`；主体为 Apache-2.0，按 NOTICE 与第三方组件许可证要求只读研究 Workspace、Script、Schedule、Agent 与 heartbeat 语义。
- Multica 参考仓库：`E:\MyProject\multica`，固定提交 `64ec7f54163d918d5d7fd4dcae857f241b7842d0`；其许可证附带商业嵌入、托管、品牌和归属限制，因此本项目只做 clean-room 架构研究，不复制、翻译或嵌入 Multica 源码、UI、品牌和受限制资产。
- 对比材料：`cursor-byok` 的 `docs\feature-inventory.md`、`docs\cursor-capability-map.md`、`docs\goal-design.md`、`docs\subagent-smart-routing-design.md`、`docs\opencode-comparison-and-optimization.md` 及相关实现目录。
- Code Work 依据：`apps\server\src\provider\byok`、`apps\server\src\composition`、`apps\server\src\provider`、`apps\web\src\components\settings` 及现有 contracts。
- 结论更新时间：2026-08-29。

### 本轮刷新记录

- 检索关键词：`Paseo workspace script schedule heartbeat`、`Multica daemon runtime squad leader task graph MCP retry resume quick-create`、`cursor-byok delegation PendingExecs exec_id message_id provider_pass watchdog`。
- 采用来源：本地 Code Work、Paseo、Multica 与 cursor-byok 的固定源码和测试，以及三个参考仓库的 LICENSE/NOTICE。
- 采用原因：Code Work 当前工作树和提交是“是否已经迁移”的直接证据；固定参考提交用于稳定描述架构语义，许可证用于限定只可自主重建的边界。
- 不能由本轮证据得出的结论：未启动真实 Multica daemon、真实 Cursor、真实 VS Code，也未使用真实 BYOK 凭据，因此以下“本地跨进程 E2E”均不等同于对应真实产品 E2E。

## 状态定义

| 状态         | 含义                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------- |
| 已有等价     | Code Work 已有同一用户能力，协议和生命周期不必依赖 Cursor 私有协议。                     |
| 部分迁移     | Code Work 已覆盖主要路径，但缺少控制面、持久化、边界状态或 UI。                          |
| 只有底层零件 | Code Work 有可复用服务、合同或工具，但用户路径尚未闭环。                                 |
| 未迁移       | `cursor-byok` 有完整能力，Code Work 当前没有等价实现。                                   |
| 不直接迁移   | 该能力依赖 Cursor 私有客户端或本地 CA；应通过隔离兼容层提供，而不是侵入 Code Work 核心。 |

## 总体结论

Code Work 可以达到以下目标：

```text
Code Work Web/Desktop/Mobile 壳
    + 多 Provider / 多 BYOK API / CLI / ACP / IDE Adapter
    + 统一 Workspace / Terminal / Git / MCP / Browser / Skills 能力
    + 统一 Task / Run / Event / Lease / Capability 控制面
    + Multica daemon / runtime / Agent / Squad / Leader 协同
```

关键前提是把外部执行器限定在 Adapter 边界内：

- Provider、CLI、ACP、IDE、Multica 都投影为稳定的 Agent Driver。
- Code Work 原生工具调用经过 `CapabilityRegistry` 和 `ToolBroker`；外部 Runtime 只有在完成 capability handshake 后才能形成同等闭环，不能因为保存了 grant 引用就声称已经授权。
- Multica 的任务创建走正式 `POST /api/issues/quick-create`；daemon 的 `claim` 只负责领取服务端已经排队的任务，不能被伪装成任意 Code Work Task 的投递接口。
- Code Work assignee ID、Multica Agent/Squad UUID、Runtime ID、Workspace ID 必须显式映射。
- 真实 IDE 必须实现 handshake、能力验证和断线恢复；仅有 profile 合同或 probe 不能算 IDE 接入完成。

Code Work 当前不能通过“接入一个 API”自动获得 Cursor 客户端的全部私有能力，特别是 MITM、`RunSSE`、`BidiAppend`、Cursor 客户端持有的子代理会话注入，以及 Cursor 账户替换。

## 功能迁移矩阵

### 1. Provider、Supplier 与模型控制中心

| cursor-byok 能力                                         | Code Work 当前状态 | Code Work 证据                                                                                                    | 缺口与迁移动作                                                                  |
| -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| OpenAI Chat/Responses、Anthropic Messages、Gemini Native | 部分迁移           | `E:\MyProject\code-work\codework\apps\server\src\provider\byok\ByokAdaptersImport.ts`、`OpenAiByokModelDriver.ts` | 已有协议适配，但需要统一 Provider Profile、健康状态和模型来源的控制面。         |
| 自定义 Base URL、API Key、Header、模型参数               | 部分迁移           | `ProviderInstanceEnvironment.ts`、`ProviderInstanceRegistry.ts`、`ByokAdaptersImport.ts`                          | 需要补齐供应商级编辑、凭据生命周期和敏感字段显示策略。                          |
| Supplier 模板、供应商目录                                | 部分迁移           | `SupplierCatalog.ts`、`ModelCatalog.ts`                                                                           | 需要把模板能力映射到 Code Work Provider Instance，而不是只在导入阶段使用。      |
| 模型目录拉取与导入                                       | 部分迁移           | `ByokModelDiscoveryService.ts`、`ByokModelAdaptersSection.tsx`                                                    | 需要统一拉取状态、失败诊断、模型来源标识和导入回滚。                            |
| 模型编辑器                                               | 部分迁移           | `apps\web\src\components\settings\ProviderSettingsForm.tsx`                                                       | 当前已有 Provider 设置，但与 `cursor-byok` 的模型粒度编辑器不完全等价。         |
| 模型分组、权重路由、自动使用匹配                         | 只有底层零件       | `ByokModelDiscoveryService.ts`、Provider Instance 相关服务                                                        | 需要迁移分组合同、路由权重、匹配解释、切换回滚和 failover 状态机。              |
| 余额、用量、价格、健康状态看板                           | 部分迁移           | `ByokBalanceService.ts`、`BalanceCore.ts`                                                                         | Code Work 有查询服务和缓存，但缺少供应商级统一看板、价格历史和异常聚合。        |
| Provider 诊断与一键修复                                  | 只有底层零件       | Provider probe、diagnostics 相关服务                                                                              | 需要把诊断结果接入 Settings、命令面板和 Provider 卡片的可达路径。               |
| 多账号登录、账号切换、账号级回滚                         | 未迁移             | `cursor-byok\frontend` 多账号/控制中心相关实现；Code Work 目前以 Provider Instance 为主                           | 需要独立 Account Profile 控制面；Provider Instance 不能直接等价成 Cursor 账户。 |

**判断：** Code Work 已经具备 BYOK 的协议和运行底座，但还没有 `cursor-byok` 那种完整的 Supplier/Profile 控制中心。优先级高于单独增加更多模型协议，因为没有控制面就很难让多个 Agent 稳定共享 API、余额和路由规则。

### 2. MITM、Cursor 协议与本地代理

| cursor-byok 能力                                                                     | Code Work 当前状态                 | 证据与边界                                                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS MITM、本地 CA 生成与信任引导                                                   | 不直接迁移                         | `cursor-byok\internal\mitm`、`internal\certs`；Code Work 是原生 Provider/Runtime 架构，不依赖 Cursor 客户端网络劫持。                    |
| Cursor `RunSSE`、`BidiAppend`、`AgentService`、`aiserver` 桥                         | 不直接迁移                         | Code Work 没有 Cursor 私有协议兼容层；不能把 Code Work Provider Event 误称为 Cursor 原生协议兼容。                                       |
| Cursor 请求拦截、改写、响应注入                                                      | 不直接迁移                         | 如果未来需要，做独立 `CursorCompatibilityAdapter` 或 sidecar，不进入 Composition 核心。                                                  |
| `ExecServerMessage` 工具调用、interaction、allowlist、redacted read、thinking stream | 未迁移到 Cursor 协议；能力部分已有 | Code Work `ToolBroker`、Capability Policy、Provider Runtime Event 可以承载同类语义，但消息格式和 Cursor 客户端行为不等价。               |
| Cursor 客户端特有的子代理会话注入与 resume                                           | 未迁移                             | `cursor-byok` 自身的设计也依赖 Cursor 客户端持有的子代理 RunSSE 与工作区信息；Code Work 应采用自己的 Agent Driver/Runtime Adapter 合同。 |

**判断：** 这些功能不是 Code Work 统一壳的必需品。直接移植会把 Cursor 私有协议、证书和客户端生命周期带进核心，增加维护和安全边界。若产品目标明确要求“兼容现有 Cursor 客户端”，再单独建设兼容 Adapter。

### 3. 请求镜像、调试与 Request Lab

| cursor-byok 能力                | Code Work 当前状态 | Code Work 证据                                                             | 缺口                                                                                                 |
| ------------------------------- | ------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bidi/RunSSE 原始请求与响应镜像  | 未迁移             | `cursor-byok\internal\mitm`、`internal\historymetrics`                     | Code Work 没有 Cursor 原始协议来源，因此应做 Provider/Runtime 通用镜像，而不是复制 Cursor 文件格式。 |
| 解码请求、Runtime Debug JSONL   | 部分迁移           | Code Work Provider NDJSON、Trace diagnostics、Process/resource diagnostics | 需要统一 `requestId`、`runtimeId`、`taskId`、脱敏策略和跨重启查询。                                  |
| Request Lab、请求重放与协议对比 | 未迁移             | `cursor-byok` Request Lab 与镜像设置                                       | 可作为后续独立工具，复用 Provider Adapter 的结构化请求，但必须禁止重放带副作用的工具调用。           |
| Cursor 安装兼容性诊断           | 未迁移             | `cursor-byok` diagnostics                                                  | 仅在启用 Cursor Compatibility Adapter 时迁移。                                                       |

### 4. Delegation、Subagent、Goal 与 Multica 协同

| cursor-byok / Multica 能力                                   | Code Work 当前状态         | Code Work 证据                                                                                                  | 迁移结论                                                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 本地 delegated worker、并发队列、超时、取消、结果预览        | 部分迁移                   | `ByokDelegationService.ts`、`CompositionOrchestrator.ts`、`CompositionTaskStore.ts`                             | 需要统一 Byok delegation 与 Composition Task，而不是维护两套队列和状态。                                                                                                                         |
| Provider/Model Group 绑定到 delegation                       | 部分迁移                   | `ByokDelegationService.ts` 的 model group 解析                                                                  | 应投影成 Agent Driver 的 Provider Profile 选择策略。                                                                                                                                             |
| Goal Loop：strict 完成标记、轮数/成本/时限预算               | 部分迁移，后端闭环已存在   | `CompositionGoalLoop.ts`、`CompositionGoalLoopRunner.ts`、`CompositionGoalValidator.ts`                         | 已有 fail-closed 完成标记、独立验证、轮数/成本/截止时间和幂等事件台账；仍缺完整共享 UI、真实 Provider/Multica E2E 与产品级费用投影。                                                             |
| Goal 自动重试、idle/stale pivot、二次校验子代理              | 部分迁移                   | `CompositionGoalLoopSupervisor.ts`、`CompositionGoalLoopRedispatch.ts`、`CompositionGoalLoopAttemptAdapters.ts` | 已有停滞 pivot、验证方、跨重启未收敛扫描与幂等 redispatch；仍需真实外部 Runtime 断线恢复、动态成员选择和多端可见性验证。                                                                         |
| Code Work Composition Task/Run/Event/Dependency/Lease        | 已有等价                   | `CompositionRuntimeLeaseLifecycle.ts`、`CompositionRuntimeAgentDriver.ts`、`CompositionTaskStore.ts`            | 作为统一任务控制面保留；提交 `31b8413f8` 已把 `probe online`、30 秒内新鲜 heartbeat、Runtime/Agent scope 与 capability handshake 组成领取前 fail-closed 门禁。                                   |
| Provider Agent Driver                                        | 已有运行底座，授权未闭环   | `CompositionProviderAgentDriver.ts`、`CompositionProviderAgentDriverRegistry.ts`                                | Provider Session/Turn 继续通过 Code Work `ProviderService`；当前没有 Provider 原生工具的 Code Work grant handshake。                                                                             |
| Multica daemon register/heartbeat/claim/status/complete/fail | 部分迁移                   | `MulticaDaemonProtocol.ts`、`MulticaDaemonRuntimeAdapter.ts`、`MulticaDualChannelProcess.e2e.test.ts`           | 已有本地 Node 子进程的 control + task-event 双通道回流验证；真实 Multica daemon、身份、数据库与权限尚未启动验证。                                                                                |
| Multica quick-create 创建任务                                | 已有协议接线，尚未真实 E2E | `MulticaDaemonProtocol.ts` 的 `quickCreateTask`、`MulticaDaemonRuntimeAdapter.test.ts`                          | 使用 `/api/issues/quick-create`；返回 `task_id` 后由 daemon claim。真实服务端幂等键、重启恢复和权限仍缺。                                                                                        |
| Multica Agent/Squad/Leader                                   | 部分迁移                   | `CompositionSquad`、`CompositionMulticaProbeResult`、`CompositionTaskGraphExecutor.ts`                          | Code Work 已有本地 Leader + 子任务依赖图、并行、失败取消、有限重试和结果汇聚；尚未与真实 Multica Agent/Squad 查询和动态成员调度闭环。                                                            |
| Multica 任务取消/恢复                                        | 部分迁移                   | `MulticaDaemonRuntimeAdapter.ts`、`CompositionTaskGraphExecutor.ts`                                             | 本地 Composition 图可传播取消和重试；外部 Multica 仅有窄协议 cancel-ack，远端 resume 仍未成为可验证的用户路径。                                                                                  |
| 多 Agent 监督、重试、恢复、结果合并                          | 部分迁移                   | `CompositionTaskGraphExecutor.ts`、`CompositionTaskGraphExecutor.test.ts`                                       | 本地 Task Graph 已实现依赖调度、Leader 汇聚、失败清理和跨重启稳定 retry Run 复用；提交 `eaef6f6a8` 会校验 task/agent/attempt 身份并在并发竞争后复用胜出的持久化 Run。真实 Multica 汇聚仍未闭环。 |

### 5. Skills、MCP、Workspace、Terminal、Git、Browser、IDE

| 能力                                           | Code Work 当前状态                     | 证据                                                                                                                            | 缺口                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace 文件、Terminal、Git/Worktree         | 已有等价                               | Code Work Workspace File System、Terminal Manager、VCS/Worktree 服务                                                            | 外部 Runtime 必须通过 grant 使用，不能直接取得宿主机权限。                                                                                                               |
| Browser/Preview 自动化                         | 已有等价                               | Code Work Preview、Browser Automation、Browser trace collector                                                                  | 需要把 task-scoped grant 和审计事件接入外部 Runtime。                                                                                                                    |
| MCP HTTP Server、Session Registry、Preview MCP | 已有等价                               | Code Work MCP 服务与 `ToolBroker`                                                                                               | 需要补齐跨 Runtime 的 capability handshake 和撤销。                                                                                                                      |
| Skills 搜索、加载、运行时注入                  | 部分迁移                               | Code Work Skills 搜索、加载和运行时注入服务                                                                                     | `cursor-byok` 的编辑器、扫描、导入、启停与 sparse activation 规则尚未完全对齐。                                                                                          |
| Sparse Skill Activation                        | 未迁移                                 | `cursor-byok` 对应设计/实现；Code Work 当前非完全等价                                                                           | 可复用 `skill-sparse-activation` 的设计，但应以 Code Work 的 Skill Registry 和 prompt 编译边界实现。                                                                     |
| Cursor 原生工具能力                            | 不直接迁移                             | 依赖 Cursor `ExecServerMessage` 和客户端回注                                                                                    | 仅迁移语义到 Code Work canonical tool，不迁移私有 wire format。                                                                                                          |
| Cursor/VSCode IDE Adapter handshake            | 已有自定义 bridge 与本地跨进程 fixture | `CompositionIdeJsonRpcTransport.ts`、`CompositionIdeAgentDriver.ts`、`CompositionIdeAgentDriver.e2e.test.ts`                    | 已验证本地 JSON-RPC 子进程的 task.start、task.cancel、progress/completed event、事件隔离和去敏；仍未实现或验证 Cursor / VS Code 官方 Extension、IPC 或 API 接入。        |
| 各 Agent 共享 Code Work 能力                   | 部分迁移，存在真实调用路径             | `CapabilityRegistry`、`CapabilityPolicy`、`ToolBroker`、`CompositionRuntimeToolBridgeHttp.ts`、`CompositionRuntimeMcpServer.ts` | BYOK loop 和 Runtime bridge 已通过统一 ToolBroker 的本地 HTTP/MCP 路径验证；Provider 原生 Session/Turn、Multica 远端和官方 IDE 仍缺真实 grant 注入、撤销回执与审计闭环。 |

### 6. 多账号、多端与控制中心

| cursor-byok 能力               | Code Work 当前状态 | 缺口                                                                                                        |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Cursor 账户替换/切换           | 未迁移             | 依赖 Cursor 客户端本地账户和凭据格式，不应直接进入 Code Work Provider Instance。                            |
| 多账号存储、导入、profile 回滚 | 未迁移             | 需要独立 Account Profile 与密钥存储策略；当前没有等价控制面。                                               |
| Provider 多实例与热更新        | 已有等价           | `ProviderInstanceRegistry`、Provider 配置热更新。                                                           |
| Web/Desktop/Mobile 共享 Server | 已有等价           | Code Work 多端客户端通过统一 Server/RPC 使用 Provider、Composition 和 Workspace。                           |
| 桌面控制中心                   | 部分迁移           | Code Work 有 Settings、Provider、Agents 入口，但没有 `cursor-byok` 的完整供应商、账号、请求实验室控制中心。 |

## 尚未移植功能清单

按对“统一 Code Work 壳 + 多 Agent 协同”影响排序，当前真正缺失或不完整的功能是：

1. 完整 Supplier/Profile/Account 控制中心：模型分组、权重路由、自动匹配、余额/价格/健康聚合、多账号切换与回滚。
2. Goal Loop 产品闭环：后端已有严格完成标记、轮数/成本/时限预算、stale pivot、验证方和跨重启监督；仍缺完整共享 UI、真实 Provider/Multica 运行和产品级费用投影。
3. Multica 真正 Squad/Leader 闭环：Code Work 已有本地 Task Graph 的子任务派发、依赖、并行、有限重试、失败取消、Leader 汇聚和稳定 retry Run 跨重启复用；仍缺真实 Multica Agent/Squad 查询、动态成员调度与远端结果映射。
4. 外部 Runtime 的 task-scoped capability grant 实际注入：Code Work 已有统一 handshake 合同和 InMemory 验证闭环；Provider 原生 Session/Turn、Multica 窄协议和 IDE Adapter 仍需要真实协议授权、撤销、过期和审计回执。
5. IDE Runtime 的真实接入：`cursor_ide`、`vscode_ide` 已有 TCode 自定义 JSON-RPC bridge 与本地子进程 fixture，但未完成真实 Cursor 或 VS Code 官方 Extension/IPC/API handshake。
6. Request Lab 与通用请求镜像：Code Work 有诊断和 Provider Event，但没有等价的结构化重放/协议分析界面。
7. Skills/MCP Control Center 的完整管理体验，以及与 `cursor-byok` 一致的 sparse activation 语义。
8. 多账号与账号级凭据生命周期：Provider Instance 不能替代 Cursor 账户管理。

以下能力不属于“漏移植”，而是有意不直接移植：Cursor MITM、本地 CA、Cursor 私有 `RunSSE/BidiAppend` wire protocol、Cursor 客户端私有子代理注入。它们应在需要时以隔离兼容 Adapter/sidecar 形式接入。

## 目标架构与数据流

```text
Web / Desktop / Mobile
          |
          v
Code Work RPC + Capability Policy
          |
          v
Composition Task / Run / Event Store
          |
          v
统一 Composition Agent Driver Registry
          |
          +--> Provider Driver --> Code Work ProviderService --> Codex / Claude / OpenCode / BYOK
          |
          +--> CLI / ACP Driver --> Runtime Adapter
          |
          +--> IDE Driver ------> IDE Adapter handshake + ToolBroker
          |
          +--> Multica Driver --> quick-create / daemon claim / HTTP status / WebSocket events
                                  |
                                  v
                         Multica Agent / Squad / Leader / Task Graph
```

### Multica 派发语义

1. Code Work 创建自己的 Composition Task/Run。
2. `MulticaDaemonRuntimeAdapter` 根据显式 route 把 Code Work assignee 映射为 Multica `agent_id` 或 `squad_id`，并携带 `X-Workspace-ID` 调用 `/api/issues/quick-create`。
3. Multica 返回队列 `task_id`；Code Work 将其保存为 `runtimeTaskId`。
4. daemon 通过 `/api/daemon/runtimes/{runtimeId}/tasks/claim` 领取任务，随后按 start/progress/complete/fail 回报事实。
5. WebSocket 只作为实时事件和控制通道；HTTP heartbeat/status 作为恢复和正确性路径。
6. 重复事件按 `sourceEventId` 去重；不能用 WebSocket 唤醒帧推断完成。

### 当前明确限制

- quick-create 的远端 API 当前没有与 Code Work `runId` 等价的服务端幂等键；本轮只做进程内幂等映射。进程在 HTTP 成功但响应丢失后重启，仍存在重复创建风险，必须在后续通过 Multica 服务端幂等能力、持久化 outbox 或人工冲突校验补齐。
- Code Work 当前没有默认配置真实 Multica Adapter 来源，也不会扫描或启动用户的 `~/.t3/userdata`、Multica daemon 或真实 IDE。
- Multica 外部取消和恢复没有被当前窄协议完整暴露；Adapter 会返回稳定错误，不能把本地取消写成外部任务已取消。
- Provider 原生 Session/Turn 只有在 accepted handshake 后接收 `capabilityHandshakeId`；当前生产投影没有 handshake 实现，会拒绝带 grant 的任务。Multica quick-create 不携带 Code Work grant，带 grant 的任务会被 Adapter 拒绝。握手 ID 已进入 Run 持久化，但真实外部 Runtime 的撤销回执仍需单独验证。
- 真实 IDE、真实 Multica daemon、Web/Desktop/Mobile 多端刷新和真实 API 凭据链路仍需单独 E2E。

## 推荐迁移顺序

### 阶段 A：控制面和可观测性

- Provider Profile、Supplier、Model Group、Route、Failover 合同。
- 供应商余额/用量/价格/健康统一查询与 Settings UI。
- Request/Runtime Debug 统一事件结构和脱敏查询。

### 阶段 B：统一 Goal 与 Delegation

- 把 `ByokDelegationService` 的队列状态投影进 Composition Task/Run。
- 复用现有 Goal 预算、验证、stale pivot、跨重启监督与 redispatch，不建立第二套循环状态机。
- 把 Goal 面板接入 Web/Desktop/Mobile 共享 RPC，移动端只消费稳定投影。

### 阶段 C：Multica Squad/Leader/Task Graph

- Runtime 注册来源、Agent/Squad 查询和稳定映射配置。
- 远端任务创建的持久化 outbox/idempotency、断线重连、claim 恢复。
- Squad Leader、子任务图、依赖、监督、结果合并和跨 Runtime 事件归属。

### 阶段 D：IDE Adapter 与能力注入

- Cursor/VSCode 官方 Extension/IPC/API handshake。
- 能力版本协商、task-scoped grant、撤销和过期。
- 真实 IDE 工具调用经过 Code Work ToolBroker，并补充拒绝和重连测试。

### 阶段 E：可选 Cursor 兼容层

- 只有在产品明确需要兼容现有 Cursor 客户端时，才隔离实现 MITM、CA、RunSSE/BidiAppend 和 Cursor 账户兼容。
- 兼容层输出 canonical ProviderRuntimeEvent，不允许把 Cursor 私有协议泄漏进 Composition 核心。

## 验收边界

### 已完成的本地证据

- Composition Runtime Adapter、Provider Agent Driver、Multica daemon protocol 和 runtime adapter 有定向测试。
- Multica quick-create 的路径、请求体、`X-Workspace-ID` 和 `task_id` 归一化有 fake transport 测试。
- 无显式 Agent/Squad 映射时会失败，不猜测远端 UUID。
- 提交 `eaef6f6a8` 已验证 Task Graph 在服务重启后复用持久化的 `:retry:2`、`:retry:3` Run；身份冲突 fail-closed，并发重试竞争后重新读取稳定胜出 Run。
- 提交 `731587aa8` 已验证 Automation 的 `retry_pending` Run 会在后续 tick 中周期恢复，且使用稳定 Automation/Composition 身份，不重复创建计划运行。
- 已运行聚焦的 Composition Runtime、IDE event-stream、Multica 双通道与 ToolBroker 测试；本轮不把全量 `typecheck` 作为成功证据，当前已知全量检查存在既有 Effect / MCP / server 测试基线问题。

### 尚未宣称完成的证据

- 已运行本地 Node 子进程的 Multica control + task-event 双通道 E2E、IDE JSON-RPC event-stream E2E，以及 Runtime ToolBridge HTTP/MCP 路径测试；它们均为协议 fixture，不是官方产品进程。
- 未启动真实 Multica daemon，未验证真实数据库、登录身份、PAT/daemon token、Agent/Squad 查询与权限。
- 未启动真实 Cursor/VSCode IDE，未验证官方 Extension/IPC/API handshake。
- 未进行 Web/Desktop/Mobile 集成 E2E 或真实 BYOK API 请求。
- 尚未完成真实 Multica daemon 的跨进程幂等、HTTP 成功但响应丢失后的 outbox 恢复，以及真实 WebSocket 断线重连演练；本地稳定 retry Run 和 Automation 周期自愈不能替代这些外部 E2E。

## 回滚与风险

- 本文档和 Adapter 代码均为增量修改；代码节点可回滚到提交 `fc24a5d6`，quick-create 节点为提交 `57b888cd`，Task Graph 重试恢复节点为 `eaef6f6a8`，Automation 周期自愈节点为 `731587aa8`。
- 当前没有修改 `cursor-byok`，没有启动真实服务，没有 push，也没有修改生产数据。
- 若 Multica quick-create API 的权限或字段与只读源码快照不一致，应关闭该 Adapter 的 dispatch 能力，保留 probe/claim/status 只读路径；不能自动降级为猜测式 POST。
- 若后续发现远端 quick-create 无法提供可靠幂等，应先增加持久化 outbox 和冲突恢复，再开放自动重试。
