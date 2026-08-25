# Tasks: t3-byok-agent-squad-composition

> deps omitted = sequential; owner marks the primary implementation surface.

- [x] 1. Shared composition contracts
  - [x] 1.1 Add capability, model tool call, ToolBroker, AgentDriver, IDE descriptor, Task/Run/Event schemas and stable error codes. 
  - [x] 1.2 Add contract tests for valid payloads, missing identity, invalid capability grants, event ordering and terminal states.
  - [x] 1.3 Run focused contracts tests and document the wire compatibility rule. 

- [x] 2. Capability registry and Tool Broker
  - [x] 2.1 Implement capability discovery from T3-owned Workspace, MCP and provider runtime sources. owner: backend deps: 1.1
  - [x] 2.2 Implement policy evaluation for Workspace, Agent and Task scope, approval-required states, cancellation and idempotency. owner: backend deps: 1.1
  - [x] 2.3 Connect one real read-only Workspace/MCP tool path and one approval-gated mutation path for `agent_loop`; keep existing direct Workspace/MCP calls on their current authorization path. owner: backend deps: 2.1, 2.2
  - [x] 2.4 Add denial, duplicate invocation, approval and cancellation tests. owner: backend deps: 2.3

- [ ] 3. BYOK Agent Loop
  - [ ] 3.1 Extract a protocol-neutral model-run state machine from the existing BYOK adapter. owner: backend deps: 1.1
  - [ ] 3.2 Map OpenAI-compatible tool-call events to canonical ToolInvocation events; return `agent_loop_unsupported` for Anthropic/Gemini until their adapters are separately scoped. owner: backend deps: 3.1, 2.3
  - [ ] 3.3 Implement tool-result reinjection, terminal deduplication, retry boundary, explicit unsupported errors and pure-text compatibility. owner: backend deps: 3.2
  - [ ] 3.4 Add red-green tests for OpenAI tool call/broker result/next model turn, unsupported protocols, and legacy text. owner: backend deps: 3.3

- [ ] 4. Composition event and runtime contracts
  - [ ] 4.1 Add optional Composition Event Envelope and canonical capability descriptor contracts without changing legacy Provider Runtime terminal semantics. owner: backend deps: 1.1
  - [ ] 4.2 Add AgentDriver, IDEAdapter and MulticaAdapter probe/error contracts with explicit unsupported and runtime-offline results. owner: backend deps: 4.1
  - [ ] 4.3 Add contract tests for unknown IDE profile, unavailable external runtime, legacy Checkpoint replay and new-event isolation. owner: backend deps: 4.2

- [ ] 5. Integration and acceptance
  - [ ] 5.1 Run focused server and contracts tests for policy, broker, OpenAI loop, unsupported protocols and legacy paths. deps: 2.4, 3.4, 4.3
  - [ ] 5.2 Run affected package typecheck/build checks and `git diff --check`. deps: 5.1
  - [ ] 5.3 Record excluded Cursor/Multica/Squad capabilities and confirm the old BYOK pure-text, Workspace/MCP and Checkpoint paths remain available. deps: 5.2
