import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const CompositionMode = Schema.Literals(["legacy_text", "agent_loop"]);
export type CompositionMode = typeof CompositionMode.Type;

const CompositionIdentity = Schema.Struct({
  providerInstanceId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  threadId: ThreadId,
});

export const CompositionLegacyTextRequest = Schema.Struct({
  ...CompositionIdentity.fields,
  mode: Schema.Literal("legacy_text"),
});
export type CompositionLegacyTextRequest = typeof CompositionLegacyTextRequest.Type;

export const CompositionAgentLoopRequest = Schema.Union([
  CompositionLegacyTextRequest,
  Schema.Struct({
    ...CompositionIdentity.fields,
    mode: Schema.Literal("agent_loop"),
    taskId: TrimmedNonEmptyString,
    agentId: TrimmedNonEmptyString,
    capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
  }),
]);
export type CompositionAgentLoopRequest = typeof CompositionAgentLoopRequest.Type;

const CompositionCapabilityKind = Schema.Literals(["model", "tool", "mcp", "ide", "runtime"]);
export type CompositionCapabilityKind = typeof CompositionCapabilityKind.Type;

const CompositionCapabilityStatus = Schema.Literals(["available", "degraded", "unavailable"]);
export type CompositionCapabilityStatus = typeof CompositionCapabilityStatus.Type;

const CompositionCapabilitySource = Schema.Literals(["t3", "runtime", "ide", "multica"]);
export type CompositionCapabilitySource = typeof CompositionCapabilitySource.Type;

export const CompositionCapabilityDescriptor = Schema.Struct({
  capabilityId: TrimmedNonEmptyString,
  kind: CompositionCapabilityKind,
  providerId: Schema.optional(TrimmedNonEmptyString),
  version: Schema.optional(TrimmedNonEmptyString),
  status: CompositionCapabilityStatus,
  grants: Schema.Struct({
    read: Schema.Boolean,
    execute: Schema.Boolean,
    mutate: Schema.Boolean,
  }),
  approval: Schema.Literals(["never", "on_first_use", "every_use"]),
  source: CompositionCapabilitySource,
});
export type CompositionCapabilityDescriptor = typeof CompositionCapabilityDescriptor.Type;

export const CompositionCapabilityPolicyDecision = Schema.Struct({
  decision: Schema.Literals(["allow", "approval_required", "deny"]),
  reasonCode: TrimmedNonEmptyString,
  approvalRequestId: Schema.optional(ApprovalRequestId),
  expiresAtUnixMs: Schema.optional(NonNegativeInt),
});
export type CompositionCapabilityPolicyDecision = typeof CompositionCapabilityPolicyDecision.Type;

export const CompositionTaskStatus = Schema.Literals([
  "queued",
  "dispatched",
  "running",
  "waiting_approval",
  "waiting_input",
  "blocked",
  "in_review",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
export type CompositionTaskStatus = typeof CompositionTaskStatus.Type;

export const CompositionTaskEventType = Schema.Literals([
  "progress",
  "blocker",
  "message",
  "review_requested",
  "tool",
  "status",
]);
export type CompositionTaskEventType = typeof CompositionTaskEventType.Type;

export const CompositionTaskEvent = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  parentTaskId: Schema.optional(TrimmedNonEmptyString),
  agentId: TrimmedNonEmptyString,
  runtimeId: Schema.optional(TrimmedNonEmptyString),
  status: CompositionTaskStatus,
  sequence: NonNegativeInt,
  eventType: CompositionTaskEventType,
  summary: TrimmedNonEmptyString,
  progress: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(100))),
  blockerCode: Schema.optional(TrimmedNonEmptyString),
  approvalRequestId: Schema.optional(ApprovalRequestId),
  childTaskIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type CompositionTaskEvent = typeof CompositionTaskEvent.Type;

export const CompositionToolInvocation = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  toolCallId: TrimmedNonEmptyString,
  canonicalToolName: TrimmedNonEmptyString,
  arguments: Schema.Unknown,
  approvalRequestId: Schema.optional(ApprovalRequestId),
  idempotencyKey: TrimmedNonEmptyString,
});
export type CompositionToolInvocation = typeof CompositionToolInvocation.Type;

export const CompositionToolResult = Schema.Struct({
  invocationId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  toolCallId: TrimmedNonEmptyString,
  canonicalToolName: TrimmedNonEmptyString,
  status: Schema.Literals(["succeeded", "failed", "denied", "cancelled"]),
  result: Schema.optional(Schema.Unknown),
  errorCode: Schema.optional(TrimmedNonEmptyString),
  startedAtUnixMs: Schema.optional(NonNegativeInt),
  finishedAtUnixMs: Schema.optional(NonNegativeInt),
});
export type CompositionToolResult = typeof CompositionToolResult.Type;

export const CompositionCapabilityDescriptorList = Schema.Array(CompositionCapabilityDescriptor);
export type CompositionCapabilityDescriptorList = typeof CompositionCapabilityDescriptorList.Type;

const CompositionTaskAssigneeKind = Schema.Literals(["agent", "squad"]);
export type CompositionTaskAssigneeKind = typeof CompositionTaskAssigneeKind.Type;

const CompositionTaskDispatchMode = Schema.Literals(["serial", "parallel", "review"]);
export type CompositionTaskDispatchMode = typeof CompositionTaskDispatchMode.Type;

/** 可恢复的 Composition Task 投影，不保存完整 prompt。 */
export const CompositionTask = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  parentTaskId: Schema.optional(TrimmedNonEmptyString),
  assigneeKind: CompositionTaskAssigneeKind,
  assigneeId: TrimmedNonEmptyString,
  mode: CompositionTaskDispatchMode,
  status: CompositionTaskStatus,
  promptDigest: TrimmedNonEmptyString,
  dependsOnTaskIds: Schema.Array(TrimmedNonEmptyString),
  createdAtUnixMs: NonNegativeInt,
  updatedAtUnixMs: NonNegativeInt,
  finishedAtUnixMs: Schema.optional(NonNegativeInt),
});
export type CompositionTask = typeof CompositionTask.Type;

/** 一次实际执行；重试必须创建新的 runId 和 attempt。 */
export const CompositionTaskRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  runtimeId: TrimmedNonEmptyString,
  runtimeTaskId: Schema.optional(TrimmedNonEmptyString),
  status: CompositionTaskStatus,
  attempt: NonNegativeInt,
  leaseId: Schema.optional(TrimmedNonEmptyString),
  startedAtUnixMs: Schema.optional(NonNegativeInt),
  finishedAtUnixMs: Schema.optional(NonNegativeInt),
  failureCode: Schema.optional(TrimmedNonEmptyString),
  resultSummary: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionTaskRun = typeof CompositionTaskRun.Type;

const CompositionTaskDependencyCondition = Schema.Literals([
  "success",
  "terminal",
  "review_approved",
]);
export type CompositionTaskDependencyCondition = typeof CompositionTaskDependencyCondition.Type;

export const CompositionTaskDependency = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  dependsOnTaskId: TrimmedNonEmptyString,
  condition: CompositionTaskDependencyCondition,
  createdAtUnixMs: NonNegativeInt,
});
export type CompositionTaskDependency = typeof CompositionTaskDependency.Type;

const CompositionRuntimeLeaseState = Schema.Literals(["active", "expired", "released"]);
export type CompositionRuntimeLeaseState = typeof CompositionRuntimeLeaseState.Type;

export const CompositionRuntimeLease = Schema.Struct({
  leaseId: TrimmedNonEmptyString,
  runtimeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  workspaceRootDigest: TrimmedNonEmptyString,
  heartbeatAtUnixMs: NonNegativeInt,
  expiresAtUnixMs: NonNegativeInt,
  state: CompositionRuntimeLeaseState,
});
export type CompositionRuntimeLease = typeof CompositionRuntimeLease.Type;

export const CompositionSquad = Schema.Struct({
  squadId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  leaderAgentId: TrimmedNonEmptyString,
  memberAgentIds: Schema.Array(TrimmedNonEmptyString),
  instructions: Schema.optional(TrimmedNonEmptyString),
  archivedAtUnixMs: Schema.optional(NonNegativeInt),
});
export type CompositionSquad = typeof CompositionSquad.Type;
