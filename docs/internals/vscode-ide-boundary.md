# vscode_ide 边界：内嵌工作台 ≠ IDE bridge，且不存在 VSCode Agent 供应商

仓库里有两个都叫 "VS Code" 的东西，语义完全不同，改代码前先分清。本文记录三件事：两者的边界、外部 bridge 的协议契约、以及"没有 VSCode agent 供应商"这一研究结论。内嵌工作台自身的架构约束见 [workspace-ide.md](./workspace-ide.md)。

## 两个东西

**内嵌工作台（IDE 模式）**：`apps/web/src/components/ide/vscode/` 在宿主文档内直接渲染 VS Code 工作台（monaco-vscode-api），由服务端同机 VSCodium REH 提供协议后端。这是一个面向用户的编辑器表面，不是 agent 供应商，也不是 composition 的 IDE Runtime。

**`vscode_ide` composition profile**：`packages/contracts/src/compositionRuntime.ts` 中 `CompositionIdeProfile` 的字面量之一（`cursor_ide` / `vscode_ide` / `browser_mcp` / `unknown`）。它描述的是 composition 层的一种 **外部 IDE Runtime 会话**：用户在 IDE 会话设置（Web `IdeSessionsSettings`、移动端 `SettingsIdeSessionsRouteScreen`）里配置一个 WebSocket URL（`CompositionIdeRuntimeConfig`：sessionId、profile、url、header 绑定、超时与重连参数），Code Work 作为**客户端**连过去。

也就是说：`vscode_ide` 期望的是**一个外部 bridge 进程**，不是内嵌工作台。

## 外部 bridge 的协议契约

`apps/server/src/composition/CompositionIdeJsonRpcTransport.ts` 实现 JSON-RPC 2.0 over WebSocket：

- `t3.ide.probe`（请求）：参数 `{sessionId, profile}`，bridge 返回探测结果；
- `t3.ide.handshake`（请求）：task 级能力握手，参数含 taskId / runId / agentId / capabilityGrantIds；bridge 返回 `accepted | rejected | unsupported`，accepted 必须带 handshakeId、acceptedGrantIds、verifiedOperations 与过期时间；
- `t3.ide.invoke`（请求）：凭 handshakeId 调用具体操作（`CompositionIdeAgentDriver.ts` 定义 `task.start` / `task.cancel` / `task.events`）；
- `t3.ide.event`（通知，无 id）：bridge 主动推 `ProviderRuntimeEvent`，经 transport 转成 composition 事件流。

能力授权经 ToolBroker 的 capability 通道（`CompositionToolRegistry.ts` 中 `t3.ide.invoke` 是 capabilityId），未握手的会话不允许降级执行任何 IDE 操作（`CompositionIdeSessionRegistry.ts`：unknown profile 一律 unavailable）。URL 校验拒绝凭据查询参数，错误文本经敏感模式脱敏。`CompositionIdeJsonRpcFixture.mjs` 是实现该协议的本地测试 fixture——除 fixture 外，仓库内没有任何真实实现，这条边界与 [byok-multica-migration-matrix.md](./byok-multica-migration-matrix.md) 第 5 条记录一致。

## 没有 VSCode Agent 供应商

结论（Paseo 上游研究，commit `7bcf167862ce`，2026-09-10）：**不存在 VSCode agent 供应商**——不在 Paseo 的 provider manifest 里，不在 ACP catalog 里，也没有可用的 VSCode agent CLI。因此 Code Work 不提供（也没有计划伪造）`vscode` driver kind：`apps/server/src/provider/builtInDrivers.ts` 的 `BUILT_IN_DRIVERS` 没有也不会有它，除非上游真的出现这样一个 CLI。

## 内嵌工作台作为 IDE 会话：已知缺口

内嵌工作台（`apps/web/src/components/ide/vscode/`）**今天不实现** `t3.ide.*` bridge 服务端：整个目录没有 bridge 协议引用，服务端 REH（`apps/server/src/ide/`）只做协议代理与扩展宿主，不对外说 JSON-RPC over WebSocket。这意味着无法把"当前打开的内嵌工作台"当作 `vscode_ide` 会话接入 composition。这是**已知缺口**，有意不伪装成已支持；若未来要打通，需要在内嵌工作台或其桥接扩展里实现 `t3.ide.probe/handshake/invoke/event` 服务端，并复用 REH 会话的连接令牌模型。在实现落地之前，文档与 UI 不得宣称"IDE 模式可作为 IDE Runtime 使用"。
