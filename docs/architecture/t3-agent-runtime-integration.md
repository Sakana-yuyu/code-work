# T3 Agent Runtime 集成决策

## 目的

本文是 T3 Code 统一 IDE、Agent Driver 和多 Agent Runtime 的架构入口。目标是让 T3 保持独立可用的 IDE 壳，同时把 Provider、BYOK、ACP、CLI、MCP、Cursor/VSCode Adapter 和 Multica 接入同一个任务、权限和工具执行平面。

本文记录当前代码审计后的决策，不把类型合同、模拟 Adapter、单元测试或构建成功误认为真实外部 Runtime 已完成。

## 当前边界

```text
T3 Web / Desktop / Mobile
        |
        v
Composition Orchestrator
        |
Agent Driver Registry
        |-- Provider / BYOK / ACP / CLI
        |-- Cursor / VSCode IDE Adapter
        |-- Multica Runtime Adapter
        |
Capability Registry -> task-scoped Grant -> Approval -> ToolBroker
        |
Workspace / Terminal / Git / MCP / Browser / Computer Use / IDE API / Provider API
        |
Audit / Idempotency / Cancellation / Timeout / Retry / Review
```

核心原则：Driver 负责“谁来执行”，ToolBroker 负责“能执行什么以及如何执行”。Driver 不得直接访问宿主文件系统、终端、Git、MCP、浏览器或 IDE；所有工具调用都必须带有任务和运行上下文，并经过 Capability、Grant、Approval、Audit、幂等和取消链路。

## 审计结论

### 已在 T3 保留或实现

- 原生 IDE、Workspace、Terminal、Git、Provider、Composition、Task/Run/Event。
- Provider、BYOK 和 Runtime Driver 注册、探测、派发、取消及事件投影基础。
- Capability Registry、task-scoped Grant、Approval、Audit 和 ToolBroker。
- 第一批 Workspace、Terminal、Git canonical tool。
- Preview Browser 的 Composition 工具入口。
- MCP tool catalog、JSON Schema 校验、结果去敏、超时，以及官方 SDK 的 stdio、Streamable HTTP、SSE runtime adapter。
- Multica daemon 的注册、心跳、quick-create、任务状态投影、Leader/Squad 显式路由和 T3 Task Graph 元数据传递。
- review checkpoint、失败 Run 重试和基础 Task/Run 状态机。
- 原生 Task Graph 执行器已通过 `server.executeCompositionTaskGraph` 暴露到 WebSocket RPC，
  `client-runtime` 已提供任务列表、事件查询、执行、取消、审核和重试的共享查询/命令入口；服务端支持
  Leader review、串行/并行子节点、依赖、retry、结果汇聚和迟到事件保护。

### `cursor-byok` 可吸收，但需要 T3 原生重做

- 多协议 BYOK 请求和 Provider 错误归一化：映射到 T3 Provider/BYOK adapter，不复制 Cursor 私有消息。
- Supplier、模型发现、模型分组、权重路由、failover、余额、用量和成本：统一为 Provider Profile、Model Catalog 和 Runtime Usage 控制面。
- Agent Loop、委派、并发、超时、取消、结果汇聚、上下文裁剪：统一为 Composition Run、Driver 和 Task Graph。
- Skills、原生提示词和 sparse activation：复用 T3 Skill Registry 与 prompt 编译边界，逐项补充合同和 UI。
- Request/Runtime diagnostics：使用 T3 的 runtime、task、run、exchange 标识和统一脱敏格式重做。

### 只能作为独立可选 Adapter

- Cursor 原生 Bidi/RunSSE、AgentService、ExecServerMessage 和网络 MITM。
- Cursor 本地 CA、请求镜像、Cursor 启动预检和 Cursor 专属代理 UI。
- Cursor 官方账户 OAuth、Token 导入、客户端数据库回写和多账户切换。
- 真实 Cursor/VSCode 本地协议或 Extension/IPC transport。

这些能力依赖 Cursor 私有客户端生命周期或本机协议，不能成为 T3 Provider、Composition、ToolBroker 或原生 IDE 的前置依赖。若实现，必须有独立 Runtime ID、配置、进程生命周期、日志、审计和回滚边界。

### 当前仍缺少的主线能力

- client-runtime 和 Web/Desktop/Mobile 的 MCP 配置、连接状态、工具目录和错误可达性。
- Provider/BYOK/ACP/CLI 的统一 capability projection 和真实跨 Driver ToolBroker E2E。
- Web/Desktop/Mobile 尚未提供 Task Graph 的产品入口、可视化状态和取消/审核交互；当前已有服务端 RPC 与
  `client-runtime` 共享查询/命令，但还没有真实客户端点击验收。
- Multica 在 T3 壳内通过真实 daemon 执行 Leader -> Squad -> Task Graph -> 子 Agent -> 结果汇聚 -> Review 的
  完整外部编排链仍未验收；当前本地 Task Graph 可使用 T3 Driver/ToolBroker，外部 Multica 仍受窄协议限制。
- Multica 官方窄协议之外的 Tool-call/Grant handshake。当前没有证据证明官方 daemon 接受 T3 grant 或能够回调 T3 ToolBroker，因此不能静默赋予 full access。
- Cursor/VSCode 真实 transport、IDE operation 和断线恢复。
- Browser/Computer Use 的完整 canonical tool、session、审批、审计和取消闭环。
- 供应商目录、usage/cost ledger、context compaction、supervisor retry/reassign/escalate/circuit breaker 等产品级控制面。

## Multica 集成决策

Multica 作为外部执行 Runtime 接入 T3，而不是替代 T3 的任务和权限控制面。

```text
T3 Task
  -> T3 Leader / Squad / Task Graph
  -> Multica quick-create 或本地执行 route
  -> daemon claim / start / progress / complete / fail
  -> T3 event projector
  -> Leader 汇聚结果
  -> T3 review checkpoint
```

必须遵守以下边界：

1. T3 的 `taskId`、`runId`、`agentId`、`squadId`、Multica `task_id`、远端 Agent/Squad UUID 显式映射，禁止按名称猜测。
2. quick-create 返回异步 `task_id` 只能证明任务进入队列，不能直接推断完成。
3. WebSocket 唤醒帧不是终态事实；终态必须来自 HTTP 状态或带稳定事件 ID 的任务事件。
4. 当前官方窄协议没有可验证的 T3 Capability Grant 接收、Tool-call RPC 或 revoke 协议。带 grant 的外部派发必须返回明确的 `capability_handshake_unsupported`，不能把 grant 引用当作授权完成。
5. 若要让 Multica 使用 T3 canonical tools，优先通过显式 MCP bridge 或经过审计的独立 daemon extension；bridge 必须重新校验 `taskId`、`runId`、`agentId`、`grantId` 和过期时间，并最终进入 T3 ToolBroker。
6. Multica 断线、取消、超时、重放和 quick-create 响应丢失必须保留未知结果语义；没有远端幂等键时不得自动重复创建。

## 实施顺序

每个批次独立提交、独立验证：

1. 客户端 MCP 状态和生命周期命令，随后接入 Settings UI。
2. 统一 Agent Driver capability projection，验证 Provider/BYOK/ACP/CLI 共享 Workspace、Terminal、Git、MCP 和 Provider API。
3. T3 原生 Leader/Squad/Task Graph 执行器，包含并行、依赖、隔离、取消、超时、重试、结果汇聚和 review。
4. Multica bridge/extension 协议协商；在协议未实现前保持稳定拒绝。
5. Cursor/VSCode 独立 Adapter，先实现 T3 IDE API 的可验证 operation，再接真实 transport。
6. Browser/Computer Use canonical session 和 ToolBroker 闭环。
7. Provider catalog、usage/cost、context compaction、诊断 UI 和跨端可达性。
8. 最后评估 Cursor MITM；它不是统一 Runtime 的基础依赖。

## 验收口径

每一批必须分别报告：

- 定向单元/集成测试、类型检查、格式检查和 `git diff --check`。
- 真实本地 Runtime 或子进程 E2E；模拟 Adapter 只能证明合同。
- Web、Desktop、Mobile 是否存在可达入口；未验证的端必须明确列出。
- 权限、幂等、取消、超时、错误和敏感值脱敏证据。
- 已实现、仅完成合同、真实 E2E 已通过、尚未完成和明确放弃的能力。

## 回滚与风险

本架构不要求修改 `E:\MyProject\cursor-byok`，也不修改已安装 Cursor bundle。每个能力批次使用独立提交；发生回归时按提交逆序回滚，不回滚用户已有工作区改动。

主要风险是外部协议能力漂移、quick-create 缺少跨进程幂等、真实 IDE transport 未验证，以及把“有 Driver/Grant 字段”误判为“外部 Runtime 已获得工具权限”。这些风险通过稳定错误码、显式 handshake、Task/Run 事件去重、适配器隔离和真实 E2E 逐批收敛。
