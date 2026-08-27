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
export const CompositionTaskGraphExecutionRequest = Schema.Struct({
  leader: CompositionTaskGraphLeaderRequest,
  children: Schema.Array(CompositionTaskGraphNodeRequest),
  schedule: Schema.optional(Schema.Literals(["serial", "parallel"])),
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

export const CompositionTaskGraphExecutionResult = Schema.Struct({
  leader: CompositionTaskDispatchResult,
  children: Schema.Array(CompositionTaskGraphNodeResult),
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
      failureCode: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  goalLoop: Schema.optional(CompositionControlCenterGoalLoop),
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
