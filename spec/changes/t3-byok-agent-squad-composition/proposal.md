# Proposal: t3-byok-agent-squad-composition

## Why

当前 T3 已经具备多 Provider、BYOK、Workspace、MCP、Checkpoint 和基础 delegation，但 BYOK 直连仍主要是文本流，工具调用和审批没有统一闭环。`cursor-byok` 中已有的工具桥、多 executor、Task/Subagent、路由和 Cursor 兼容能力也无法直接被 T3 客户端复用。

本变更先交付一个可运行的最小组合内核：统一合同、能力授权、一个真实 BYOK 工具循环和旧路径兼容。它为后续多个模型 API、CLI Agent、IDE Runtime、Task/Squad 和 Multica 适配保留稳定边界，但不把所有复杂度捆绑进第一批。

## What

- 新增可选的 ModelDriver、AgentDriver、CapabilityGrant、ToolBroker、IDEAdapter、Task/Run/Event 共享合同；旧文本请求可以不携带 Task/Agent/Capability，新 `agent_loop` 请求必须携带明确身份和 grants。 | refs: R-2, R-3, R-4 | verify: contracts 测试能分别通过 legacy text 和 agent_loop payload，拒绝 agent_loop 缺失身份的 payload，并验证工具事件顺序。
- 实现 T3 Capability Registry/Policy 和第一条真实 Tool Broker 路径，只对 `agent_loop` 调用收口到既有 Workspace/MCP 能力；现有 Web/Desktop/Mobile 的直接 Workspace/MCP 调用保持原权限路径。 | refs: R-2, R-3 | verify: 服务端测试覆盖 allow、approval_required、deny、cancel、重复 idempotencyKey 和旧直连回归；未授权 agent_loop 不会写入工作区。
- 将 T3 BYOK 文本流扩展为可选择的 agent_loop，第一批只接入 OpenAI-compatible；Anthropic/Gemini 在 agent_loop 模式返回明确的 `agent_loop_unsupported`，无 grants 或 legacy 请求继续走纯文本。 | refs: R-2, R-3 | verify: OpenAI-compatible 有一条“模型工具调用 -> Tool Broker -> tool result -> 下一轮模型请求”的测试；Anthropic/Gemini 的不支持错误和旧纯文本测试均通过。
- 增加最小 Composition Event Envelope 和 AgentDriver/IDEAdapter/MulticaAdapter 的探测合同，不在本批持久化 Squad/Task 图或启动外部 daemon；为后续 Task/Run/Leader/IDE/Multica 实现固定可演进边界。 | refs: R-2, R-3, R-4 | verify: 合同测试验证 capability descriptor、未知 IDE profile 拒绝、外部 runtime 不可用显式报错，并确认旧 Checkpoint/Provider Runtime 不读取新事件作为旧终态。

**Not in this change**: Anthropic/Gemini Agent Loop、完整 Task/Run 持久化、Squad/Leader 调度、Multica daemon/remote server、三端任务 UI、所有 CLI/IDE Runtime 的生产级适配、Cursor 账号/MITM/CA/relay/Request Lab/Control Center、自动化 1%/5%/10% 灰度发布和正式发布操作。

## How

- 选择 ModelDriver 与 AgentDriver 分离；模型 driver 只处理模型协议，Agent driver 只处理 Runtime 生命周期，ToolBroker 统一处理工具、审批、脱敏和幂等。
- 选择 T3 作为 Task、Capability、事件和恢复的事实源；Multica 通过 adapter 映射 daemon/runtime/task，不让外部服务取代 T3 的 Workspace、Thread 和 Checkpoint。
- BYOK 默认保持纯文本兼容；只有请求明确声明 `agent_loop` 并携带身份和工具 grants 时，才进入工具循环。已声明 agent_loop 但协议不支持时必须返回 `agent_loop_unsupported`，不得静默回到文本模式。
- 新 Tool Broker 只接管 agent_loop 调用；既有直接 Workspace/MCP 路径保持原入口和权限。新增字段使用可选扩展或新事件类型，旧 ProviderAdapterShape、旧 Checkpoint 和旧客户端不得把新事件当成旧终态。

## Risk

- Tool Broker 连接文件或终端后，错误的 capability grant 可能造成工作区修改；通过 Task/Agent/Workspace 三层授权、资源范围校验、审批和幂等键降低风险，旧 BYOK 无 grant 时仍只读文本。
- 新旧工具入口并存可能造成权限边界分叉；通过 agent_loop-only 入口、旧直连回归测试和显式事件来源字段避免把新 grants 错套到旧调用。
- 第一批只接一个协议，其他协议显式失败；后续扩展必须复用 canonical ToolInvocation 测试，不能复制一套无终态约束的循环。
- 回滚计划：关闭 agent_loop feature flag，保留旧 BYOK 文本路径；删除新增 composition contracts、server modules 和 event handlers 后运行旧 Provider/Workspace 测试，不迁移或改写既有会话和 Checkpoint。

<!-- APPROVED: 2026-08-25 01:09 -->
