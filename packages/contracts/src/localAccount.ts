import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalAccountId = TrimmedNonEmptyString.check(Schema.isMaxLength(96)).pipe(
  Schema.brand("LocalAccountId"),
);
export type LocalAccountId = typeof LocalAccountId.Type;

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
});
export type LocalAccount = typeof LocalAccount.Type;

export const LocalAccountSummary = Schema.Struct({
  id: LocalAccountId,
  provider: LocalAccountProvider,
  authKind: Schema.optional(LocalAccountAuthKind),
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  models: Schema.Array(TrimmedNonEmptyString),
});
export type LocalAccountSummary = typeof LocalAccountSummary.Type;

export const LocalAccountPoolSettings = Schema.Struct({
  accounts: Schema.Record(LocalAccountId, LocalAccount).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  strategy: Schema.Literals(["round-robin", "fill-first"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("round-robin" as const)),
  ),
  /** 将请求绑定到当前对话时传入的 Provider 实例；空值表示只作为本地 API 代理。 */
  providerInstances: Schema.Record(ProviderInstanceId, Schema.Array(LocalAccountId)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type LocalAccountPoolSettings = typeof LocalAccountPoolSettings.Type;
