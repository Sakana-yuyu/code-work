// @effect-diagnostics preferSchemaOverJson:off - 兼容管理 API 接受上游 CPA 的未知 JSON 形状。
// @effect-diagnostics instanceOfSchema:off - 管理路由只归一化未知异常，不向客户端暴露原始对象。

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
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/unstable/http";

import {
  ByokSettings,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ByokModelAdapter,
  type ByokSettings as ByokSettingsType,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
  type LocalAccountProvider,
} from "@codework/contracts";

import * as NodeCrypto from "node:crypto";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  credentialAuthKind,
  credentialToken,
  ensureLocalAccountCredential,
  importLocalAccount,
  markLocalAccountFailure,
  pickLocalAccount,
  removeLocalAccount,
  setLocalAccountEnabled,
  setLocalAccountPoolStrategy,
} from "../LocalAccountPool.ts";
import { matchLocalGatewayKey, readLocalGatewayKeys } from "../LocalGatewayKey.ts";
import { localPoolUsageStore } from "../LocalPoolUsage.ts";

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
  readonly supplierID?: string;
  readonly localProvider?: LocalAccountProvider;
  readonly localAccountIds?: readonly string[];
}

/**
 * The adapters a routed harness may reach: openai/anthropic adapters from
 * every enabled BYOK instance with a real credential materialized. Keys stay
 * in server memory; callers must never log the result.
 */
export const gatewayAdapterRoutes = (
  settings: ServerSettings,
  sourceInstanceId?: string,
  requestedModel?: string,
): readonly GatewayAdapterRoute[] => {
  const routes: GatewayAdapterRoute[] = [];
  const localAccountPool = settings.localAccountPool ?? {
    accounts: {},
    strategy: "round-robin" as const,
    providerInstances: {},
  };
  const instances = Object.entries(settings.providerInstances);
  // 老设置文件可能只有 providers.<kind>，而实例注册表会在 hydration
  // 阶段补出默认实例。网关也必须看到同一份实例图，否则旧用户绑定的
  // 本地账号池会在请求时变成空路由。
  const legacyProviderEntries: ReadonlyArray<
    readonly [string, { driver: ProviderDriverKind; config: unknown }]
  > = [
    ["codex", { driver: ProviderDriverKind.make("codex"), config: settings.providers?.codex }],
    [
      "claudeAgent",
      { driver: ProviderDriverKind.make("claudeAgent"), config: settings.providers?.claudeAgent },
    ],
    ["grok", { driver: ProviderDriverKind.make("grok"), config: settings.providers?.grok }],
    [
      "opencode",
      { driver: ProviderDriverKind.make("opencode"), config: settings.providers?.opencode },
    ],
  ];
  for (const [id, entry] of legacyProviderEntries) {
    if (!instances.some(([instanceId]) => instanceId === id)) instances.push([id, entry]);
  }
  // 与实例注册表一致：显式实例优先，旧版 BYOK 配置只填补尚未迁移的默认实例。
  if (!instances.some(([id]) => id === "byok") && settings.providers?.byok) {
    instances.push([
      "byok",
      { driver: ProviderDriverKind.make("byok"), config: settings.providers.byok },
    ]);
  }
  for (const [instanceId, instance] of instances) {
    if (sourceInstanceId !== undefined && instanceId !== sourceInstanceId) continue;
    if (instance.driver !== "byok" || !resolveProviderInstanceEnabled(instance)) continue;
    const byok = decodeByokConfigSafe(instance.config);
    // 信封上的 enabled 是唯一开关；normalize 已把旧的内层 enabled 折叠进信封
    // （ByokSettings 解码默认 false，重新检查会把所有正常实例全部滤掉）。
    if (byok === undefined) continue;
    for (const adapter of byok.adapters) {
      // 内置账号池的 BYOK 适配器只是给本地驱动提供目录和根 /v1 地址；
      // 真正的上游由下面的 local:* 路由选择，不能把网关再当成自己的上游。
      if (!isGatewayRoutable(adapter) || adapter.supplierID === "codework-local-account") continue;
      routes.push({
        id: adapter.id,
        protocol: adapter.protocol,
        baseURL: adapter.baseURL.trim().replace(/\/+$/u, ""),
        apiKey: adapter.apiKey,
        displayName: adapter.displayName,
        modelId: adapter.modelId,
        groupName: adapter.groupName?.trim() ?? "",
        ...(adapter.supplierID ? { supplierID: adapter.supplierID } : {}),
      });
    }
  }
  for (const [instanceId, accountIds] of Object.entries(localAccountPool.providerInstances)) {
    if (sourceInstanceId !== undefined && instanceId !== sourceInstanceId) continue;
    const instance = instances.find(([id]) => id === instanceId)?.[1];
    if (instance === undefined || !resolveProviderInstanceEnabled(instance)) continue;
    const configuredProvider =
      instance?.driver === "claudeAgent"
        ? ("claude" as const)
        : instance?.driver === "grok"
          ? ("xai" as const)
          : instance?.driver === "codex"
            ? ("codex" as const)
            : undefined;
    const providers =
      configuredProvider === undefined
        ? [
            ...new Set(
              accountIds
                .map((id) => localAccountPool.accounts[id]?.provider)
                .filter(
                  (value): value is LocalAccountProvider =>
                    value !== undefined && value !== "cursor",
                ),
            ),
          ]
        : [configuredProvider];
    for (const provider of providers) {
      const accounts = accountIds
        .map((id) => localAccountPool.accounts[id])
        .filter(
          (account) =>
            account?.enabled &&
            account.provider === provider &&
            !(
              instance?.driver === "opencode" &&
              provider === "codex" &&
              account.authKind === "oauth"
            ),
        );
      const models = [...new Set(accounts.flatMap((account) => account?.models ?? []))];
      // 官方 OAuth auth.json 通常没有 models 字段；请求本身携带模型时，
      // 用该模型生成一次性目录路由，交给 pickLocalAccount 的空模型通配规则选账号。
      if (models.length === 0 && requestedModel?.trim()) models.push(requestedModel.trim());
      // 没有能力声明时不发布虚构模型；账号必须在导入凭据中声明可用模型。
      for (const modelId of models) {
        routes.push({
          id: `local:${instanceId}:${provider}:${modelId}`,
          protocol: provider === "claude" ? "anthropic" : "openai",
          baseURL: `local://${provider}`,
          apiKey: "",
          displayName: modelId,
          modelId,
          groupName: `Code Work · ${provider} 本地账号池`,
          supplierID: "codework-local-account",
          localProvider: provider,
          localAccountIds: accountIds,
        });
      }
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
  const candidates = routes.filter(
    (route) => route.protocol === protocol && (route.id === model || route.id === normalized),
  );
  if (candidates.length === 0) return undefined;
  const local = candidates.filter((route) => route.localProvider !== undefined);
  if (local.length > 0) return local[0];
  return candidates[0];
};

/**
 * Model list a routed harness instance publishes: the protocol-matched BYOK
 * adapters, same slugs the gateway routes by. Replaces the harness's native
 * catalog so the picker only offers models the gateway can actually serve.
 */
export const routedServerProviderModels = (
  settings: ServerSettings,
  protocol: GatewayProtocol,
  sourceInstanceId?: string,
): readonly ServerProviderModel[] =>
  gatewayAdapterRoutes(settings, sourceInstanceId)
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
 * Availability overrides for a routed snapshot: the gateway supplies auth, so
 * the harness's native-login probe must not mark the instance unusable — the
 * model picker hides every model of a non-`ready` instance. A missing binary
 * or a disabled instance keeps the probe status (sessions cannot run then).
 */
export const applyRoutedProviderAvailability = <T extends ServerProvider>(snapshot: T): T => {
  if (!snapshot.installed || snapshot.status === "disabled") return snapshot;
  const { message: _probeMessage, ...rest } = snapshot;
  return { ...rest, status: "ready" } as T;
};

/** 原生目录不能先发布再异步替换；读取渠道失败时保持空目录，避免误选。 */
export const prepareRoutedProviderSnapshot = (
  snapshot: ServerProvider,
  config: {
    readonly routeThroughByok: boolean;
    readonly byokSourceInstanceId?: string | undefined;
  },
  getSettings: ServerSettingsService["Service"]["getSettings"],
): Effect.Effect<ServerProvider> => {
  if (!config.routeThroughByok) return Effect.succeed(snapshot);
  return getSettings.pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.map((settings) => {
      const models = settings
        ? routedServerProviderModels(
            settings,
            snapshot.driver === "claudeAgent" ? "anthropic" : "openai",
            config.byokSourceInstanceId,
          )
        : [];
      return applyRoutedProviderAvailability({
        ...snapshot,
        models:
          snapshot.driver === "opencode"
            ? models.map((model) => {
                const slug = `${BYOK_GATEWAY_PROVIDER_ID}/${model.slug}`;
                return (
                  snapshot.models.find((existing) => existing.slug === slug) ?? { ...model, slug }
                );
              })
            : models,
        auth: { status: "authenticated", type: "byok", label: "BYOK Gateway" },
      });
    }),
  );
};

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

export const anthropicGatewayBase = (origin: string, sourceInstanceId?: string): string =>
  `${origin}${BYOK_GATEWAY_ROUTE_PREFIX}/anthropic${sourceInstanceId === undefined ? "" : `/source/${encodeURIComponent(sourceInstanceId)}`}`;

export const openaiGatewayBase = (origin: string, sourceInstanceId?: string): string =>
  `${origin}${BYOK_GATEWAY_ROUTE_PREFIX}/openai${sourceInstanceId === undefined ? "" : `/source/${encodeURIComponent(sourceInstanceId)}`}/v1`;

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
  sourceInstanceId?: string,
): string => {
  const lines: string[] = [GROK_MANAGED_BEGIN];
  for (const route of routes) {
    if (route.protocol !== "openai") continue;
    lines.push(`[model."${route.id}"]`);
    lines.push(`model = "${grokTomlString(route.id)}"`);
    lines.push(`base_url = "${openaiGatewayBase(origin, sourceInstanceId)}"`);
    lines.push(`name = "${grokTomlString(route.displayName.trim() || route.modelId || route.id)}"`);
    lines.push(`env_key = "${BYOK_GATEWAY_TOKEN_ENV}"`);
    lines.push('api_backend = "chat_completions"');
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
  sourceInstanceId?: string,
): Readonly<Record<string, string>> => ({
  ANTHROPIC_BASE_URL: anthropicGatewayBase(origin, sourceInstanceId),
  ANTHROPIC_AUTH_TOKEN: token,
  ANTHROPIC_API_KEY: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
});

/**
 * 将网关注册为 Codex 的 Responses 供应商；令牌通过
 * {@link BYOK_GATEWAY_TOKEN_ENV} 读取，不写入启动参数。
 */
export const gatewayCodexConfigArgs = (
  origin: string,
  sourceInstanceId?: string,
): readonly string[] => [
  "-c",
  `model_provider="${BYOK_GATEWAY_PROVIDER_ID}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.name="Code Work BYOK Gateway"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.base_url="${openaiGatewayBase(origin, sourceInstanceId)}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.env_key="${BYOK_GATEWAY_TOKEN_ENV}"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.wire_api="responses"`,
  "-c",
  `model_providers.${BYOK_GATEWAY_PROVIDER_ID}.requires_openai_auth=false`,
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

const readProvidedToken = (headers: Record<string, string>, url?: URL): string | null => {
  const authorization = headers.authorization ?? headers.Authorization;
  if (authorization !== undefined && authorization.trim().length > 0) {
    const bearer = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
    return bearer?.[1]?.trim() || authorization.trim();
  }
  const apiKey = headers["x-api-key"] ?? headers["X-Api-Key"];
  if (apiKey !== undefined && apiKey.trim().length > 0) return apiKey.trim();
  const queryKey = url?.searchParams.get("key") ?? url?.searchParams.get("auth_token");
  return typeof queryKey === "string" && queryKey.trim().length > 0 ? queryKey.trim() : null;
};

const decodeSourceInstanceId = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return /^[A-Za-z][A-Za-z0-9_-]{0,95}$/u.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
};

const allowedGatewayPath = (
  protocol: GatewayProtocol,
  provider: LocalAccountProvider | undefined,
  path: string,
): boolean => {
  const normalized = path.replace(/\/+/gu, "/");
  if (provider === undefined) return true; // 普通中转透明转发；路径范围只约束本地官方账号池。
  if (normalized === "/v1/models") return true;
  if (protocol === "anthropic")
    return (
      provider === "claude" &&
      (normalized === "/v1/messages" || normalized === "/v1/messages/count_tokens")
    );
  return normalized === "/v1/chat/completions" || normalized === "/v1/responses";
};

/** 仅在响应头已收到、响应体尚未交给 CLI 时允许本地账号换号。 */
export const isRetryableLocalGatewayStatus = (status: number): boolean =>
  status === 401 || status === 403 || status === 429 || status >= 500;

export interface GatewayUsageTotals {
  inputTokens: number;
  outputTokens: number;
}

const gatewayUsageTokens = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * 从一条 SSE `data:` 载荷提取 token 用量，其余载荷返回 undefined。识别
 * Anthropic 的 message_start/message_delta 与 OpenAI 的 chat-completions
 * `usage`、Responses API 的 `response.usage`。调用方按"同维度取最大值"
 * 累积：Anthropic 的 message_delta 携带累计 output_tokens，message_start
 * 只报输入。
 */
export const extractGatewayUsageLine = (
  protocol: GatewayProtocol,
  data: string,
): GatewayUsageTotals | undefined => {
  if (!data.includes("token")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const usageOf = (container: unknown): Record<string, unknown> | undefined => {
    if (container === null || typeof container !== "object" || Array.isArray(container)) {
      return undefined;
    }
    const usage = (container as Record<string, unknown>).usage;
    return usage !== null && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : undefined;
  };
  if (protocol === "anthropic") {
    if (record.type === "message_start") {
      const usage = usageOf(record.message);
      if (usage === undefined) return undefined;
      return {
        inputTokens:
          gatewayUsageTokens(usage.input_tokens) +
          gatewayUsageTokens(usage.cache_read_input_tokens) +
          gatewayUsageTokens(usage.cache_creation_input_tokens),
        outputTokens: 0,
      };
    }
    if (record.type === "message_delta") {
      const usage = usageOf(record);
      if (usage === undefined) return undefined;
      return { inputTokens: 0, outputTokens: gatewayUsageTokens(usage.output_tokens) };
    }
    return undefined;
  }
  const usage = usageOf(record) ?? usageOf(record.response);
  if (usage === undefined) return undefined;
  const inputTokens =
    gatewayUsageTokens(usage.prompt_tokens) + gatewayUsageTokens(usage.input_tokens);
  const outputTokens =
    gatewayUsageTokens(usage.completion_tokens) + gatewayUsageTokens(usage.output_tokens);
  return inputTokens === 0 && outputTokens === 0 ? undefined : { inputTokens, outputTokens };
};

/**
 * 透传式用量探针：原样转发响应流，同时按完整 SSE 行扫描 token 用量，
 * 流结束时把累计值交给 onTotal。客户端中断导致的尾部丢失可接受——请求数
 * 已在响应开始时记录。
 */
export const tapGatewayUsageStream = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  protocol: GatewayProtocol,
  onTotal: (totals: GatewayUsageTotals) => void,
): Stream.Stream<Uint8Array, E> => {
  const decoder = new TextDecoder();
  const totals: GatewayUsageTotals = { inputTokens: 0, outputTokens: 0 };
  let pending = "";
  const scanLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const usage = extractGatewayUsageLine(protocol, trimmed.slice(5).trim());
    if (usage === undefined) return;
    totals.inputTokens = Math.max(totals.inputTokens, usage.inputTokens);
    totals.outputTokens = Math.max(totals.outputTokens, usage.outputTokens);
  };
  return stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        pending += decoder.decode(chunk, { stream: true });
        let index = pending.indexOf("\n");
        while (index >= 0) {
          scanLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
          index = pending.indexOf("\n");
        }
      }),
    ),
    Stream.ensuring(
      Effect.sync(() => {
        pending += decoder.decode();
        if (pending.trim().length > 0) scanLine(pending);
        onTotal(totals);
      }),
    ),
  );
};

const nonEmptyCredentialField = (
  credential: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const value = credential?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

export const rewriteGatewayModel = (bodyText: string, modelId: string): string => {
  try {
    const body: unknown = JSON.parse(bodyText);
    if (body !== null && typeof body === "object" && !Array.isArray(body) && "model" in body) {
      return JSON.stringify({ ...body, model: modelId });
    }
  } catch {
    // 不改写无模型字段或非 JSON 的辅助请求。
  }
  return bodyText;
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

type GatewayHandlerMode = "byok" | "cliProxy";

const requestHeader = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

const cliProxyModelsProtocol = (request: HttpServerRequest.HttpServerRequest): GatewayProtocol => {
  const userAgent = requestHeader(request.headers, "user-agent")?.trim().toLowerCase() ?? "";
  return requestHeader(request.headers, "anthropic-version") !== undefined ||
    userAgent.startsWith("claude-cli")
    ? "anthropic"
    : "openai";
};

const gatewayHandler = (
  request: HttpServerRequest.HttpServerRequest,
  mode: GatewayHandlerMode = "byok",
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
    const isCliProxy = mode === "cliProxy";
    // 旧网关路径是 /byok-gw/{protocol}/...；内置 CLIProxyAPI 直接兼容
    // /v1/models、/v1/chat/completions、/v1/messages。
    const protocolSegment = isCliProxy
      ? segments[1] === "messages"
        ? "anthropic"
        : segments[1] === "models"
          ? cliProxyModelsProtocol(request)
          : segments[0] === "v1"
            ? "openai"
            : undefined
      : segments[1];
    const scoped = !isCliProxy && segments[2] === "source";
    const sourceInstanceId = scoped ? decodeSourceInstanceId(segments[3]) : undefined;
    const restPath = isCliProxy ? segments : segments.slice(scoped ? 4 : 2);

    const protocol =
      protocolSegment === "anthropic"
        ? ("anthropic" as const)
        : protocolSegment === "openai"
          ? ("openai" as const)
          : undefined;
    if (
      protocol === undefined ||
      restPath.length === 0 ||
      (scoped && sourceInstanceId === undefined)
    ) {
      return HttpServerResponse.empty({ status: 404 });
    }

    const expectedToken = yield* ensureGatewayToken(secretStore);
    const providedToken = readProvidedToken(request.headers, url);
    const internalToken =
      providedToken !== null && timingSafeTokenMatch(providedToken, expectedToken);
    const externalKey =
      providedToken === null
        ? undefined
        : internalToken
          ? undefined
          : matchLocalGatewayKey(yield* readLocalGatewayKeys(secretStore), providedToken);
    if (providedToken === null || (!internalToken && externalKey === undefined)) {
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
    // 外部 Agent key 只允许访问本地官方账号池，不能借用普通 BYOK 的上游密钥。
    const routes = gatewayAdapterRoutes(settings, sourceInstanceId, model).filter(
      (route) => internalToken || route.localProvider !== undefined,
    );
    if (method === "GET" && restPath.join("/") === "v1/models") {
      const models = routes.filter((route) => route.protocol === protocol);
      return HttpServerResponse.jsonUnsafe(
        protocol === "openai"
          ? {
              object: "list",
              data: models.map((route) => ({
                id: route.id,
                object: "model",
                created: 0,
                owned_by: route.groupName || "byok",
              })),
            }
          : {
              data: models.map((route) => ({
                id: route.id,
                type: "model",
                display_name: route.displayName,
              })),
              has_more: false,
              first_id: models[0]?.id ?? null,
              last_id: models.at(-1)?.id ?? null,
            },
      );
    }

    let adapter: GatewayAdapterRoute | undefined;
    if (model !== undefined) {
      adapter = pickGatewayAdapter(routes, protocol, model);
      if (adapter === undefined && isCliProxy) {
        const aliases = routes.filter(
          (route) => route.protocol === protocol && route.modelId === model,
        );
        if (aliases.length === 1) adapter = aliases[0];
      }
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

    const requestPath = `/${restPath.join("/")}`;
    if (!allowedGatewayPath(protocol, adapter.localProvider, requestPath)) {
      return errorResponse(
        protocol,
        anthropicError(404, "not_found_error", "该本地账号池路径不在允许的模型 API 范围内。"),
      );
    }

    const localProvider = adapter.localProvider;
    const triedLocalIds = new Set<string>();
    const nextLocalAccount = () =>
      localProvider === undefined
        ? undefined
        : pickLocalAccount(
            settings,
            localProvider,
            adapter.localAccountIds?.filter((id) => !triedLocalIds.has(id)),
            adapter.modelId,
          );
    let localAccount = nextLocalAccount();
    // ponytail: 每请求最多换号一次，响应流开始后不再重放请求。
    for (let attempt = 0; attempt < (localProvider === undefined ? 1 : 2); attempt += 1) {
      let localCredential: Record<string, unknown> | undefined;
      let localToken = "";
      let localAccountId: string | undefined;
      if (adapter.localProvider !== undefined) {
        const account = localAccount;
        if (account === undefined) {
          return errorResponse(
            protocol,
            anthropicError(
              503,
              "overloaded_error",
              `本地 ${adapter.localProvider} 账号池暂无可用账号。`,
            ),
          );
        }
        localAccountId = String(account.id);
        triedLocalIds.add(localAccountId);
        localCredential = yield* ensureLocalAccountCredential(
          account,
          secretStore,
          httpClient,
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const token =
          localCredential === undefined
            ? undefined
            : credentialToken(
                localCredential,
                account.authKind ?? credentialAuthKind(localCredential),
              );
        if (token === undefined) {
          markLocalAccountFailure(localAccountId, 401);
          localPoolUsageStore.recordRequest(localAccountId, adapter.localProvider ?? "", false);
          localAccount = attempt === 0 ? nextLocalAccount() : undefined;
          if (localAccount !== undefined) continue;
          return errorResponse(
            protocol,
            anthropicError(502, "authentication_error", "本地账号凭据无有效访问令牌。"),
          );
        }
        localToken = token;
      }
      const suffixPath = `${requestPath}${url.search}`;
      const apiKey = nonEmptyCredentialField(localCredential, "api_key");
      const authKind =
        localCredential === undefined
          ? undefined
          : (localAccount?.authKind ?? credentialAuthKind(localCredential));
      const target =
        adapter.localProvider === "codex"
          ? joinOpenAITarget(
              authKind === "api-key"
                ? "https://api.openai.com/v1"
                : "https://chatgpt.com/backend-api/codex",
              authKind === "api-key" ? suffixPath : suffixPath.replace(/^\/v1(?=\/|$)/u, ""),
            )
          : adapter.localProvider === "xai"
            ? joinOpenAITarget(
                authKind === "api-key"
                  ? "https://api.x.ai/v1"
                  : "https://cli-chat-proxy.grok.com/v1",
                suffixPath,
              )
            : adapter.localProvider === "claude"
              ? joinAnthropicTarget("https://api.anthropic.com", suffixPath)
              : protocol === "anthropic"
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
      if (adapter.localProvider === "claude") {
        if (authKind === "api-key" && localToken)
          forwardHeaders["x-api-key"] = apiKey ?? localToken;
        else {
          forwardHeaders["authorization"] = `Bearer ${localToken}`;
          forwardHeaders["anthropic-beta"] = [forwardHeaders["anthropic-beta"], "oauth-2025-04-20"]
            .filter(Boolean)
            .join(",");
        }
      } else if (adapter.localProvider === "codex") {
        forwardHeaders["authorization"] = `Bearer ${localToken}`;
        if (typeof localCredential?.account_id === "string")
          forwardHeaders["chatgpt-account-id"] = localCredential.account_id;
        if (authKind !== "api-key") forwardHeaders["OAI-Product-Sku"] = "codex";
      } else if (adapter.localProvider === "xai") {
        forwardHeaders["authorization"] = `Bearer ${localToken}`;
        if (authKind !== "api-key") {
          forwardHeaders["x-xai-token-auth"] = "xai-grok-cli";
          forwardHeaders["x-grok-client-identifier"] = "grok-shell";
          forwardHeaders["x-grok-client-version"] ??= "0.2.120";
        }
      } else if (protocol === "anthropic") {
        forwardHeaders["x-api-key"] = adapter.apiKey;
      } else {
        forwardHeaders["authorization"] = `Bearer ${adapter.apiKey}`;
      }

      const attemptResult = yield* httpClient
        .execute(
          HttpClientRequest.make(method)(target).pipe(
            HttpClientRequest.setHeaders(forwardHeaders),
            bodyText === undefined
              ? identity
              : HttpClientRequest.bodyText(
                  // 已发布的本地路由 ID 只是目录别名；发送给官方端点必须还原真实模型名。
                  rewriteGatewayModel(
                    bodyText,
                    adapter.localProvider !== undefined && !adapter.id.startsWith("local:")
                      ? (model ?? adapter.modelId)
                      : adapter.modelId,
                  ),
                  request.headers["content-type"] ?? "application/json",
                ),
          ),
        )
        .pipe(
          Effect.map((upstream) => ({ ok: true as const, upstream })),
          Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
        );
      if (!attemptResult.ok) {
        if (localAccountId !== undefined) {
          markLocalAccountFailure(localAccountId, 503);
          localPoolUsageStore.recordRequest(localAccountId, adapter.localProvider ?? "", false);
        }
        localAccount = attempt === 0 ? nextLocalAccount() : undefined;
        if (localAccount !== undefined) continue;
        yield* Effect.logWarning("BYOK gateway upstream request failed", {
          protocol,
          model: model ?? "(none)",
          cause:
            attemptResult.cause instanceof Error
              ? attemptResult.cause.message
              : String(attemptResult.cause),
        });
        return errorResponse(
          protocol,
          anthropicError(
            502,
            "api_error",
            "The BYOK gateway could not reach the adapter's endpoint.",
          ),
        );
      }
      const upstream = attemptResult.upstream;
      if (localAccountId !== undefined) {
        markLocalAccountFailure(localAccountId, upstream.status);
        localPoolUsageStore.recordRequest(
          localAccountId,
          adapter.localProvider ?? "",
          upstream.status < 400,
        );
      }
      const retryable = isRetryableLocalGatewayStatus(upstream.status);
      if (localProvider !== undefined && retryable && attempt === 0) {
        localAccount = nextLocalAccount();
        if (localAccount !== undefined) {
          // 丢弃首个错误响应，后续只透传新账号的完整流，避免混合两个响应。
          yield* upstream.text.pipe(Effect.catch(() => Effect.succeed("")));
          continue;
        }
      }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "retry-after", "request-id", "x-request-id"]) {
        const value = upstream.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      let responseStream = upstream.stream;
      if (localAccountId !== undefined && upstream.status < 400) {
        const accountId = localAccountId;
        responseStream = tapGatewayUsageStream(upstream.stream, protocol, (totals) => {
          if (totals.inputTokens > 0 || totals.outputTokens > 0) {
            localPoolUsageStore.recordTokens(accountId, totals.inputTokens, totals.outputTokens);
          }
        });
      }
      return HttpServerResponse.stream(responseStream, { status: upstream.status, headers });
    }
    return errorResponse(
      protocol,
      anthropicError(502, "api_error", "The BYOK gateway could not reach the adapter's endpoint."),
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
  readonly sourceInstanceId?: string;
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
      baseURL: openaiGatewayBase(input.origin, input.sourceInstanceId),
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
 * CLIProxyAPI 的同进程兼容入口。它复用账号池、换号、凭据刷新和流式
 * 转发逻辑，不启动外部 CLIProxyAPI 进程；当前支持 OpenAI/Anthropic 的
 * models、chat/completions、responses、messages 核心路径。
 */
export const cliProxyGatewayRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/v1/*", (request) => gatewayHandler(request, "cliProxy")),
  HttpRouter.add("POST", "/v1/*", (request) => gatewayHandler(request, "cliProxy")),
);

const managementAccountId = (name: string): string => {
  const normalized = name
    .replace(/\.json$/iu, "")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 96);
  return /^[A-Za-z]/u.test(normalized) ? normalized : `account-${normalized || "import"}`;
};

const managementProvider = (value: unknown): LocalAccountProvider | undefined => {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  if (normalized === "codex" || normalized === "openai") return "codex";
  if (normalized === "claude" || normalized === "anthropic") return "claude";
  if (normalized === "xai" || normalized === "grok") return "xai";
  // Cursor 账号只走 ACP 子进程，没有等价的 HTTP `/v1` 上游。
  return undefined;
};

const managementError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message, type: "invalid_request_error" } }, { status });

class CliProxyManagementError extends Schema.TaggedErrorClass<CliProxyManagementError>()(
  "CliProxyManagementError",
  { message: Schema.String },
) {}
const isCliProxyManagementError = Schema.is(CliProxyManagementError);

type CliProxyManagementFile = {
  readonly name: string;
  readonly content: string;
};

type CliProxyManagementBody =
  | { readonly kind: "json"; readonly value: Record<string, unknown>; readonly raw: string }
  | {
      readonly kind: "multipart";
      readonly fields: Readonly<Record<string, string>>;
      readonly files: readonly CliProxyManagementFile[];
    };

const readCliProxyManagementBody = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<CliProxyManagementBody, CliProxyManagementError> => {
  const contentType = requestHeader(request.headers, "content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return request.text.pipe(
      Effect.flatMap((raw) => {
        if (raw.trim().length === 0)
          return Effect.succeed({ kind: "json", value: {}, raw } as const);
        if (new TextEncoder().encode(raw).byteLength > 2 * 1024 * 1024)
          return Effect.fail(
            new CliProxyManagementError({ message: "管理请求体超过 2 MiB 大小限制。" }),
          );
        return Effect.try({
          try: () => JSON.parse(raw) as unknown,
          catch: () => new CliProxyManagementError({ message: "请求体必须是有效 JSON。" }),
        }).pipe(
          Effect.flatMap((value) =>
            value !== null && typeof value === "object" && !Array.isArray(value)
              ? Effect.succeed({
                  kind: "json",
                  value: value as Record<string, unknown>,
                  raw,
                } as const)
              : Effect.fail(new CliProxyManagementError({ message: "请求体必须是 JSON 对象。" })),
          ),
        );
      }),
      Effect.mapError((error) =>
        error instanceof CliProxyManagementError
          ? error
          : new CliProxyManagementError({ message: "读取请求体失败。" }),
      ),
    );
  }
  return Stream.runCollect(request.multipartStream).pipe(
    // CPA 把 JSON 凭据作为文件上传；Effect 默认会把 application/json 当普通字段。
    Effect.provideService(Multipart.FieldMimeTypes, []),
    Effect.provideService(Multipart.MaxFileSize, 2 * 1024 * 1024),
    Effect.provideService(Multipart.MaxFieldSize, 64 * 1024),
    Effect.flatMap((parts) =>
      Effect.gen(function* () {
        const fields: Record<string, string> = {};
        const files: CliProxyManagementFile[] = [];
        for (const part of parts) {
          if (Multipart.isField(part)) {
            fields[part.key] = part.value;
            continue;
          }
          if (!Multipart.isFile(part)) continue;
          const content = yield* part.contentEffect.pipe(
            Effect.mapError(
              () => new CliProxyManagementError({ message: "读取上传的 auth file 失败。" }),
            ),
          );
          if (content.byteLength > 2 * 1024 * 1024) {
            return yield* new CliProxyManagementError({
              message: "auth file 超过 2 MiB 大小限制。",
            });
          }
          files.push({ name: part.name, content: new TextDecoder().decode(content) });
        }
        return { kind: "multipart", fields, files } as const;
      }),
    ),
    Effect.mapError((error) =>
      error instanceof CliProxyManagementError
        ? error
        : new CliProxyManagementError({ message: "解析 multipart 请求失败。" }),
    ),
  );
};

const validCliProxyAuthFileName = (name: string): boolean => {
  const normalized = name.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,95}\.json$/iu.test(normalized);
};

const managementCredentialObject = (content: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(content);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * CLIProxyAPI 管理面兼容子集。只操作 Code Work 的本地账号池，不读写
 * 外部 CPA 文件；凭据仍进入 ServerSecretStore，响应只返回脱敏元数据。
 */
const cliProxyManagementHandler = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  ServerSecretStore | ServerSettingsService
> =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const settingsService = yield* ServerSettingsService;
    // 管理面只接受显式的管理头；不能复用 /v1 的 Authorization、x-api-key
    // 或查询参数，否则任何拿到推理令牌的客户端都可能尝试提升为管理权限。
    const provided = requestHeader(request.headers, "x-management-key")?.trim() || null;
    const expected = yield* ensureGatewayToken(secretStore);
    const internal = provided !== null && timingSafeTokenMatch(provided, expected);
    // 推理 key 只允许访问 /v1，不得提升为账号、凭据或调度配置管理权限。
    if (!internal) return managementError(401, "Invalid management key.");

    const url = new URL(request.url, "http://cliproxy.invalid");
    const path = url.pathname.replace(/^\/v0\/management\/?/u, "").replace(/\/+$/u, "");
    const method = request.method.toUpperCase();
    const parsedBody =
      method === "GET" || method === "HEAD"
        ? ({ kind: "json", value: {}, raw: "" } as const)
        : yield* readCliProxyManagementBody(request);
    const body = parsedBody.kind === "json" ? parsedBody.value : {};
    const current = yield* settingsService.getSettings;

    if (path === "auth-files" && method === "GET") {
      const requestedName = url.searchParams.get("name")?.trim();
      if (requestedName !== undefined && !validCliProxyAuthFileName(requestedName)) {
        return managementError(400, "auth file name 无效。");
      }
      const requestedId =
        requestedName === undefined ? undefined : managementAccountId(requestedName);
      return HttpServerResponse.jsonUnsafe({
        files: Object.values(current.localAccountPool.accounts)
          .filter((account) => requestedId === undefined || account.id === requestedId)
          .map((account) => ({
            id: account.id,
            name: `${account.id}.json`,
            type: account.provider,
            provider: account.provider,
            disabled: !account.enabled,
            status: account.enabled ? "active" : "disabled",
            status_message: account.enabled ? "" : "disabled",
            unavailable: !account.enabled,
            runtime_only: false,
            models: account.models,
          })),
      });
    }
    if (path === "auth-files/models" && method === "GET") {
      const name = url.searchParams.get("name")?.trim();
      if (name === undefined || !validCliProxyAuthFileName(name)) {
        return managementError(400, "auth file name 无效。");
      }
      const account = Object.values(current.localAccountPool.accounts).find(
        (candidate) => candidate.id === managementAccountId(name),
      );
      if (account === undefined) return managementError(404, "auth file 不存在。");
      return HttpServerResponse.jsonUnsafe({
        models: account.models.map((id) => ({
          id,
          display_name: id,
          type: "model",
          owned_by: account.provider,
        })),
      });
    }
    if (path === "auth-files" && method === "DELETE") {
      const name =
        url.searchParams.get("name")?.trim() ??
        (typeof body.name === "string" ? body.name.trim() : "");
      if (!validCliProxyAuthFileName(name)) return managementError(400, "auth file name 无效。");
      if (
        !Object.values(current.localAccountPool.accounts).some(
          (account) => account.id === managementAccountId(name),
        )
      ) {
        return managementError(404, "auth file 不存在。");
      }
      yield* removeLocalAccount(settingsService, secretStore, managementAccountId(name)).pipe(
        Effect.mapError((error) => new CliProxyManagementError({ message: error.message })),
      );
      return HttpServerResponse.jsonUnsafe({ ok: true, status: "ok" });
    }
    if (path === "auth-files" && (method === "POST" || method === "PUT")) {
      if (parsedBody.kind === "multipart") {
        if (parsedBody.files.length === 0)
          return managementError(400, "multipart 请求没有上传 auth file。");
        const imported: Array<{
          name: string;
          provider: LocalAccountProvider;
          models: readonly string[];
        }> = [];
        const failed: Array<{ name: string; error: string }> = [];
        for (const file of parsedBody.files) {
          if (!validCliProxyAuthFileName(file.name)) {
            failed.push({ name: file.name, error: "auth file 必须是安全的 .json 文件名。" });
            continue;
          }
          const credential = managementCredentialObject(file.content);
          const provider = managementProvider(credential?.type ?? credential?.provider);
          if (credential === undefined || provider === undefined) {
            failed.push({ name: file.name, error: "auth file JSON 缺少受支持的 type/provider。" });
            continue;
          }
          const result = yield* importLocalAccount(settingsService, secretStore, {
            id: managementAccountId(file.name),
            provider,
            displayName: file.name.replace(/\.json$/iu, ""),
            content: file.content,
          }).pipe(
            Effect.map((account) => ({ ok: true as const, account })),
            Effect.catch((error) =>
              Effect.succeed({
                ok: false as const,
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          );
          if (!result.ok) {
            failed.push({ name: file.name, error: result.error });
            continue;
          }
          const account = result.account;
          imported.push({
            name: `${account.id}.json`,
            provider: account.provider,
            models: account.models,
          });
        }
        return HttpServerResponse.jsonUnsafe(
          failed.length === 0
            ? { ok: true, status: "ok", uploaded: imported.length, files: imported }
            : { status: "partial", uploaded: imported.length, files: imported, failed },
          { status: failed.length === 0 ? 200 : 207 },
        );
      }
      const name = url.searchParams.get("name") ?? (typeof body.name === "string" ? body.name : "");
      const provider = managementProvider(body.type ?? body.provider);
      if (!validCliProxyAuthFileName(name) || provider === undefined)
        return managementError(400, "auth file name 或 provider 无效。");
      const rawContent =
        typeof body.content === "string"
          ? body.content
          : body.data !== undefined || body.credential !== undefined
            ? JSON.stringify(body.data ?? body.credential)
            : parsedBody.raw.trim();
      const content = (() => {
        if (!Array.isArray(body.models)) return rawContent;
        try {
          const parsed: unknown = JSON.parse(rawContent);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
            return JSON.stringify({ ...(parsed as Record<string, unknown>), models: body.models });
        } catch {
          // importLocalAccount 返回统一的 JSON 格式错误。
        }
        return rawContent;
      })();
      const account = yield* importLocalAccount(settingsService, secretStore, {
        id: managementAccountId(name),
        provider,
        displayName:
          typeof body.displayName === "string" ? body.displayName : name.replace(/\.json$/iu, ""),
        content,
      }).pipe(Effect.mapError((error) => new CliProxyManagementError({ message: error.message })));
      return HttpServerResponse.jsonUnsafe({
        ok: true,
        status: "ok",
        file: {
          name: `${account.id}.json`,
          provider: account.provider,
          disabled: !account.enabled,
          status: "active",
          models: account.models,
        },
      });
    }
    if (path === "auth-files/status" && (method === "POST" || method === "PATCH")) {
      const rawName =
        typeof body.name === "string" ? body.name : (url.searchParams.get("name") ?? "");
      if (!validCliProxyAuthFileName(rawName) || typeof body.disabled !== "boolean")
        return managementError(400, "status 请求需要 name 和 disabled。");
      if (
        !Object.values(current.localAccountPool.accounts).some(
          (account) => account.id === managementAccountId(rawName),
        )
      ) {
        return managementError(404, "auth file 不存在。");
      }
      yield* setLocalAccountEnabled(
        settingsService,
        managementAccountId(rawName),
        !body.disabled,
      ).pipe(Effect.mapError((error) => new CliProxyManagementError({ message: error.message })));
      return HttpServerResponse.jsonUnsafe({ ok: true, status: "ok", disabled: body.disabled });
    }
    if (path === "config" && method === "GET") {
      return HttpServerResponse.jsonUnsafe({ strategy: current.localAccountPool.strategy });
    }
    if (path === "config" && (method === "PATCH" || method === "POST")) {
      const strategy =
        body.strategy === "fill-first"
          ? "fill-first"
          : body.strategy === "round-robin"
            ? "round-robin"
            : body.strategy === "weighted-round-robin"
              ? "weighted-round-robin"
              : undefined;
      if (strategy === undefined)
        return managementError(
          400,
          "strategy 必须是 round-robin、fill-first 或 weighted-round-robin。",
        );
      yield* setLocalAccountPoolStrategy(settingsService, strategy).pipe(
        Effect.mapError((error) => new CliProxyManagementError({ message: error.message })),
      );
      return HttpServerResponse.jsonUnsafe({ ok: true, strategy });
    }
    if (path === "routing/strategy" && method === "GET") {
      return HttpServerResponse.jsonUnsafe({ strategy: current.localAccountPool.strategy });
    }
    if (path === "routing/strategy" && (method === "PUT" || method === "PATCH")) {
      const requested = body.value ?? body.strategy;
      const strategy =
        requested === "fill-first"
          ? "fill-first"
          : requested === "round-robin"
            ? "round-robin"
            : requested === "weighted-round-robin"
              ? "weighted-round-robin"
              : undefined;
      if (strategy === undefined)
        return managementError(400, "仅支持 round-robin、fill-first 或 weighted-round-robin。");
      yield* setLocalAccountPoolStrategy(settingsService, strategy).pipe(
        Effect.mapError((error) => new CliProxyManagementError({ message: error.message })),
      );
      return HttpServerResponse.jsonUnsafe({ ok: true, strategy });
    }
    return managementError(404, "内置管理 API 未实现该路径。");
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        managementError(400, isCliProxyManagementError(error) ? error.message : "管理请求失败。"),
      ),
    ),
  );

export const cliProxyManagementRouteLayer = Layer.mergeAll(
  HttpRouter.add("GET", "/v0/management/*", cliProxyManagementHandler),
  HttpRouter.add("POST", "/v0/management/*", cliProxyManagementHandler),
  HttpRouter.add("PUT", "/v0/management/*", cliProxyManagementHandler),
  HttpRouter.add("PATCH", "/v0/management/*", cliProxyManagementHandler),
  HttpRouter.add("DELETE", "/v0/management/*", cliProxyManagementHandler),
);

/**
 * Origin harnesses should point at. CLIs run beside the server, so loopback is
 * always reachable even when the Code Work clients connect remotely.
 */
export const byokGatewayOriginFromConfig = (config: { readonly port: number }): string =>
  gatewayOrigin(config.port);
