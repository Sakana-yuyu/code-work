import * as Effect from "effect/Effect";
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

const CompositionRuntimeCapabilityHandshakeStatus = Schema.Literals([
  "accepted",
  "rejected",
  "unsupported",
]);
export type CompositionRuntimeCapabilityHandshakeStatus =
  typeof CompositionRuntimeCapabilityHandshakeStatus.Type;

/** Runtime 在接收 task-scoped grant 前必须确认的授权握手请求。 */
export const CompositionRuntimeCapabilityHandshakeRequest = Schema.Struct({
  runtimeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionRuntimeCapabilityHandshakeRequest =
  typeof CompositionRuntimeCapabilityHandshakeRequest.Type;

/** 外部 Runtime 对 grant 的可验证接收结果；accepted 必须带 handshakeId。 */
export const CompositionRuntimeCapabilityHandshakeResult = Schema.Struct({
  runtimeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  status: CompositionRuntimeCapabilityHandshakeStatus,
  handshakeId: Schema.optional(TrimmedNonEmptyString),
  acceptedGrantIds: Schema.Array(TrimmedNonEmptyString),
  expiresAtUnixMs: Schema.optional(NonNegativeInt),
  reasonCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionRuntimeCapabilityHandshakeResult =
  typeof CompositionRuntimeCapabilityHandshakeResult.Type;

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

/** Multica HTTP Header 与 T3 provider environment secret 的绑定。 */
export const CompositionMulticaHeaderBinding = Schema.Struct({
  headerName: TrimmedNonEmptyString,
  environmentVariable: TrimmedNonEmptyString,
});
export type CompositionMulticaHeaderBinding = typeof CompositionMulticaHeaderBinding.Type;

/** T3 assignee 到 Multica Agent/Squad UUID 的显式映射。 */
export const CompositionMulticaAssigneeRoute = Schema.Struct({
  t3AgentId: TrimmedNonEmptyString,
  workspaceId: TrimmedNonEmptyString,
  multicaAgentId: Schema.optional(TrimmedNonEmptyString),
  multicaSquadId: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionMulticaAssigneeRoute = typeof CompositionMulticaAssigneeRoute.Type;

/**
 * ServerSettings.providerInstances[instanceId].config 中的 Multica 配置。
 * Header 值只允许来自 provider environment，避免把 token 写入 settings.json。
 */
export const CompositionMulticaRuntimeConfig = Schema.Struct({
  schemaVersion: Schema.Literal(1).pipe(Schema.withDecodingDefault(Effect.succeed(1 as const))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  runtimeId: TrimmedNonEmptyString,
  daemonId: TrimmedNonEmptyString,
  daemonRuntimeId: TrimmedNonEmptyString,
  baseUrl: TrimmedNonEmptyString,
  headers: Schema.Array(CompositionMulticaHeaderBinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  assigneeRoutes: Schema.Array(CompositionMulticaAssigneeRoute).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  version: Schema.optional(TrimmedNonEmptyString),
  capabilities: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  supportsResume: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  supportsMcp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  supportsSquad: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  supportsLeader: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  supportsTaskGraph: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type CompositionMulticaRuntimeConfig = typeof CompositionMulticaRuntimeConfig.Type;

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
