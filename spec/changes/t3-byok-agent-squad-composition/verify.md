# SDD ledger — plan: spec/changes/t3-byok-agent-squad-composition/tasks.md

## Round 0 (stage: propose)

| ID | Severity | Status | Finding | Evidence |
|---|---|---|---|---|
| V-001 | P1 | fixed(r0) | proposal 将“现有 Workspace/MCP 能力”作为 Tool Broker 的真实执行目标，但尚未指定具体工具入口。已改为第一批明确选择一个读路径和一个 approval-gated 写路径，并限定只作用于 `agent_loop`。 | proposal.md `What` 第 2 项；tasks.md 2.3 |
| V-002 | P1 | fixed(r0) | 旧 BYOK 纯文本和旧 Workspace/MCP 直连可能被新 Task/Agent/Capability 必填校验误伤。已增加 legacy text 兼容分支、agent_loop-only Tool Broker 入口和回归验收。 | proposal.md `What` 第 1-3 项；proposal.md `How` 第 3-4 项 |
| V-003 | P1 | fixed(r0) | 第一批原本把完整 Composition Orchestrator、三协议 Agent Loop、三端 UI 和 Multica 一起交付，范围过大。已收窄为一个协议的真实闭环、合同和兼容测试；完整编排与 UI 移到后续变更。 | proposal.md `Not in this change`；tasks.md 3-5 |
| V-004 | P1 | fixed(r0) | Agent Loop 对不支持工具循环的 provider 若静默回到文本，会让用户误以为 Agent 已执行工具。已规定 Anthropic/Gemini 在本批返回 `agent_loop_unsupported`。 | proposal.md `What` 第 3 项；proposal.md `How` 第 3 项 |
| V-005 | P2 | fixed(r0) | 新增 Composition Event 可能被旧 Provider Runtime 或旧 Checkpoint 误读为终态。已移除第一批持久化 Task/Run 实现，并要求新事件隔离测试。 | proposal.md `What` 第 4 项；tasks.md 4.1、4.3 |
