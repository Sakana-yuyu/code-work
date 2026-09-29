import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "./providerInstance.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalAccountId = TrimmedNonEmptyString.check(Schema.isMaxLength(96)).pipe(
  Schema.brand("LocalAccountId"),
);
export type LocalAccountId = typeof LocalAccountId.Type;

/** 加权轮询权重；与客户端输入上限一致，防止异常配置展开过多调度槽位。 */
export const LocalAccountWeight = NonNegativeInt.check(Schema.isLessThanOrEqualTo(99));
export type LocalAccountWeight = typeof LocalAccountWeight.Type;

export const LocalAccountProvider = Schema.Literals(["codex", "claude", "xai", "cursor", "zcode"]);
export type LocalAccountProvider = typeof LocalAccountProvider.Type;

/** 官方凭据的实际认证方式；订阅 OAuth 与通用 API Key 的端点和请求头不同。 */
export const LocalAccountAuthKind = Schema.Literals(["oauth", "api-key"]);
export type LocalAccountAuthKind = typeof LocalAccountAuthKind.Type;

/** 只保存可展示元数据；令牌由 ServerSecretStore 按 credentialRef 保管。 */
export const LocalAccount = Schema.Struct({
  id: LocalAccountId,
  provider: LocalAccountProvider,
  authKind: Schema.optional(LocalAccountAuthKind),
  displayName: TrimmedNonEmptyString,
  // settings RPC 会把该服务端索引脱敏为空串；真实写入仍由本地账号服务生成非空值。
  credentialRef: Schema.Union([TrimmedNonEmptyString, Schema.Literal("")]),
  enabled: Schema.Boolean,
  models: Schema.Array(TrimmedNonEmptyString),
  /** weighted-round-robin 的调度权重；缺省或小于 1 时按 1 处理。 */
  weight: Schema.optional(LocalAccountWeight),
});
export type LocalAccount = typeof LocalAccount.Type;

export const LocalAccountSummary = Schema.Struct({
  id: LocalAccountId,
  provider: LocalAccountProvider,
  authKind: Schema.optional(LocalAccountAuthKind),
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  models: Schema.Array(TrimmedNonEmptyString),
  weight: Schema.optional(LocalAccountWeight),
});
export type LocalAccountSummary = typeof LocalAccountSummary.Type;

/**
 * round-robin 轮询全部账号；fill-first 固定先用第一个可用账号；
 * weighted-round-robin 按 weight 比例扩展开来轮询，权重越大分到的调用越多。
 */
export const LocalAccountPoolStrategy = Schema.Literals([
  "round-robin",
  "fill-first",
  "weighted-round-robin",
]);
export type LocalAccountPoolStrategy = typeof LocalAccountPoolStrategy.Type;

/**
 * ZCode Individual Coding Plan 开放的官方模型（builtinProviderModelRules 中
 * enabled 的集合）。服务端 zcodeCredentials 与号池默认目录共用这一份。
 */
export const ZCODE_OFFICIAL_MODELS: ReadonlyArray<string> = [
  "GLM-5.3",
  "GLM-5.3-Flash",
  "GLM-5.2",
  "GLM-5-Turbo",
];

/**
 * 账号没声明 `models` 时按平台发布的默认目录：空数组的语义是"不限模型"
 * （路由放行任意请求），但 BYOK 网关按 models 展开通道，空目录会让账号
 * 一条线路都产不出——这里给每个平台一份官方目录兜底展示与转发。
 */
export const LOCAL_POOL_DEFAULT_MODELS: Record<LocalAccountProvider, ReadonlyArray<string>> = {
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark"],
  claude: [
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ],
  xai: ["grok-build"],
  cursor: [],
  zcode: ZCODE_OFFICIAL_MODELS,
};

export const LocalAccountPoolSettings = Schema.Struct({
  accounts: Schema.Record(LocalAccountId, LocalAccount).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  strategy: LocalAccountPoolStrategy.pipe(
    Schema.withDecodingDefault(Effect.succeed("round-robin" as const)),
  ),
  /** 将请求绑定到当前对话时传入的 Provider 实例；空值表示只作为本地 API 代理。 */
  providerInstances: Schema.Record(ProviderInstanceId, Schema.Array(LocalAccountId)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type LocalAccountPoolSettings = typeof LocalAccountPoolSettings.Type;
