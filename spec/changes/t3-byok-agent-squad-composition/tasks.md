# Tasks: t3-byok-agent-squad-composition

> deps omitted = sequential; owner marks the primary implementation surface.
>
> 进度已按实际代码同步（2026-08-27）：各项以 `codework` 仓库提交为证据（见各项标注）。
> 本清单范围之外的后续批次（Batch A~F2：MCP、IDE 门、Multica、Provider ToolBroker 等）
> 见 `../../../codework/spec/changes/t3-multica-runtime/design.md` 的逐批落地记录；
> 其中反复声明的剩余缺口是真实模型 / 真实 daemon / 真实 IDE 与 Web/Desktop/Mobile 的现场 E2E，
> 以及 `t3` 全量 typecheck 约 312 条既有基线错误，均不属于本清单原始验收项。

- [x] 1. Shared composition contracts
  - [x] 1.1 Add capability, model tool call, ToolBroker, AgentDriver, IDE descriptor, Task/Run/Event schemas and stable error codes. (evidence: codework `packages/contracts/src/composition.ts`、`compositionRuntime.ts`)
  - [x] 1.2 Add contract tests for valid payloads, missing identity, invalid capability grants, event ordering and terminal states. (evidence: `composition.test.ts`、`compositionRuntime.test.ts`)
  - [x] 1.3 Run focused contracts tests and document the wire compatibility rule.

- [x] 2. Capability registry and Tool Broker
  - [x] 2.1 Implement capability discovery from T3-owned Workspace, MCP and provider runtime sources. owner: backend deps: 1.1 (evidence: `CapabilityRegistry.ts` + MCP/Browser catalog)
  - [x] 2.2 Implement policy evaluation for Workspace, Agent and Task scope, approval-required states, cancellation and idempotency. owner: backend deps: 1.1 (evidence: `CapabilityPolicy.ts`、`CapabilityGrantRegistry.ts`)
  - [x] 2.3 Connect one real read-only Workspace/MCP tool path and one approval-gated mutation path for `agent_loop`; keep existing direct Workspace/MCP calls on their current authorization path. owner: backend deps: 2.1, 2.2
  - [x] 2.4 Add denial, duplicate invocation, approval and cancellation tests. owner: backend deps: 2.3

- [x] 3. BYOK Agent Loop
  - [x] 3.1 Extract a protocol-neutral model-run state machine from the existing BYOK adapter. owner: backend deps: 1.1 (evidence: codework 654c0a2f，`apps/server/src/composition/ByokAgentLoop.ts`)
  - [x] 3.2 Map OpenAI-compatible tool-call events to canonical ToolInvocation events; return `agent_loop_unsupported` for Anthropic/Gemini until their adapters are separately scoped. owner: backend deps: 3.1, 2.3 (evidence: 已被 99dcc534 超额完成——Agent Loop 与 Driver 协议无关，OpenAI/Anthropic/Gemini 均接入，不再有 unsupported 边界)
  - [x] 3.3 Implement tool-result reinjection, terminal deduplication, retry boundary, explicit unsupported errors and pure-text compatibility. owner: backend deps: 3.2 (evidence: ByokAgentLoop 幂等、结果回放、临时 grant 撤销；legacy 文本路径保持可用)
  - [x] 3.4 Add red-green tests for OpenAI tool call/broker result/next model turn, unsupported protocols, and legacy text. owner: backend deps: 3.3 (evidence: `ByokAgentLoop.test.ts`)

- [x] 4. Composition event and runtime contracts
  - [x] 4.1 Add optional Composition Event Envelope and canonical capability descriptor contracts without changing legacy Provider Runtime terminal semantics. owner: backend deps: 1.1 (evidence: `packages/contracts/src/compositionRuntime.ts`)
  - [x] 4.2 Add AgentDriver, IDEAdapter and MulticaAdapter probe/error contracts with explicit unsupported and runtime-offline results. owner: backend deps: 4.1 (evidence: `CompositionRuntimeAdapter.ts`、`CompositionProbeRegistry.ts`、Multica Adapter、`CompositionIdeSessionRegistry.ts`)
  - [x] 4.3 Add contract tests for unknown IDE profile, unavailable external runtime, legacy Checkpoint replay and new-event isolation. owner: backend deps: 4.2 (evidence: 各 probe/adapter/IdeSession 定向测试)

- [x] 5. Integration and acceptance
  - [x] 5.1 Run focused server and contracts tests for policy, broker, OpenAI loop, unsupported protocols and legacy paths. deps: 2.4, 3.4, 4.3 (evidence: Batch A~F2 各批次记录的定向测试，如 Batch E 132 个、F2 56 个通过)
  - [x] 5.2 Run affected package typecheck/build checks and `git diff --check`. deps: 5.1 (evidence: 各批次记录执行；`t3` 全量 typecheck 剩约 312 条既有基线错误待专项清理)
  - [x] 5.3 Record excluded Cursor/Multica/Squad capabilities and confirm the old BYOK pure-text, Workspace/MCP and Checkpoint paths remain available. deps: 5.2 (evidence: `codework/docs/internals/byok-multica-migration-matrix.md` 记录未迁移能力域；各批回归确认旧路径保留)
