import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { CompositionTaskEventType, CompositionTaskStatus } from "./composition.ts";

const CompositionEventKind = Schema.Literals([
  "composition.task",
  "composition.runtime",
  "composition.ide",
  "composition.multica",
]);
export type CompositionEventKind = typeof CompositionEventKind.Type;

const CompositionEventSource = Schema.Literals(["t3", "runtime", "ide", "multica"]);
export type CompositionEventSource = typeof CompositionEventSource.Type;

/** 可追加到现有 Provider/Checkpoint 事件流旁路的组合事件信封。 */
export const CompositionEventEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  eventId: TrimmedNonEmptyString,
  kind: CompositionEventKind,
  taskId: Schema.optional(TrimmedNonEmptyString),
  runId: Schema.optional(TrimmedNonEmptyString),
  agentId: Schema.optional(TrimmedNonEmptyString),
  runtimeId: Schema.optional(TrimmedNonEmptyString),
  sequence: NonNegativeInt,
  eventType: CompositionTaskEventType,
  status: CompositionTaskStatus,
  summary: TrimmedNonEmptyString,
  source: CompositionEventSource,
  occurredAtUnixMs: NonNegativeInt,
  terminal: Schema.Boolean,
  payload: Schema.optional(Schema.Unknown),
});
export type CompositionEventEnvelope = typeof CompositionEventEnvelope.Type;

const CompositionRuntimeDriverKind = Schema.Literals(["acp", "cli", "ide", "multica"]);
export type CompositionRuntimeDriverKind = typeof CompositionRuntimeDriverKind.Type;

const CompositionRuntimeProbeStatus = Schema.Literals(["online", "offline", "unstable"]);
export type CompositionRuntimeProbeStatus = typeof CompositionRuntimeProbeStatus.Type;

/** AgentDriver/RuntimeAdapter 的真实探测结果，不代表已获得 Task 授权。 */
export const CompositionRuntimeProbeResult = Schema.Struct({
  runtimeId: TrimmedNonEmptyString,
  driverKind: CompositionRuntimeDriverKind,
  status: CompositionRuntimeProbeStatus,
  version: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.Array(TrimmedNonEmptyString),
  supportedModels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  supportsResume: Schema.Boolean,
  supportsMcp: Schema.Boolean,
  reasonCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionRuntimeProbeResult = typeof CompositionRuntimeProbeResult.Type;

const CompositionIdeProfile = Schema.Literals([
  "cursor_ide",
  "vscode_ide",
  "browser_mcp",
  "unknown",
]);
export type CompositionIdeProfile = typeof CompositionIdeProfile.Type;

const CompositionIdeResolveStatus = Schema.Literals(["ready", "incomplete", "unavailable"]);
export type CompositionIdeResolveStatus = typeof CompositionIdeResolveStatus.Type;

/** IDEAdapter 的会话解析结果；unknown 不允许降级执行任何 IDE 操作。 */
export const CompositionIdeResolveResult = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  profile: CompositionIdeProfile,
  verifiedOperations: Schema.Array(TrimmedNonEmptyString),
  status: CompositionIdeResolveStatus,
  reasonCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionIdeResolveResult = typeof CompositionIdeResolveResult.Type;

const CompositionMulticaProbeStatus = Schema.Literals(["online", "offline", "unstable"]);
export type CompositionMulticaProbeStatus = typeof CompositionMulticaProbeStatus.Type;

/** Multica daemon 适配器的能力探测结果，T3 仍然保留事实源。 */
export const CompositionMulticaProbeResult = Schema.Struct({
  runtimeId: TrimmedNonEmptyString,
  status: CompositionMulticaProbeStatus,
  version: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.Array(TrimmedNonEmptyString),
  supportsSquad: Schema.Boolean,
  supportsLeader: Schema.Boolean,
  supportsTaskGraph: Schema.Boolean,
  reasonCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionMulticaProbeResult = typeof CompositionMulticaProbeResult.Type;
