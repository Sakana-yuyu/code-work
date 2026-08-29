import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CompositionAutomationCadence = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("every"),
    intervalMs: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    expression: TrimmedNonEmptyString,
    /** Cron 必须显式指定 IANA 时区，禁止静默继承服务器本地时区。 */
    timezone: TrimmedNonEmptyString,
  }),
]);
export type CompositionAutomationCadence = typeof CompositionAutomationCadence.Type;

export const CompositionAutomationExecutionContext = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("existing_thread"),
    threadId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    mode: Schema.Literal("isolated"),
    workspaceRoot: TrimmedNonEmptyString,
    archiveOnFinish: Schema.Boolean,
  }),
]);
export type CompositionAutomationExecutionContext =
  typeof CompositionAutomationExecutionContext.Type;

const CompositionAutomationTargetFields = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("agent"),
    agentId: TrimmedNonEmptyString,
    model: Schema.optional(TrimmedNonEmptyString),
    capabilityIds: Schema.Array(TrimmedNonEmptyString),
    executionContext: CompositionAutomationExecutionContext,
  }),
  Schema.Struct({
    type: Schema.Literal("squad"),
    squadId: TrimmedNonEmptyString,
    /** 固定 revision，避免 Squad 编辑后静默改变已保存的自动化。 */
    squadRevision: PositiveInt,
    executionContext: CompositionAutomationExecutionContext,
  }),
  Schema.Struct({
    type: Schema.Literal("goal_loop"),
    agentId: TrimmedNonEmptyString,
    reviewerAgentId: Schema.optional(TrimmedNonEmptyString),
    model: Schema.optional(TrimmedNonEmptyString),
    capabilityIds: Schema.Array(TrimmedNonEmptyString),
    maxAttempts: PositiveInt,
    maxCostUnits: Schema.optional(PositiveInt),
    stalePivotRounds: Schema.optional(PositiveInt),
    deadlineDurationMs: Schema.optional(PositiveInt),
    executionContext: CompositionAutomationExecutionContext,
  }),
]);

type CompositionAutomationTargetUnchecked = typeof CompositionAutomationTargetFields.Type;

export type CompositionAutomationTargetValidationIssueCode =
  | "duplicate_capability"
  | "reviewer_must_differ"
  | "stale_pivot_exceeds_attempts";

export type CompositionAutomationTargetValidationIssue = {
  readonly code: CompositionAutomationTargetValidationIssueCode;
  readonly path: string;
};

const hasDuplicates = <A>(values: ReadonlyArray<A>): boolean =>
  new Set(values).size !== values.length;

/** Automation 表单与服务端保存共用的目标跨字段校验。 */
export const validateCompositionAutomationTarget = (
  input: CompositionAutomationTargetUnchecked,
): ReadonlyArray<CompositionAutomationTargetValidationIssue> => {
  const issues: CompositionAutomationTargetValidationIssue[] = [];
  if (input.type !== "squad" && hasDuplicates(input.capabilityIds)) {
    issues.push({ code: "duplicate_capability", path: "capabilityIds" });
  }
  if (input.type === "goal_loop") {
    if (input.reviewerAgentId !== undefined && input.reviewerAgentId === input.agentId) {
      issues.push({ code: "reviewer_must_differ", path: "reviewerAgentId" });
    }
    if (input.stalePivotRounds !== undefined && input.stalePivotRounds > input.maxAttempts) {
      issues.push({ code: "stale_pivot_exceeds_attempts", path: "stalePivotRounds" });
    }
  }
  return issues;
};

export const CompositionAutomationTarget = CompositionAutomationTargetFields.check(
  Schema.makeFilter((input) => {
    const issue = validateCompositionAutomationTarget(input)[0];
    return issue === undefined || `Invalid Automation target: ${issue.code} at ${issue.path}`;
  }),
);
export type CompositionAutomationTarget = typeof CompositionAutomationTarget.Type;

export const CompositionAutomationStatus = Schema.Literals(["active", "paused", "completed"]);
export type CompositionAutomationStatus = typeof CompositionAutomationStatus.Type;

const CompositionAutomationFields = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  cadence: CompositionAutomationCadence,
  target: CompositionAutomationTarget,
  status: CompositionAutomationStatus,
  revision: PositiveInt,
  maxRuns: Schema.NullOr(PositiveInt),
  runCount: NonNegativeInt,
  createdAtUnixMs: NonNegativeInt,
  updatedAtUnixMs: NonNegativeInt,
  nextRunAtUnixMs: Schema.NullOr(NonNegativeInt),
  lastRunAtUnixMs: Schema.NullOr(NonNegativeInt),
  pausedAtUnixMs: Schema.NullOr(NonNegativeInt),
  expiresAtUnixMs: Schema.NullOr(NonNegativeInt),
});

type CompositionAutomationUnchecked = typeof CompositionAutomationFields.Type;

export type CompositionAutomationValidationIssueCode =
  | "status_timing_invalid"
  | "timestamp_order_invalid"
  | "run_limit_exceeded"
  | "run_limit_reached"
  | "schedule_after_expiry";

export type CompositionAutomationValidationIssue = {
  readonly code: CompositionAutomationValidationIssueCode;
  readonly path: string;
};

/** 校验稳定持久化快照，不允许把调度中间态作为对外 Automation 记录。 */
export const validateCompositionAutomation = (
  input: CompositionAutomationUnchecked,
): ReadonlyArray<CompositionAutomationValidationIssue> => {
  const issues: CompositionAutomationValidationIssue[] = [];
  const add = (code: CompositionAutomationValidationIssueCode, path: string): void => {
    issues.push({ code, path });
  };

  if (input.updatedAtUnixMs < input.createdAtUnixMs) {
    add("timestamp_order_invalid", "updatedAtUnixMs");
  }
  if (
    input.lastRunAtUnixMs !== null &&
    (input.lastRunAtUnixMs < input.createdAtUnixMs || input.lastRunAtUnixMs > input.updatedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "lastRunAtUnixMs");
  }
  if (
    input.pausedAtUnixMs !== null &&
    (input.pausedAtUnixMs < input.createdAtUnixMs || input.pausedAtUnixMs > input.updatedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "pausedAtUnixMs");
  }
  if (input.expiresAtUnixMs !== null && input.expiresAtUnixMs <= input.createdAtUnixMs) {
    add("timestamp_order_invalid", "expiresAtUnixMs");
  }

  if (
    (input.status === "active" &&
      (input.nextRunAtUnixMs === null || input.pausedAtUnixMs !== null)) ||
    (input.status === "paused" &&
      (input.nextRunAtUnixMs !== null || input.pausedAtUnixMs === null)) ||
    (input.status === "completed" && input.nextRunAtUnixMs !== null)
  ) {
    add("status_timing_invalid", "status");
  }

  if (input.maxRuns !== null && input.runCount > input.maxRuns) {
    add("run_limit_exceeded", "runCount");
  } else if (
    input.status === "active" &&
    input.maxRuns !== null &&
    input.runCount >= input.maxRuns
  ) {
    add("run_limit_reached", "runCount");
  }

  if (
    input.nextRunAtUnixMs !== null &&
    input.expiresAtUnixMs !== null &&
    input.nextRunAtUnixMs > input.expiresAtUnixMs
  ) {
    add("schedule_after_expiry", "nextRunAtUnixMs");
  }

  return issues;
};

export const CompositionAutomation = CompositionAutomationFields.check(
  Schema.makeFilter((input) => {
    const issue = validateCompositionAutomation(input)[0];
    return issue === undefined || `Invalid Automation: ${issue.code} at ${issue.path}`;
  }),
);
export type CompositionAutomation = typeof CompositionAutomation.Type;

export const CompositionAutomationCreateRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  cadence: CompositionAutomationCadence,
  target: CompositionAutomationTarget,
  maxRuns: Schema.NullOr(PositiveInt),
  expiresAtUnixMs: Schema.NullOr(NonNegativeInt),
  runOnCreate: Schema.Boolean,
});
export type CompositionAutomationCreateRequest = typeof CompositionAutomationCreateRequest.Type;

const CompositionAutomationUpdateFields = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
  name: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  cadence: Schema.optional(CompositionAutomationCadence),
  target: Schema.optional(CompositionAutomationTarget),
  maxRuns: Schema.optional(Schema.NullOr(PositiveInt)),
  expiresAtUnixMs: Schema.optional(Schema.NullOr(NonNegativeInt)),
});

export const CompositionAutomationUpdateRequest = CompositionAutomationUpdateFields.check(
  Schema.makeFilter(
    (input) =>
      input.name !== undefined ||
      input.prompt !== undefined ||
      input.cadence !== undefined ||
      input.target !== undefined ||
      input.maxRuns !== undefined ||
      input.expiresAtUnixMs !== undefined ||
      "Automation update requires at least one mutable field",
  ),
);
export type CompositionAutomationUpdateRequest = typeof CompositionAutomationUpdateRequest.Type;

export const CompositionAutomationGetRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
});
export type CompositionAutomationGetRequest = typeof CompositionAutomationGetRequest.Type;

export const CompositionAutomationListRequest = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
  statuses: Schema.optional(Schema.Array(CompositionAutomationStatus)),
});
export type CompositionAutomationListRequest = typeof CompositionAutomationListRequest.Type;

export const CompositionAutomationResult = Schema.Struct({
  automation: CompositionAutomation,
});
export type CompositionAutomationResult = typeof CompositionAutomationResult.Type;

export const CompositionAutomationListResult = Schema.Struct({
  automations: Schema.Array(CompositionAutomation),
});
export type CompositionAutomationListResult = typeof CompositionAutomationListResult.Type;

/** 暂停、恢复和删除都使用乐观 revision，防止覆盖其他客户端的新配置。 */
export const CompositionAutomationRevisionMutationRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
});
export type CompositionAutomationRevisionMutationRequest =
  typeof CompositionAutomationRevisionMutationRequest.Type;

export const CompositionAutomationDeleteResult = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  deletedAtUnixMs: NonNegativeInt,
});
export type CompositionAutomationDeleteResult = typeof CompositionAutomationDeleteResult.Type;

export const CompositionAutomationRunOnceRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
  /** 客户端重试同一次点击时必须复用 operationId。 */
  operationId: TrimmedNonEmptyString,
});
export type CompositionAutomationRunOnceRequest = typeof CompositionAutomationRunOnceRequest.Type;

export const CompositionAutomationRetryRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  automationRunId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
  operationId: TrimmedNonEmptyString,
});
export type CompositionAutomationRetryRequest = typeof CompositionAutomationRetryRequest.Type;

export const CompositionAutomationRunTrigger = Schema.Literals([
  "scheduled",
  "run_once",
  "retry",
  "recovery",
]);
export type CompositionAutomationRunTrigger = typeof CompositionAutomationRunTrigger.Type;

export const CompositionAutomationRunStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
]);
export type CompositionAutomationRunStatus = typeof CompositionAutomationRunStatus.Type;

export const makeCompositionAutomationRunIdempotencyKey = (input: {
  readonly automationId: string;
  readonly scheduledForUnixMs: number;
}): string => `composition-automation:${input.automationId}:${input.scheduledForUnixMs}`;

const CompositionAutomationRunFields = Schema.Struct({
  automationRunId: TrimmedNonEmptyString,
  automationId: TrimmedNonEmptyString,
  automationRevision: PositiveInt,
  /** automationId + scheduledForUnixMs 是定时触发去重的稳定业务身份。 */
  scheduledForUnixMs: NonNegativeInt,
  idempotencyKey: TrimmedNonEmptyString,
  trigger: CompositionAutomationRunTrigger,
  operationId: Schema.optional(TrimmedNonEmptyString),
  sourceAutomationRunId: Schema.optional(TrimmedNonEmptyString),
  status: CompositionAutomationRunStatus,
  attempt: PositiveInt,
  requestedAtUnixMs: NonNegativeInt,
  startedAtUnixMs: Schema.NullOr(NonNegativeInt),
  finishedAtUnixMs: Schema.NullOr(NonNegativeInt),
  compositionTaskId: Schema.NullOr(TrimmedNonEmptyString),
  compositionRunId: Schema.NullOr(TrimmedNonEmptyString),
  outputSummary: Schema.NullOr(TrimmedNonEmptyString),
  errorCode: Schema.NullOr(TrimmedNonEmptyString),
  errorDetail: Schema.NullOr(TrimmedNonEmptyString),
});

type CompositionAutomationRunUnchecked = typeof CompositionAutomationRunFields.Type;

export type CompositionAutomationRunValidationIssueCode =
  | "idempotency_key_invalid"
  | "operation_identity_invalid"
  | "timestamp_order_invalid"
  | "queued_time_invalid"
  | "running_time_invalid"
  | "terminal_time_invalid"
  | "skipped_time_invalid"
  | "success_error_invalid"
  | "failure_error_missing";

export type CompositionAutomationRunValidationIssue = {
  readonly code: CompositionAutomationRunValidationIssueCode;
  readonly path: string;
};

/** Run 状态机校验供 Store、RPC 和客户端测试共用。 */
export const validateCompositionAutomationRun = (
  input: CompositionAutomationRunUnchecked,
): ReadonlyArray<CompositionAutomationRunValidationIssue> => {
  const issues: CompositionAutomationRunValidationIssue[] = [];
  const add = (code: CompositionAutomationRunValidationIssueCode, path: string): void => {
    issues.push({ code, path });
  };

  if (
    input.idempotencyKey !==
    makeCompositionAutomationRunIdempotencyKey({
      automationId: input.automationId,
      scheduledForUnixMs: input.scheduledForUnixMs,
    })
  ) {
    add("idempotency_key_invalid", "idempotencyKey");
  }
  const manualTrigger = input.trigger === "run_once" || input.trigger === "retry";
  if (
    (manualTrigger && input.operationId === undefined) ||
    (!manualTrigger &&
      (input.operationId !== undefined || input.sourceAutomationRunId !== undefined)) ||
    (input.trigger === "run_once" && input.sourceAutomationRunId !== undefined) ||
    (input.trigger === "retry" && input.sourceAutomationRunId === undefined)
  ) {
    add("operation_identity_invalid", "operationId");
  }
  if (input.requestedAtUnixMs < input.scheduledForUnixMs) {
    add("timestamp_order_invalid", "requestedAtUnixMs");
  }
  if (input.startedAtUnixMs !== null && input.startedAtUnixMs < input.requestedAtUnixMs) {
    add("timestamp_order_invalid", "startedAtUnixMs");
  }
  if (
    input.finishedAtUnixMs !== null &&
    input.finishedAtUnixMs < (input.startedAtUnixMs ?? input.requestedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "finishedAtUnixMs");
  }

  if (
    input.status === "queued" &&
    (input.startedAtUnixMs !== null || input.finishedAtUnixMs !== null)
  ) {
    add("queued_time_invalid", "status");
  }
  if (
    input.status === "running" &&
    (input.startedAtUnixMs === null || input.finishedAtUnixMs !== null)
  ) {
    add("running_time_invalid", "status");
  }
  if (
    (input.status === "succeeded" || input.status === "failed") &&
    (input.startedAtUnixMs === null || input.finishedAtUnixMs === null)
  ) {
    add("terminal_time_invalid", "finishedAtUnixMs");
  }
  if (input.status === "cancelled" && input.finishedAtUnixMs === null) {
    add("terminal_time_invalid", "finishedAtUnixMs");
  }
  if (
    input.status === "skipped" &&
    (input.startedAtUnixMs !== null || input.finishedAtUnixMs === null)
  ) {
    add("skipped_time_invalid", "status");
  }

  if (input.status === "succeeded" && (input.errorCode !== null || input.errorDetail !== null)) {
    add("success_error_invalid", "errorCode");
  }
  if (input.status === "failed" && input.errorCode === null) {
    add("failure_error_missing", "errorCode");
  }

  return issues;
};

export const CompositionAutomationRun = CompositionAutomationRunFields.check(
  Schema.makeFilter((input) => {
    const issue = validateCompositionAutomationRun(input)[0];
    return issue === undefined || `Invalid Automation run: ${issue.code} at ${issue.path}`;
  }),
);
export type CompositionAutomationRun = typeof CompositionAutomationRun.Type;

export const CompositionAutomationRunResult = Schema.Struct({
  run: CompositionAutomationRun,
});
export type CompositionAutomationRunResult = typeof CompositionAutomationRunResult.Type;

export const COMPOSITION_AUTOMATION_RUN_HISTORY_MAX_LIMIT = 200;

export const CompositionAutomationRunListRequest = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(COMPOSITION_AUTOMATION_RUN_HISTORY_MAX_LIMIT)),
  ),
});
export type CompositionAutomationRunListRequest = typeof CompositionAutomationRunListRequest.Type;

export const CompositionAutomationRunListResult = Schema.Struct({
  runs: Schema.Array(CompositionAutomationRun),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type CompositionAutomationRunListResult = typeof CompositionAutomationRunListResult.Type;

export class CompositionAutomationRpcError extends Schema.TaggedErrorClass<CompositionAutomationRpcError>()(
  "CompositionAutomationRpcError",
  {
    code: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    automationId: TrimmedNonEmptyString,
    automationRunId: Schema.optional(TrimmedNonEmptyString),
    expectedRevision: Schema.optional(PositiveInt),
    actualRevision: Schema.optional(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Automation 操作失败：${this.code}: ${this.detail}`;
  }
}

/** Scheduler 到执行适配器的命令；幂等键由调用方稳定生成并由 Store 唯一约束。 */
const CompositionAutomationRunRequestFields = Schema.Struct({
  automationId: TrimmedNonEmptyString,
  automationRevision: PositiveInt,
  scheduledForUnixMs: NonNegativeInt,
  trigger: CompositionAutomationRunTrigger,
  idempotencyKey: TrimmedNonEmptyString,
  sourceRunId: Schema.optional(TrimmedNonEmptyString),
});

export const CompositionAutomationRunRequest = CompositionAutomationRunRequestFields.check(
  Schema.makeFilter(
    (input) =>
      input.idempotencyKey ===
        makeCompositionAutomationRunIdempotencyKey({
          automationId: input.automationId,
          scheduledForUnixMs: input.scheduledForUnixMs,
        }) || "Automation run idempotency key does not match automationId + scheduledForUnixMs",
  ),
);
export type CompositionAutomationRunRequest = typeof CompositionAutomationRunRequest.Type;
