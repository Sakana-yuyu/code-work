import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkspaceScriptRunStatus = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "stopped",
  "exited",
  "failed",
]);
export type WorkspaceScriptRunStatus = typeof WorkspaceScriptRunStatus.Type;

export const WorkspaceScriptHealthStatus = Schema.Literals(["unknown", "healthy", "unhealthy"]);
export type WorkspaceScriptHealthStatus = typeof WorkspaceScriptHealthStatus.Type;

export const WorkspaceScriptPortProtocol = Schema.Literals(["tcp", "http", "https"]);
export type WorkspaceScriptPortProtocol = typeof WorkspaceScriptPortProtocol.Type;

export const WorkspaceScriptPortSource = Schema.Literals(["declared", "discovered"]);
export type WorkspaceScriptPortSource = typeof WorkspaceScriptPortSource.Type;

const WorkspaceScriptPortNumber = PositiveInt.check(Schema.isLessThanOrEqualTo(65_535));

export const WorkspaceScriptPort = Schema.Struct({
  port: WorkspaceScriptPortNumber,
  protocol: WorkspaceScriptPortProtocol,
  source: WorkspaceScriptPortSource,
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorkspaceScriptPort = typeof WorkspaceScriptPort.Type;

const WorkspaceScriptRunFields = Schema.Struct({
  workspaceScriptRunId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  scriptId: TrimmedNonEmptyString,
  scriptName: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  status: WorkspaceScriptRunStatus,
  healthStatus: WorkspaceScriptHealthStatus,
  healthCheckedAtUnixMs: Schema.NullOr(NonNegativeInt),
  healthDetail: Schema.NullOr(TrimmedNonEmptyString),
  ports: Schema.Array(WorkspaceScriptPort),
  revision: PositiveInt,
  requestedAtUnixMs: NonNegativeInt,
  startedAtUnixMs: Schema.NullOr(NonNegativeInt),
  finishedAtUnixMs: Schema.NullOr(NonNegativeInt),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  errorCode: Schema.NullOr(TrimmedNonEmptyString),
  errorDetail: Schema.NullOr(TrimmedNonEmptyString),
  compositionTaskId: Schema.NullOr(TrimmedNonEmptyString),
  compositionRunId: Schema.NullOr(TrimmedNonEmptyString),
  updatedAtUnixMs: NonNegativeInt,
});

type WorkspaceScriptRunUnchecked = typeof WorkspaceScriptRunFields.Type;

export type WorkspaceScriptRunValidationIssueCode =
  | "duplicate_port"
  | "error_state_invalid"
  | "health_state_invalid"
  | "relation_identity_invalid"
  | "status_timing_invalid"
  | "timestamp_order_invalid";

export type WorkspaceScriptRunValidationIssue = {
  readonly code: WorkspaceScriptRunValidationIssueCode;
  readonly path: string;
};

const isFinishedWorkspaceScriptStatus = (status: WorkspaceScriptRunStatus): boolean =>
  status === "stopped" || status === "exited" || status === "failed";

/** Workspace Script Run 的持久化与跨客户端投影共用同一组状态不变量。 */
export const validateWorkspaceScriptRun = (
  input: WorkspaceScriptRunUnchecked,
): ReadonlyArray<WorkspaceScriptRunValidationIssue> => {
  const issues: WorkspaceScriptRunValidationIssue[] = [];
  const add = (code: WorkspaceScriptRunValidationIssueCode, path: string): void => {
    issues.push({ code, path });
  };

  if (input.updatedAtUnixMs < input.requestedAtUnixMs) {
    add("timestamp_order_invalid", "updatedAtUnixMs");
  }
  if (
    input.startedAtUnixMs !== null &&
    (input.startedAtUnixMs < input.requestedAtUnixMs ||
      input.startedAtUnixMs > input.updatedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "startedAtUnixMs");
  }
  if (
    input.finishedAtUnixMs !== null &&
    (input.finishedAtUnixMs < (input.startedAtUnixMs ?? input.requestedAtUnixMs) ||
      input.finishedAtUnixMs > input.updatedAtUnixMs)
  ) {
    add("timestamp_order_invalid", "finishedAtUnixMs");
  }

  const finished = isFinishedWorkspaceScriptStatus(input.status);
  if (
    (input.status === "starting" &&
      (input.startedAtUnixMs !== null || input.finishedAtUnixMs !== null)) ||
    (input.status === "running" &&
      (input.startedAtUnixMs === null || input.finishedAtUnixMs !== null)) ||
    (input.status === "stopping" &&
      (input.startedAtUnixMs === null || input.finishedAtUnixMs !== null)) ||
    (input.status === "stopped" &&
      (input.startedAtUnixMs === null || input.finishedAtUnixMs === null)) ||
    (input.status === "exited" &&
      (input.startedAtUnixMs === null || input.finishedAtUnixMs === null)) ||
    (input.status === "failed" && input.finishedAtUnixMs === null)
  ) {
    add("status_timing_invalid", "status");
  }

  const hasError = input.errorCode !== null || input.errorDetail !== null;
  if (
    (input.errorCode === null) !== (input.errorDetail === null) ||
    (input.status === "failed" && !hasError) ||
    (input.status !== "failed" && hasError)
  ) {
    add("error_state_invalid", "errorCode");
  }

  if (
    (input.healthStatus === "unknown" &&
      (input.healthCheckedAtUnixMs !== null || input.healthDetail !== null)) ||
    (input.healthStatus === "healthy" &&
      (input.healthCheckedAtUnixMs === null || input.healthDetail !== null)) ||
    (input.healthStatus === "unhealthy" &&
      (input.healthCheckedAtUnixMs === null || input.healthDetail === null)) ||
    (input.healthCheckedAtUnixMs !== null &&
      (input.healthCheckedAtUnixMs < input.requestedAtUnixMs ||
        input.healthCheckedAtUnixMs > input.updatedAtUnixMs)) ||
    (finished && input.healthStatus !== "unknown")
  ) {
    add("health_state_invalid", "healthStatus");
  }

  const portKeys = input.ports.map((port) => `${port.protocol}:${port.port}`);
  if (new Set(portKeys).size !== portKeys.length) {
    add("duplicate_port", "ports");
  }

  if ((input.compositionTaskId === null) !== (input.compositionRunId === null)) {
    add("relation_identity_invalid", "compositionTaskId");
  }

  return issues;
};

export const WorkspaceScriptRun = WorkspaceScriptRunFields.check(
  Schema.makeFilter((input) => {
    const issue = validateWorkspaceScriptRun(input)[0];
    return issue === undefined || `Invalid Workspace Script Run: ${issue.code} at ${issue.path}`;
  }),
);
export type WorkspaceScriptRun = typeof WorkspaceScriptRun.Type;

export const makeWorkspaceScriptRunId = (operationId: string): string =>
  `workspace-script-run:${operationId}`;

export const makeWorkspaceScriptRunIdempotencyKey = (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly scriptId: string;
  readonly operationId: string;
}): string =>
  `workspace-script:${input.projectId}:${input.threadId}:${input.scriptId}:${input.operationId}`;

const WorkspaceScriptStartRequestFields = Schema.Struct({
  operationId: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  threadId: TrimmedNonEmptyString,
  scriptId: TrimmedNonEmptyString,
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  compositionTaskId: Schema.optional(TrimmedNonEmptyString),
  compositionRunId: Schema.optional(TrimmedNonEmptyString),
});

export const WorkspaceScriptStartRequest = WorkspaceScriptStartRequestFields.check(
  Schema.makeFilter(
    (input) =>
      (input.compositionTaskId === undefined) === (input.compositionRunId === undefined) ||
      "Workspace Script composition relation requires taskId and runId together",
  ),
);
export type WorkspaceScriptStartRequest = typeof WorkspaceScriptStartRequest.Type;

export const WorkspaceScriptStopRequest = Schema.Struct({
  workspaceScriptRunId: TrimmedNonEmptyString,
  operationId: TrimmedNonEmptyString,
  expectedRevision: PositiveInt,
});
export type WorkspaceScriptStopRequest = typeof WorkspaceScriptStopRequest.Type;

export const WorkspaceScriptGetRequest = Schema.Struct({
  workspaceScriptRunId: TrimmedNonEmptyString,
});
export type WorkspaceScriptGetRequest = typeof WorkspaceScriptGetRequest.Type;

export const WorkspaceScriptLogsRequest = Schema.Struct({
  workspaceScriptRunId: TrimmedNonEmptyString,
});
export type WorkspaceScriptLogsRequest = typeof WorkspaceScriptLogsRequest.Type;

export const WorkspaceScriptListRequest = Schema.Struct({
  projectId: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(TrimmedNonEmptyString),
  statuses: Schema.optional(Schema.Array(WorkspaceScriptRunStatus)),
});
export type WorkspaceScriptListRequest = typeof WorkspaceScriptListRequest.Type;

export const WorkspaceScriptRunResult = Schema.Struct({
  run: WorkspaceScriptRun,
});
export type WorkspaceScriptRunResult = typeof WorkspaceScriptRunResult.Type;

export const WorkspaceScriptRunListResult = Schema.Struct({
  runs: Schema.Array(WorkspaceScriptRun),
});
export type WorkspaceScriptRunListResult = typeof WorkspaceScriptRunListResult.Type;

export const WORKSPACE_SCRIPT_LOG_MAX_BYTES = 256 * 1024;

export const WorkspaceScriptLogsResult = Schema.Struct({
  workspaceScriptRunId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  history: Schema.String.check(Schema.isMaxLength(WORKSPACE_SCRIPT_LOG_MAX_BYTES)),
  truncated: Schema.Boolean,
});
export type WorkspaceScriptLogsResult = typeof WorkspaceScriptLogsResult.Type;

export class WorkspaceScriptRpcError extends Schema.TaggedErrorClass<WorkspaceScriptRpcError>()(
  "WorkspaceScriptRpcError",
  {
    code: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    workspaceScriptRunId: Schema.optional(TrimmedNonEmptyString),
    expectedRevision: Schema.optional(PositiveInt),
    actualRevision: Schema.optional(NonNegativeInt),
  },
) {
  override get message(): string {
    return `Workspace Script 操作失败：${this.code}: ${this.detail}`;
  }
}
