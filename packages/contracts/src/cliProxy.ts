import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  LocalAccountPoolStrategy,
  LocalAccountProvider,
  LocalAccountSummary,
  LocalAccountWeight,
} from "./localAccount.ts";

/** 外部 Agent 使用的本地账号池访问凭据摘要；明文 key 只在创建/轮换结果中返回一次。 */
export const CliProxyExternalGatewayKey = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  createdAt: Schema.String,
});
export type CliProxyExternalGatewayKey = typeof CliProxyExternalGatewayKey.Type;

export const CliProxyExternalGateway = Schema.Struct({
  openaiBaseUrl: Schema.String,
  anthropicBaseUrl: Schema.String,
  keys: Schema.Array(CliProxyExternalGatewayKey),
  /** 创建/轮换时一次性返回；状态刷新和列表操作不会返回该字段。 */
  issuedKey: Schema.optional(Schema.String),
});
export type CliProxyExternalGateway = typeof CliProxyExternalGateway.Type;

/** 外部代理和本地账号池的凭据均只由服务端持有，客户端仅接收脱敏状态。 */
export const CliProxyAccount = Schema.Struct({
  name: TrimmedNonEmptyString,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.Boolean,
  status: Schema.String,
  statusMessage: Schema.optional(Schema.String),
});
export type CliProxyAccount = typeof CliProxyAccount.Type;

export const CliProxyConfig = Schema.Struct({
  strategy: LocalAccountPoolStrategy,
});
export type CliProxyConfig = typeof CliProxyConfig.Type;

/**
 * 本地账号池按账号的调用统计。令牌数字来自网关对响应流的统计，只包含
 * 聚合数字，不包含任何凭据或请求内容；`lastUsedAt` 是最近一次调用的
 * ISO 时间，从未被使用过时为 null。
 */
export const CliProxyAccountUsage = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: Schema.String,
  requests: NonNegativeInt,
  failed: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** 账号冷却截止（unix ms），仅在冷却仍有效时出现。 */
  cooldownUntilUnixMs: Schema.optional(NonNegativeInt),
});
export type CliProxyAccountUsage = typeof CliProxyAccountUsage.Type;

export const CliProxyRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("status") }),
  Schema.Struct({ action: Schema.Literal("configure"), config: CliProxyConfig }),
  Schema.Struct({ action: Schema.Literal("accounts") }),
  Schema.Struct({
    action: Schema.Literal("setAccountEnabled"),
    name: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("deleteAccount"), name: TrimmedNonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("importAccount"),
    name: TrimmedNonEmptyString,
    provider: Schema.optional(LocalAccountProvider),
    content: Schema.String.check(Schema.isMaxLength(1048576)),
  }),
  Schema.Struct({
    action: Schema.Literal("connectByok"),
    instanceId: ProviderInstanceId,
    displayName: TrimmedNonEmptyString,
  }),
  Schema.Struct({ action: Schema.Literal("localAccounts") }),
  Schema.Struct({
    action: Schema.Literal("importLocalAccount"),
    id: Schema.String.check(Schema.isMaxLength(96)),
    provider: LocalAccountProvider,
    displayName: TrimmedNonEmptyString,
    content: Schema.String.check(Schema.isMaxLength(1048576)),
  }),
  Schema.Struct({ action: Schema.Literal("deleteLocalAccount"), id: TrimmedNonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("setLocalAccountEnabled"),
    id: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("setLocalAccountsEnabled"),
    ids: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500)),
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literal("setLocalAccountPoolStrategy"),
    strategy: LocalAccountPoolStrategy,
  }),
  Schema.Struct({
    action: Schema.Literal("setLocalAccountWeight"),
    id: TrimmedNonEmptyString,
    weight: LocalAccountWeight,
  }),
  Schema.Struct({
    action: Schema.Literal("publishLocalAccountPool"),
    instanceId: ProviderInstanceId,
    provider: Schema.optional(LocalAccountProvider),
  }),
  Schema.Struct({ action: Schema.Literal("externalGatewayKeys") }),
  Schema.Struct({
    action: Schema.Literal("createExternalGatewayKey"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(96)),
  }),
  Schema.Struct({
    action: Schema.Literal("rotateExternalGatewayKey"),
    id: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("revokeExternalGatewayKey"),
    id: TrimmedNonEmptyString,
  }),
]);
export type CliProxyRequest = typeof CliProxyRequest.Type;

export const CliProxyResult = Schema.Struct({
  config: CliProxyConfig,
  /** 内置兼容服务随 Code Work Server 一起运行，不再有外部 CPA 子进程。 */
  running: Schema.Literal(true),
  version: Schema.Literal("embedded"),
  baseUrl: Schema.String,
  accounts: Schema.Array(CliProxyAccount),
  localAccounts: Schema.optional(Schema.Array(LocalAccountSummary)),
  localStrategy: Schema.optional(LocalAccountPoolStrategy),
  externalGateway: Schema.optional(CliProxyExternalGateway),
  connectedInstanceId: Schema.optional(ProviderInstanceId),
  accountUsage: Schema.optional(Schema.Array(CliProxyAccountUsage)),
});
export type CliProxyResult = typeof CliProxyResult.Type;

export class CliProxyError extends Schema.TaggedErrorClass<CliProxyError>()("CliProxyError", {
  code: Schema.Literals(["invalid_config", "busy", "upstream_error"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
