# Custom model service gateway

A custom model service (BYOK) can act as the single model gateway ("replaceable core") for every
agent harness Code Work drives. Instead of configuring each provider's own credentials, the model
service adapters — the models you import under a custom model service instance in Settings — serve
every turn, while official logins keep working exactly as before.

## Turning it on

Each provider instance's settings expose a **Route through your model services** switch:

- **Off (default):** the instance behaves as today — its own login, its own model catalog.
- **On:** the instance's model requests are served through the local model service gateway from the
  model service adapters, and its model list is replaced by the protocol-matched adapters.

## Per-harness support

| Harness  | Gateway routing | Mechanism                                                                           |
| -------- | --------------- | ----------------------------------------------------------------------------------- |
| Claude   | Yes             | `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` injected into the CLI environment     |
| Codex    | Yes             | `model_provider` `-c` config overrides pointing at the gateway, token via `env_key` |
| OpenCode | Yes             | A `byok_gateway` provider merged into `OPENCODE_CONFIG_CONTENT`                     |
| Grok     | Not yet         | The Grok CLI exposes no custom endpoint override                                    |
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
