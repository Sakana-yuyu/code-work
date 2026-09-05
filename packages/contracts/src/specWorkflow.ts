import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { CompositionTask, CompositionTaskRun } from "./composition.ts";

export const SpecWorkflowMode = Schema.Literals(["full", "fix", "loop"]);
export type SpecWorkflowMode = typeof SpecWorkflowMode.Type;

export const SpecWorkflowStage = Schema.Literals([
  "idle",
  "research",
  "ask",
  "design",
  "propose",
  "awaitingApproval",
  "revise",
  "apply",
  "verify",
  "acceptance",
  "archive",
]);
export type SpecWorkflowStage = typeof SpecWorkflowStage.Type;

export const SpecWorkflowStatus = Schema.Literals(["active", "paused", "blocked", "completed"]);
export type SpecWorkflowStatus = typeof SpecWorkflowStatus.Type;

export const SpecWorkflowProposalStatus = Schema.Literals(["pending", "approved", "rejected"]);
export type SpecWorkflowProposalStatus = typeof SpecWorkflowProposalStatus.Type;

export const SpecWorkflowVerificationStatus = Schema.Literals(["pending", "passed", "failed"]);
export type SpecWorkflowVerificationStatus = typeof SpecWorkflowVerificationStatus.Type;

export const SpecWorkflowAcceptanceStatus = Schema.Literals(["pending", "passed"]);
export type SpecWorkflowAcceptanceStatus = typeof SpecWorkflowAcceptanceStatus.Type;

/** Spec Workflow 自主循环的有限预算；没有 maxAttempts 就不得启动循环。 */
export const SpecWorkflowLoopConfig = Schema.Struct({
  maxAttempts: PositiveInt,
  maxCostUnits: Schema.optional(PositiveInt),
  stalePivotRounds: Schema.optional(PositiveInt),
  deadlineDurationMs: Schema.optional(PositiveInt),
  reviewerAgentId: Schema.optional(TrimmedNonEmptyString),
});
export type SpecWorkflowLoopConfig = typeof SpecWorkflowLoopConfig.Type;

export const SpecWorkflowState = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  changeName: TrimmedNonEmptyString,
  mode: SpecWorkflowMode,
  stage: SpecWorkflowStage,
  status: SpecWorkflowStatus,
  revision: NonNegativeInt,
  tbdCount: NonNegativeInt,
  proposalStatus: SpecWorkflowProposalStatus,
  implementationCompleted: Schema.Boolean,
  verificationStatus: SpecWorkflowVerificationStatus,
  acceptanceStatus: SpecWorkflowAcceptanceStatus,
  activeTaskId: Schema.NullOr(TrimmedNonEmptyString),
  /** 自主循环运行期间保留预算；终态回写后由 Server 清空。 */
  loopConfig: Schema.optional(Schema.NullOr(SpecWorkflowLoopConfig)),
  lastError: Schema.NullOr(TrimmedString),
  updatedAt: NonNegativeInt,
});
export type SpecWorkflowState = typeof SpecWorkflowState.Type;

export const SpecWorkflowStartInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  changeName: TrimmedNonEmptyString,
  mode: SpecWorkflowMode,
  updatedAt: NonNegativeInt,
});
export type SpecWorkflowStartInput = typeof SpecWorkflowStartInput.Type;

export const SpecWorkflowTransitionAction = Schema.Literals([
  "advance",
  "complete-node",
  "set-tbd-count",
  "approve-proposal",
  "reject-proposal",
  "mark-implementation-complete",
  "record-verification",
  "record-task-result",
  "complete-acceptance",
  "pause",
  "resume",
]);
export type SpecWorkflowTransitionAction = typeof SpecWorkflowTransitionAction.Type;

export const SpecWorkflowIntentName = Schema.Literals([
  "workflow",
  "research",
  "ask",
  "chat",
  "design",
  "propose",
  "revise",
  "apply",
  "verify",
  "acceptance",
  "archive",
  "status",
  "stash",
  "resume",
  "fix",
  "ship",
  "loop",
]);
export type SpecWorkflowIntentName = typeof SpecWorkflowIntentName.Type;

/** 可以独立重做的文档节点；完成方案后必须重新由用户批准。 */
export const SpecWorkflowDocumentNode = Schema.Literals([
  "research",
  "ask",
  "design",
  "propose",
  "revise",
]);

export const SpecWorkflowRouteAction = Schema.Literals([
  "pass-through",
  "start",
  "advance",
  "show-status",
  "pause",
  "resume",
]);
export type SpecWorkflowRouteAction = typeof SpecWorkflowRouteAction.Type;

export const SpecWorkflowRouteReason = Schema.Literals([
  "not-enabled",
  "workflow-not-started",
  "node-not-selected",
  "requested-stage-allowed",
  "already-at-target",
  "tbd-remaining",
  "proposal-not-approved",
  "implementation-incomplete",
  "verification-failed",
  "invalid-current-stage",
  "paused",
  "not-paused",
  "acceptance-required",
  "loop-budget-required",
  "fix-batch-verification-required",
]);
export type SpecWorkflowRouteReason = typeof SpecWorkflowRouteReason.Type;

export const SpecWorkflowRoute = Schema.Struct({
  requestedIntent: SpecWorkflowIntentName,
  action: SpecWorkflowRouteAction,
  targetStage: Schema.NullOr(SpecWorkflowStage),
  corrected: Schema.Boolean,
  reason: SpecWorkflowRouteReason,
});
export type SpecWorkflowRoute = typeof SpecWorkflowRoute.Type;

const SpecWorkflowExpectedRevision = {
  expectedRevision: NonNegativeInt,
};

export const SpecWorkflowAdvanceInput = Schema.Struct({
  type: Schema.Literal("advance"),
  to: SpecWorkflowStage,
  activeTaskId: Schema.optional(TrimmedNonEmptyString),
  loopConfig: Schema.optional(SpecWorkflowLoopConfig),
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowSetTbdCountInput = Schema.Struct({
  type: Schema.Literal("set-tbd-count"),
  tbdCount: NonNegativeInt,
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowProposalDecisionInput = Schema.Struct({
  type: Schema.Literals(["approve-proposal", "reject-proposal"]),
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowImplementationInput = Schema.Struct({
  type: Schema.Literal("mark-implementation-complete"),
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowVerificationInput = Schema.Struct({
  type: Schema.Literal("record-verification"),
  passed: Schema.Boolean,
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowAcceptanceInput = Schema.Struct({
  type: Schema.Literal("complete-acceptance"),
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowTaskResultInput = Schema.Struct({
  type: Schema.Literal("record-task-result"),
  taskId: TrimmedNonEmptyString,
  status: Schema.Literals(["completed", "failed", "cancelled", "timed_out"]),
  error: Schema.optional(TrimmedString),
  ...SpecWorkflowExpectedRevision,
});
export const SpecWorkflowPauseResumeInput = Schema.Struct({
  type: Schema.Literals(["pause", "resume"]),
  ...SpecWorkflowExpectedRevision,
});

export const SpecWorkflowCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("complete-node"),
    node: SpecWorkflowDocumentNode,
    ...SpecWorkflowExpectedRevision,
  }),
  SpecWorkflowAdvanceInput,
  SpecWorkflowSetTbdCountInput,
  SpecWorkflowProposalDecisionInput,
  SpecWorkflowImplementationInput,
  SpecWorkflowVerificationInput,
  SpecWorkflowAcceptanceInput,
  SpecWorkflowTaskResultInput,
  SpecWorkflowPauseResumeInput,
]);
export type SpecWorkflowCommand = typeof SpecWorkflowCommand.Type;

export const SpecWorkflowStartedEvent = Schema.Struct({
  type: Schema.Literal("started"),
  state: SpecWorkflowState,
});
export const SpecWorkflowStateChangedEvent = Schema.Struct({
  type: Schema.Literal("state-changed"),
  action: SpecWorkflowTransitionAction,
  state: SpecWorkflowState,
});
export const SpecWorkflowStateEvent = Schema.Union([
  SpecWorkflowStartedEvent,
  SpecWorkflowStateChangedEvent,
]);
export type SpecWorkflowStateEvent = typeof SpecWorkflowStateEvent.Type;

/** 由 Server workflow service 接收的阶段意图；具体能否推进仍由 Router/Decider 判断。 */
export const SpecWorkflowDispatchInput = Schema.Struct({
  workflowId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  changeName: TrimmedNonEmptyString,
  mode: SpecWorkflowMode,
  intent: SpecWorkflowIntentName,
  workspaceRoot: TrimmedNonEmptyString,
  assigneeId: TrimmedNonEmptyString,
  prompt: Schema.String,
  promptDigest: TrimmedNonEmptyString,
  model: Schema.optional(TrimmedNonEmptyString),
  capabilityIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  loopConfig: Schema.optional(SpecWorkflowLoopConfig),
  implementationAssigneeId: Schema.optional(TrimmedNonEmptyString),
  independentVerifierId: Schema.optional(TrimmedNonEmptyString),
});
export type SpecWorkflowDispatchInput = typeof SpecWorkflowDispatchInput.Type;

export const SpecWorkflowDispatchResult = Schema.Struct({
  route: SpecWorkflowRoute,
  state: SpecWorkflowState,
  stateEvent: Schema.NullOr(SpecWorkflowStateEvent),
  task: Schema.NullOr(
    Schema.Struct({
      task: CompositionTask,
      run: CompositionTaskRun,
    }),
  ),
});
export type SpecWorkflowDispatchResult = typeof SpecWorkflowDispatchResult.Type;

export const SpecWorkflowStateGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type SpecWorkflowStateGetInput = typeof SpecWorkflowStateGetInput.Type;

export const SpecWorkflowControlInput = Schema.Struct({
  threadId: ThreadId,
  expectedRevision: NonNegativeInt,
});
export type SpecWorkflowControlInput = typeof SpecWorkflowControlInput.Type;

export const SpecWorkflowProposalReviewDecision = Schema.Literals(["approve", "reject"]);
export type SpecWorkflowProposalReviewDecision = typeof SpecWorkflowProposalReviewDecision.Type;

export const SpecWorkflowProposalReviewInput = Schema.Struct({
  threadId: ThreadId,
  decision: SpecWorkflowProposalReviewDecision,
  expectedRevision: NonNegativeInt,
});
export type SpecWorkflowProposalReviewInput = typeof SpecWorkflowProposalReviewInput.Type;

export const SpecWorkflowArtifactName = Schema.Literals([
  "fix.md",
  "research.md",
  "design.md",
  "proposal.md",
  "tasks.md",
  "verify.md",
  "retrospect.md",
]);
export type SpecWorkflowArtifactName = typeof SpecWorkflowArtifactName.Type;

export const SpecWorkflowArtifactReadInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  changeName: TrimmedNonEmptyString,
  artifact: SpecWorkflowArtifactName,
});
export type SpecWorkflowArtifactReadInput = typeof SpecWorkflowArtifactReadInput.Type;

export const SpecWorkflowArtifactWriteInput = Schema.Struct({
  ...SpecWorkflowArtifactReadInput.fields,
  contents: Schema.String,
});
export type SpecWorkflowArtifactWriteInput = typeof SpecWorkflowArtifactWriteInput.Type;

export const SpecWorkflowArtifact = Schema.Struct({
  changeName: TrimmedNonEmptyString,
  artifact: SpecWorkflowArtifactName,
  contents: Schema.String,
});
export type SpecWorkflowArtifact = typeof SpecWorkflowArtifact.Type;

export const SpecWorkflowArtifactListInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  changeName: TrimmedNonEmptyString,
});
export type SpecWorkflowArtifactListInput = typeof SpecWorkflowArtifactListInput.Type;

/** 线程级 Spec Workflow 能力开关。未创建记录时由服务端返回 disabled 默认值。 */
export const SpecWorkflowCapability = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
  /** 缺省兼容旧客户端的完整流程；单节点选择只授权这一部分。 */
  selectedIntent: Schema.optionalKey(SpecWorkflowIntentName),
  revision: NonNegativeInt,
  updatedAt: NonNegativeInt,
});
export type SpecWorkflowCapability = typeof SpecWorkflowCapability.Type;

export const SpecWorkflowGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type SpecWorkflowGetInput = typeof SpecWorkflowGetInput.Type;

export const SpecWorkflowSetInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
  selectedIntent: Schema.optionalKey(SpecWorkflowIntentName),
  expectedRevision: Schema.optionalKey(NonNegativeInt),
});
export type SpecWorkflowSetInput = typeof SpecWorkflowSetInput.Type;

export const SpecWorkflowUpdatedEvent = Schema.Struct({
  type: Schema.Literal("updated"),
  capability: SpecWorkflowCapability,
});
export type SpecWorkflowUpdatedEvent = typeof SpecWorkflowUpdatedEvent.Type;

export const SpecWorkflowEvent = SpecWorkflowUpdatedEvent;
export type SpecWorkflowEvent = typeof SpecWorkflowEvent.Type;

export const SpecWorkflowErrorCode = Schema.Literals([
  "not-enabled",
  "thread-not-found",
  "workflow-not-found",
  "invalid-input",
  "invalid-transition",
  "gate-blocked",
  "persistence-failed",
  "stale-version",
  "revision-conflict",
  "invalid-state",
  "artifact-not-found",
  "artifact-path-invalid",
  "identity-conflict",
  "stage-not-dispatchable",
  "independent-verifier-required",
  "idempotency-conflict",
  "composition-unavailable",
]);
export type SpecWorkflowErrorCode = typeof SpecWorkflowErrorCode.Type;

export class SpecWorkflowRpcError extends Schema.TaggedErrorClass<SpecWorkflowRpcError>()(
  "SpecWorkflowRpcError",
  {
    code: SpecWorkflowErrorCode,
    message: TrimmedNonEmptyString,
  },
) {}
