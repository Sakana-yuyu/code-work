# Index: t3-byok-agent-squad-composition

## Requirements

- R-1：对比当前分支 T3 与 `E:/MyProject/cursor-byok`，列出 BYOK 侧尚未移植能力。
- R-2：验证是否可以使用 T3 的壳，接入多个 Agent 驱动。
- R-3：验证每个驱动是否可以使用接入的模型 API、工具 API 和各个 IDE API。
- R-4：纳入 `multica-ai/multica` 的多 Agent 协同能力。

## Assets

- A-1：T3 `ProviderDriver` / `ProviderAdapter` / `ProviderRuntime` 合同。
- A-2：T3 BYOK model adapter、balance/discovery、delegation scheduler 与 Workspace/MCP/Checkpoint 能力。
- A-3：`cursor-byok` agent model、tool bridge、delegation、routing、MITM、Request Lab、Control Center、Cursor account/capabilities 和 computer use 模块。
- A-4：Multica 官方 Agent、Runtime、Task、Squad、Leader、daemon 语义。

## Exemplars

- E-1：`E:/MyProject/code-work/t3code/apps/server/src/provider/ProviderDriver.ts` 的多实例 Driver SPI。
- E-2：`E:/MyProject/code-work/t3code/apps/server/src/provider/Services/ProviderAdapter.ts` 的会话、审批、用户输入和事件流合同。
- E-3：`E:/MyProject/cursor-byok/internal/backend/agent/model/tool_admission.go` 与 `internal/backend/agent/bridge/exec/tool_registry.go` 的工具准入和 canonical 映射。
- E-4：`E:/MyProject/cursor-byok/internal/backend/delegation/executor_registry.go` 的多 executor 注册、探测、失败冷却与能力声明。
- E-5：Multica 官方 Squad 文档的 Leader-first 调度语义。
