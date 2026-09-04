/**
 * modelGateway — the local BYOK model gateway.
 *
 * Agent harnesses that support a custom model endpoint (Claude Code via
 * `ANTHROPIC_BASE_URL`, Codex via a `model_provider` config override,
 * OpenCode via injected provider config) can serve every turn from the BYOK
 * adapters instead of their own logins. The gateway is mounted on the server's
 * existing HTTP listener under `/byok-gw/{protocol}/*` and forwards
 * same-protocol requests to the adapter whose id the client sent as the
 * `model` field — pure passthrough plus auth substitution. Cross-protocol
 * translation is deliberately out of scope: an anthropic request can only
 * route to an anthropic adapter, an openai request to an openai adapter.
 *
 * The gateway token lives in the server secret store, reaches harnesses only
 * through child-process environment variables, and never appears in settings
 * RPC payloads, the DOM, or logs.
 *
 * @module provider/byok/modelGateway
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import {
  ByokSettings,
  type ByokModelAdapter,
  type ByokSettings as ByokSettingsType,
  type ServerProviderModel,
  type ServerSettings,
} from "@codework/contracts";

import * as NodeCrypto from "node:crypto";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

/** URL prefix the gateway is mounted under. */
export const BYOK_GATEWAY_ROUTE_PREFIX = "/byok-gw";

/** Secret-store entry holding the bearer token harnesses authenticate with. */
export const BYOK_GATEWAY_TOKEN_SECRET = "byok-gateway-token";

/** Env var name carrying the token into harness child processes. */
export const BYOK_GATEWAY_TOKEN_ENV = "CODEWORK_BYOK_GATEWAY_TOKEN";

/** Sentinel provider id used inside Codex `-c` overrides. */
export const BYOK_GATEWAY_PROVIDER_ID = "byok_gateway";

/** Protocols the gateway can pass through today. Gemini stays direct-only. */
export type GatewayProtocol = "anthropic" | "openai";

const decodeByokConfig = Schema.decodeUnknownSync(ByokSettings);

export interface GatewayAdapterRoute {
  /** Gateway model slug — the adapter id, same slug the picker publishes. */
  readonly id: string;
  readonly protocol: GatewayProtocol;
  readonly baseURL: string;
  readonly apiKey: string;
  readonly displayName: string;
  readonly modelId: string;
  /** Non-sensitive vendor/relay group label for picker display, "" when unset. */
  readonly groupName: string;
}

/**
 * The adapters a routed harness may reach: openai/anthropic adapters from
 * every enabled BYOK instance with a real credential materialized. Keys stay
 * in server memory; callers must never log the result.
 */
export const gatewayAdapterRoutes = (settings: ServerSettings): readonly GatewayAdapterRoute[] => {
  const routes: GatewayAdapterRoute[] = [];
  for (const instance of Object.values(settings.providerInstances)) {
    if (instance.driver !== "byok" || !instance.enabled) continue;
    const byok = decodeByokConfigSafe(instance.config);
    if (byok === undefined || !byok.enabled) continue;
    for (const adapter of byok.adapters) {
      if (!isGatewayRoutable(adapter)) continue;
      routes.push({
        id: adapter.id,
        protocol: adapter.protocol,
        baseURL: adapter.baseURL.trim().replace(/\/+$/u, ""),
        apiKey: adapter.apiKey,
        displayName: adapter.displayName,
        modelId: adapter.modelId,
        groupName: adapter.groupName?.trim() ?? "",
      });
    }
  }
  return routes;
};

const decodeByokConfigSafe = (config: unknown): ByokSettingsType | undefined => {
  try {
    return decodeByokConfig(config);
  } catch {
    return undefined;
  }
};

const isGatewayRoutable = (
  adapter: ByokModelAdapter,
): adapter is ByokModelAdapter & { readonly protocol: GatewayProtocol } =>
  (adapter.protocol === "anthropic" || adapter.protocol === "openai") &&
  adapter.baseURL.trim().length > 0 &&
  adapter.apiKey.trim().length > 0;

/**
 * Strict slug match. Unlike the in-process BYOK driver there is no
 * first-adapter fallback: a gateway that silently reroutes an unknown model to
 * whichever adapter is first would be lying about what the user is spending.
 *
 * Claude appends a context-window qualifier to the model id it sends
 * (`resolveClaudeApiModelId` may emit `<slug>[1m]`), so one trailing
 * `[…]` bracket group is stripped before matching; adapter ids never contain
 * brackets themselves.
 */
export const pickGatewayAdapter = (
  routes: readonly GatewayAdapterRoute[],
  protocol: GatewayProtocol,
  model: string,
): GatewayAdapterRoute | undefined => {
  const normalized = model.replace(/\[[^\[\]]*\]$/u, "").trim();
  return routes.find(
    (route) => route.protocol === protocol && (route.id === model || route.id === normalized),
  );
};

/**
 * Model list a routed harness instance publishes: the protocol-matched BYOK
 * adapters, same slugs the gateway routes by. Replaces the harness's native
 * catalog so the picker only offers models the gateway can actually serve.
 */
export const routedServerProviderModels = (
  settings: ServerSettings,
  protocol: GatewayProtocol,
): readonly ServerProviderModel[] =>
  gatewayAdapterRoutes(settings)
    .filter((route) => route.protocol === protocol)
    .map((route) => {
      // The picker labels each model with `instance · subProvider`. Prefer
      // the vendor/relay group so same-named models from different vendors
      // stay distinguishable; keep the raw model id as the fallback label.
      const subProvider = route.groupName || route.modelId.trim();
      return {
        slug: route.id,
        name: route.displayName.trim().length > 0 ? route.displayName : route.modelId,
        ...(subProvider.length > 0 ? { subProvider } : {}),
        isCustom: false,
        capabilities: null,
      };
    });

/**
 * Anthropic clients append the full upstream path to the base URL, and
 * anthropic adapter base URLs do not end in `/v1`, so the path passes through
 * verbatim (`/v1/messages`, `/v1/messages/count_tokens`, beta query strings).
 */
export const joinAnthropicTarget = (baseURL: string, path: string): string => `${baseURL}${path}`;

/**
 * OpenAI adapter base URLs conventionally end in `/v1`, and an OpenAI client
 * pointed at `${gateway}/openai/v1` appends `/v1/...` again — strip the
 * leading `v1` so `${base}/v1/chat/completions` lands on
 * `${adapterBase}/chat/completions`.
 */
export const joinOpenAITarget = (baseURL: string, path: string): string =>
  `${baseURL}${path.replace(/^\/v1(?=\/)/u, "")}`;

export const gatewayOrigin = (port: number): string => `http://127.0.0.1:${port}`;

export const anthropicGatewayBase = (origin: string): string =>
  `${origin}${BYOK_GATEWAY_ROUTE_PREFIX}/anthropic`;

export const openaiGatewayBase = (origin: string): string =>
  `${origin}${BYOK_GATEWAY_ROUTE_PREFIX}/openai/v1`;

/**
 * Grok Build CLI reads custom endpoints from `~/.grok/config.toml` — there is
 * no base-url env var. Routed mode manages a marker-wrapped block of
 * `[model."…"]` tables (one per OpenAI-protocol adapter) inside that file and
 * removes them again when routing is off; everything outside the markers is
 * the user's own config and is never touched.
 */
export const GROK_MANAGED_BEGIN = "# >>> codework-byok >>> (managed by Code Work)";
export const GROK_MANAGED_END = "# <<< codework-byok <<<";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const grokTomlString = (value: string): string => value.replace(/"/g, "'").replace(/[\r\n]/g, " ");

export const grokGatewayConfigBlock = (
  origin: string,
  routes: readonly GatewayAdapterRoute[],
): string => {
  const lines: string[] = [GROK_MANAGED_BEGIN];
  for (const route of routes) {
    if (route.protocol !== "openai") continue;
    lines.push(`[model."${route.id}"]`);
    lines.push(`model = "${grokTomlString(route.id)}"`);
    lines.push(`base_url = "${openaiGatewayBase(origin)}"`);
    lines.push(`name = "${grokTomlString(route.displayName.trim() || route.modelId || route.id)}"`);
    lines.push(`env_key = "${BYOK_GATEWAY_TOKEN_ENV}"`);
    lines.push("");
  }
  lines.push(GROK_MANAGED_END);
  return lines.join("\n");
};

/** Splices the managed region in (or out, when `managedBlock` is null). */
export const mergeGrokManagedConfig = (
  existing: string | undefined,
  managedBlock: string | null,
): string => {
  const managedRegion = new RegExp(
    `\\n?${escapeRegExp(GROK_MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(GROK_MANAGED_END)}\\n?`,
    "g",
  );
  const base = (existing ?? "")
    .replace(managedRegion, "\n")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/u, "");
  if (managedBlock === null) return base;
  return base.length === 0 ? managedBlock : `${base}\n\n${managedBlock}`;
};

/** Claude Code reads its endpoint and token from these variables. */
export const anthropicGatewayEnv = (
  origin: string,
  token: string,
): Readonly<Record<string, string>> => ({
  ANTHROPIC_BASE_URL: anthropicGatewayBase(origin),
  ANTHROPIC_AUTH_TOKEN: token,
});

/**
 * Codex `-c` overrides: register the gateway as a chat-wire provider and make
 * it the active one. The key itself travels via {@link BYOK_GATEWAY_TOKEN_ENV}
 * (`env_key`), never the argv.
 */
export const gatewayCodexConfigArgs = (origin: string): readonly string[] => [
  "-c",
  `model_provider="${BYOK_GATEWAY_PROVIDER_ID}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.name="Code Work BYOK Gateway"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.base_url="${openaiGatewayBase(origin)}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.env_key="${BYOK_GATEWAY_TOKEN_ENV}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.wire_api="chat"`,
];

/** Pulls (or lazily creates) the gateway bearer token as a hex string. */
export const ensureGatewayToken = (
  secretStore: ServerSecretStore["Service"],
): Effect.Effect<string> =>
  secretStore.getOrCreateRandom(BYOK_GATEWAY_TOKEN_SECRET, 32).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
    Effect.orDie,
  );

const timingSafeTokenMatch = (provided: string, expected: string): boolean => {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const readProvidedToken = (headers: Record<string, string>): string | null => {
  const authorization = headers.authorization ?? headers.Authorization;
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const apiKey = headers["x-api-key"] ?? headers["X-Api-Key"];
  return apiKey !== undefined && apiKey.trim().length > 0 ? apiKey.trim() : null;
};

const extractGatewayModel = (bodyText: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "model" in parsed &&
      typeof (parsed as { model: unknown }).model === "string"
    ) {
      return (parsed as { model: string }).model;
    }
  } catch {
    // Non-JSON bodies fall through to the no-model path below.
  }
  return undefined;
};

interface GatewayErrorShape {
  readonly status: number;
  readonly body: unknown;
}

const anthropicError = (status: number, type: string, message: string): GatewayErrorShape => ({
  status,
  body: { type: "error", error: { type, message } },
});

const openaiError = (status: number, type: string, message: string): GatewayErrorShape => ({
  status,
  body: { error: { message, type } },
});

const identity = <T>(value: T): T => value;

const errorResponse = (
  protocol: GatewayProtocol,
  error: GatewayErrorShape,
): HttpServerResponse.HttpServerResponse => {
  const shape =
    protocol === "anthropic"
      ? error
      : openaiError(error.status, "invalid_request_error", errorMessage(error.body));
  return HttpServerResponse.jsonUnsafe(shape.body, { status: shape.status });
};

const errorMessage = (body: unknown): string => {
  if (typeof body === "object" && body !== null && "error" in body) {
    const inner = (body as { error: unknown }).error;
    if (typeof inner === "object" && inner !== null && "message" in inner) {
      return String((inner as { message: unknown }).message);
    }
  }
  return "BYOK gateway request failed.";
};

const gatewayHandler = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  ServerSecretStore | ServerSettingsService | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const serverSettings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;

    const { method } = request;
    const url = new URL(request.url, "http://gateway.invalid");
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    // [<prefix>, <protocol>, ...rest]
    const protocolSegment = segments[1];
    const restPath = segments.slice(2);

    const protocol =
      protocolSegment === "anthropic"
        ? ("anthropic" as const)
        : protocolSegment === "openai"
          ? ("openai" as const)
          : undefined;
    if (protocol === undefined || restPath.length === 0) {
      return HttpServerResponse.empty({ status: 404 });
    }

    const expectedToken = yield* ensureGatewayToken(secretStore);
    const providedToken = readProvidedToken(request.headers);
    if (providedToken === null || !timingSafeTokenMatch(providedToken, expectedToken)) {
      return errorResponse(
        protocol,
        anthropicError(401, "authentication_error", "Invalid BYOK gateway token."),
      );
    }

    const bodyText =
      method === "GET" || method === "HEAD" ? undefined : yield* request.text.pipe(Effect.orDie);
    const model = bodyText === undefined ? undefined : extractGatewayModel(bodyText);
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.catch(() =>
        Effect.logWarning("BYOK gateway could not read settings").pipe(Effect.as(null)),
      ),
    );
    if (settings === null) {
      return errorResponse(
        protocol,
        anthropicError(502, "api_error", "The BYOK gateway could not read server settings."),
      );
    }
    const routes = gatewayAdapterRoutes(settings);

    let adapter: GatewayAdapterRoute | undefined;
    if (model !== undefined) {
      adapter = pickGatewayAdapter(routes, protocol, model);
      if (adapter === undefined) {
        return errorResponse(
          protocol,
          anthropicError(
            404,
            "not_found_error",
            `No BYOK adapter is published as model '${model}'. Add it under a BYOK instance in Settings and select it again.`,
          ),
        );
      }
    } else {
      const protocolRoutes = routes.filter((route) => route.protocol === protocol);
      if (protocolRoutes.length !== 1 || protocolRoutes[0] === undefined) {
        return errorResponse(
          protocol,
          anthropicError(
            400,
            "invalid_request_error",
            "The request carries no model field, so the gateway cannot pick an adapter.",
          ),
        );
      }
      adapter = protocolRoutes[0];
    }

    const suffixPath = `/${restPath.join("/")}${url.search}`;
    const target =
      protocol === "anthropic"
        ? joinAnthropicTarget(adapter.baseURL, suffixPath)
        : joinOpenAITarget(adapter.baseURL, suffixPath);

    const forwardHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase();
      if (
        lower === "host" ||
        lower === "authorization" ||
        lower === "x-api-key" ||
        lower === "content-length" ||
        lower === "connection" ||
        lower === "accept-encoding"
      ) {
        continue;
      }
      forwardHeaders[name] = value;
    }
    if (protocol === "anthropic") {
      forwardHeaders["x-api-key"] = adapter.apiKey;
    } else {
      forwardHeaders["authorization"] = `Bearer ${adapter.apiKey}`;
    }

    return yield* httpClient
      .execute(
        HttpClientRequest.make(method)(target).pipe(
          HttpClientRequest.setHeaders(forwardHeaders),
          bodyText === undefined ? identity : HttpClientRequest.bodyText(bodyText),
        ),
      )
      .pipe(
        Effect.map((upstream) => {
          const contentType = upstream.headers["content-type"];
          return HttpServerResponse.stream(upstream.stream, {
            status: upstream.status,
            ...(contentType !== undefined ? { headers: { "content-type": contentType } } : {}),
          });
        }),
        Effect.tapError((cause) =>
          Effect.logWarning("BYOK gateway upstream request failed", {
            protocol,
            model: model ?? "(none)",
            cause: cause instanceof Error ? cause.message : String(cause),
          }),
        ),
        Effect.orElseSucceed(() =>
          errorResponse(
            protocol,
            anthropicError(
              502,
              "api_error",
              "The BYOK gateway could not reach the adapter's endpoint.",
            ),
          ),
        ),
      );
  });

/**
 * Merges a `provider.byok_gateway` entry into OpenCode's injected config
 * content, so a routed OpenCode instance discovers every openai-protocol
 * adapter as `<byok_gateway>/<adapter id>` through its own inventory.
 * Whatever the user already put in OPENCODE_CONFIG_CONTENT is preserved.
 */
export const openCodeGatewayConfigContent = (input: {
  readonly existingContent: string | undefined;
  readonly origin: string;
  readonly token: string;
  readonly routes: readonly GatewayAdapterRoute[];
}): string => {
  let parsed: { provider?: Record<string, unknown> } = {};
  const existing = input.existingContent?.trim();
  if (existing !== undefined && existing.length > 0) {
    try {
      const value: unknown = JSON.parse(existing);
      if (typeof value === "object" && value !== null) {
        parsed = value as typeof parsed;
      }
    } catch {
      // Unparseable user config: keep it as an opaque base under "provider".
    }
  }
  const providers = { ...parsed.provider };
  providers[BYOK_GATEWAY_PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Code Work BYOK Gateway",
    options: {
      baseURL: openaiGatewayBase(input.origin),
      apiKey: input.token,
    },
    models: Object.fromEntries(
      input.routes
        .filter((route) => route.protocol === "openai")
        .map((route) => [
          route.id,
          {
            name: route.displayName.trim().length > 0 ? route.displayName : route.modelId,
          },
        ]),
    ),
  };
  return JSON.stringify({ ...parsed, provider: providers });
};

/**
 * The mounted gateway. Token and adapters are re-resolved per request so
 * adapter edits apply without a server restart.
 */
// Harnesses only ever GET (model lists) or POST (completions) against the
// gateway, and the router does not match `add("*", ...)`, so each method is
// registered explicitly. The trailing-slash wildcard form also registers the
// bare prefix, so no separate base route is needed.
export const byokGatewayRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", `${BYOK_GATEWAY_ROUTE_PREFIX}/anthropic/*`, gatewayHandler),
  HttpRouter.add("POST", `${BYOK_GATEWAY_ROUTE_PREFIX}/anthropic/*`, gatewayHandler),
  HttpRouter.add("GET", `${BYOK_GATEWAY_ROUTE_PREFIX}/openai/*`, gatewayHandler),
  HttpRouter.add("POST", `${BYOK_GATEWAY_ROUTE_PREFIX}/openai/*`, gatewayHandler),
);

/**
 * Origin harnesses should point at. CLIs run beside the server, so loopback is
 * always reachable even when the Code Work clients connect remotely.
 */
export const byokGatewayOriginFromConfig = (config: { readonly port: number }): string =>
  gatewayOrigin(config.port);
