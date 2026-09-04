# BYOK model gateway internals

The BYOK gateway lets any agent harness serve turns from BYOK adapters, making BYOK the
replaceable core of the system: suppliers are configured once (as adapters) and every harness
routes through them, with official logins as the untouched alternative.

## Components

- `apps/server/src/provider/byok/modelGateway.ts` — the gateway. Mounted on the server's existing
  HTTP listener under `/byok-gw/{anthropic|openai}/*` via `byokGatewayRouteLayer` in
  `makeRoutesLayer` (`apps/server/src/server.ts`). The handler authenticates a bearer token
  (constant-time compare), resolves the `model` field from the JSON body, picks the adapter by
  strict id match (no first-adapter fallback — an unknown model is a 404, never a silent reroute),
  and streams the upstream response back unchanged after substituting credentials. Cross-protocol
  translation is deliberately out of scope.
- Token: `ServerSecretStore.getOrCreateRandom("byok-gateway-token", 32)`, hex-encoded. It reaches
  harnesses only via child-process env (`ANTHROPIC_AUTH_TOKEN`, or `env_key`
  `CODEWORK_BYOK_GATEWAY_TOKEN` for Codex).
- Injection points per driver, applied only when the instance config has `routeThroughByok: true`:
  - Claude: env appended after `mergeProviderInstanceEnvironment` in
    `provider/Drivers/ClaudeDriver.ts` — injected vars win over same-named instance env.
  - Codex: token env in `CodexDriver` plus `gatewayCodexConfigArgs` argv threaded through
    `CodexAdapterLiveOptions.gatewayAppServerArgs` into `CodexSessionRuntime`. The overrides are
    passed as argv (not through the shell-tokenized `launchArgs` string) because find-my-way
    quoting aside, TOML string values need their quotes preserved; they are appended last so
    `-c` assignment order makes the gateway provider win.
  - OpenCode: `openCodeGatewayConfigContent` merges a `byok_gateway` provider into
    `OPENCODE_CONFIG_CONTENT` in `provider/Drivers/OpenCodeDriver.ts`; opencode discovers the
    models itself, so no snapshot override is needed.
- Routed snapshots: `routedServerProviderModels(settings, protocol)` replaces the harness's native
  model catalog with the protocol-matched BYOK adapters (slug = adapter id) and reports auth as
  `authenticated (BYOK Gateway)` via the `enrichSnapshot` hook.

## Router notes

The vendored find-my-way does not match `HttpRouter.add("*", …)` registrations; gateway routes are
registered explicitly per method (`GET`, `POST`) per protocol. A `…/*` registration also registers
the bare prefix, so base-path routes must not be added separately (duplicate-method error).

## Known limits

- Grok: no CLI endpoint override exists; routing is not implemented.
- Cursor: `-e` is Cursor's private protocol and cannot point at the gateway.
- Gemini-protocol adapters are not gateway-routable (no harness speaks that wire format natively
  through the injection points).
- Cross-protocol translation (e.g. anthropic request → openai adapter) is not built; the gateway
  rejects mismatches with a protocol-shaped error.
