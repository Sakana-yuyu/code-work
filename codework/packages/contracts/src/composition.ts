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

export const CompositionAgentTool = Schema.Struct({
  canonicalToolName: TrimmedNonEmptyString,
  description: Schema.String,
  parameters: Schema.Unknown,
});
export type CompositionAgentTool = typeof CompositionAgentTool.Type;

export const COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES = 3;
export const COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES = 65;
export const COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS = 160;
export const COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS = 120_000;

/** 显式启动 BYOK Agent Loop 的 RPC 输入，不改变旧文本会话语义。 */
export const CompositionAgentLoopRunRequest = Schema.Struct({
  mode: Schema.Literal("agent_loop"),
  providerInstanceId: TrimmedNonEmptyString,
  modelId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  prompt: Schema.String,
  capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
  tools: Schema.Array(CompositionAgentTool),
  maxRounds: Schema.optional(PositiveInt),
  maxContextMessages: Schema.optional(
    PositiveInt.check(
      Schema.isGreaterThanOrEqualTo(COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES),
      Schema.isLessThanOrEqualTo(COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES),
    ),
  ),
  maxToolResultChars: Schema.optional(
    PositiveInt.check(
      Schema.isGreaterThanOrEqualTo(COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS),
      Schema.isLessThanOrEqualTo(COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS),
    ),
  ),
});
export type CompositionAgentLoopRunRequest = typeof CompositionAgentLoopRunRequest.Type;

export const CompositionAgentLoopRunResult = Schema.Struct({
  text: Schema.String,
  rounds: PositiveInt,
});
export type CompositionAgentLoopRunResult = typeof CompositionAgentLoopRunResult.Type;

export class CompositionAgentLoopRunError extends Schema.TaggedErrorClass<CompositionAgentLoopRunError>()(
  "CompositionAgentLoopRunError",
  {
    code: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Agent Loop 执行失败：${this.code}: ${this.detail}`;
  }
}

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

const CompositionCapabilityOperation = Schema.Literals(["read", "execute", "mutate"]);
export type CompositionCapabilityOperation = typeof CompositionCapabilityOperation.Type;

/** 绑定到单个 task/agent 的短期能力授权，不等同于一次审批。 */
export const CompositionCapabilityGrant = Schema.Struct({
  grantId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  capabilityId: TrimmedNonEmptyString,
  issuedAtUnixMs: NonNegativeInt,
  expiresAtUnixMs: NonNegativeInt,
  revokedAtUnixMs: Schema.optional(NonNegativeInt),
});
export type CompositionCapabilityGrant = typeof CompositionCapabilityGrant.Type;

const CompositionCapabilityAuditOutcome = Schema.Literals([
  "allowed",
  "approval_required",
  "denied",
  "expired",
  "revoked",
  "cancelled",
  "failed",
]);
export type CompositionCapabilityAuditOutcome = typeof CompositionCapabilityAuditOutcome.Type;

/** 工具调用审计只保留身份、决策和结果，不保存 arguments 或秘密。 */
export const CompositionCapabilityAuditEvent = Schema.Struct({
  auditId: TrimmedNonEmptyString,
  grantId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  capabilityId: TrimmedNonEmptyString,
  operation: CompositionCapabilityOperation,
  outcome: CompositionCapabilityAuditOutcome,
  errorCode: Schema.optional(TrimmedNonEmptyString),
  occurredAtUnixMs: NonNegativeInt,
});
export type CompositionCapabilityAuditEvent = typeof CompositionCapabilityAuditEvent.Type;

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
  "resuming",
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
  /** Provider Runtime event id，用于重连或重复投递去重。 */
  sourceEventId: Schema.optional(TrimmedNonEmptyString),
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
  /** BYOK 等本地 Runtime 已确认持久化的原始输出增量，允许仅包含空白。 */
  outputDelta: Schema.optional(Schema.String),
  /** 该输出 checkpoint 结束位置的 UTF-8 累计字节偏移。 */
  outputOffsetBytes: Schema.optional(NonNegativeInt),
  /** 该输出增量的内容摘要，用于校验确定性 checkpoint 身份。 */
  outputDigest: Schema.optional(TrimmedNonEmptyString),
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

/** 外部 Runtime/IDE 通过 Code Work 请求 canonical tool 的输入，不携带 workspaceRoot。 */
export const CompositionRuntimeToolInvocation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  capabilityHandshakeId: Schema.optional(TrimmedNonEmptyString),
  toolCallId: TrimmedNonEmptyString,
  canonicalToolName: TrimmedNonEmptyString,
  arguments: Schema.Unknown,
  idempotencyKey: TrimmedNonEmptyString,
  capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
  approvalRequestId: Schema.optional(ApprovalRequestId),
});
export type CompositionRuntimeToolInvocation = typeof CompositionRuntimeToolInvocation.Type;

/** 外部 Runtime/IDE 取消一次尚未完成的 canonical tool 调用。 */
export const CompositionRuntimeToolCancellation = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  capabilityHandshakeId: Schema.optional(TrimmedNonEmptyString),
  toolCallId: TrimmedNonEmptyString,
  canonicalToolName: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionRuntimeToolCancellation = typeof CompositionRuntimeToolCancellation.Type;

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
  /** Runtime 接受本次 Run capability grant 后返回的握手 ID。 */
  capabilityHandshakeId: Schema.optional(TrimmedNonEmptyString),
  status: CompositionTaskStatus,
  attempt: NonNegativeInt,
  /** 本次 Run 已由服务端签发的短期 capability grant；不保存用户原始请求。 */
  capabilityGrantIds: Schema.Array(TrimmedNonEmptyString),
  leaseId: Schema.optional(TrimmedNonEmptyString),
  startedAtUnixMs: Schema.optional(NonNegativeInt),
  /** 最近一次被 Composition Runtime Projector 接受的 Runtime 事件时间。 */
  lastRuntimeEventAtUnixMs: Schema.optional(NonNegativeInt),
  /** Driver 接受取消请求的时间；不是最终取消确认。 */
  cancelRequestedAtUnixMs: Schema.optional(NonNegativeInt),
  finishedAtUnixMs: Schema.optional(NonNegativeInt),
  failureCode: Schema.optional(TrimmedNonEmptyString),
  resultSummary: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionTaskRun = typeof CompositionTaskRun.Type;

/** Task RPC 失败的稳定传输形状；服务端内部错误不会直接泄漏到客户端。 */
export class CompositionTaskRpcError extends Schema.TaggedErrorClass<CompositionTaskRpcError>()(
  "CompositionTaskRpcError",
  {
    code: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Composition Task 请求失败：${this.code}: ${this.detail}`;
  }
}

/** 派发请求中的完整 prompt 只在本次调用中使用，不写入 CompositionTask。 */
export const CompositionTaskDispatchRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  parentTaskId: Schema.optional(TrimmedNonEmptyString),
  assigneeKind: Schema.Literals(["agent", "squad"]),
  assigneeId: TrimmedNonEmptyString,
  mode: Schema.Literals(["serial", "parallel", "review"]),
  promptDigest: TrimmedNonEmptyString,
  prompt: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceRootDigest: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  /** 用户请求的 capability ID；服务端派发时会转换成 task-scoped grant。 */
  capabilityIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  dependsOnTaskIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionTaskDispatchRequest = typeof CompositionTaskDispatchRequest.Type;

export const CompositionTaskDispatchResult = Schema.Struct({
  task: CompositionTask,
  run: CompositionTaskRun,
});
export type CompositionTaskDispatchResult = typeof CompositionTaskDispatchResult.Type;

/** Task Graph 子节点输入；依赖使用 Graph 内的 nodeId 表达，由服务端映射为 taskId。 */
export const CompositionTaskGraphNodeRequest = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  assigneeKind: Schema.Literals(["agent", "squad"]),
  assigneeId: TrimmedNonEmptyString,
  mode: Schema.Literals(["serial", "parallel"]),
  promptDigest: TrimmedNonEmptyString,
  prompt: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceRootDigest: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  capabilityIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  dependsOnNodeIds: Schema.Array(TrimmedNonEmptyString),
  maxAttempts: Schema.optional(PositiveInt),
});
export type CompositionTaskGraphNodeRequest = typeof CompositionTaskGraphNodeRequest.Type;

/** Task Graph Leader 输入；Leader 的执行模式由服务端固定为 review。 */
export const CompositionTaskGraphLeaderRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: Schema.optional(TrimmedNonEmptyString),
  assigneeKind: Schema.Literals(["agent", "squad"]),
  assigneeId: TrimmedNonEmptyString,
  promptDigest: TrimmedNonEmptyString,
  prompt: Schema.String,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceRootDigest: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  capabilityIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type CompositionTaskGraphLeaderRequest = typeof CompositionTaskGraphLeaderRequest.Type;

/** 从 Code Work Leader、Squad 和子 Agent 节点启动真实 Task Graph。 */
export const CompositionSquadFailurePolicy = Schema.Literals(["fail_fast", "continue_independent"]);
export type CompositionSquadFailurePolicy = typeof CompositionSquadFailurePolicy.Type;

export const CompositionSquadPartialSuccessPolicy = Schema.Literals(["reject", "require_review"]);
export type CompositionSquadPartialSuccessPolicy = typeof CompositionSquadPartialSuccessPolicy.Type;

export const CompositionTaskGraphExecutionRequest = Schema.Struct({
  leader: CompositionTaskGraphLeaderRequest,
  children: Schema.Array(CompositionTaskGraphNodeRequest),
  schedule: Schema.optional(Schema.Literals(["serial", "parallel"])),
  maxConcurrency: Schema.optional(PositiveInt),
  failurePolicy: Schema.optional(CompositionSquadFailurePolicy),
  partialSuccessPolicy: Schema.optional(CompositionSquadPartialSuccessPolicy),
});
export type CompositionTaskGraphExecutionRequest = typeof CompositionTaskGraphExecutionRequest.Type;

export const CompositionTaskGraphNodeResult = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  task: CompositionTask,
  run: CompositionTaskRun,
  attempts: PositiveInt,
  dispatches: Schema.Array(CompositionTaskDispatchResult),
});
export type CompositionTaskGraphNodeResult = typeof CompositionTaskGraphNodeResult.Type;

export const CompositionTaskGraphNodeFailure = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  kind: Schema.Literals(["failed", "skipped"]),
  failureCode: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
  task: Schema.optional(CompositionTask),
  run: Schema.optional(CompositionTaskRun),
});
export type CompositionTaskGraphNodeFailure = typeof CompositionTaskGraphNodeFailure.Type;

export const CompositionTaskGraphExecutionResult = Schema.Struct({
  leader: CompositionTaskDispatchResult,
  children: Schema.Array(CompositionTaskGraphNodeResult),
  failures: Schema.optional(Schema.Array(CompositionTaskGraphNodeFailure)),
});
export type CompositionTaskGraphExecutionResult = typeof CompositionTaskGraphExecutionResult.Type;

export const CompositionTaskCancelRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type CompositionTaskCancelRequest = typeof CompositionTaskCancelRequest.Type;

export const CompositionTaskCancelResult = Schema.Struct({
  task: CompositionTask,
  run: CompositionTaskRun,
  status: Schema.Literals(["cancelled", "cancel_requested", "already_terminal"]),
});
export type CompositionTaskCancelResult = typeof CompositionTaskCancelResult.Type;

/** 对仍保有外部 Runtime 身份的非终态 Run 请求恢复；不会创建新的 Run。 */
export const CompositionTaskResumeRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
});
export type CompositionTaskResumeRequest = typeof CompositionTaskResumeRequest.Type;

export const CompositionTaskResumeResult = Schema.Struct({
  task: CompositionTask,
  run: CompositionTaskRun,
  status: Schema.Literals(["accepted", "already_running", "already_terminal"]),
});
export type CompositionTaskResumeResult = typeof CompositionTaskResumeResult.Type;

export const CompositionTaskReviewRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  decision: Schema.Literals(["approve", "reject"]),
  reason: TrimmedNonEmptyString,
});
export type CompositionTaskReviewRequest = typeof CompositionTaskReviewRequest.Type;

export const CompositionTaskReviewResult = Schema.Struct({
  task: CompositionTask,
  run: CompositionTaskRun,
  status: Schema.Literals(["approved", "rejected"]),
});
export type CompositionTaskReviewResult = typeof CompositionTaskReviewResult.Type;

/** 失败或超时 Task 的显式重试请求；每次重试都必须使用新的 Run。 */
export const CompositionTaskRetryRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  previousRunId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  reason: TrimmedNonEmptyString,
  /** 本次重试重新申请的 capability，不继承旧 Run 的 grant。 */
  capabilityIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionTaskRetryRequest = typeof CompositionTaskRetryRequest.Type;

export const CompositionTaskRetryResult = Schema.Struct({
  task: CompositionTask,
  run: CompositionTaskRun,
});
export type CompositionTaskRetryResult = typeof CompositionTaskRetryResult.Type;

export const CompositionTaskEventsRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
});
export type CompositionTaskEventsRequest = typeof CompositionTaskEventsRequest.Type;

export const CompositionTaskEventsResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  events: Schema.Array(CompositionTaskEvent),
});
export type CompositionTaskEventsResult = typeof CompositionTaskEventsResult.Type;

/** 任务列表的可操作快照，携带当前最新 Run 以支持刷新后的控制操作。 */
export const CompositionTaskSnapshot = Schema.Struct({
  task: CompositionTask,
  latestRun: Schema.optional(CompositionTaskRun),
});
export type CompositionTaskSnapshot = typeof CompositionTaskSnapshot.Type;

export const CompositionTaskListRequest = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionTaskListRequest = typeof CompositionTaskListRequest.Type;

export const CompositionTaskListResult = Schema.Struct({
  tasks: Schema.Array(CompositionTaskSnapshot),
});
export type CompositionTaskListResult = typeof CompositionTaskListResult.Type;

/** 控制中心统一投影的请求：可选项目过滤与关注的 Squad 集合。 */
export const CompositionControlCenterRequest = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
  squadIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type CompositionControlCenterRequest = typeof CompositionControlCenterRequest.Type;

const CompositionControlCenterGoalLoopState = Schema.Literals([
  "not_started",
  "running",
  "converged",
  "supervisor_settled",
  "interrupted",
]);
export type CompositionControlCenterGoalLoopState =
  typeof CompositionControlCenterGoalLoopState.Type;

export const CompositionControlCenterGoalLoop = Schema.Struct({
  runId: TrimmedNonEmptyString,
  state: CompositionControlCenterGoalLoopState,
  completedRounds: NonNegativeInt,
  rejectedCompletions: NonNegativeInt,
  terminalStatuses: Schema.Array(Schema.String),
  settledBySupervisor: Schema.Boolean,
});
export type CompositionControlCenterGoalLoop = typeof CompositionControlCenterGoalLoop.Type;

/**
 * 最新 Run 的 BYOK 部分输出恢复态：控制中心"恢复并重派"入口的渲染门槛数据源。
 * Goal Loop 五态只扫 `goalloop:*` 前缀，识别不到 BYOK checkpoint 链，故单独投影。
 */
export const CompositionControlCenterByokResume = Schema.Struct({
  runId: TrimmedNonEmptyString,
  /** `byok:` 前缀的持久化 checkpoint 行数。 */
  checkpointCount: NonNegativeInt,
  /** 摘要链校验通过时的恢复字节数；不可恢复时为 0。 */
  recoveredUtf8Bytes: NonNegativeInt,
  /** 摘要链完整可恢复（`recoverPersistedCheckpointText` 成功）。 */
  recoverable: Schema.Boolean,
  /** 已存在 `byok-redispatch:<task>:<run>:settle` 结算行，重复触发会被服务端拒绝。 */
  redispatchSettled: Schema.Boolean,
  /** 校验失败时的稳定错误码（empty/digest_mismatch/offset_gap）。 */
  recoveryFailureCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionControlCenterByokResume = typeof CompositionControlCenterByokResume.Type;

/** 合成委派 Task 在 Composition 台账上的 projectId；控制中心据此跳过 Goal Loop 五态。 */
export const BYOK_DELEGATION_PROJECT_ID = "byok-delegation";

/** 服务端 BYOK 恢复重派结算给陈旧 Run 打的 failureCode。 */
export const BYOK_RESUME_INTERRUPTED_FAILURE_CODE = "byok_resume_interrupted";

/**
 * 最新 Run 的 BYOK 委派台账摘要。只含委派 ID/状态/轮次/错误码；
 * 委派 prompt 原文与输出正文不进投影。
 */
export const CompositionControlCenterByokDelegation = Schema.Struct({
  runId: TrimmedNonEmptyString,
  /** 调度器进程内 ID（delegation-N），跨重启会复用，只作展示。 */
  delegationId: TrimmedNonEmptyString,
  status: CompositionTaskStatus,
  attempt: NonNegativeInt,
  failureCode: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionControlCenterByokDelegation =
  typeof CompositionControlCenterByokDelegation.Type;

export const CompositionControlCenterHumanActionKind = Schema.Literals([
  "approval",
  "input",
  "review",
]);
export type CompositionControlCenterHumanActionKind =
  typeof CompositionControlCenterHumanActionKind.Type;

/** 由最新 Run 的持久化状态事件派生出的人工待办摘要，不包含 prompt 或输出正文。 */
export const CompositionControlCenterHumanAction = Schema.Struct({
  runId: TrimmedNonEmptyString,
  kind: CompositionControlCenterHumanActionKind,
  summary: TrimmedNonEmptyString,
  sequence: NonNegativeInt,
  blockerCode: Schema.optional(TrimmedNonEmptyString),
  approvalRequestId: Schema.optional(ApprovalRequestId),
});
export type CompositionControlCenterHumanAction = typeof CompositionControlCenterHumanAction.Type;

export const CompositionControlCenterTask = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  status: CompositionTaskStatus,
  agentId: TrimmedNonEmptyString,
  updatedAtUnixMs: NonNegativeInt,
  dependsOnTaskIds: Schema.Array(TrimmedNonEmptyString),
  latestRun: Schema.optional(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      status: CompositionTaskStatus,
      attempt: NonNegativeInt,
      runtimeTaskId: Schema.optional(TrimmedNonEmptyString),
      failureCode: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  goalLoop: Schema.optional(CompositionControlCenterGoalLoop),
  byokResume: Schema.optional(CompositionControlCenterByokResume),
  byokDelegation: Schema.optional(CompositionControlCenterByokDelegation),
  humanAction: Schema.optional(CompositionControlCenterHumanAction),
  grants: Schema.optional(
    Schema.Struct({
      taskId: TrimmedNonEmptyString,
      totalEvents: NonNegativeInt,
      revokedEvents: NonNegativeInt,
      lastOutcome: Schema.optional(CompositionCapabilityAuditOutcome),
      lastOccurredAtUnixMs: Schema.optional(NonNegativeInt),
    }),
  ),
});
export type CompositionControlCenterTask = typeof CompositionControlCenterTask.Type;

/**
 * 控制中心"恢复并重派"渲染门槛：存在最新 Run、排除已有结算行，然后接受
 * `byok_resume_interrupted` 或校验通过的可恢复 checkpoint 链。
 * 不可只凭 failureCode 开门——带该码且已结算的 Run 再触发只会 `already_settled`。
 */
export const isByokResumeRedispatchable = (task: CompositionControlCenterTask): boolean => {
  if (task.latestRun === undefined) return false;
  if (task.byokResume?.redispatchSettled === true) return false;
  return (
    task.latestRun.failureCode === BYOK_RESUME_INTERRUPTED_FAILURE_CODE ||
    task.byokResume?.recoverable === true
  );
};

/** 控制中心行是否为 BYOK 委派合成 Task（有委派摘要即视为委派行）。 */
export const isByokDelegationControlTask = (task: CompositionControlCenterTask): boolean =>
  task.byokDelegation !== undefined;

export const CompositionControlCenterSquad = Schema.Struct({
  squadId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  leaderAgentId: TrimmedNonEmptyString,
  memberAgentIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionControlCenterSquad = typeof CompositionControlCenterSquad.Type;

export const CompositionControlCenterResult = Schema.Struct({
  generatedAtUnixMs: NonNegativeInt,
  tasks: Schema.Array(CompositionControlCenterTask),
  squads: Schema.Array(CompositionControlCenterSquad),
});
export type CompositionControlCenterResult = typeof CompositionControlCenterResult.Type;

/** 控制中心"自动重派"操作：结算未收敛 Goal Loop 并经 retryTask 创建新 Run。 */
export const CompositionControlCenterRedispatchRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  newRunId: TrimmedNonEmptyString,
  capabilityIds: Schema.Array(TrimmedNonEmptyString),
  note: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionControlCenterRedispatchRequest =
  typeof CompositionControlCenterRedispatchRequest.Type;

export const CompositionControlCenterRedispatchResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  previousRunId: TrimmedNonEmptyString,
  newRunId: TrimmedNonEmptyString,
  interruptedRounds: NonNegativeInt,
});
export type CompositionControlCenterRedispatchResult =
  typeof CompositionControlCenterRedispatchResult.Type;

/**
 * 控制中心"恢复并重派"操作：校验 BYOK checkpoint 链可恢复后结算陈旧 Run，
 * 把恢复出的部分输出写回重派 prompt，再经 retryTask 创建新 Run 续跑。
 */
export const CompositionControlCenterByokResumeRedispatchRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  newRunId: TrimmedNonEmptyString,
  capabilityIds: Schema.Array(TrimmedNonEmptyString),
  note: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionControlCenterByokResumeRedispatchRequest =
  typeof CompositionControlCenterByokResumeRedispatchRequest.Type;

export const CompositionControlCenterByokResumeRedispatchResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  previousRunId: TrimmedNonEmptyString,
  newRunId: TrimmedNonEmptyString,
  /** 恢复的 checkpoint 段数。 */
  recoveredChunkCount: NonNegativeInt,
  /** 恢复的部分输出字节数；恢复正文本身不回传客户端。 */
  recoveredUtf8Bytes: NonNegativeInt,
});
export type CompositionControlCenterByokResumeRedispatchResult =
  typeof CompositionControlCenterByokResumeRedispatchResult.Type;

/** 控制中心"放弃结算"操作：结算未收敛 Goal Loop 并落放弃终态，不创建新 Run。 */
export const CompositionControlCenterAbandonRequest = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  note: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionControlCenterAbandonRequest =
  typeof CompositionControlCenterAbandonRequest.Type;

export const CompositionControlCenterAbandonResult = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  abandonedRounds: NonNegativeInt,
});
export type CompositionControlCenterAbandonResult =
  typeof CompositionControlCenterAbandonResult.Type;

/** Supplier 条目上与 Provider 实例关联的 Agent Driver 档案摘要。 */
export const CompositionSupplierRegistryProfileLink = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  runtimeId: TrimmedNonEmptyString,
  status: Schema.Literals(["available", "degraded", "unavailable"]),
  supportsResume: Schema.Boolean,
});
export type CompositionSupplierRegistryProfileLink =
  typeof CompositionSupplierRegistryProfileLink.Type;

/**
 * Supplier/Profile/Account 统一投影条目：一个 Provider 实例即一个 Supplier
 * 账号绑定（continuationKey 为账号延续身份），profile 为其派生的 Agent Driver。
 */
export const CompositionSupplierRegistryEntry = Schema.Struct({
  instanceId: TrimmedNonEmptyString,
  driverKind: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  continuationKey: TrimmedNonEmptyString,
  defaultModelId: Schema.optional(TrimmedNonEmptyString),
  profile: Schema.optional(CompositionSupplierRegistryProfileLink),
});
export type CompositionSupplierRegistryEntry = typeof CompositionSupplierRegistryEntry.Type;

/** Supplier/Profile/Account 统一只读投影：Supplier 条目 + 失去实例的孤儿档案。 */
export const CompositionSupplierRegistryResult = Schema.Struct({
  generatedAtUnixMs: NonNegativeInt,
  suppliers: Schema.Array(CompositionSupplierRegistryEntry),
  orphanProfileAgentIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionSupplierRegistryResult = typeof CompositionSupplierRegistryResult.Type;

/** Supplier/Profile 统一注册表只读投影请求。 */
export const CompositionSupplierRegistryRequest = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
});
export type CompositionSupplierRegistryRequest = typeof CompositionSupplierRegistryRequest.Type;

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

export const CompositionSquadMemberRole = Schema.Literals([
  "leader",
  "worker",
  "reviewer",
  "critic",
]);
export type CompositionSquadMemberRole = typeof CompositionSquadMemberRole.Type;

export const CompositionSquadCollaborationMode = Schema.Literals([
  "serial",
  "parallel",
  "dependency_graph",
  "review_critic",
  "leader_workers",
]);
export type CompositionSquadCollaborationMode = typeof CompositionSquadCollaborationMode.Type;

export const CompositionSquadApprovalStage = Schema.Literals([
  "before_dispatch",
  "before_mutating_tool",
  "before_finalize",
]);
export type CompositionSquadApprovalStage = typeof CompositionSquadApprovalStage.Type;

/** Squad 成员模板只保存默认请求；每次运行仍签发 task-scoped capability grant。 */
export const CompositionSquadMember = Schema.Struct({
  agentId: TrimmedNonEmptyString,
  role: CompositionSquadMemberRole,
  order: NonNegativeInt,
  required: Schema.Boolean,
  model: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  capabilityIds: Schema.Array(TrimmedNonEmptyString),
  maxConcurrentTasks: PositiveInt,
});
export type CompositionSquadMember = typeof CompositionSquadMember.Type;

/** 可版本化的 Squad 模板；可选丰富字段兼容已持久化的旧版 Squad。 */
const CompositionSquadFields = Schema.Struct({
  squadId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  leaderAgentId: TrimmedNonEmptyString,
  memberAgentIds: Schema.Array(TrimmedNonEmptyString),
  instructions: Schema.optional(TrimmedNonEmptyString),
  revision: Schema.optional(PositiveInt),
  collaborationMode: Schema.optional(CompositionSquadCollaborationMode),
  members: Schema.optional(Schema.Array(CompositionSquadMember)),
  maxConcurrency: Schema.optional(PositiveInt),
  maxRetries: Schema.optional(NonNegativeInt),
  failurePolicy: Schema.optional(CompositionSquadFailurePolicy),
  partialSuccessPolicy: Schema.optional(CompositionSquadPartialSuccessPolicy),
  approvalStages: Schema.optional(Schema.Array(CompositionSquadApprovalStage)),
  createdAtUnixMs: Schema.optional(NonNegativeInt),
  updatedAtUnixMs: Schema.optional(NonNegativeInt),
  archivedAtUnixMs: Schema.optional(NonNegativeInt),
});

type CompositionSquadUnchecked = typeof CompositionSquadFields.Type;

export type CompositionSquadValidationIssueCode =
  | "rich_configuration_incomplete"
  | "duplicate_member"
  | "duplicate_order"
  | "duplicate_capability"
  | "leader_mismatch"
  | "member_projection_mismatch"
  | "missing_required_role"
  | "concurrency_exceeded"
  | "duplicate_approval_stage"
  | "timestamp_order_invalid";

export type CompositionSquadValidationIssue = {
  readonly code: CompositionSquadValidationIssueCode;
  readonly path: string;
};

const hasDuplicates = <A>(values: ReadonlyArray<A>): boolean =>
  new Set(values).size !== values.length;

/** 后端保存与 Squad Builder 实时校验共用的跨字段规则。 */
export const validateCompositionSquadConfiguration = (
  input: CompositionSquadUnchecked,
): ReadonlyArray<CompositionSquadValidationIssue> => {
  const issues: CompositionSquadValidationIssue[] = [];
  const add = (code: CompositionSquadValidationIssueCode, path: string): void => {
    issues.push({ code, path });
  };
  const members = input.members;
  const richConfigurationEnabled =
    input.revision !== undefined ||
    input.collaborationMode !== undefined ||
    members !== undefined ||
    input.maxConcurrency !== undefined ||
    input.maxRetries !== undefined ||
    input.failurePolicy !== undefined ||
    input.partialSuccessPolicy !== undefined ||
    input.approvalStages !== undefined;

  if (richConfigurationEnabled) {
    if (
      input.revision === undefined ||
      input.collaborationMode === undefined ||
      members === undefined ||
      members.length === 0 ||
      input.maxConcurrency === undefined ||
      input.failurePolicy === undefined ||
      input.partialSuccessPolicy === undefined
    ) {
      add("rich_configuration_incomplete", "members");
    }
  }

  if (hasDuplicates(input.memberAgentIds)) add("duplicate_member", "memberAgentIds");

  if (members !== undefined) {
    const memberIds = members.map((member) => member.agentId);
    const memberOrders = members.map((member) => member.order);
    if (hasDuplicates(memberIds)) add("duplicate_member", "members.agentId");
    if (hasDuplicates(memberOrders)) add("duplicate_order", "members.order");
    for (const [index, member] of members.entries()) {
      if (hasDuplicates(member.capabilityIds)) {
        add("duplicate_capability", `members.${index}.capabilityIds`);
      }
    }

    const leaders = members.filter((member) => member.role === "leader");
    if (leaders.length !== 1 || leaders[0]?.agentId !== input.leaderAgentId) {
      add("leader_mismatch", "leaderAgentId");
    }

    const projectedMemberIds = new Set(input.memberAgentIds);
    const memberIdSet = new Set(memberIds);
    if (
      projectedMemberIds.size !== memberIdSet.size ||
      [...projectedMemberIds].some((agentId) => !memberIdSet.has(agentId))
    ) {
      add("member_projection_mismatch", "memberAgentIds");
    }

    if (
      input.collaborationMode === "review_critic" &&
      !members.some((member) => member.role === "reviewer" || member.role === "critic")
    ) {
      add("missing_required_role", "members.role");
    }
    if (
      input.collaborationMode === "leader_workers" &&
      !members.some((member) => member.role === "worker")
    ) {
      add("missing_required_role", "members.role");
    }

    const memberCapacity = members.reduce((total, member) => total + member.maxConcurrentTasks, 0);
    if (input.maxConcurrency !== undefined && input.maxConcurrency > memberCapacity) {
      add("concurrency_exceeded", "maxConcurrency");
    }
  }

  if (input.approvalStages !== undefined && hasDuplicates(input.approvalStages)) {
    add("duplicate_approval_stage", "approvalStages");
  }
  if (
    (input.createdAtUnixMs !== undefined &&
      input.updatedAtUnixMs !== undefined &&
      input.updatedAtUnixMs < input.createdAtUnixMs) ||
    (input.updatedAtUnixMs !== undefined &&
      input.archivedAtUnixMs !== undefined &&
      input.archivedAtUnixMs < input.updatedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "updatedAtUnixMs");
  }

  return issues;
};

export const CompositionSquad = CompositionSquadFields.check(
  Schema.makeFilter((input) => {
    const issue = validateCompositionSquadConfiguration(input)[0];
    return issue === undefined || `Invalid Squad configuration: ${issue.code} at ${issue.path}`;
  }),
);
export type CompositionSquad = typeof CompositionSquad.Type;

/** Squad 的不可变历史记录；旧版迁移记录可能没有完整配置快照。 */
export const CompositionSquadRevision = Schema.Struct({
  squadId: TrimmedNonEmptyString,
  revision: PositiveInt,
  configuration: Schema.NullOr(CompositionSquad),
  createdAtUnixMs: NonNegativeInt,
});
export type CompositionSquadRevision = typeof CompositionSquadRevision.Type;

const CompositionSquadWritableFields = {
  squadId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  leaderAgentId: TrimmedNonEmptyString,
  instructions: Schema.optional(TrimmedNonEmptyString),
  collaborationMode: CompositionSquadCollaborationMode,
  members: Schema.Array(CompositionSquadMember),
  maxConcurrency: PositiveInt,
  maxRetries: Schema.optional(NonNegativeInt),
  failurePolicy: CompositionSquadFailurePolicy,
  partialSuccessPolicy: CompositionSquadPartialSuccessPolicy,
  approvalStages: Schema.optional(Schema.Array(CompositionSquadApprovalStage)),
};

/** Squad Builder 只提交业务配置；revision、成员投影和时间戳由服务端维护。 */
export const CompositionSquadCreateRequest = Schema.Struct(CompositionSquadWritableFields);
export type CompositionSquadCreateRequest = typeof CompositionSquadCreateRequest.Type;

export const CompositionSquadUpdateRequest = Schema.Struct({
  ...CompositionSquadWritableFields,
  expectedRevision: PositiveInt,
});
export type CompositionSquadUpdateRequest = typeof CompositionSquadUpdateRequest.Type;

export const CompositionSquadDuplicateRequest = Schema.Struct({
  sourceSquadId: TrimmedNonEmptyString,
  squadId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
});
export type CompositionSquadDuplicateRequest = typeof CompositionSquadDuplicateRequest.Type;

export const CompositionSquadRevisionMutationRequest = Schema.Struct({
  squadId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
});
export type CompositionSquadRevisionMutationRequest =
  typeof CompositionSquadRevisionMutationRequest.Type;

export const CompositionSquadGetRequest = Schema.Struct({
  squadId: TrimmedNonEmptyString,
});
export type CompositionSquadGetRequest = typeof CompositionSquadGetRequest.Type;

export const CompositionSquadResult = Schema.Struct({
  squad: CompositionSquad,
});
export type CompositionSquadResult = typeof CompositionSquadResult.Type;

export const CompositionSquadListRequest = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
});
export type CompositionSquadListRequest = typeof CompositionSquadListRequest.Type;

export const CompositionSquadListResult = Schema.Struct({
  squads: Schema.Array(CompositionSquad),
});
export type CompositionSquadListResult = typeof CompositionSquadListResult.Type;

export const CompositionSquadRevisionListRequest = Schema.Struct({
  squadId: TrimmedNonEmptyString,
});
export type CompositionSquadRevisionListRequest = typeof CompositionSquadRevisionListRequest.Type;

export const CompositionSquadRevisionListResult = Schema.Struct({
  revisions: Schema.Array(CompositionSquadRevision),
});
export type CompositionSquadRevisionListResult = typeof CompositionSquadRevisionListResult.Type;

export const CompositionSquadPlanNode = Schema.Struct({
  nodeId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  dependsOnNodeIds: Schema.Array(TrimmedNonEmptyString),
});
export type CompositionSquadPlanNode = typeof CompositionSquadPlanNode.Type;

/** 运行请求固定绑定 Squad revision，防止编辑配置后静默改变已发起的执行。 */
export const CompositionSquadExecutionRequest = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  squadId: TrimmedNonEmptyString,
  squadRevision: PositiveInt,
  projectId: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
  goal: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceRootDigest: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(Schema.Array(CompositionSquadPlanNode)),
});
export type CompositionSquadExecutionRequest = typeof CompositionSquadExecutionRequest.Type;

export const CompositionSquadExecutionResult = Schema.Struct({
  executionId: TrimmedNonEmptyString,
  squadId: TrimmedNonEmptyString,
  squadRevision: PositiveInt,
  graph: CompositionTaskGraphExecutionResult,
});
export type CompositionSquadExecutionResult = typeof CompositionSquadExecutionResult.Type;

/** Squad 生命周期和执行错误的稳定传输形状，不向客户端泄漏内部异常。 */
export class CompositionSquadRpcError extends Schema.TaggedErrorClass<CompositionSquadRpcError>()(
  "CompositionSquadRpcError",
  {
    code: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    squadId: TrimmedNonEmptyString,
    nodeId: Schema.optional(TrimmedNonEmptyString),
    expectedRevision: Schema.optional(PositiveInt),
    actualRevision: Schema.optional(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Squad 操作失败：${this.code}: ${this.detail}`;
  }
}
