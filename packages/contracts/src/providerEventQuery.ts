import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * Provider 事件日志（logs/provider/events.<thread>.log）的只读查询合同。
 *
 * 这是 Request Lab 能力的第一块底座：把落盘的 native/canonical 事件经脱敏后
 * 暴露给客户端做诊断，只读、限量、不提供任何写路径或重放入口。
 */

export const ProviderEventQueryStream = Schema.Literals(["native", "canonical", "orchestration"]);
export type ProviderEventQueryStream = typeof ProviderEventQueryStream.Type;

export const ProviderEventQueryInput = Schema.Struct({
  threadId: ThreadId,
  stream: Schema.optionalKey(ProviderEventQueryStream),
  limit: Schema.optionalKey(NonNegativeInt),
});
export type ProviderEventQueryInput = typeof ProviderEventQueryInput.Type;

export const ProviderEventLogEntry = Schema.Struct({
  /** 行头的落盘时间（ISO 字符串），解析失败为 null。 */
  loggedAt: Schema.NullOr(Schema.String),
  stream: ProviderEventQueryStream,
  eventId: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  requestId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  providerRequestId: Schema.NullOr(Schema.String),
  /** 完整解析后的事件对象（已按敏感键脱敏）。 */
  event: Schema.Unknown,
});
export type ProviderEventLogEntry = typeof ProviderEventLogEntry.Type;

export const ProviderEventQueryResult = Schema.Struct({
  threadSegment: Schema.String,
  scannedFileNames: Schema.Array(Schema.String),
  events: Schema.Array(ProviderEventLogEntry),
  /** 日志行数超过 limit 时为 true，events 取最新一段。 */
  truncated: Schema.Boolean,
});
export type ProviderEventQueryResult = typeof ProviderEventQueryResult.Type;
