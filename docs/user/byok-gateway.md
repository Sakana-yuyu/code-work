# Custom model service gateway

A custom model service (BYOK) can act as the single model gateway ("replaceable core") for every
agent harness Code Work drives. Instead of configuring each provider's own credentials, the model
service adapters — the models you import under a custom model service instance in Settings — serve
every turn, while official logins keep working exactly as before.

## Turning it on

网页与桌面端在供应商配置顶部的 **连接与登录** 统一选择连接方式，下方不再重复显示“改用模型服务提供模型”开关。已有的网关开关配置会自动对应到该入口，无需重新配置。

- **原生账号（默认）或 URL / API Key：** 使用该 CLI 自己的账号或独立连接，不经过共享模型网关。
- **共享模型渠道：** 通过本地模型服务网关调用协议匹配的共享模型，模型列表也切换为这些渠道中的模型。选择后点击 **保存** 生效；切回原生账号或 URL / API Key 并保存即可关闭共享路由。

同一页面可以编辑共享模型服务的 URL、密钥和模型；修改共享渠道也会影响其他使用它的 CLI。高级环境变量入口保留。URL / API Key 直接连接目前适用于 Codex 和 Claude。

## Per-harness support

| Harness  | Gateway routing | Mechanism                                                                           |
| -------- | --------------- | ----------------------------------------------------------------------------------- |
| Claude   | Yes             | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` injected into the CLI environment     |
| Codex    | Yes             | `model_provider` `-c` config overrides pointing at the gateway, token via `env_key` |
| OpenCode | Yes             | A `byok_gateway` provider merged into `OPENCODE_CONFIG_CONTENT`                     |
| Grok     | Yes             | 通过受管理的 TOML 模型配置块连接网关                                                |
| Cursor   | No              | `cursor-agent -e` speaks Cursor's private protocol, not a model gateway             |

## How routing works

The gateway lives on the Code Work server's own HTTP listener under `/byok-gw/{protocol}/…`
(`anthropic` and `openai`). A harness request is forwarded to the BYOK adapter whose id the client
sent as the `model` field — same-protocol passthrough with the adapter's stored credentials
substituted in. An anthropic request can only reach an anthropic adapter, an openai request only an
openai adapter; anything else is rejected with a clear error instead of being silently translated.
Cross-protocol translation is intentionally not built.

Model slugs are the BYOK adapter ids. A routed Claude instance lists anthropic-protocol adapters, a
routed Codex instance lists openai-protocol adapters; OpenCode discovers the injected gateway
provider through its own inventory.

转发请求时，网关会把内部渠道 ID 替换为渠道配置的上游模型名，并保留请求的 JSON 类型和流式设置。Codex 使用 Responses API；OpenAI 协议渠道还需要实际支持 `/responses`，网关不会把 Chat Completions 自动转换成 Responses。Codex 的会话、健康检查和辅助生成使用同一网关配置。各供应商 OAuth 账号仍由各自 CLI 管理，不共享或转换登录凭据。

A routed Grok instance lists openai-protocol adapters. The Grok CLI has no base-url environment
variable, so routing manages a marker-wrapped block of `[model."…"]` tables inside the user's
`~/.grok/config.toml` (`# >>> codework-byok >>>` … `# <<< codework-byok <<<`): one table per
adapter, each pointing at the gateway with the bearer token supplied through the env var the block
declares. Everything outside the markers is the user's own configuration and is never modified;
turning routing off removes exactly the managed block.

## Security

The gateway bearer token is generated into the server secret store and reaches harnesses only
through child-process environment variables. It never appears in settings RPC payloads, the DOM, or
logs, and requests are authenticated with a constant-time token comparison.
