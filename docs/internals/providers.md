# Provider architecture

同一线程可在回合结束后切换 Provider 实例。切换时 `ProviderCommandReactor` 重新创建目标实例的会话，以已落库的线程消息构建限长历史交接，并排除当前及尚未执行的排队消息。交接还包含最近已完成工具调用的短结果摘要，标记为历史参考；没有结果的旧命令不会进入交接。消息与工具活动都按本轮请求的事件日志边界排除后续排队内容，整个交接不超过 64,000 字符。`ProviderService` 只在目标实例没有兼容续聊游标时将这段历史附在首次普通请求前；原生控制命令不消费交接历史。运行中的回合保持路由锁定。助手消息事件在生成时写入 `providerInstanceId`，内存、数据库与客户端都从事件读取归属，供同一时间线展示来源；旧消息缺少此字段时保持无来源标识。

消息投影保存首次 `thread.message-sent` 事件序号；同一时间戳的消息从数据库快照恢复时按该序号排序。迁移会从事件日志回填旧投影，流式更新继续保留首次序号，使重启前后的交接顺序一致。

> For maintainers. Using Code Work? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. Code Work supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with eleven entries:

| Driver kind   | Driver source                                 |
| ------------- | --------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]             |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]           |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]           |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]               |
| `kimi`        | [`Drivers/KimiDriver.ts`][kimi]               |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity] |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]       |
| `piAgent`     | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `ompAgent`    | [`Drivers/PifamilyDrivers.ts`][pifamily]      |
| `acpAgent`    | [`Drivers/GenericAcpDriver.ts`][genericacp]   |
| `byok`        | [`Drivers/ByokDriver.ts`][byok]               |

Pi and OhMyPi share a BYOK-only architecture — see [pi-family-providers.md](./pi-family-providers.md); the user-configured ACP entry is covered in [generic-acp-provider.md](./generic-acp-provider.md).

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

Antigravity 的 `agy -p --output-format stream-json` 逐行输出 `init`、`step_update`、`result`。
适配器在进程运行期间把 `agent_response.text_delta` 送入共用正文流，并把 `tool` 步骤的
`ACTIVE` / `DONE` 映射为同一工具项的进行中 / 完成事件；`tool_info.error` 映射为失败。
末尾 `result.response` 是完整结果，已有文本增量时不能再追加，否则会重复显示。
会话 ID 从顶层或内层的 `conversation_id` 保存，终态以 `result.status` 和进程退出码共同判断。
依据是 [Antigravity 官方 Headless 文档](https://antigravity.google/docs/cli/headless/)；
检索词为 `Antigravity CLI stream-json step_update tool_info result`，2026-09-25 查阅。
该文档直接给出了事件字段和终态枚举，优先于按字段名猜测递归解析。

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

Conversation rollback is fail-closed: an adapter must declare `threadRollback: true` only when it
restores the provider's real conversation context. Codex is currently the only built-in adapter that
does so. Before changing files, `CheckpointReactor` excludes active work in the same Git worktree and
captures a recovery checkpoint plus the original Git index. Provider rollback and the local history
commit cannot form one transaction, so failures keep the recovery references and require the caller
to verify provider context before retrying.

### 共用工具时间线

适配器把原生工具事件映射为带同一 `itemId` 的 `item.started`、`item.updated` 和 `item.completed`；
`ProviderRuntimeIngestion` 分别投影为 `tool.started`、`tool.updated` 和 `tool.completed`。网页与手机
工作日志在仅收到开始事件时就显示进行中工具，后续按回合与 `toolCallId` 归并到同一行，并以终态
覆盖状态、保留失败详情。适配器若能取得原生工具调用 ID，应在整个生命周期沿用该 ID；否则
客户端只能根据相邻事件的工具类型与标题尽力归并。
Cursor/Grok 的 ACP `tool_call` 首次状态通常映射为 `item.updated`（`inProgress`），其工作日志
同样立即可见；OpenCode 的 `pending` 会映射为 `item.started`。Codex、Claude、Cursor、Grok、
OpenCode、Antigravity、BYOK、Pi、Omp 的定向适配器测试均把实际生成的工具事件送过
`runtimeEventToActivities` 验证；失败详情在 `tool.completed` 保留。正文增量走运行时流，最终
消息由 ingestion 收敛，网页和手机分别用共用活动合同派生时间线。

### BYOK 余额查询边界

余额缓存的适配器指纹覆盖协议、地址、供应商、余额档案、账号标识、API Key 和余额 Token，
以 SHA-256 保存摘要。相同长度的密钥轮换也必须使旧账号余额缓存失效；指纹和 RPC 结果
均不包含明文密钥。`unsupported_profile` 表示当前没有已接入的查询接口，HTTP 或载荷错误
仍归入查询失败，成功响应中的余额 `0` 保留为实际零值。

2026-09-25 检索 `SiliconFlow /user/info retired replacement account API` 后核对
[SiliconFlow 官方更新日志](https://docs.siliconflow.cn/docs/release-notes/overview)：
`/user/info` 于 2026-08-14 停用，新账号接口待另行公告。Code Work 的官方 SiliconFlow
模板因此标为无已核验余额接口，并在自动档案中阻止对官方 `.cn` 和 `.com` 域名做通用
计费探测；明确选择的中转档案仍按用户配置执行。官方一手公告优先于
[CC Switch 用量查询说明](https://github.com/farion1231/cc-switch-website/blob/main/public/docs/en/2-providers/2.5-usage-query.md)
中的旧供应商模板。该说明区分官方余额与第三方自定义查询，并要求用户主动启用第三方
模板；我们保留逐档案显式选择和按适配器查询的边界，不把一个供应商名称等同于余额接口。

2026-09-25 检索 `OpenRouter credits management key current API key limit_remaining` 并核对
[官方账户额度接口](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
与[当前 Key 信息接口](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)：
`GET /api/v1/credits` 需要管理密钥，返回账户 `total_credits` 与 `total_usage`；普通
推理 Key 可调用 `GET /api/v1/key`，其中 `limit_remaining` 是该 Key 的支出上限剩余，
不能当成账户余额。仅对精确的 `https://openrouter.ai` 官方主机使用这两个接口，管理
密钥优先；管理密钥查询失败时不回退到 Key 限额，以免把两种数据混为一谈。相似中转
域名的自动档案不发送管理密钥。采用官方权限和字段定义，优先于第三方模板只标记
“可查询”而不区分凭据和数值语义的做法。

2026-09-25 检索 `Moonshot API balance available_balance CC Switch`，参考
[CC Switch 的 Kimi API 余额脚本示例](https://github.com/farion1231/cc-switch/discussions/5544)
及 [CodexBar 的 Moonshot 查询说明](https://github.com/steipete/CodexBar/blob/main/docs/moonshot.md)：
`GET https://api.moonshot.cn/v1/users/me/balance` 使用推理 API Key，读取
`data.available_balance`；后者还列出 `.ai` 国际域名。Code Work 仅对精确的 `api.moonshot.cn` / `api.moonshot.ai`
主机启用相应区域的查询，零值保留，错误载荷不当作零值。此公开示例直接给出请求和
字段，优先于只写“支持余额”的目录标签。这里核验的是同类产品的公开实现，尚无
供应商一手接口文档或本项目真实账号实测，后续须用真实凭据
核验两区返回格式。供应商目录的 `fixed` / `token_plan` 仅用于已经有对应查询实现的
Moonshot、DeepSeek、OpenRouter、智谱、Novita；未接入的 Kimi Coding、MiniMax、
StepFun Step Plan、火山和 ZenMux 改标为 `none`。官方模板未接入时，自动查询直接返回
`unsupported_profile`，不再盲探通用中转计费路径；自定义中转和用户显式选择的
通用计费 / NewAPI 档案仍照常查询。手机端余额为零时允许再次刷新。

2026-09-25 检索 `StepFun API account balance GET /v1/accounts official` 后核对
[StepFun 国内官方账户接口](https://platform.stepfun.com/docs/zh/api-reference/accounts/get)
和[国际官方账户接口](https://platform.stepfun.ai/docs/en/api-reference/accounts/get)：两区均要求
Bearer API Key，响应 `object: "account"`、`balance`、`total_cash_balance`、
`total_voucher_balance`；`balance` 才是当前可用余额，不能把总充值或总赠额相加。
目录新增 `stepfun_api` / `stepfun_api_en`，分别使用 `/v1` 推理地址和对应区域的
`/v1/accounts` 余额地址；既有 `stepfun` / `stepfun_en` 保持 `/step_plan`，标签明确写
Step Plan，仍不显示尚未接入的套餐 Credits 用量。国内 CNY、国际 USD 标签来自对应
官方账户页面的货币展示，API 响应本身没有货币字段。只允许 HTTPS 且主机精确匹配
`api.stepfun.com` / `api.stepfun.ai`、推理路径位于 `/v1` 时使用账户接口。显式
`balanceProfile: "none"` 统一尊重“不查询”，旧通道若曾保存此值，要改选“自动”才会
使用后来加入的官方余额接口。官方接口文档比其他产品的模板标签更能确定请求和字段。

2026-09-25 检索 `Novita CLI account balance credit_balance /v3/user`，核对
[Novita 官方 CLI 请求实现](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/core/client.py)、
[余额命令](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/novita_cli.py)及
[单位换算](https://github.com/novitalabs/novita-cli/blob/main/novita_cli/utils/output.py)：
`NOVITA_API_KEY` 以 Bearer 形式请求 `GET https://api.novita.ai/v3/user`，读取顶层
`credit_balance`，其整数单位是 `0.0001 USD`。Code Work 仅在 HTTPS 主机精确为
`api.novita.ai` 时使用此接口，缺字段、非法整数和 HTTP 失败均显示查询失败，不沿用 CLI
输出里的缺字段默认 `0`，以免把未知值误报为零余额。这里有官方 CLI 源码依据，但尚无
本项目真实 Novita 账号实测；接口变更时应更新实现与预设状态。

网页/桌面与手机编辑 BYOK 适配器时，只有供应商 ID、协议、完整 Base URL 均保持一致，
才允许沿用服务端脱敏密钥标记；切换目标须重新输入 API Key，同时清除旧余额令牌、
自定义请求头和模型目录元数据。服务端发现模型会忽略跨出新 Base URL origin 的模板
目录，以及已知属于其他供应商的模板目录。单独显式配置的 `modelCatalogURL` 仍按原有
自定义路径处理。这样即使旧版本客户端曾保存残留的 `modelCatalogURLs`，当前查询也不会
把新通道 Key 发送到另一家供应商的模板目录。

多 Agent 共用时间线、供应商选择、余额语义与同类产品公开行为的对照见
[多 Agent 与供应商体验：公开产品对照](./agent-provider-product-comparison.md)。该页列出检索日期、
一手来源、已验证的本仓库实现和真实客户端性能验收的剩余边界。

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

### 会话错误与部分回复

`session.state.changed(error)` 表示运行中的会话已失败。接入层先把会话和当前回合标为错误，再冲刷该回合尚在缓冲的助手文字并结束已投影消息的流式状态，保留可读的部分回复。带有旧回合 ID 的状态事件不能覆盖新回合；仅 `runtime.error` 活动仍可能先于正式终态到达，不能据此提前清除正文缓存。重试以新的回合开始，历史失败记录仍可查看。

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[kimi]: ../../apps/server/src/provider/Drivers/KimiDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[pifamily]: ../../apps/server/src/provider/Drivers/PifamilyDrivers.ts
[genericacp]: ../../apps/server/src/provider/Drivers/GenericAcpDriver.ts
[byok]: ../../apps/server/src/provider/Drivers/ByokDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
