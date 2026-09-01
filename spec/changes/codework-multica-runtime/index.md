# Index: codework-multica-runtime

Requirement source: 用户长期目标文件 `C:\Users\Administrator\.codex\attachments\461416e4-2999-4f56-810d-8287f9559878\goal-objective.md`，访问日期 2026-08-27。

## Requirements

- R-1: "保留 pending、running、completed、failed、stopped、timeout、resuming 等状态语义。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移
- R-2: "避免旧事件覆盖新事件。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移
- R-3: "增加 watchdog。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移
- R-4: "增加 recoverExecWithoutTerminal。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移
- R-5: "保证取消不会丢失最终状态。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移
- R-6: "每个 Driver 都必须可以根据 capability/grant 调用" | source: 用户长期目标文件，ToolBroker 和 Capability 完整可达性
- R-7: "每个工具调用必须：有 capability 标识、有 grant 检查、有 approval 检查、有 audit 记录、有超时和取消传播。" | source: 用户长期目标文件，ToolBroker 和 Capability 完整可达性
- R-8: "不得把本地 mock fixture 当成 Multica 真实接入完成。" | source: 用户长期目标文件，Multica 真实接入
- R-9: "映射 exec_id、message_id、runtimeTaskId，避免旧事件覆盖新事件。" | source: 用户长期目标文件，第一阶段 Cursor BYOK delegation lifecycle 迁移

## Delivered Slices

- D-1: delegated runtime event isolation | implements: `packages/contracts/src/providerRuntime.ts`, `apps/server/src/composition/CompositionRuntimeAgentDriver.ts` | tests: `packages/contracts/src/providerRuntime.test.ts`, `apps/server/src/composition/CompositionRuntimeAgentDriver.test.ts` | evidence: runtimeId/executionId/sourceMessageId 归属保护和 providerPass 非硬拒绝回归测试；不等于真实 Cursor Adapter 或 Multica daemon E2E。

## Assets

- A-1: `apps/server/src/composition/CompositionTaskRuntimeProjector.ts` | use: extend
- A-2: `apps/server/src/composition/CompositionTaskRuntimeProjectionService.ts` | use: extend
- A-3: `apps/server/src/composition/CompositionOrchestrator.ts` | use: extend
- A-4: `apps/server/src/persistence/Services/CompositionTaskStore.ts` | use: reuse
- A-5: `apps/server/src/persistence/Layers/CompositionTaskStore.ts` | use: extend
- A-6: `packages/contracts/src/composition.ts` | use: extend
- A-7: `packages/contracts/src/providerRuntime.ts` | use: extend
- A-8: `E:\MyProject\cursor-byok\internal\backend\forwarder\turn_stale.go` | use: pattern
- A-9: `E:\MyProject\cursor-byok\internal\backend\forwarder\shell_recovery.go` | use: pattern
- A-10: `E:\MyProject\cursor-byok\internal\backend\forwarder\service_exec.go` | use: exact pending identity and provider-pass semantics

## Exemplars

- E-1: `CompositionRunLiveness` → `apps/server/src/composition/CompositionTaskRuntimeProjectionService.ts`
