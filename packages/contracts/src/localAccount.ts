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

export const LocalAccountProvider = Schema.Literals(["codex", "claude", "xai", "cursor"]);
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
