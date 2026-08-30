import {
  WorkspaceScriptPort,
  WorkspaceScriptRun as WorkspaceScriptRunSchema,
  WorkspaceScriptRunStatus,
  type WorkspaceScriptRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  WorkspaceScriptStore,
  WorkspaceScriptStoreDomainError,
  type StoredWorkspaceScriptRun,
  type WorkspaceScriptRunClaimResult,
  type WorkspaceScriptStoreErrorCode,
  type WorkspaceScriptStoreShape,
} from "../Services/WorkspaceScriptStore.ts";

const WorkspaceScriptPortsJson = Schema.fromJsonString(Schema.Array(WorkspaceScriptPort));
const WorkspaceScriptRunJson = Schema.fromJsonString(WorkspaceScriptRunSchema);
const encodePorts = Schema.encodeSync(WorkspaceScriptPortsJson);
const encodeRun = Schema.encodeSync(WorkspaceScriptRunJson);
const decodeRun = Schema.decodeUnknownEffect(WorkspaceScriptRunSchema);

const WorkspaceScriptRunRowSchema = Schema.Struct({
  workspaceScriptRunId: Schema.String,
  idempotencyKey: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  scriptId: Schema.String,
  scriptName: Schema.String,
  terminalId: Schema.String,
  cwd: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  status: WorkspaceScriptRunStatus,
  healthStatus: Schema.Literals(["unknown", "healthy", "unhealthy"]),
  healthCheckedAtUnixMs: Schema.NullOr(Schema.Number),
  healthDetail: Schema.NullOr(Schema.String),
  ports: WorkspaceScriptPortsJson,
  revision: Schema.Number,
  requestedAtUnixMs: Schema.Number,
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  exitSignal: Schema.NullOr(Schema.Number),
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
  compositionTaskId: Schema.NullOr(Schema.String),
  compositionRunId: Schema.NullOr(Schema.String),
  stopOperationId: Schema.NullOr(Schema.String),
  updatedAtUnixMs: Schema.Number,
});

const WorkspaceScriptRunWriteSchema = Schema.Struct({
  workspaceScriptRunId: Schema.String,
  idempotencyKey: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  scriptId: Schema.String,
  scriptName: Schema.String,
  terminalId: Schema.String,
  cwd: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  status: WorkspaceScriptRunStatus,
  healthStatus: Schema.Literals(["unknown", "healthy", "unhealthy"]),
  healthCheckedAtUnixMs: Schema.NullOr(Schema.Number),
  healthDetail: Schema.NullOr(Schema.String),
  portsJson: Schema.String,
  revision: Schema.Number,
  requestedAtUnixMs: Schema.Number,
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  exitSignal: Schema.NullOr(Schema.Number),
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
  compositionTaskId: Schema.NullOr(Schema.String),
  compositionRunId: Schema.NullOr(Schema.String),
  updatedAtUnixMs: Schema.Number,
});

const WorkspaceScriptRunTransitionSchema = Schema.Struct({
  ...WorkspaceScriptRunWriteSchema.fields,
  expectedRevision: Schema.Number,
});
const WorkspaceScriptStopTransitionSchema = Schema.Struct({
  ...WorkspaceScriptRunTransitionSchema.fields,
  operationId: Schema.String,
});
const WorkspaceScriptRunIdRequest = Schema.Struct({ workspaceScriptRunId: Schema.String });
const WorkspaceScriptIdempotencyRequest = Schema.Struct({ idempotencyKey: Schema.String });
const WorkspaceScriptOperationRequest = Schema.Struct({ operationId: Schema.String });
const WorkspaceScriptTerminalRequest = Schema.Struct({
  threadId: Schema.String,
  terminalId: Schema.String,
});
const WorkspaceScriptListQuery = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  filterStatuses: Schema.Number,
  includeStarting: Schema.Number,
  includeRunning: Schema.Number,
  includeStopping: Schema.Number,
  includeStopped: Schema.Number,
  includeExited: Schema.Number,
  includeFailed: Schema.Number,
});

type WorkspaceScriptRunRow = Schema.Schema.Type<typeof WorkspaceScriptRunRowSchema>;

const toRunCandidate = (row: WorkspaceScriptRunRow): WorkspaceScriptRun => ({
  workspaceScriptRunId: row.workspaceScriptRunId,
  idempotencyKey: row.idempotencyKey,
  projectId: row.projectId,
  threadId: row.threadId,
  scriptId: row.scriptId,
  scriptName: row.scriptName,
  terminalId: row.terminalId,
  cwd: row.cwd,
  worktreePath: row.worktreePath,
  status: row.status,
  healthStatus: row.healthStatus,
  healthCheckedAtUnixMs: row.healthCheckedAtUnixMs,
  healthDetail: row.healthDetail,
  ports: row.ports,
  revision: row.revision,
  requestedAtUnixMs: row.requestedAtUnixMs,
  startedAtUnixMs: row.startedAtUnixMs,
  finishedAtUnixMs: row.finishedAtUnixMs,
  exitCode: row.exitCode,
  exitSignal: row.exitSignal,
  errorCode: row.errorCode,
  errorDetail: row.errorDetail,
  compositionTaskId: row.compositionTaskId,
  compositionRunId: row.compositionRunId,
  updatedAtUnixMs: row.updatedAtUnixMs,
});

const toRunWrite = (run: WorkspaceScriptRun) => ({
  ...run,
  portsJson: encodePorts(run.ports),
});

const sameRun = (left: WorkspaceScriptRun, right: WorkspaceScriptRun): boolean =>
  encodeRun(left) === encodeRun(right);

const sameRunIdentity = (left: WorkspaceScriptRun, right: WorkspaceScriptRun): boolean =>
  left.workspaceScriptRunId === right.workspaceScriptRunId &&
  left.idempotencyKey === right.idempotencyKey &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId &&
  left.scriptId === right.scriptId &&
  left.scriptName === right.scriptName &&
  left.terminalId === right.terminalId &&
  left.cwd === right.cwd &&
  left.worktreePath === right.worktreePath &&
  left.requestedAtUnixMs === right.requestedAtUnixMs &&
  left.compositionTaskId === right.compositionTaskId &&
  left.compositionRunId === right.compositionRunId;

const sameStartClaimIdentity = (left: WorkspaceScriptRun, right: WorkspaceScriptRun): boolean =>
  left.workspaceScriptRunId === right.workspaceScriptRunId &&
  left.idempotencyKey === right.idempotencyKey &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId &&
  left.scriptId === right.scriptId &&
  left.scriptName === right.scriptName &&
  left.terminalId === right.terminalId &&
  left.cwd === right.cwd &&
  left.worktreePath === right.worktreePath &&
  left.compositionTaskId === right.compositionTaskId &&
  left.compositionRunId === right.compositionRunId;

const domainError = (
  code: WorkspaceScriptStoreErrorCode,
  detail: string,
  metadata: {
    readonly workspaceScriptRunId?: string;
    readonly operationId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  } = {},
): WorkspaceScriptStoreDomainError =>
  new WorkspaceScriptStoreDomainError({ code, detail, ...metadata });

const mapQueryError =
  (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
  (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRunRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptRunIdRequest,
    Result: WorkspaceScriptRunRowSchema,
    execute: ({ workspaceScriptRunId }) => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE workspace_script_run_id = ${workspaceScriptRunId}
    `,
  });

  const getRunByIdempotencyRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptIdempotencyRequest,
    Result: WorkspaceScriptRunRowSchema,
    execute: ({ idempotencyKey }) => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE idempotency_key = ${idempotencyKey}
    `,
  });

  const getRunByOperationRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptOperationRequest,
    Result: WorkspaceScriptRunRowSchema,
    execute: ({ operationId }) => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE stop_operation_id = ${operationId}
    `,
  });

  const getActiveRunByTerminalRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptTerminalRequest,
    Result: WorkspaceScriptRunRowSchema,
    execute: ({ threadId, terminalId }) => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE thread_id = ${threadId}
        AND terminal_id = ${terminalId}
        AND status IN ('starting', 'running', 'stopping')
      ORDER BY updated_at_unix_ms DESC, workspace_script_run_id DESC
      LIMIT 1
    `,
  });

  const insertRunRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptRunWriteSchema,
    Result: WorkspaceScriptRunRowSchema,
    execute: (run) => sql`
      INSERT INTO workspace_script_runs (
        workspace_script_run_id, idempotency_key, project_id, thread_id,
        script_id, script_name, terminal_id, cwd, worktree_path, status,
        health_status, health_checked_at_unix_ms, health_detail, ports_json,
        revision, requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
        exit_code, exit_signal, error_code, error_detail,
        composition_task_id, composition_run_id, updated_at_unix_ms
      ) VALUES (
        ${run.workspaceScriptRunId}, ${run.idempotencyKey}, ${run.projectId}, ${run.threadId},
        ${run.scriptId}, ${run.scriptName}, ${run.terminalId}, ${run.cwd}, ${run.worktreePath},
        ${run.status}, ${run.healthStatus}, ${run.healthCheckedAtUnixMs}, ${run.healthDetail},
        ${run.portsJson}, ${run.revision}, ${run.requestedAtUnixMs}, ${run.startedAtUnixMs},
        ${run.finishedAtUnixMs}, ${run.exitCode}, ${run.exitSignal}, ${run.errorCode},
        ${run.errorDetail}, ${run.compositionTaskId}, ${run.compositionRunId}, ${run.updatedAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const updateRunRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptRunTransitionSchema,
    Result: WorkspaceScriptRunRowSchema,
    execute: (run) => sql`
      UPDATE workspace_script_runs
      SET
        status = ${run.status},
        health_status = ${run.healthStatus},
        health_checked_at_unix_ms = ${run.healthCheckedAtUnixMs},
        health_detail = ${run.healthDetail},
        ports_json = ${run.portsJson},
        revision = ${run.revision},
        started_at_unix_ms = ${run.startedAtUnixMs},
        finished_at_unix_ms = ${run.finishedAtUnixMs},
        exit_code = ${run.exitCode},
        exit_signal = ${run.exitSignal},
        error_code = ${run.errorCode},
        error_detail = ${run.errorDetail},
        updated_at_unix_ms = ${run.updatedAtUnixMs}
      WHERE workspace_script_run_id = ${run.workspaceScriptRunId}
        AND revision = ${run.expectedRevision}
      RETURNING
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimStopRow = SqlSchema.findOneOption({
    Request: WorkspaceScriptStopTransitionSchema,
    Result: WorkspaceScriptRunRowSchema,
    execute: (run) => sql`
      UPDATE workspace_script_runs
      SET
        status = ${run.status},
        health_status = ${run.healthStatus},
        health_checked_at_unix_ms = ${run.healthCheckedAtUnixMs},
        health_detail = ${run.healthDetail},
        ports_json = ${run.portsJson},
        revision = ${run.revision},
        started_at_unix_ms = ${run.startedAtUnixMs},
        finished_at_unix_ms = ${run.finishedAtUnixMs},
        exit_code = ${run.exitCode},
        exit_signal = ${run.exitSignal},
        error_code = ${run.errorCode},
        error_detail = ${run.errorDetail},
        stop_operation_id = ${run.operationId},
        updated_at_unix_ms = ${run.updatedAtUnixMs}
      WHERE workspace_script_run_id = ${run.workspaceScriptRunId}
        AND revision = ${run.expectedRevision}
        AND (
          stop_operation_id IS NULL OR
          (stop_operation_id = ${run.operationId} AND status = 'running')
        )
      RETURNING
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: WorkspaceScriptListQuery,
    Result: WorkspaceScriptRunRowSchema,
    execute: (request) => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE (${request.projectId} IS NULL OR project_id = ${request.projectId})
        AND (${request.threadId} IS NULL OR thread_id = ${request.threadId})
        AND (
          ${request.filterStatuses} = 0 OR
          (${request.includeStarting} = 1 AND status = 'starting') OR
          (${request.includeRunning} = 1 AND status = 'running') OR
          (${request.includeStopping} = 1 AND status = 'stopping') OR
          (${request.includeStopped} = 1 AND status = 'stopped') OR
          (${request.includeExited} = 1 AND status = 'exited') OR
          (${request.includeFailed} = 1 AND status = 'failed')
        )
      ORDER BY requested_at_unix_ms DESC, workspace_script_run_id DESC
    `,
  });

  const listRecoveryCandidateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorkspaceScriptRunRowSchema,
    execute: () => sql`
      SELECT
        workspace_script_run_id AS "workspaceScriptRunId",
        idempotency_key AS "idempotencyKey",
        project_id AS "projectId",
        thread_id AS "threadId",
        script_id AS "scriptId",
        script_name AS "scriptName",
        terminal_id AS "terminalId",
        cwd,
        worktree_path AS "worktreePath",
        status,
        health_status AS "healthStatus",
        health_checked_at_unix_ms AS "healthCheckedAtUnixMs",
        health_detail AS "healthDetail",
        ports_json AS ports,
        revision,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        error_code AS "errorCode",
        error_detail AS "errorDetail",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        stop_operation_id AS "stopOperationId",
        updated_at_unix_ms AS "updatedAtUnixMs"
      FROM workspace_script_runs
      WHERE
        (stop_operation_id IS NULL AND status IN ('starting', 'running', 'stopping')) OR
        (stop_operation_id IS NOT NULL AND status = 'stopping')
      ORDER BY requested_at_unix_ms ASC, workspace_script_run_id ASC
    `,
  });

  const query = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("WorkspaceScriptStore.withTransaction")(cause)),
        ),
      );

  const decodeStoredRow = (operation: string, row: WorkspaceScriptRunRow) =>
    decodeRun(toRunCandidate(row)).pipe(
      Effect.map((run) => ({ run, stopOperationId: row.stopOperationId })),
      Effect.mapError(toPersistenceDecodeError(`${operation}:run`)),
    );

  const validateRun = (operation: string, run: WorkspaceScriptRun) =>
    decodeRun(run).pipe(Effect.mapError(toPersistenceDecodeError(`${operation}:input`)));

  const readStoredRun = (workspaceScriptRunId: string) =>
    query("WorkspaceScriptStore.getRun", getRunRow({ workspaceScriptRunId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<StoredWorkspaceScriptRun>()),
          onSome: (row) =>
            decodeStoredRow("WorkspaceScriptStore.getRun", row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const readStoredRunByIdempotency = (idempotencyKey: string) =>
    query(
      "WorkspaceScriptStore.getRunByIdempotency",
      getRunByIdempotencyRow({ idempotencyKey }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<StoredWorkspaceScriptRun>()),
          onSome: (row) =>
            decodeStoredRow("WorkspaceScriptStore.getRunByIdempotency", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const readStoredRunByOperation = (operationId: string) =>
    query("WorkspaceScriptStore.getRunByOperation", getRunByOperationRow({ operationId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<StoredWorkspaceScriptRun>()),
          onSome: (row) =>
            decodeStoredRow("WorkspaceScriptStore.getRunByOperation", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const revisionError = (
    run: WorkspaceScriptRun,
    expectedRevision: number,
    actualRevision: number,
  ) =>
    domainError("workspace_script_revision_conflict", "Run revision 已被其他操作推进。", {
      workspaceScriptRunId: run.workspaceScriptRunId,
      expectedRevision,
      actualRevision,
    });

  const claimStart: WorkspaceScriptStoreShape["claimStart"] = (requestedRun) =>
    withTransaction(
      Effect.gen(function* () {
        const run = yield* validateRun("WorkspaceScriptStore.claimStart", requestedRun);
        const inserted = yield* query(
          "WorkspaceScriptStore.claimStart.insert",
          insertRunRow(toRunWrite(run)),
        );
        if (Option.isSome(inserted)) {
          const stored = yield* decodeStoredRow(
            "WorkspaceScriptStore.claimStart.insert",
            inserted.value,
          );
          return { run: stored.run, claimed: true } satisfies WorkspaceScriptRunClaimResult;
        }

        const byId = yield* readStoredRun(run.workspaceScriptRunId);
        if (Option.isSome(byId)) {
          if (sameStartClaimIdentity(byId.value.run, run)) {
            return { run: byId.value.run, claimed: false } satisfies WorkspaceScriptRunClaimResult;
          }
          return yield* domainError(
            "workspace_script_run_conflict",
            "Run ID 已绑定到不同的脚本运行身份。",
            { workspaceScriptRunId: run.workspaceScriptRunId },
          );
        }

        const byIdempotency = yield* readStoredRunByIdempotency(run.idempotencyKey);
        if (Option.isSome(byIdempotency) && sameStartClaimIdentity(byIdempotency.value.run, run)) {
          return {
            run: byIdempotency.value.run,
            claimed: false,
          } satisfies WorkspaceScriptRunClaimResult;
        }
        return yield* domainError("workspace_script_run_conflict", "幂等键已被其他脚本运行占用。", {
          workspaceScriptRunId: run.workspaceScriptRunId,
        });
      }),
    );

  const saveTransition: WorkspaceScriptStoreShape["saveTransition"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const run = yield* validateRun("WorkspaceScriptStore.saveTransition", input.run);
        const current = yield* readStoredRun(run.workspaceScriptRunId);
        if (Option.isNone(current)) {
          return yield* domainError(
            "workspace_script_run_not_found",
            "Workspace Script Run 不存在。",
            { workspaceScriptRunId: run.workspaceScriptRunId },
          );
        }
        if (!sameRunIdentity(current.value.run, run)) {
          return yield* domainError(
            "workspace_script_run_conflict",
            "Run transition 试图修改不可变身份字段。",
            { workspaceScriptRunId: run.workspaceScriptRunId },
          );
        }
        if (sameRun(current.value.run, run)) return current.value.run;
        if (
          current.value.run.revision !== input.expectedRevision ||
          run.revision !== input.expectedRevision + 1
        ) {
          return yield* revisionError(run, input.expectedRevision, current.value.run.revision);
        }

        const updated = yield* query(
          "WorkspaceScriptStore.saveTransition.update",
          updateRunRow({ ...toRunWrite(run), expectedRevision: input.expectedRevision }),
        );
        if (Option.isSome(updated)) {
          return (yield* decodeStoredRow(
            "WorkspaceScriptStore.saveTransition.update",
            updated.value,
          )).run;
        }
        const latest = yield* readStoredRun(run.workspaceScriptRunId);
        if (Option.isSome(latest) && sameRun(latest.value.run, run)) return latest.value.run;
        return yield* revisionError(
          run,
          input.expectedRevision,
          Option.isSome(latest) ? latest.value.run.revision : 0,
        );
      }),
    );

  const claimStop: WorkspaceScriptStoreShape["claimStop"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const run = yield* validateRun("WorkspaceScriptStore.claimStop", input.run);
        const operationWinner = yield* readStoredRunByOperation(input.operationId);
        if (Option.isSome(operationWinner)) {
          if (operationWinner.value.run.workspaceScriptRunId !== run.workspaceScriptRunId) {
            return yield* domainError(
              "workspace_script_stop_operation_conflict",
              "停止 operationId 已绑定到其他 Workspace Script Run。",
              {
                workspaceScriptRunId: run.workspaceScriptRunId,
                operationId: input.operationId,
              },
            );
          }
          if (!sameRunIdentity(operationWinner.value.run, run)) {
            return yield* domainError(
              "workspace_script_run_conflict",
              "停止操作试图修改不可变身份字段。",
              { workspaceScriptRunId: run.workspaceScriptRunId },
            );
          }
          if (operationWinner.value.run.status === "running") {
            if (
              run.status !== "stopping" ||
              run.revision !== operationWinner.value.run.revision + 1
            ) {
              return yield* revisionError(
                run,
                operationWinner.value.run.revision,
                operationWinner.value.run.revision,
              );
            }
            const reclaimed = yield* query(
              "WorkspaceScriptStore.claimStop.reclaim",
              claimStopRow({
                ...toRunWrite(run),
                expectedRevision: operationWinner.value.run.revision,
                operationId: input.operationId,
              }),
            );
            if (Option.isSome(reclaimed)) {
              const stored = yield* decodeStoredRow(
                "WorkspaceScriptStore.claimStop.reclaim",
                reclaimed.value,
              );
              return { run: stored.run, claimed: true } satisfies WorkspaceScriptRunClaimResult;
            }
            const latest = yield* readStoredRunByOperation(input.operationId);
            if (
              Option.isSome(latest) &&
              latest.value.run.workspaceScriptRunId === run.workspaceScriptRunId &&
              sameRunIdentity(latest.value.run, run)
            ) {
              return {
                run: latest.value.run,
                claimed: false,
              } satisfies WorkspaceScriptRunClaimResult;
            }
            return yield* revisionError(
              run,
              operationWinner.value.run.revision,
              Option.isSome(latest) ? latest.value.run.revision : 0,
            );
          }
          return {
            run: operationWinner.value.run,
            claimed: false,
          } satisfies WorkspaceScriptRunClaimResult;
        }

        const current = yield* readStoredRun(run.workspaceScriptRunId);
        if (Option.isNone(current)) {
          return yield* domainError(
            "workspace_script_run_not_found",
            "Workspace Script Run 不存在。",
            { workspaceScriptRunId: run.workspaceScriptRunId },
          );
        }
        if (current.value.stopOperationId !== null) {
          return yield* domainError(
            "workspace_script_stop_operation_conflict",
            "Workspace Script Run 已被其他停止操作领取。",
            {
              workspaceScriptRunId: run.workspaceScriptRunId,
              operationId: input.operationId,
            },
          );
        }
        if (!sameRunIdentity(current.value.run, run)) {
          return yield* domainError(
            "workspace_script_run_conflict",
            "停止操作试图修改不可变身份字段。",
            { workspaceScriptRunId: run.workspaceScriptRunId },
          );
        }
        if (
          current.value.run.revision !== input.expectedRevision ||
          run.revision !== input.expectedRevision + 1
        ) {
          return yield* revisionError(run, input.expectedRevision, current.value.run.revision);
        }

        const claimed = yield* query(
          "WorkspaceScriptStore.claimStop.update",
          claimStopRow({
            ...toRunWrite(run),
            expectedRevision: input.expectedRevision,
            operationId: input.operationId,
          }),
        );
        if (Option.isSome(claimed)) {
          const stored = yield* decodeStoredRow(
            "WorkspaceScriptStore.claimStop.update",
            claimed.value,
          );
          return { run: stored.run, claimed: true } satisfies WorkspaceScriptRunClaimResult;
        }

        const winner = yield* readStoredRunByOperation(input.operationId);
        if (
          Option.isSome(winner) &&
          winner.value.run.workspaceScriptRunId === run.workspaceScriptRunId &&
          sameRunIdentity(winner.value.run, run)
        ) {
          return { run: winner.value.run, claimed: false } satisfies WorkspaceScriptRunClaimResult;
        }
        const latest = yield* readStoredRun(run.workspaceScriptRunId);
        if (Option.isSome(latest) && latest.value.stopOperationId !== null) {
          return yield* domainError(
            "workspace_script_stop_operation_conflict",
            "Workspace Script Run 已被其他停止操作领取。",
            {
              workspaceScriptRunId: run.workspaceScriptRunId,
              operationId: input.operationId,
            },
          );
        }
        return yield* revisionError(
          run,
          input.expectedRevision,
          Option.isSome(latest) ? latest.value.run.revision : 0,
        );
      }),
    );

  const store: WorkspaceScriptStoreShape = {
    claimStart,
    saveTransition,
    claimStop,
    getRun: (workspaceScriptRunId) =>
      readStoredRun(workspaceScriptRunId).pipe(Effect.map(Option.map((stored) => stored.run))),
    getStoredRun: readStoredRun,
    getActiveRunByTerminal: (threadId, terminalId) =>
      query(
        "WorkspaceScriptStore.getActiveRunByTerminal",
        getActiveRunByTerminalRow({ threadId, terminalId }),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<StoredWorkspaceScriptRun>()),
            onSome: (row) =>
              decodeStoredRow("WorkspaceScriptStore.getActiveRunByTerminal", row).pipe(
                Effect.map(Option.some),
              ),
          }),
        ),
      ),
    listRuns: (request) => {
      const statuses = request.statuses ?? [];
      return query(
        "WorkspaceScriptStore.listRuns",
        listRunRows({
          projectId: request.projectId ?? null,
          threadId: request.threadId ?? null,
          filterStatuses: request.statuses === undefined ? 0 : 1,
          includeStarting: statuses.includes("starting") ? 1 : 0,
          includeRunning: statuses.includes("running") ? 1 : 0,
          includeStopping: statuses.includes("stopping") ? 1 : 0,
          includeStopped: statuses.includes("stopped") ? 1 : 0,
          includeExited: statuses.includes("exited") ? 1 : 0,
          includeFailed: statuses.includes("failed") ? 1 : 0,
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeStoredRow("WorkspaceScriptStore.listRuns", row).pipe(
              Effect.map((stored) => stored.run),
            ),
          ),
        ),
      );
    },
    listRecoveryCandidates: () =>
      query(
        "WorkspaceScriptStore.listRecoveryCandidates",
        listRecoveryCandidateRows(undefined),
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeStoredRow("WorkspaceScriptStore.listRecoveryCandidates", row),
          ),
        ),
      ),
  };

  return store;
});

export const WorkspaceScriptStoreLive = Layer.effect(WorkspaceScriptStore, makeStore);
