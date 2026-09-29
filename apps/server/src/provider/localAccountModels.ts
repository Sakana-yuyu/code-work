// @effect-diagnostics preferSchemaOverJson:off - 平台模型目录响应形状松散，逐字段取值比 Schema 结构更稳。
import {
  LOCAL_POOL_DEFAULT_MODELS,
  ZCODE_OFFICIAL_MODELS,
  type LocalAccount,
  type LocalAccountAuthKind,
  type LocalAccountProvider,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { fetchZCodeStartPlanBalance } from "./zcode/zcodeStartPlan.ts";

/** 拉取结果：models 供勾选弹窗展示，source 告诉 UI 列表是官方接口还是静态目录兜底。 */
export interface LocalAccountModelsResult {
  readonly source: "provider" | "catalog";
  readonly models: ReadonlyArray<string>;
}

const REQUEST_TIMEOUT_MS = 15_000;
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (record: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof record?.[key] === "string" && (record[key] as string).trim().length > 0
    ? (record[key] as string).trim()
    : undefined;

/** Codex `backend-api/codex/models`：`{models:[{slug,...}]}`，slug 即路由用的模型 ID。 */
export const codexModelsFromPayload = (payload: unknown): ReadonlyArray<string> => {
  const models = asRecord(payload)?.models;
  if (!Array.isArray(models)) return [];
  const slugs = models
    .map((entry) => readString(asRecord(entry), "slug"))
    .filter((slug): slug is string => slug !== undefined);
  return [...new Set(slugs)];
};

/** Anthropic/xAI 的 `/v1/models`：OpenAI 风格 `{data:[{id,...}]}`。 */
export const openAiModelsFromPayload = (payload: unknown): ReadonlyArray<string> => {
  const data = asRecord(payload)?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) => readString(asRecord(entry), "id"))
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
};

/** 体验套餐余额 capabilities 里的 `model:<id>` 条目（zcodeStartPlan 已归一化成 models）。 */
export const zcodeModelsFromCatalog = (
  official: ReadonlyArray<string>,
  startPlanModels: ReadonlyArray<string>,
): ReadonlyArray<string> => [...new Set([...official, ...startPlanModels])];

const catalogResult = (provider: LocalAccountProvider): LocalAccountModelsResult => ({
  source: "catalog",
  models: LOCAL_POOL_DEFAULT_MODELS[provider],
});

const getJson = (input: {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly failure: string;
}): Effect.Effect<Record<string, unknown>, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(input.url).pipe(HttpClientRequest.setHeaders(input.headers)))
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT_MS),
        Effect.mapError(() => input.failure),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(`${input.failure}（HTTP ${response.status}）`);
    const text = yield* response.text.pipe(Effect.mapError(() => `${input.failure}（响应不可读）`));
    const decoded = yield* decodeJson(text).pipe(
      Effect.mapError(() => `${input.failure}（响应不是 JSON）`),
    );
    const record = asRecord(decoded);
    return record === undefined
      ? yield* Effect.fail(`${input.failure}（响应不是 JSON 对象）`)
      : record;
  });

const providerResultOrCatalog = (
  models: ReadonlyArray<string>,
  provider: LocalAccountProvider,
): LocalAccountModelsResult =>
  models.length === 0 ? catalogResult(provider) : { source: "provider", models };

/** Codex OAuth：上游 fetch_codex_models 同款端点；拉取失败落静态目录。 */
const fetchCodexModels = (
  credential: Record<string, unknown>,
  token: string,
): Effect.Effect<LocalAccountModelsResult, never, HttpClient.HttpClient> => {
  const accountId = readString(credential, "account_id");
  return getJson({
    url: "https://chatgpt.com/backend-api/codex/models?client_version=0.153.3",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.153.3 (Windows 10.0.19045; x64)",
      ...(accountId === undefined ? {} : { "Chatgpt-Account-Id": accountId }),
    },
    failure: "Codex 模型拉取失败",
  }).pipe(
    Effect.map((payload) => providerResultOrCatalog(codexModelsFromPayload(payload), "codex")),
    Effect.orElseSucceed(() => catalogResult("codex")),
  );
};

/** Anthropic API Key：官方 `/v1/models` 目录。 */
const fetchClaudeApiModels = (
  token: string,
): Effect.Effect<LocalAccountModelsResult, never, HttpClient.HttpClient> =>
  getJson({
    url: "https://api.anthropic.com/v1/models?limit=100",
    headers: {
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    },
    failure: "Claude 模型拉取失败",
  }).pipe(
    Effect.map((payload) => providerResultOrCatalog(openAiModelsFromPayload(payload), "claude")),
    Effect.orElseSucceed(() => catalogResult("claude")),
  );

/** xAI API Key：官方 `/v1/models` 目录。 */
const fetchXaiApiModels = (
  token: string,
): Effect.Effect<LocalAccountModelsResult, never, HttpClient.HttpClient> =>
  getJson({
    url: "https://api.x.ai/v1/models",
    headers: { Authorization: `Bearer ${token}` },
    failure: "Grok 模型拉取失败",
  }).pipe(
    Effect.map((payload) => providerResultOrCatalog(openAiModelsFromPayload(payload), "xai")),
    Effect.orElseSucceed(() => catalogResult("xai")),
  );

/** ZCode：官方目录 + 体验套餐余额 capabilities 解出的模型（JWT 账号才可查）。 */
const fetchZCodeModels = (
  credential: Record<string, unknown>,
): Effect.Effect<LocalAccountModelsResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const jwt = readString(credential, "zcode_jwt");
    // 官方目录恒非空，"provider" 只在余额查询真实给出模型时成立。
    const startPlanModels =
      jwt === undefined
        ? undefined
        : yield* fetchZCodeStartPlanBalance(jwt).pipe(
            Effect.map((view) => (view.models.length > 0 ? view.models : undefined)),
            Effect.orElseSucceed(() => undefined as ReadonlyArray<string> | undefined),
          );
    return startPlanModels === undefined
      ? catalogResult("zcode")
      : {
          source: "provider" as const,
          models: zcodeModelsFromCatalog(ZCODE_OFFICIAL_MODELS, startPlanModels),
        };
  });

const credentialString = (
  credential: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined => {
  for (const key of keys) {
    const value = readString(credential, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * 按账号拉取模型目录。拉取源：codex OAuth→`backend-api/codex/models`；
 * claude/xai 的 API-Key 账号→各自 `/v1/models`；zcode→官方目录 + 体验套餐
 * capabilities；OAuth 的 claude/xai 与 cursor 无目录接口，落静态目录兜底。
 * 永不失败——平台请求失败一律回静态目录，保证 UI 总有可勾选列表。
 */
export const fetchLocalAccountModels = (input: {
  readonly account: LocalAccount;
  readonly credential: Record<string, unknown>;
  readonly authKind: LocalAccountAuthKind;
}): Effect.Effect<LocalAccountModelsResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { account, credential, authKind } = input;
    const tokenKeys =
      account.provider === "zcode"
        ? // zcode：体验套餐模型走 JWT；Coding Plan Key 账号官方目录已覆盖。
          ["api_key", "zcode_jwt", "access_token", "token", "key"]
        : authKind === "api-key"
          ? ["api_key", "access_token", "token", "key"]
          : ["access_token", "api_key", "token", "key"];
    const token = credentialString(credential, tokenKeys);
    switch (account.provider) {
      case "codex":
        return authKind === "oauth" && token !== undefined
          ? yield* fetchCodexModels(credential, token)
          : catalogResult("codex");
      case "claude":
        return authKind === "api-key" && token !== undefined
          ? yield* fetchClaudeApiModels(token)
          : catalogResult("claude");
      case "xai":
        return authKind === "api-key" && token !== undefined
          ? yield* fetchXaiApiModels(token)
          : catalogResult("xai");
      case "zcode":
        return yield* fetchZCodeModels(credential);
      default:
        return catalogResult(account.provider);
    }
  });
