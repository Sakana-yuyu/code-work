import {
  CompositionSquad as CompositionSquadSchema,
  CompositionSquadExecution as CompositionSquadExecutionSchema,
  CompositionSquadExecutionNode,
  CompositionSquadExecutionPendingApproval,
  CompositionSquadExecutionStatus,
  ThreadId,
  isCompositionSquadExecutionStatusTransitionAllowed,
  type CompositionSquad,
  type CompositionSquadExecution,
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
  CompositionSquadExecutionStore,
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionClaimResult,
  type CompositionSquadExecutionStoreErrorCode,
  type CompositionSquadExecutionStoreShape,
} from "../Services/CompositionSquadExecutionStore.ts";

const ExecutionJson = Schema.fromJsonString(CompositionSquadExecutionSchema);
const ExecutionNodesJson = Schema.fromJsonString(Schema.Array(CompositionSquadExecutionNode));
const PendingApprovalsJson = Schema.fromJsonString(
  Schema.Array(CompositionSquadExecutionPendingApproval),
);
const SquadConfigurationJson = Schema.fromJsonString(CompositionSquadSchema);
const ExecutionBindingIdentityKind = Schema.Literals(["task", "run"]);
const ExecutionBindingRole = Schema.Literals([
  "goal_task",
  "leader_task",
  "leader_run",
  "node_task",
  "node_run",
]);
const ExecutionBindingSchema = Schema.Struct({
  executionId: Schema.String,
  identityKind: ExecutionBindingIdentityKind,
  identityId: Schema.String,
  role: ExecutionBindingRole,
  nodeId: Schema.NullOr(Schema.String),
});
const ExecutionBindingsJson = Schema.fromJsonString(Schema.Array(ExecutionBindingSchema));
const encodeExecution = Schema.encodeSync(ExecutionJson);
const encodeNodes = Schema.encodeSync(ExecutionNodesJson);
const encodePendingApprovals = Schema.encodeSync(PendingApprovalsJson);
const encodeBindings = Schema.encodeSync(ExecutionBindingsJson);
const decodeExecution = Schema.decodeUnknownEffect(CompositionSquadExecutionSchema);
const EXECUTION_LIST_MAX = 200;

const ExecutionRowSchema = Schema.Struct({
  executionId: Schema.String,
  squadId: Schema.String,
  squadRevision: Schema.Number,
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  goalDigest: Schema.String,
  planDigest: Schema.NullOr(Schema.String),
  goalTaskId: Schema.String,
  workspaceRootDigest: Schema.String,
  status: CompositionSquadExecutionStatus,
  revision: Schema.Number,
  nodes: Schema.NullOr(ExecutionNodesJson),
  leaderTaskId: Schema.String,
  leaderRunId: Schema.String,
  pendingApprovals: PendingApprovalsJson,
  pausedFromStatus: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  failureDetail: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  pausedAtUnixMs: Schema.NullOr(Schema.Number),
  cancelRequestedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
});

const ExecutionWriteSchema = Schema.Struct({
  executionId: Schema.String,
  squadId: Schema.String,
  squadRevision: Schema.Number,
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  goalDigest: Schema.String,
  planDigest: Schema.NullOr(Schema.String),
  goalTaskId: Schema.String,
  workspaceRootDigest: Schema.String,
  status: CompositionSquadExecutionStatus,
  revision: Schema.Number,
  nodesJson: Schema.NullOr(Schema.String),
  leaderTaskId: Schema.String,
  leaderRunId: Schema.String,
  pendingApprovalsJson: Schema.String,
  pausedFromStatus: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  failureDetail: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  pausedAtUnixMs: Schema.NullOr(Schema.Number),
  cancelRequestedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
});

const ExecutionUpdateSchema = Schema.Struct({
  ...ExecutionWriteSchema.fields,
  expectedRevision: Schema.Number,
  expectedStatus: CompositionSquadExecutionStatus,
});

const ExecutionIdRequest = Schema.Struct({ executionId: Schema.String });
const SquadRevisionRequest = Schema.Struct({
  squadId: Schema.String,
  squadRevision: Schema.Number,
});
const SquadRevisionRow = Schema.Struct({
  configuration: Schema.NullOr(SquadConfigurationJson),
});
const ExecutionListRequest = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  squadId: Schema.NullOr(Schema.String),
  filterStatuses: Schema.Number,
  includeQueued: Schema.Number,
  includePlanning: Schema.Number,
  includeAwaitingApproval: Schema.Number,
  includeRunning: Schema.Number,
  includeInReview: Schema.Number,
  includePaused: Schema.Number,
  includeCancelling: Schema.Number,
  includeCompleted: Schema.Number,
  includeFailed: Schema.Number,
  includeCancelled: Schema.Number,
  limit: Schema.Number,
});
const ExecutionUnsettledListRequest = Schema.Struct({
  cursorUpdatedAtUnixMs: Schema.NullOr(Schema.Number),
  cursorExecutionId: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});
const ExecutionBindingReservationRequest = Schema.Struct({
  executionId: Schema.String,
  bindingsJson: Schema.String,
});
const ExecutionBindingListRequest = Schema.Struct({ executionId: Schema.String });

type ExecutionRow = Schema.Schema.Type<typeof ExecutionRowSchema>;
type ExecutionBinding = Schema.Schema.Type<typeof ExecutionBindingSchema>;

const toExecutionCandidate = (row: ExecutionRow): CompositionSquadExecution => ({
  executionId: row.executionId,
  squadId: row.squadId,
  squadRevision: row.squadRevision,
  projectId: row.projectId,
  ...(row.threadId === null ? {} : { threadId: ThreadId.make(row.threadId) }),
  goalDigest: row.goalDigest,
  ...(row.planDigest === null ? {} : { planDigest: row.planDigest }),
  goalTaskId: row.goalTaskId,
  workspaceRootDigest: row.workspaceRootDigest,
  status: row.status,
  revision: row.revision,
  ...(row.nodes === null ? {} : { nodes: row.nodes }),
  leaderTaskId: row.leaderTaskId,
  leaderRunId: row.leaderRunId,
  pendingApprovals: row.pendingApprovals,
  ...(row.pausedFromStatus === null
    ? {}
    : {
        pausedFromStatus: row.pausedFromStatus as CompositionSquadExecution["pausedFromStatus"],
      }),
  ...(row.resultSummary === null ? {} : { resultSummary: row.resultSummary }),
  ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
  ...(row.failureDetail === null ? {} : { failureDetail: row.failureDetail }),
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
  ...(row.startedAtUnixMs === null ? {} : { startedAtUnixMs: row.startedAtUnixMs }),
  ...(row.pausedAtUnixMs === null ? {} : { pausedAtUnixMs: row.pausedAtUnixMs }),
  ...(row.cancelRequestedAtUnixMs === null
    ? {}
    : { cancelRequestedAtUnixMs: row.cancelRequestedAtUnixMs }),
  ...(row.finishedAtUnixMs === null ? {} : { finishedAtUnixMs: row.finishedAtUnixMs }),
});

const toExecutionWrite = (execution: CompositionSquadExecution) => ({
  executionId: execution.executionId,
  squadId: execution.squadId,
  squadRevision: execution.squadRevision,
  projectId: execution.projectId,
  threadId: execution.threadId ?? null,
  goalDigest: execution.goalDigest,
  planDigest: execution.planDigest ?? null,
  goalTaskId: execution.goalTaskId,
  workspaceRootDigest: execution.workspaceRootDigest,
  status: execution.status,
  revision: execution.revision,
  nodesJson: execution.nodes === undefined ? null : encodeNodes(execution.nodes),
  leaderTaskId: execution.leaderTaskId,
  leaderRunId: execution.leaderRunId,
  pendingApprovalsJson: encodePendingApprovals(execution.pendingApprovals),
  pausedFromStatus: execution.pausedFromStatus ?? null,
  resultSummary: execution.resultSummary ?? null,
  failureCode: execution.failureCode ?? null,
  failureDetail: execution.failureDetail ?? null,
  createdAtUnixMs: execution.createdAtUnixMs,
  updatedAtUnixMs: execution.updatedAtUnixMs,
  startedAtUnixMs: execution.startedAtUnixMs ?? null,
  pausedAtUnixMs: execution.pausedAtUnixMs ?? null,
  cancelRequestedAtUnixMs: execution.cancelRequestedAtUnixMs ?? null,
  finishedAtUnixMs: execution.finishedAtUnixMs ?? null,
});

const sameExecution = (
  left: CompositionSquadExecution,
  right: CompositionSquadExecution,
): boolean => encodeExecution(left) === encodeExecution(right);

const sameExecutionIdentity = (
  left: CompositionSquadExecution,
  right: CompositionSquadExecution,
): boolean =>
  left.executionId === right.executionId &&
  left.squadId === right.squadId &&
  left.squadRevision === right.squadRevision &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId &&
  left.goalDigest === right.goalDigest &&
  left.planDigest === right.planDigest &&
  left.goalTaskId === right.goalTaskId &&
  left.workspaceRootDigest === right.workspaceRootDigest &&
  left.leaderTaskId === right.leaderTaskId &&
  left.leaderRunId === right.leaderRunId &&
  left.createdAtUnixMs === right.createdAtUnixMs;

const sameExecutionNodes = (
  left: CompositionSquadExecution["nodes"],
  right: CompositionSquadExecution["nodes"],
): boolean =>
  left === undefined
    ? right === undefined
    : right !== undefined && encodeNodes(left) === encodeNodes(right);

const toExecutionBindings = (
  execution: CompositionSquadExecution,
): ReadonlyArray<ExecutionBinding> => [
  {
    executionId: execution.executionId,
    identityKind: "task",
    identityId: execution.goalTaskId,
    role: "goal_task",
    nodeId: null,
  },
  {
    executionId: execution.executionId,
    identityKind: "task",
    identityId: execution.leaderTaskId,
    role: "leader_task",
    nodeId: null,
  },
  {
    executionId: execution.executionId,
    identityKind: "run",
    identityId: execution.leaderRunId,
    role: "leader_run",
    nodeId: null,
  },
  ...(execution.nodes ?? []).flatMap((node) => [
    {
      executionId: execution.executionId,
      identityKind: "task" as const,
      identityId: node.taskId,
      role: "node_task" as const,
      nodeId: node.nodeId,
    },
    {
      executionId: execution.executionId,
      identityKind: "run" as const,
      identityId: node.runId,
      role: "node_run" as const,
      nodeId: node.nodeId,
    },
  ]),
];

const sortExecutionBindings = (
  bindings: ReadonlyArray<ExecutionBinding>,
): ReadonlyArray<ExecutionBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.role}\u0000${left.nodeId ?? ""}\u0000${left.identityKind}\u0000${left.identityId}`;
    const rightKey = `${right.role}\u0000${right.nodeId ?? ""}\u0000${right.identityKind}\u0000${right.identityId}`;
    return leftKey.localeCompare(rightKey);
  });

const sameExecutionBindings = (
  left: ReadonlyArray<ExecutionBinding>,
  right: ReadonlyArray<ExecutionBinding>,
): boolean =>
  encodeBindings(sortExecutionBindings(left)) === encodeBindings(sortExecutionBindings(right));

const squadRevisionOf = (squad: CompositionSquad): number => squad.revision ?? 1;

const domainError = (
  code: CompositionSquadExecutionStoreErrorCode,
  executionId: string,
  detail: string,
  metadata: {
    readonly squadId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedStatus?: string;
    readonly actualStatus?: string;
  } = {},
): CompositionSquadExecutionStoreDomainError =>
  new CompositionSquadExecutionStoreDomainError({ code, executionId, detail, ...metadata });

const mapQueryError =
  (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
  (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const validateListLimit = (operation: string, limit: number) =>
  Number.isSafeInteger(limit) && limit >= 1 && limit <= EXECUTION_LIST_MAX
    ? Effect.succeed(limit)
    : Effect.fail(
        domainError(
          "squad_execution_list_limit_invalid",
          "*",
          `${operation} 的 limit 必须是 1 到 ${EXECUTION_LIST_MAX} 的安全整数。`,
        ),
      );

const validateUnsettledCursor = (
  cursor: { readonly updatedAtUnixMs: number; readonly executionId: string } | undefined,
) => {
  if (cursor === undefined) return Effect.succeed(cursor);
  return Number.isSafeInteger(cursor.updatedAtUnixMs) &&
    cursor.updatedAtUnixMs >= 0 &&
    cursor.executionId.trim().length > 0
    ? Effect.succeed(cursor)
    : Effect.fail(
        domainError(
          "squad_execution_list_cursor_invalid",
          cursor.executionId,
          "未收敛 execution 游标必须包含非负更新时间和非空 executionId。",
        ),
      );
};

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getExecutionRow = SqlSchema.findOneOption({
    Request: ExecutionIdRequest,
    Result: ExecutionRowSchema,
    execute: ({ executionId }) => sql`
      SELECT
        execution_id AS "executionId", squad_id AS "squadId",
        squad_revision AS "squadRevision", project_id AS "projectId",
        thread_id AS "threadId", goal_digest AS "goalDigest", plan_digest AS "planDigest",
        goal_task_id AS "goalTaskId", workspace_root_digest AS "workspaceRootDigest",
        status, revision, nodes_json AS nodes,
        leader_task_id AS "leaderTaskId", leader_run_id AS "leaderRunId",
        pending_approvals_json AS "pendingApprovals",
        paused_from_status AS "pausedFromStatus", result_summary AS "resultSummary",
        failure_code AS "failureCode", failure_detail AS "failureDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs", paused_at_unix_ms AS "pausedAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_squad_executions
      WHERE execution_id = ${executionId}
      LIMIT 1
    `,
  });

  const getSquadRevisionRow = SqlSchema.findOneOption({
    Request: SquadRevisionRequest,
    Result: SquadRevisionRow,
    execute: ({ squadId, squadRevision }) => sql`
      SELECT configuration_json AS configuration
      FROM composition_squad_revisions
      WHERE squad_id = ${squadId} AND revision = ${squadRevision}
      LIMIT 1
    `,
  });

  const insertExecutionRow = SqlSchema.findOneOption({
    Request: ExecutionWriteSchema,
    Result: ExecutionRowSchema,
    execute: (execution) => sql`
      INSERT INTO composition_squad_executions (
        execution_id, squad_id, squad_revision, project_id, thread_id,
        goal_digest, plan_digest, goal_task_id, workspace_root_digest,
        status, revision, nodes_json, leader_task_id, leader_run_id,
        pending_approvals_json, paused_from_status,
        result_summary, failure_code, failure_detail,
        created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms,
        paused_at_unix_ms, cancel_requested_at_unix_ms, finished_at_unix_ms
      ) VALUES (
        ${execution.executionId}, ${execution.squadId}, ${execution.squadRevision},
        ${execution.projectId}, ${execution.threadId}, ${execution.goalDigest},
        ${execution.planDigest},
        ${execution.goalTaskId}, ${execution.workspaceRootDigest},
        ${execution.status}, ${execution.revision}, ${execution.nodesJson},
        ${execution.leaderTaskId}, ${execution.leaderRunId},
        ${execution.pendingApprovalsJson}, ${execution.pausedFromStatus},
        ${execution.resultSummary}, ${execution.failureCode}, ${execution.failureDetail},
        ${execution.createdAtUnixMs}, ${execution.updatedAtUnixMs},
        ${execution.startedAtUnixMs}, ${execution.pausedAtUnixMs},
        ${execution.cancelRequestedAtUnixMs}, ${execution.finishedAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        execution_id AS "executionId", squad_id AS "squadId",
        squad_revision AS "squadRevision", project_id AS "projectId",
        thread_id AS "threadId", goal_digest AS "goalDigest", plan_digest AS "planDigest",
        goal_task_id AS "goalTaskId", workspace_root_digest AS "workspaceRootDigest",
        status, revision, nodes_json AS nodes,
        leader_task_id AS "leaderTaskId", leader_run_id AS "leaderRunId",
        pending_approvals_json AS "pendingApprovals",
        paused_from_status AS "pausedFromStatus", result_summary AS "resultSummary",
        failure_code AS "failureCode", failure_detail AS "failureDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs", paused_at_unix_ms AS "pausedAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const updateExecutionRow = SqlSchema.findOneOption({
    Request: ExecutionUpdateSchema,
    Result: ExecutionRowSchema,
    execute: (execution) => sql`
      UPDATE composition_squad_executions
      SET
        squad_id = ${execution.squadId},
        squad_revision = ${execution.squadRevision},
        project_id = ${execution.projectId},
        thread_id = ${execution.threadId},
        goal_digest = ${execution.goalDigest},
        plan_digest = ${execution.planDigest},
        goal_task_id = ${execution.goalTaskId},
        workspace_root_digest = ${execution.workspaceRootDigest},
        status = ${execution.status},
        revision = ${execution.revision},
        nodes_json = ${execution.nodesJson},
        leader_task_id = ${execution.leaderTaskId},
        leader_run_id = ${execution.leaderRunId},
        pending_approvals_json = ${execution.pendingApprovalsJson},
        paused_from_status = ${execution.pausedFromStatus},
        result_summary = ${execution.resultSummary},
        failure_code = ${execution.failureCode},
        failure_detail = ${execution.failureDetail},
        created_at_unix_ms = ${execution.createdAtUnixMs},
        updated_at_unix_ms = ${execution.updatedAtUnixMs},
        started_at_unix_ms = ${execution.startedAtUnixMs},
        paused_at_unix_ms = ${execution.pausedAtUnixMs},
        cancel_requested_at_unix_ms = ${execution.cancelRequestedAtUnixMs},
        finished_at_unix_ms = ${execution.finishedAtUnixMs}
      WHERE execution_id = ${execution.executionId}
        AND revision = ${execution.expectedRevision}
        AND status = ${execution.expectedStatus}
      RETURNING
        execution_id AS "executionId", squad_id AS "squadId",
        squad_revision AS "squadRevision", project_id AS "projectId",
        thread_id AS "threadId", goal_digest AS "goalDigest", plan_digest AS "planDigest",
        goal_task_id AS "goalTaskId", workspace_root_digest AS "workspaceRootDigest",
        status, revision, nodes_json AS nodes,
        leader_task_id AS "leaderTaskId", leader_run_id AS "leaderRunId",
        pending_approvals_json AS "pendingApprovals",
        paused_from_status AS "pausedFromStatus", result_summary AS "resultSummary",
        failure_code AS "failureCode", failure_detail AS "failureDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs", paused_at_unix_ms AS "pausedAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const reserveExecutionBindingRows = SqlSchema.void({
    Request: ExecutionBindingReservationRequest,
    execute: ({ executionId, bindingsJson }) => sql`
      INSERT INTO composition_squad_execution_bindings (
        execution_id, identity_kind, identity_id, role, node_id
      )
      SELECT
        ${executionId},
        json_extract(binding.value, '$.identityKind'),
        json_extract(binding.value, '$.identityId'),
        json_extract(binding.value, '$.role'),
        json_extract(binding.value, '$.nodeId')
      FROM json_each(${bindingsJson}) AS binding
      WHERE 1
      ON CONFLICT DO NOTHING
    `,
  });

  const listExecutionBindingRows = SqlSchema.findAll({
    Request: ExecutionBindingListRequest,
    Result: ExecutionBindingSchema,
    execute: ({ executionId }) => sql`
      SELECT
        execution_id AS "executionId",
        identity_kind AS "identityKind",
        identity_id AS "identityId",
        role,
        node_id AS "nodeId"
      FROM composition_squad_execution_bindings
      WHERE execution_id = ${executionId}
      ORDER BY role ASC, node_id ASC, identity_kind ASC, identity_id ASC
    `,
  });

  const listExecutionRows = SqlSchema.findAll({
    Request: ExecutionListRequest,
    Result: ExecutionRowSchema,
    execute: (request) => sql`
      SELECT
        execution_id AS "executionId", squad_id AS "squadId",
        squad_revision AS "squadRevision", project_id AS "projectId",
        thread_id AS "threadId", goal_digest AS "goalDigest", plan_digest AS "planDigest",
        goal_task_id AS "goalTaskId", workspace_root_digest AS "workspaceRootDigest",
        status, revision, nodes_json AS nodes,
        leader_task_id AS "leaderTaskId", leader_run_id AS "leaderRunId",
        pending_approvals_json AS "pendingApprovals",
        paused_from_status AS "pausedFromStatus", result_summary AS "resultSummary",
        failure_code AS "failureCode", failure_detail AS "failureDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs", paused_at_unix_ms AS "pausedAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_squad_executions
      WHERE (${request.projectId} IS NULL OR project_id = ${request.projectId})
        AND (${request.threadId} IS NULL OR thread_id = ${request.threadId})
        AND (${request.squadId} IS NULL OR squad_id = ${request.squadId})
        AND (
          ${request.filterStatuses} = 0 OR
          (${request.includeQueued} = 1 AND status = 'queued') OR
          (${request.includePlanning} = 1 AND status = 'planning') OR
          (${request.includeAwaitingApproval} = 1 AND status = 'awaiting_approval') OR
          (${request.includeRunning} = 1 AND status = 'running') OR
          (${request.includeInReview} = 1 AND status = 'in_review') OR
          (${request.includePaused} = 1 AND status = 'paused') OR
          (${request.includeCancelling} = 1 AND status = 'cancelling') OR
          (${request.includeCompleted} = 1 AND status = 'completed') OR
          (${request.includeFailed} = 1 AND status = 'failed') OR
          (${request.includeCancelled} = 1 AND status = 'cancelled')
        )
      ORDER BY created_at_unix_ms DESC, execution_id DESC
      LIMIT ${request.limit}
    `,
  });

  const listUnsettledExecutionRows = SqlSchema.findAll({
    Request: ExecutionUnsettledListRequest,
    Result: ExecutionRowSchema,
    execute: ({ cursorUpdatedAtUnixMs, cursorExecutionId, limit }) => sql`
      SELECT
        execution_id AS "executionId", squad_id AS "squadId",
        squad_revision AS "squadRevision", project_id AS "projectId",
        thread_id AS "threadId", goal_digest AS "goalDigest", plan_digest AS "planDigest",
        goal_task_id AS "goalTaskId", workspace_root_digest AS "workspaceRootDigest",
        status, revision, nodes_json AS nodes,
        leader_task_id AS "leaderTaskId", leader_run_id AS "leaderRunId",
        pending_approvals_json AS "pendingApprovals",
        paused_from_status AS "pausedFromStatus", result_summary AS "resultSummary",
        failure_code AS "failureCode", failure_detail AS "failureDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs", paused_at_unix_ms AS "pausedAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_squad_executions
      WHERE status NOT IN ('completed', 'failed', 'cancelled')
        AND (
          ${cursorUpdatedAtUnixMs} IS NULL OR
          updated_at_unix_ms > ${cursorUpdatedAtUnixMs} OR
          (
            updated_at_unix_ms = ${cursorUpdatedAtUnixMs} AND
            execution_id > ${cursorExecutionId}
          )
        )
      ORDER BY updated_at_unix_ms ASC, execution_id ASC
      LIMIT ${limit}
    `,
  });

  const query = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("CompositionSquadExecutionStore.withTransaction")(cause),
          ),
        ),
      );

  const decodeExecutionRow = (operation: string, row: ExecutionRow) =>
    decodeExecution(toExecutionCandidate(row)).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:execution`)),
    );

  const validateExecution = (operation: string, execution: CompositionSquadExecution) =>
    decodeExecution(execution).pipe(
      Effect.mapError((cause) =>
        domainError(
          "squad_execution_snapshot_invalid",
          execution.executionId,
          `${operation} 的 execution 快照不合法：${cause.message}`,
          { squadId: execution.squadId },
        ),
      ),
    );

  const readExecution = (executionId: string) =>
    query("CompositionSquadExecutionStore.getExecution", getExecutionRow({ executionId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionSquadExecution>()),
          onSome: (row) =>
            decodeExecutionRow("CompositionSquadExecutionStore.getExecution", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const decodeRows = (operation: string, rows: ReadonlyArray<ExecutionRow>) =>
    Effect.forEach(rows, (row) => decodeExecutionRow(operation, row));

  const reserveExecutionBindings = Effect.fn("CompositionSquadExecutionStore.reserveBindings")(
    function* (execution: CompositionSquadExecution) {
      const expected = toExecutionBindings(execution);
      yield* query(
        "CompositionSquadExecutionStore.reserveBindings.insert",
        reserveExecutionBindingRows({
          executionId: execution.executionId,
          bindingsJson: encodeBindings(expected),
        }),
      );
      const actual = yield* query(
        "CompositionSquadExecutionStore.reserveBindings.list",
        listExecutionBindingRows({ executionId: execution.executionId }),
      );
      if (!sameExecutionBindings(actual, expected)) {
        return yield* domainError(
          "squad_execution_conflict",
          execution.executionId,
          "Squad execution 的 Task/Run 身份已被其他 execution 或槽位占用。",
          { squadId: execution.squadId },
        );
      }
    },
  );

  const claimExecution: CompositionSquadExecutionStoreShape["claimExecution"] = (requested) =>
    Effect.gen(function* () {
      const execution = yield* validateExecution("claimExecution", requested);
      if (execution.revision !== 1 || execution.status !== "queued") {
        return yield* domainError(
          "squad_execution_initial_state_invalid",
          execution.executionId,
          "新 execution 必须从 queued、revision 1 开始。",
          {
            squadId: execution.squadId,
            expectedRevision: 1,
            actualRevision: execution.revision,
            expectedStatus: "queued",
            actualStatus: execution.status,
          },
        );
      }

      const squadRevision = yield* query(
        "CompositionSquadExecutionStore.claimExecution.squadRevision",
        getSquadRevisionRow({
          squadId: execution.squadId,
          squadRevision: execution.squadRevision,
        }),
      );
      const configuration = Option.isSome(squadRevision) ? squadRevision.value.configuration : null;
      if (
        configuration === null ||
        configuration.squadId !== execution.squadId ||
        squadRevisionOf(configuration) !== execution.squadRevision
      ) {
        return yield* domainError(
          "squad_execution_squad_revision_invalid",
          execution.executionId,
          `Squad revision ${execution.squadRevision} 不存在或缺少可恢复配置。`,
          { squadId: execution.squadId },
        );
      }

      return yield* withTransaction(
        Effect.gen(function* () {
          const inserted = yield* query(
            "CompositionSquadExecutionStore.claimExecution.insert",
            insertExecutionRow(toExecutionWrite(execution)),
          );
          if (Option.isSome(inserted)) {
            const stored = yield* decodeExecutionRow(
              "CompositionSquadExecutionStore.claimExecution.insert",
              inserted.value,
            );
            yield* reserveExecutionBindings(stored);
            return {
              execution: stored,
              claimed: true,
            } satisfies CompositionSquadExecutionClaimResult;
          }

          const current = yield* readExecution(execution.executionId);
          if (Option.isSome(current) && sameExecution(current.value, execution)) {
            yield* reserveExecutionBindings(current.value);
            return {
              execution: current.value,
              claimed: false,
            } satisfies CompositionSquadExecutionClaimResult;
          }
          return yield* domainError(
            "squad_execution_conflict",
            execution.executionId,
            "executionId 或派生 Task/Run 身份已绑定到不同执行快照。",
            { squadId: execution.squadId },
          );
        }),
      );
    });

  const saveTransition: CompositionSquadExecutionStoreShape["saveTransition"] = (input) =>
    Effect.gen(function* () {
      const next = yield* validateExecution("saveTransition", input.execution);
      if (next.revision !== input.expectedRevision + 1) {
        return yield* domainError(
          "squad_execution_revision_conflict",
          next.executionId,
          "execution revision 必须连续递增。",
          {
            squadId: next.squadId,
            expectedRevision: input.expectedRevision + 1,
            actualRevision: next.revision,
          },
        );
      }

      const currentOption = yield* readExecution(next.executionId);
      if (Option.isNone(currentOption)) {
        return yield* domainError(
          "squad_execution_not_found",
          next.executionId,
          "Squad execution 不存在。",
          { squadId: next.squadId },
        );
      }
      const current = currentOption.value;
      if (sameExecution(current, next)) {
        if (input.expectedRevision === current.revision - 1) {
          return yield* withTransaction(reserveExecutionBindings(current).pipe(Effect.as(current)));
        }
        return yield* domainError(
          "squad_execution_revision_conflict",
          next.executionId,
          "幂等重放使用了不匹配的 expectedRevision。",
          {
            squadId: next.squadId,
            expectedRevision: current.revision - 1,
            actualRevision: input.expectedRevision,
          },
        );
      }
      if (!sameExecutionIdentity(current, next)) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "execution 不可变身份字段发生漂移。",
          { squadId: next.squadId },
        );
      }
      if (current.revision !== input.expectedRevision) {
        return yield* domainError(
          "squad_execution_revision_conflict",
          next.executionId,
          `预期 revision ${input.expectedRevision}，实际为 ${current.revision}。`,
          {
            squadId: next.squadId,
            expectedRevision: input.expectedRevision,
            actualRevision: current.revision,
          },
        );
      }
      if (next.updatedAtUnixMs < current.updatedAtUnixMs) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "updatedAtUnixMs 不能倒退。",
          { squadId: next.squadId },
        );
      }
      if (
        current.startedAtUnixMs !== undefined &&
        next.startedAtUnixMs !== current.startedAtUnixMs
      ) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "startedAtUnixMs 一旦写入便不可改变。",
          { squadId: next.squadId },
        );
      }
      if (current.nodes !== undefined && !sameExecutionNodes(current.nodes, next.nodes)) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "已绑定的节点 Task/Run 身份不可改写。",
          { squadId: next.squadId },
        );
      }
      if (
        current.cancelRequestedAtUnixMs !== undefined &&
        next.cancelRequestedAtUnixMs !== current.cancelRequestedAtUnixMs
      ) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "cancelRequestedAtUnixMs 一旦写入便不可改变。",
          { squadId: next.squadId },
        );
      }
      if (
        current.status === "paused" &&
        next.status === "paused" &&
        (next.pausedFromStatus !== current.pausedFromStatus ||
          next.pausedAtUnixMs !== current.pausedAtUnixMs)
      ) {
        return yield* domainError(
          "squad_execution_conflict",
          next.executionId,
          "同一暂停周期的来源状态和暂停时间不可改写。",
          { squadId: next.squadId },
        );
      }
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        return yield* domainError(
          "squad_execution_status_conflict",
          next.executionId,
          "终态 execution 不允许继续推进。",
          {
            squadId: next.squadId,
            expectedStatus: current.status,
            actualStatus: next.status,
          },
        );
      }
      if (current.status !== next.status) {
        const pausedFromStatus =
          next.status === "paused"
            ? next.pausedFromStatus
            : current.status === "paused"
              ? current.pausedFromStatus
              : undefined;
        if (
          !isCompositionSquadExecutionStatusTransitionAllowed({
            from: current.status,
            to: next.status,
            ...(pausedFromStatus === undefined ? {} : { pausedFromStatus }),
          })
        ) {
          return yield* domainError(
            "squad_execution_status_conflict",
            next.executionId,
            `不允许从 ${current.status} 转换到 ${next.status}。`,
            {
              squadId: next.squadId,
              expectedStatus: current.status,
              actualStatus: next.status,
            },
          );
        }
      }

      return yield* withTransaction(
        Effect.gen(function* () {
          const updated = yield* query(
            "CompositionSquadExecutionStore.saveTransition.update",
            updateExecutionRow({
              ...toExecutionWrite(next),
              expectedRevision: input.expectedRevision,
              expectedStatus: current.status,
            }),
          );
          if (Option.isSome(updated)) {
            const stored = yield* decodeExecutionRow(
              "CompositionSquadExecutionStore.saveTransition.update",
              updated.value,
            );
            yield* reserveExecutionBindings(stored);
            return stored;
          }

          const latest = yield* readExecution(next.executionId);
          if (Option.isSome(latest) && sameExecution(latest.value, next)) {
            yield* reserveExecutionBindings(latest.value);
            return latest.value;
          }
          if (Option.isNone(latest)) {
            return yield* domainError(
              "squad_execution_not_found",
              next.executionId,
              "Squad execution 在更新时消失。",
              { squadId: next.squadId },
            );
          }
          return yield* domainError(
            latest.value.revision !== input.expectedRevision
              ? "squad_execution_revision_conflict"
              : "squad_execution_status_conflict",
            next.executionId,
            "execution 已被其他写入者推进。",
            {
              squadId: next.squadId,
              expectedRevision: input.expectedRevision,
              actualRevision: latest.value.revision,
              expectedStatus: current.status,
              actualStatus: latest.value.status,
            },
          );
        }),
      );
    });

  const store: CompositionSquadExecutionStoreShape = {
    claimExecution,
    saveTransition,
    getExecution: readExecution,
    listExecutions: (input) =>
      Effect.gen(function* () {
        const limit = yield* validateListLimit("listExecutions", input.limit);
        const statuses = input.statuses ?? [];
        const rows = yield* query(
          "CompositionSquadExecutionStore.listExecutions",
          listExecutionRows({
            projectId: input.projectId ?? null,
            threadId: input.threadId ?? null,
            squadId: input.squadId ?? null,
            filterStatuses: input.statuses === undefined ? 0 : 1,
            includeQueued: statuses.includes("queued") ? 1 : 0,
            includePlanning: statuses.includes("planning") ? 1 : 0,
            includeAwaitingApproval: statuses.includes("awaiting_approval") ? 1 : 0,
            includeRunning: statuses.includes("running") ? 1 : 0,
            includeInReview: statuses.includes("in_review") ? 1 : 0,
            includePaused: statuses.includes("paused") ? 1 : 0,
            includeCancelling: statuses.includes("cancelling") ? 1 : 0,
            includeCompleted: statuses.includes("completed") ? 1 : 0,
            includeFailed: statuses.includes("failed") ? 1 : 0,
            includeCancelled: statuses.includes("cancelled") ? 1 : 0,
            limit,
          }),
        );
        return yield* decodeRows("CompositionSquadExecutionStore.listExecutions", rows);
      }),
    listUnsettledExecutions: ({ limit: requestedLimit, cursor: requestedCursor }) =>
      Effect.gen(function* () {
        const limit = yield* validateListLimit("listUnsettledExecutions", requestedLimit);
        const cursor = yield* validateUnsettledCursor(requestedCursor);
        const rows = yield* query(
          "CompositionSquadExecutionStore.listUnsettledExecutions",
          listUnsettledExecutionRows({
            cursorUpdatedAtUnixMs: cursor?.updatedAtUnixMs ?? null,
            cursorExecutionId: cursor?.executionId ?? null,
            limit,
          }),
        );
        return yield* decodeRows("CompositionSquadExecutionStore.listUnsettledExecutions", rows);
      }),
  };

  return store;
});

export const CompositionSquadExecutionStoreLive = Layer.effect(
  CompositionSquadExecutionStore,
  makeStore,
);
