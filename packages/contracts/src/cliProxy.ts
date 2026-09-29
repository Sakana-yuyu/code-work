import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  LocalAccountId,
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
  /** 客户端中断的流式请求，不计入供应商失败。 */
  canceled: Schema.optional(NonNegativeInt),
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  lastUsedAt: Schema.NullOr(Schema.String),
  /** 账号冷却截止（unix ms），仅在冷却仍有效时出现。 */
  cooldownUntilUnixMs: Schema.optional(NonNegativeInt),
});

/**
 * 本机/受管实例已登录的原生 CLI 凭据落点——号池"从本机导入"的扫描结果。
 * 客户端只拿到路径与展示名；凭据内容不回传，导入由服务端重新读盘完成。
 */
export const CliProxyNativeLogin = Schema.Struct({
  provider: LocalAccountProvider,
  path: Schema.String,
  label: Schema.optional(Schema.String),
  /** 该落点的凭据已在号池里（按 native-<provider>-<path哈希> 推导的账号 ID 判断）。 */
  imported: Schema.Boolean,
});
export type CliProxyNativeLogin = typeof CliProxyNativeLogin.Type;
export type CliProxyAccountUsage = typeof CliProxyAccountUsage.Type;

/** 单个用量窗口：label 已由服务端翻译成可读名称，percent 是已用百分比 0–100。 */
export const CliProxyUsageWindow = Schema.Struct({
  label: Schema.String,
  percent: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.String),
  resetsAt: Schema.optional(Schema.String),
});
export type CliProxyUsageWindow = typeof CliProxyUsageWindow.Type;

/**
 * 号池账号从各平台官方接口拉到的订阅/额度快照。字段尽力而为——
 * 平台不支持或请求失败时 `error` 带可读文案，其余字段可全部缺省。
 */
export const CliProxyAccountSubscription = Schema.Struct({
  id: LocalAccountId,
  plan: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  windows: Schema.Array(CliProxyUsageWindow),
  /** 键值指标（活动统计、余额等不是窗口额度的数据点）。 */
  metrics: Schema.optional(
    Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
  ),
  detail: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type CliProxyAccountSubscription = typeof CliProxyAccountSubscription.Type;

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
  Schema.Struct({
    action: Schema.Literal("importLocalLogin"),
    provider: LocalAccountProvider,
    terminalId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
    displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(96))),
    models: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50))),
  }),
  Schema.Struct({ action: Schema.Literal("scanNativeAccounts") }),
  Schema.Struct({ action: Schema.Literal("localAccountUsage") }),
  Schema.Struct({
    action: Schema.Literal("importNativeAccount"),
    provider: LocalAccountProvider,
    /** 只接受 scanNativeAccounts 返回的落点；服务端重算候选集后校验。 */
    path: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
    displayName: Schema.optional(Schema.String.check(Schema.isMaxLength(96))),
    models: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50))),
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
  nativeLogins: Schema.optional(Schema.Array(CliProxyNativeLogin)),
  /** 账号级用量/订阅快照，只在 action=localAccountUsage 的结果里填充。 */
  accountSubscriptions: Schema.optional(Schema.Array(CliProxyAccountSubscription)),
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
