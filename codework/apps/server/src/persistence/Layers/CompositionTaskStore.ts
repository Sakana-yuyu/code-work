import {
  ApprovalRequestId,
  CompositionSquad as CompositionSquadSchema,
  type CompositionRuntimeLease,
  type CompositionSquad,
  type CompositionSquadRevision,
  type CompositionTask,
  type CompositionTaskDependency,
  type CompositionTaskEvent,
  type CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CompositionTaskStore,
  type CompositionMulticaQuickCreateIntent,
  type CompositionTaskStoreShape,
} from "../Services/CompositionTaskStore.ts";

const StringArrayJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStringArray = Schema.encodeSync(StringArrayJson);
const CompositionSquadJson = Schema.fromJsonString(CompositionSquadSchema);
const encodeCompositionSquad = Schema.encodeSync(CompositionSquadJson);

class CompositionSquadRevisionWriteError extends Schema.TaggedErrorClass<CompositionSquadRevisionWriteError>()(
  "CompositionSquadRevisionWriteError",
  { detail: Schema.String },
) {}

const TaskRowSchema = Schema.Struct({
  taskId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  parentTaskId: Schema.NullOr(Schema.String),
  assigneeKind: Schema.Literals(["agent", "squad"]),
  assigneeId: Schema.String,
  mode: Schema.Literals(["serial", "parallel", "review"]),
  status: Schema.String,
  promptDigest: Schema.String,
  dependsOnTaskIds: StringArrayJson,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
});

const RunRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  runtimeId: Schema.String,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  status: Schema.String,
  attempt: Schema.Number,
  capabilityGrantIds: StringArrayJson,
  leaseId: Schema.NullOr(Schema.String),
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  lastRuntimeEventAtUnixMs: Schema.NullOr(Schema.Number),
  cancelRequestedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
  failureCode: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String),
});

const EventRowSchema = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  sourceEventId: Schema.NullOr(Schema.String),
  parentTaskId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  runtimeId: Schema.NullOr(Schema.String),
  status: Schema.String,
  sequence: Schema.Number,
  eventType: Schema.String,
  summary: Schema.String,
  progress: Schema.NullOr(Schema.Number),
  blockerCode: Schema.NullOr(Schema.String),
  approvalRequestId: Schema.NullOr(ApprovalRequestId),
  childTaskIds: Schema.NullOr(StringArrayJson),
  outputDelta: Schema.NullOr(Schema.String),
  outputOffsetBytes: Schema.NullOr(Schema.Number),
  outputDigest: Schema.NullOr(Schema.String),
});

const DependencyRowSchema = Schema.Struct({
  taskId: Schema.String,
  dependsOnTaskId: Schema.String,
  condition: Schema.String,
  createdAtUnixMs: Schema.Number,
});

const LeaseRowSchema = Schema.Struct({
  leaseId: Schema.String,
  runtimeId: Schema.String,
  taskId: Schema.String,
  workspaceRootDigest: Schema.String,
  heartbeatAtUnixMs: Schema.Number,
  expiresAtUnixMs: Schema.Number,
  state: Schema.String,
});

const SquadRowSchema = Schema.Struct({
  squadId: Schema.String,
  name: Schema.String,
  leaderAgentId: Schema.String,
  memberAgentIds: StringArrayJson,
  instructions: Schema.NullOr(Schema.String),
  revision: Schema.Number,
  configuration: Schema.NullOr(CompositionSquadJson),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  archivedAtUnixMs: Schema.NullOr(Schema.Number),
});

const SquadRevisionRowSchema = Schema.Struct({
  squadId: Schema.String,
  revision: Schema.Number,
  configuration: Schema.NullOr(CompositionSquadJson),
  createdAtUnixMs: Schema.Number,
});

const MulticaQuickCreateIntentRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  runtimeId: Schema.String,
  idempotencyKey: Schema.String,
  state: Schema.Literals(["prepared", "sending", "accepted"]),
  remoteTaskId: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});

const IdRequest = Schema.Struct({ id: Schema.String });
const TaskRequest = Schema.Struct({ taskId: Schema.String });
const RuntimeTaskRequest = Schema.Struct({
  runtimeId: Schema.String,
  runtimeTaskId: Schema.String,
});
const TaskListRequest = Schema.Struct({ projectId: Schema.NullOr(Schema.String) });
const EventListRequest = Schema.Struct({ taskId: Schema.String, runId: Schema.String });
const EventSourceRequest = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  sourceEventId: Schema.String,
});
const QuickCreateIntentRequest = Schema.Struct({ runId: Schema.String });
const QuickCreateIntentIdempotencyRequest = Schema.Struct({
  runtimeId: Schema.String,
  idempotencyKey: Schema.String,
});
const QuickCreateIntentClaimRequest = Schema.Struct({
  runId: Schema.String,
  runtimeId: Schema.String,
  updatedAtUnixMs: Schema.Number,
});
const QuickCreateIntentAcceptRequest = Schema.Struct({
  runId: Schema.String,
  runtimeId: Schema.String,
  remoteTaskId: Schema.String,
  updatedAtUnixMs: Schema.Number,
});
const QuickCreateIntentListRequest = Schema.Struct({ runtimeId: Schema.NullOr(Schema.String) });
const LeaseClaimRequest = Schema.Struct({
  ...LeaseRowSchema.fields,
  nowUnixMs: Schema.Number,
});
const LeaseRenewRequest = Schema.Struct({
  leaseId: Schema.String,
  runtimeId: Schema.String,
  heartbeatAtUnixMs: Schema.Number,
  expiresAtUnixMs: Schema.Number,
  nowUnixMs: Schema.Number,
});
const LeaseReleaseRequest = Schema.Struct({
  leaseId: Schema.String,
  runtimeId: Schema.String,
  releasedAtUnixMs: Schema.Number,
});
const LeaseReclaimRequest = Schema.Struct({ nowUnixMs: Schema.Number });
const SquadListRequest = Schema.Struct({ includeArchived: Schema.Number });
const SquadRevisionListRequest = Schema.Struct({ squadId: Schema.String });

const toTask = (row: Schema.Schema.Type<typeof TaskRowSchema>): CompositionTask => ({
  taskId: row.taskId,
  projectId: row.projectId,
  ...(row.threadId === null ? {} : { threadId: row.threadId }),
  ...(row.parentTaskId === null ? {} : { parentTaskId: row.parentTaskId }),
  assigneeKind: row.assigneeKind,
  assigneeId: row.assigneeId,
  mode: row.mode,
  status: row.status as CompositionTask["status"],
  promptDigest: row.promptDigest,
  dependsOnTaskIds: row.dependsOnTaskIds,
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
  ...(row.finishedAtUnixMs === null ? {} : { finishedAtUnixMs: row.finishedAtUnixMs }),
});

const toRun = (row: Schema.Schema.Type<typeof RunRowSchema>): CompositionTaskRun => ({
  runId: row.runId,
  taskId: row.taskId,
  agentId: row.agentId,
  runtimeId: row.runtimeId,
  ...(row.runtimeTaskId === null ? {} : { runtimeTaskId: row.runtimeTaskId }),
  ...(row.capabilityHandshakeId === null
    ? {}
    : { capabilityHandshakeId: row.capabilityHandshakeId }),
  status: row.status as CompositionTaskRun["status"],
  attempt: row.attempt,
  capabilityGrantIds: row.capabilityGrantIds,
  ...(row.leaseId === null ? {} : { leaseId: row.leaseId }),
  ...(row.startedAtUnixMs === null ? {} : { startedAtUnixMs: row.startedAtUnixMs }),
  ...(row.lastRuntimeEventAtUnixMs === null
    ? {}
    : { lastRuntimeEventAtUnixMs: row.lastRuntimeEventAtUnixMs }),
  ...(row.cancelRequestedAtUnixMs === null
    ? {}
    : { cancelRequestedAtUnixMs: row.cancelRequestedAtUnixMs }),
  ...(row.finishedAtUnixMs === null ? {} : { finishedAtUnixMs: row.finishedAtUnixMs }),
  ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
  ...(row.resultSummary === null ? {} : { resultSummary: row.resultSummary }),
});

const toEvent = (row: Schema.Schema.Type<typeof EventRowSchema>): CompositionTaskEvent => ({
  taskId: row.taskId,
  runId: row.runId,
  ...(row.sourceEventId === null ? {} : { sourceEventId: row.sourceEventId }),
  ...(row.parentTaskId === null ? {} : { parentTaskId: row.parentTaskId }),
  agentId: row.agentId,
  ...(row.runtimeId === null ? {} : { runtimeId: row.runtimeId }),
  status: row.status as CompositionTaskEvent["status"],
  sequence: row.sequence,
  eventType: row.eventType as CompositionTaskEvent["eventType"],
  summary: row.summary,
  ...(row.progress === null ? {} : { progress: row.progress }),
  ...(row.blockerCode === null ? {} : { blockerCode: row.blockerCode }),
  ...(row.approvalRequestId === null
    ? {}
    : { approvalRequestId: ApprovalRequestId.make(row.approvalRequestId) }),
  ...(row.childTaskIds === null ? {} : { childTaskIds: row.childTaskIds }),
  ...(row.outputDelta === null ? {} : { outputDelta: row.outputDelta }),
  ...(row.outputOffsetBytes === null ? {} : { outputOffsetBytes: row.outputOffsetBytes }),
  ...(row.outputDigest === null ? {} : { outputDigest: row.outputDigest }),
});

const toMulticaQuickCreateIntent = (
  row: Schema.Schema.Type<typeof MulticaQuickCreateIntentRowSchema>,
): CompositionMulticaQuickCreateIntent => ({
  runId: row.runId,
  taskId: row.taskId,
  runtimeId: row.runtimeId,
  idempotencyKey: row.idempotencyKey,
  state: row.state,
  ...(row.remoteTaskId === null ? {} : { remoteTaskId: row.remoteTaskId }),
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
});

const toDependency = (
  row: Schema.Schema.Type<typeof DependencyRowSchema>,
): CompositionTaskDependency => ({
  taskId: row.taskId,
  dependsOnTaskId: row.dependsOnTaskId,
  condition: row.condition as CompositionTaskDependency["condition"],
  createdAtUnixMs: row.createdAtUnixMs,
});

const toLease = (row: Schema.Schema.Type<typeof LeaseRowSchema>): CompositionRuntimeLease => ({
  leaseId: row.leaseId,
  runtimeId: row.runtimeId,
  taskId: row.taskId,
  workspaceRootDigest: row.workspaceRootDigest,
  heartbeatAtUnixMs: row.heartbeatAtUnixMs,
  expiresAtUnixMs: row.expiresAtUnixMs,
  state: row.state as CompositionRuntimeLease["state"],
});

const toSquad = (row: Schema.Schema.Type<typeof SquadRowSchema>): CompositionSquad =>
  row.configuration ?? {
    squadId: row.squadId,
    name: row.name,
    leaderAgentId: row.leaderAgentId,
    memberAgentIds: row.memberAgentIds,
    ...(row.instructions === null ? {} : { instructions: row.instructions }),
    ...(row.archivedAtUnixMs === null ? {} : { archivedAtUnixMs: row.archivedAtUnixMs }),
  };

const toSquadRevision = (
  row: Schema.Schema.Type<typeof SquadRevisionRowSchema>,
): CompositionSquadRevision => ({
  squadId: row.squadId,
  revision: row.revision,
  configuration: row.configuration,
  createdAtUnixMs: row.createdAtUnixMs,
});

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertTaskRow = SqlSchema.void({
    Request: Schema.Struct({
      ...TaskRowSchema.fields,
      dependsOnTaskIds: Schema.Array(Schema.String),
    }),
    execute: (task) => sql`
      INSERT INTO composition_tasks (
        task_id, project_id, thread_id, parent_task_id, assignee_kind, assignee_id,
        mode, status, prompt_digest, depends_on_task_ids_json,
        created_at_unix_ms, updated_at_unix_ms, finished_at_unix_ms
      ) VALUES (
        ${task.taskId}, ${task.projectId}, ${task.threadId}, ${task.parentTaskId},
        ${task.assigneeKind}, ${task.assigneeId}, ${task.mode}, ${task.status},
        ${task.promptDigest}, ${encodeStringArray(task.dependsOnTaskIds)},
        ${task.createdAtUnixMs}, ${task.updatedAtUnixMs}, ${task.finishedAtUnixMs}
      )
      ON CONFLICT (task_id) DO UPDATE SET
        project_id = excluded.project_id,
        thread_id = excluded.thread_id,
        parent_task_id = excluded.parent_task_id,
        assignee_kind = excluded.assignee_kind,
        assignee_id = excluded.assignee_id,
        mode = excluded.mode,
        status = excluded.status,
        prompt_digest = excluded.prompt_digest,
        depends_on_task_ids_json = excluded.depends_on_task_ids_json,
        updated_at_unix_ms = excluded.updated_at_unix_ms,
        finished_at_unix_ms = excluded.finished_at_unix_ms
    `,
  });

  const getTaskRow = SqlSchema.findOneOption({
    Request: TaskRequest,
    Result: TaskRowSchema,
    execute: ({ taskId }) => sql`
      SELECT
        task_id AS "taskId", project_id AS "projectId", thread_id AS "threadId",
        parent_task_id AS "parentTaskId", assignee_kind AS "assigneeKind",
        assignee_id AS "assigneeId", mode, status, prompt_digest AS "promptDigest",
        depends_on_task_ids_json AS "dependsOnTaskIds", created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_tasks WHERE task_id = ${taskId} LIMIT 1
    `,
  });

  const listTaskRows = SqlSchema.findAll({
    Request: TaskListRequest,
    Result: TaskRowSchema,
    execute: ({ projectId }) =>
      projectId === null
        ? sql`
            SELECT
              task_id AS "taskId", project_id AS "projectId", thread_id AS "threadId",
              parent_task_id AS "parentTaskId", assignee_kind AS "assigneeKind",
              assignee_id AS "assigneeId", mode, status, prompt_digest AS "promptDigest",
              depends_on_task_ids_json AS "dependsOnTaskIds", created_at_unix_ms AS "createdAtUnixMs",
              updated_at_unix_ms AS "updatedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
            FROM composition_tasks
            ORDER BY updated_at_unix_ms DESC, task_id ASC
          `
        : sql`
            SELECT
              task_id AS "taskId", project_id AS "projectId", thread_id AS "threadId",
              parent_task_id AS "parentTaskId", assignee_kind AS "assigneeKind",
              assignee_id AS "assigneeId", mode, status, prompt_digest AS "promptDigest",
              depends_on_task_ids_json AS "dependsOnTaskIds", created_at_unix_ms AS "createdAtUnixMs",
              updated_at_unix_ms AS "updatedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
            FROM composition_tasks
            WHERE project_id = ${projectId}
            ORDER BY updated_at_unix_ms DESC, task_id ASC
          `,
  });

  const upsertRunRow = SqlSchema.void({
    Request: Schema.Struct({
      ...RunRowSchema.fields,
      capabilityGrantIds: Schema.Array(Schema.String),
    }),
    execute: (run) => sql`
      INSERT INTO composition_task_runs (
        run_id, task_id, agent_id, runtime_id, runtime_task_id, capability_handshake_id, status, attempt,
        capability_grant_ids_json, lease_id, started_at_unix_ms, last_runtime_event_at_unix_ms,
        cancel_requested_at_unix_ms, finished_at_unix_ms,
        failure_code, result_summary
      ) VALUES (
        ${run.runId}, ${run.taskId}, ${run.agentId}, ${run.runtimeId}, ${run.runtimeTaskId},
        ${run.capabilityHandshakeId},
        ${run.status}, ${run.attempt}, ${encodeStringArray(run.capabilityGrantIds)},
        ${run.leaseId}, ${run.startedAtUnixMs}, ${run.lastRuntimeEventAtUnixMs},
        ${run.cancelRequestedAtUnixMs}, ${run.finishedAtUnixMs},
        ${run.failureCode}, ${run.resultSummary}
      )
      ON CONFLICT (run_id) DO UPDATE SET
        task_id = excluded.task_id, agent_id = excluded.agent_id, runtime_id = excluded.runtime_id,
        runtime_task_id = excluded.runtime_task_id,
        capability_handshake_id = excluded.capability_handshake_id,
        status = excluded.status, attempt = excluded.attempt,
        capability_grant_ids_json = excluded.capability_grant_ids_json,
        lease_id = excluded.lease_id, started_at_unix_ms = excluded.started_at_unix_ms,
        last_runtime_event_at_unix_ms = excluded.last_runtime_event_at_unix_ms,
        cancel_requested_at_unix_ms = excluded.cancel_requested_at_unix_ms,
        finished_at_unix_ms = excluded.finished_at_unix_ms, failure_code = excluded.failure_code,
        result_summary = excluded.result_summary
    `,
  });

  const getRunRow = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: RunRowSchema,
    execute: ({ id }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId", runtime_id AS "runtimeId",
        runtime_task_id AS "runtimeTaskId", capability_handshake_id AS "capabilityHandshakeId",
        status, attempt,
        capability_grant_ids_json AS "capabilityGrantIds", lease_id AS "leaseId",
        started_at_unix_ms AS "startedAtUnixMs",
        last_runtime_event_at_unix_ms AS "lastRuntimeEventAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        failure_code AS "failureCode", result_summary AS "resultSummary"
      FROM composition_task_runs WHERE run_id = ${id} LIMIT 1
    `,
  });

  const getLatestRunRow = SqlSchema.findOneOption({
    Request: TaskRequest,
    Result: RunRowSchema,
    execute: ({ taskId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId", runtime_id AS "runtimeId",
        runtime_task_id AS "runtimeTaskId", capability_handshake_id AS "capabilityHandshakeId",
        status, attempt,
        capability_grant_ids_json AS "capabilityGrantIds", lease_id AS "leaseId",
        started_at_unix_ms AS "startedAtUnixMs",
        last_runtime_event_at_unix_ms AS "lastRuntimeEventAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        failure_code AS "failureCode", result_summary AS "resultSummary"
      FROM composition_task_runs
      WHERE task_id = ${taskId}
      ORDER BY attempt DESC, rowid DESC
      LIMIT 1
    `,
  });

  const listRunsByRuntimeTaskRows = SqlSchema.findAll({
    Request: RuntimeTaskRequest,
    Result: RunRowSchema,
    execute: ({ runtimeId, runtimeTaskId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId", runtime_id AS "runtimeId",
        runtime_task_id AS "runtimeTaskId", capability_handshake_id AS "capabilityHandshakeId",
        status, attempt,
        capability_grant_ids_json AS "capabilityGrantIds", lease_id AS "leaseId",
        started_at_unix_ms AS "startedAtUnixMs",
        last_runtime_event_at_unix_ms AS "lastRuntimeEventAtUnixMs",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        failure_code AS "failureCode", result_summary AS "resultSummary"
      FROM composition_task_runs
      WHERE runtime_id = ${runtimeId} AND runtime_task_id = ${runtimeTaskId}
      ORDER BY attempt ASC, run_id ASC
    `,
  });

  const createMulticaQuickCreateIntentRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      runtimeId: Schema.String,
      idempotencyKey: Schema.String,
      createdAtUnixMs: Schema.Number,
      updatedAtUnixMs: Schema.Number,
    }),
    Result: Schema.Struct({ created: Schema.Number }),
    execute: (intent) => sql`
      INSERT INTO composition_multica_quick_create_intents (
        run_id, task_id, runtime_id, idempotency_key, state,
        remote_task_id, created_at_unix_ms, updated_at_unix_ms
      ) VALUES (
        ${intent.runId}, ${intent.taskId}, ${intent.runtimeId}, ${intent.idempotencyKey}, 'prepared',
        NULL, ${intent.createdAtUnixMs}, ${intent.updatedAtUnixMs}
      ) ON CONFLICT DO NOTHING
      RETURNING 1 AS "created"
    `,
  });

  const getMulticaQuickCreateIntentRow = SqlSchema.findOneOption({
    Request: QuickCreateIntentRequest,
    Result: MulticaQuickCreateIntentRowSchema,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
        idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_multica_quick_create_intents
      WHERE run_id = ${runId}
      LIMIT 1
    `,
  });

  const getMulticaQuickCreateIntentByIdempotencyKeyRow = SqlSchema.findOneOption({
    Request: QuickCreateIntentIdempotencyRequest,
    Result: MulticaQuickCreateIntentRowSchema,
    execute: ({ runtimeId, idempotencyKey }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
        idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_multica_quick_create_intents
      WHERE runtime_id = ${runtimeId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `,
  });

  const claimMulticaQuickCreateIntentRow = SqlSchema.findOneOption({
    Request: QuickCreateIntentClaimRequest,
    Result: MulticaQuickCreateIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_multica_quick_create_intents
      SET state = 'sending', updated_at_unix_ms = ${input.updatedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND runtime_id = ${input.runtimeId}
        AND state = 'prepared'
        AND remote_task_id IS NULL
      RETURNING
        run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
        idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const acceptMulticaQuickCreateIntentRow = SqlSchema.findOneOption({
    Request: QuickCreateIntentAcceptRequest,
    Result: MulticaQuickCreateIntentRowSchema,
    execute: (input) => sql`
      UPDATE composition_multica_quick_create_intents
      SET state = 'accepted', remote_task_id = ${input.remoteTaskId},
        updated_at_unix_ms = ${input.updatedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND runtime_id = ${input.runtimeId}
        AND state = 'sending'
        AND remote_task_id IS NULL
      RETURNING
        run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
        idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const listPendingMulticaQuickCreateIntentRows = SqlSchema.findAll({
    Request: QuickCreateIntentListRequest,
    Result: MulticaQuickCreateIntentRowSchema,
    execute: ({ runtimeId }) =>
      runtimeId === null
        ? sql`
            SELECT
              run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
              idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
              created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
            FROM composition_multica_quick_create_intents
            WHERE state IN ('prepared', 'sending')
            ORDER BY updated_at_unix_ms ASC, run_id ASC
          `
        : sql`
            SELECT
              run_id AS "runId", task_id AS "taskId", runtime_id AS "runtimeId",
              idempotency_key AS "idempotencyKey", state, remote_task_id AS "remoteTaskId",
              created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
            FROM composition_multica_quick_create_intents
            WHERE runtime_id = ${runtimeId} AND state IN ('prepared', 'sending')
            ORDER BY updated_at_unix_ms ASC, run_id ASC
          `,
  });

  const appendEventRow = SqlSchema.void({
    Request: Schema.Struct({
      ...EventRowSchema.fields,
      childTaskIds: Schema.optional(Schema.Array(Schema.String)),
    }),
    execute: (event) => sql`
      INSERT INTO composition_task_events (
        task_id, run_id, source_event_id, parent_task_id, agent_id, runtime_id, status, sequence,
        event_type, summary, progress, blocker_code, approval_request_id, child_task_ids_json,
        output_delta, output_offset_bytes, output_digest
      ) VALUES (
        ${event.taskId}, ${event.runId}, ${event.sourceEventId}, ${event.parentTaskId}, ${event.agentId}, ${event.runtimeId},
        ${event.status}, ${event.sequence}, ${event.eventType}, ${event.summary}, ${event.progress},
        ${event.blockerCode}, ${event.approvalRequestId},
        ${event.childTaskIds === undefined ? null : encodeStringArray(event.childTaskIds)},
        ${event.outputDelta}, ${event.outputOffsetBytes}, ${event.outputDigest}
      )
    `,
  });

  const appendEventIfNewRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      ...EventRowSchema.fields,
      sourceEventId: Schema.String,
      childTaskIds: Schema.optional(Schema.Array(Schema.String)),
    }),
    Result: Schema.Struct({ rowId: Schema.Number }),
    execute: (event) => sql`
      INSERT INTO composition_task_events (
        task_id, run_id, source_event_id, parent_task_id, agent_id, runtime_id, status, sequence,
        event_type, summary, progress, blocker_code, approval_request_id, child_task_ids_json,
        output_delta, output_offset_bytes, output_digest
      ) VALUES (
        ${event.taskId}, ${event.runId}, ${event.sourceEventId}, ${event.parentTaskId}, ${event.agentId}, ${event.runtimeId},
        ${event.status},
        COALESCE(
          (
            SELECT MAX(sequence) + 1
            FROM composition_task_events
            WHERE task_id = ${event.taskId} AND run_id = ${event.runId}
          ),
          0
        ),
        ${event.eventType}, ${event.summary}, ${event.progress},
        ${event.blockerCode}, ${event.approvalRequestId},
        ${event.childTaskIds === undefined ? null : encodeStringArray(event.childTaskIds)},
        ${event.outputDelta}, ${event.outputOffsetBytes}, ${event.outputDigest}
      )
      ON CONFLICT (task_id, run_id, source_event_id) WHERE source_event_id IS NOT NULL DO NOTHING
      RETURNING row_id AS "rowId"
    `,
  });

  const findEventBySourceRow = SqlSchema.findOneOption({
    Request: EventSourceRequest,
    Result: Schema.Struct({ rowId: Schema.Number }),
    execute: ({ taskId, runId, sourceEventId }) => sql`
      SELECT row_id AS "rowId"
      FROM composition_task_events
      WHERE task_id = ${taskId} AND run_id = ${runId} AND source_event_id = ${sourceEventId}
      LIMIT 1
    `,
  });

  const listEventRows = SqlSchema.findAll({
    Request: EventListRequest,
    Result: EventRowSchema,
    execute: ({ taskId, runId }) => sql`
      SELECT
        task_id AS "taskId", run_id AS "runId", source_event_id AS "sourceEventId",
        parent_task_id AS "parentTaskId",
        agent_id AS "agentId", runtime_id AS "runtimeId", status, sequence,
        event_type AS "eventType", summary, progress, blocker_code AS "blockerCode",
        approval_request_id AS "approvalRequestId", child_task_ids_json AS "childTaskIds",
        output_delta AS "outputDelta", output_offset_bytes AS "outputOffsetBytes",
        output_digest AS "outputDigest"
      FROM composition_task_events
      WHERE task_id = ${taskId} AND run_id = ${runId}
      ORDER BY sequence ASC
    `,
  });

  const upsertDependencyRow = SqlSchema.void({
    Request: Schema.Struct({
      taskId: Schema.String,
      dependsOnTaskId: Schema.String,
      condition: Schema.String,
      createdAtUnixMs: Schema.Number,
    }),
    execute: (dependency) => sql`
      INSERT INTO composition_task_dependencies (
        task_id, depends_on_task_id, condition, created_at_unix_ms
      ) VALUES (
        ${dependency.taskId}, ${dependency.dependsOnTaskId}, ${dependency.condition},
        ${dependency.createdAtUnixMs}
      ) ON CONFLICT (task_id, depends_on_task_id) DO UPDATE SET
        condition = excluded.condition,
        created_at_unix_ms = excluded.created_at_unix_ms
    `,
  });

  const listDependencyRows = SqlSchema.findAll({
    Request: TaskRequest,
    Result: DependencyRowSchema,
    execute: ({ taskId }) => sql`
      SELECT task_id AS "taskId", depends_on_task_id AS "dependsOnTaskId",
        condition, created_at_unix_ms AS "createdAtUnixMs"
      FROM composition_task_dependencies WHERE task_id = ${taskId}
      ORDER BY created_at_unix_ms ASC, depends_on_task_id ASC
    `,
  });

  const upsertLeaseRow = SqlSchema.void({
    Request: Schema.Struct(LeaseRowSchema.fields),
    execute: (lease) => sql`
      INSERT INTO composition_runtime_leases (
        lease_id, runtime_id, task_id, workspace_root_digest,
        heartbeat_at_unix_ms, expires_at_unix_ms, state
      ) VALUES (
        ${lease.leaseId}, ${lease.runtimeId}, ${lease.taskId}, ${lease.workspaceRootDigest},
        ${lease.heartbeatAtUnixMs}, ${lease.expiresAtUnixMs}, ${lease.state}
      ) ON CONFLICT (lease_id) DO UPDATE SET
        runtime_id = excluded.runtime_id, task_id = excluded.task_id,
        workspace_root_digest = excluded.workspace_root_digest,
        heartbeat_at_unix_ms = excluded.heartbeat_at_unix_ms,
        expires_at_unix_ms = excluded.expires_at_unix_ms, state = excluded.state
    `,
  });

  const getLeaseRow = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: LeaseRowSchema,
    execute: ({ id }) => sql`
      SELECT lease_id AS "leaseId", runtime_id AS "runtimeId", task_id AS "taskId",
        workspace_root_digest AS "workspaceRootDigest", heartbeat_at_unix_ms AS "heartbeatAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", state
      FROM composition_runtime_leases WHERE lease_id = ${id} LIMIT 1
    `,
  });

  const claimLeaseRow = SqlSchema.findOneOption({
    Request: LeaseClaimRequest,
    Result: LeaseRowSchema,
    execute: (lease) => sql`
      INSERT INTO composition_runtime_leases (
        lease_id, runtime_id, task_id, workspace_root_digest,
        heartbeat_at_unix_ms, expires_at_unix_ms, state
      )
      SELECT
        ${lease.leaseId}, ${lease.runtimeId}, ${lease.taskId}, ${lease.workspaceRootDigest},
        ${lease.heartbeatAtUnixMs}, ${lease.expiresAtUnixMs}, ${lease.state}
      WHERE ${lease.state} = 'active'
        AND (
          ${lease.heartbeatAtUnixMs} >= ${lease.nowUnixMs}
          OR EXISTS (
            SELECT 1 FROM composition_runtime_leases
            WHERE lease_id = ${lease.leaseId}
              AND runtime_id = ${lease.runtimeId}
              AND task_id = ${lease.taskId}
              AND workspace_root_digest = ${lease.workspaceRootDigest}
              AND heartbeat_at_unix_ms = ${lease.heartbeatAtUnixMs}
              AND expires_at_unix_ms = ${lease.expiresAtUnixMs}
              AND state = 'active'
              AND expires_at_unix_ms > ${lease.nowUnixMs}
          )
        )
        AND ${lease.expiresAtUnixMs} > ${lease.heartbeatAtUnixMs}
        AND ${lease.expiresAtUnixMs} > ${lease.nowUnixMs}
        AND NOT EXISTS (
          SELECT 1 FROM composition_runtime_leases
          WHERE workspace_root_digest = ${lease.workspaceRootDigest}
            AND state = 'active'
            AND expires_at_unix_ms > ${lease.nowUnixMs}
            AND lease_id <> ${lease.leaseId}
        )
      ON CONFLICT (lease_id) DO UPDATE SET lease_id = excluded.lease_id
      WHERE composition_runtime_leases.runtime_id = excluded.runtime_id
        AND composition_runtime_leases.task_id = excluded.task_id
        AND composition_runtime_leases.workspace_root_digest = excluded.workspace_root_digest
        AND composition_runtime_leases.heartbeat_at_unix_ms = excluded.heartbeat_at_unix_ms
        AND composition_runtime_leases.expires_at_unix_ms = excluded.expires_at_unix_ms
        AND composition_runtime_leases.state = 'active'
        AND composition_runtime_leases.expires_at_unix_ms > ${lease.nowUnixMs}
      RETURNING
        lease_id AS "leaseId", runtime_id AS "runtimeId", task_id AS "taskId",
        workspace_root_digest AS "workspaceRootDigest",
        heartbeat_at_unix_ms AS "heartbeatAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", state
    `,
  });

  const renewLeaseRow = SqlSchema.findOneOption({
    Request: LeaseRenewRequest,
    Result: LeaseRowSchema,
    execute: (input) => sql`
      UPDATE composition_runtime_leases
      SET heartbeat_at_unix_ms = ${input.heartbeatAtUnixMs},
        expires_at_unix_ms = ${input.expiresAtUnixMs}
      WHERE lease_id = ${input.leaseId}
        AND runtime_id = ${input.runtimeId}
        AND state = 'active'
        AND expires_at_unix_ms > ${input.nowUnixMs}
        AND heartbeat_at_unix_ms <= ${input.heartbeatAtUnixMs}
        AND expires_at_unix_ms <= ${input.expiresAtUnixMs}
        AND ${input.heartbeatAtUnixMs} >= ${input.nowUnixMs}
        AND ${input.expiresAtUnixMs} > ${input.heartbeatAtUnixMs}
      RETURNING
        lease_id AS "leaseId", runtime_id AS "runtimeId", task_id AS "taskId",
        workspace_root_digest AS "workspaceRootDigest",
        heartbeat_at_unix_ms AS "heartbeatAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", state
    `,
  });

  const releaseLeaseRow = SqlSchema.findOneOption({
    Request: LeaseReleaseRequest,
    Result: LeaseRowSchema,
    execute: (input) => sql`
      UPDATE composition_runtime_leases
      SET heartbeat_at_unix_ms = CASE
          WHEN state = 'active' THEN MAX(heartbeat_at_unix_ms, ${input.releasedAtUnixMs})
          ELSE heartbeat_at_unix_ms
        END,
        state = 'released'
      WHERE lease_id = ${input.leaseId}
        AND runtime_id = ${input.runtimeId}
        AND (
          state = 'released'
          OR (state = 'active' AND expires_at_unix_ms > ${input.releasedAtUnixMs})
        )
      RETURNING
        lease_id AS "leaseId", runtime_id AS "runtimeId", task_id AS "taskId",
        workspace_root_digest AS "workspaceRootDigest",
        heartbeat_at_unix_ms AS "heartbeatAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", state
    `,
  });

  const reclaimExpiredLeaseRows = SqlSchema.findAll({
    Request: LeaseReclaimRequest,
    Result: LeaseRowSchema,
    execute: (input) => sql`
      UPDATE composition_runtime_leases
      SET state = 'expired'
      WHERE state = 'active' AND expires_at_unix_ms <= ${input.nowUnixMs}
      RETURNING
        lease_id AS "leaseId", runtime_id AS "runtimeId", task_id AS "taskId",
        workspace_root_digest AS "workspaceRootDigest",
        heartbeat_at_unix_ms AS "heartbeatAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", state
    `,
  });

  const SquadWriteRequest = Schema.Struct({
    squadId: Schema.String,
    name: Schema.String,
    leaderAgentId: Schema.String,
    memberAgentIds: Schema.Array(Schema.String),
    instructions: Schema.NullOr(Schema.String),
    revision: Schema.Number,
    configurationJson: Schema.NullOr(Schema.String),
    createdAtUnixMs: Schema.Number,
    updatedAtUnixMs: Schema.Number,
    revisionCreatedAtUnixMs: Schema.Number,
    archivedAtUnixMs: Schema.NullOr(Schema.Number),
  });
  const upsertSquadRevisionRow = SqlSchema.findOneOption({
    Request: SquadWriteRequest,
    Result: Schema.Struct({ squadId: Schema.String }),
    execute: (squad) => sql`
      INSERT INTO composition_squad_revisions (
        squad_id, revision, configuration_json, created_at_unix_ms
      ) VALUES (
        ${squad.squadId}, ${squad.revision}, ${squad.configurationJson},
        ${squad.revisionCreatedAtUnixMs}
      ) ON CONFLICT (squad_id, revision) DO UPDATE SET
        squad_id = excluded.squad_id
      WHERE composition_squad_revisions.configuration_json IS excluded.configuration_json
        AND composition_squad_revisions.created_at_unix_ms = excluded.created_at_unix_ms
      RETURNING squad_id AS "squadId"
    `,
  });
  const upsertSquadRow = SqlSchema.findOneOption({
    Request: SquadWriteRequest,
    Result: SquadRowSchema,
    execute: (squad) => sql`
      INSERT INTO composition_squads (
        squad_id, name, leader_agent_id, member_agent_ids_json, instructions,
        revision, configuration_json, created_at_unix_ms, updated_at_unix_ms,
        archived_at_unix_ms
      ) SELECT
        ${squad.squadId}, ${squad.name}, ${squad.leaderAgentId},
        ${encodeStringArray(squad.memberAgentIds)}, ${squad.instructions},
        ${squad.revision}, ${squad.configurationJson}, ${squad.createdAtUnixMs},
        ${squad.updatedAtUnixMs}, ${squad.archivedAtUnixMs}
      WHERE ${squad.revision} = 1
        OR EXISTS (
          SELECT 1 FROM composition_squads WHERE squad_id = ${squad.squadId}
        )
      ON CONFLICT (squad_id) DO UPDATE SET
        name = excluded.name, leader_agent_id = excluded.leader_agent_id,
        member_agent_ids_json = excluded.member_agent_ids_json,
        instructions = excluded.instructions, revision = excluded.revision,
        configuration_json = excluded.configuration_json,
        created_at_unix_ms = excluded.created_at_unix_ms,
        updated_at_unix_ms = excluded.updated_at_unix_ms,
        archived_at_unix_ms = excluded.archived_at_unix_ms
      WHERE (
          excluded.revision = composition_squads.revision + 1
          AND excluded.created_at_unix_ms = composition_squads.created_at_unix_ms
        ) OR (
          excluded.revision = composition_squads.revision
          AND excluded.name = composition_squads.name
          AND excluded.leader_agent_id = composition_squads.leader_agent_id
          AND excluded.member_agent_ids_json = composition_squads.member_agent_ids_json
          AND excluded.instructions IS composition_squads.instructions
          AND excluded.configuration_json IS composition_squads.configuration_json
          AND excluded.created_at_unix_ms = composition_squads.created_at_unix_ms
          AND excluded.updated_at_unix_ms = composition_squads.updated_at_unix_ms
          AND excluded.archived_at_unix_ms IS composition_squads.archived_at_unix_ms
        )
      RETURNING
        squad_id AS "squadId", name, leader_agent_id AS "leaderAgentId",
        member_agent_ids_json AS "memberAgentIds", instructions, revision,
        configuration_json AS "configuration",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        archived_at_unix_ms AS "archivedAtUnixMs"
    `,
  });

  const getSquadRow = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: SquadRowSchema,
    execute: ({ id }) => sql`
      SELECT squad_id AS "squadId", name, leader_agent_id AS "leaderAgentId",
        member_agent_ids_json AS "memberAgentIds", instructions, revision,
        configuration_json AS "configuration",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        archived_at_unix_ms AS "archivedAtUnixMs"
      FROM composition_squads WHERE squad_id = ${id} LIMIT 1
    `,
  });
  const listSquadRows = SqlSchema.findAll({
    Request: SquadListRequest,
    Result: SquadRowSchema,
    execute: ({ includeArchived }) => sql`
      SELECT squad_id AS "squadId", name, leader_agent_id AS "leaderAgentId",
        member_agent_ids_json AS "memberAgentIds", instructions, revision,
        configuration_json AS "configuration",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        archived_at_unix_ms AS "archivedAtUnixMs"
      FROM composition_squads
      WHERE ${includeArchived} = 1 OR archived_at_unix_ms IS NULL
      ORDER BY updated_at_unix_ms DESC, squad_id ASC
    `,
  });
  const listSquadRevisionRows = SqlSchema.findAll({
    Request: SquadRevisionListRequest,
    Result: SquadRevisionRowSchema,
    execute: ({ squadId }) => sql`
      SELECT squad_id AS "squadId", revision,
        configuration_json AS "configuration",
        created_at_unix_ms AS "createdAtUnixMs"
      FROM composition_squad_revisions
      WHERE squad_id = ${squadId}
      ORDER BY revision ASC
    `,
  });

  type CompositionTaskSqlError = SqlError | Schema.SchemaError;
  const run = <A>(operation: string, effect: Effect.Effect<A, CompositionTaskSqlError>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError(operation)));

  const store: CompositionTaskStoreShape = {
    upsertTask: (task) =>
      run(
        "CompositionTaskStore.upsertTask",
        upsertTaskRow({
          ...task,
          threadId: task.threadId ?? null,
          parentTaskId: task.parentTaskId ?? null,
          finishedAtUnixMs: task.finishedAtUnixMs ?? null,
        }).pipe(Effect.as(task)),
      ),
    getTask: (taskId) =>
      run(
        "CompositionTaskStore.getTask",
        getTaskRow({ taskId }).pipe(Effect.map(Option.map(toTask))),
      ),
    listTasks: (projectId) =>
      run(
        "CompositionTaskStore.listTasks",
        listTaskRows({ projectId: projectId ?? null }).pipe(Effect.map((rows) => rows.map(toTask))),
      ),
    upsertRun: (runValue) =>
      run(
        "CompositionTaskStore.upsertRun",
        upsertRunRow({
          ...runValue,
          runtimeTaskId: runValue.runtimeTaskId ?? null,
          capabilityHandshakeId: runValue.capabilityHandshakeId ?? null,
          capabilityGrantIds: [...(runValue.capabilityGrantIds ?? [])],
          leaseId: runValue.leaseId ?? null,
          startedAtUnixMs: runValue.startedAtUnixMs ?? null,
          lastRuntimeEventAtUnixMs: runValue.lastRuntimeEventAtUnixMs ?? null,
          cancelRequestedAtUnixMs: runValue.cancelRequestedAtUnixMs ?? null,
          finishedAtUnixMs: runValue.finishedAtUnixMs ?? null,
          failureCode: runValue.failureCode ?? null,
          resultSummary: runValue.resultSummary ?? null,
        }).pipe(Effect.as(runValue)),
      ),
    getRun: (runId) =>
      run(
        "CompositionTaskStore.getRun",
        getRunRow({ id: runId }).pipe(Effect.map(Option.map(toRun))),
      ),
    getLatestRun: (taskId) =>
      run(
        "CompositionTaskStore.getLatestRun",
        getLatestRunRow({ taskId }).pipe(Effect.map(Option.map(toRun))),
      ),
    listRunsByRuntimeTask: (runtimeId, runtimeTaskId) =>
      run(
        "CompositionTaskStore.listRunsByRuntimeTask",
        listRunsByRuntimeTaskRows({ runtimeId, runtimeTaskId }).pipe(
          Effect.map((rows) => rows.map(toRun)),
        ),
      ),
    createMulticaQuickCreateIntent: (intent) =>
      run(
        "CompositionTaskStore.createMulticaQuickCreateIntent",
        createMulticaQuickCreateIntentRow(intent).pipe(Effect.map(Option.isSome)),
      ),
    getMulticaQuickCreateIntent: (runId) =>
      run(
        "CompositionTaskStore.getMulticaQuickCreateIntent",
        getMulticaQuickCreateIntentRow({ runId }).pipe(
          Effect.map(Option.map(toMulticaQuickCreateIntent)),
        ),
      ),
    getMulticaQuickCreateIntentByIdempotencyKey: (runtimeId, idempotencyKey) =>
      run(
        "CompositionTaskStore.getMulticaQuickCreateIntentByIdempotencyKey",
        getMulticaQuickCreateIntentByIdempotencyKeyRow({ runtimeId, idempotencyKey }).pipe(
          Effect.map(Option.map(toMulticaQuickCreateIntent)),
        ),
      ),
    claimMulticaQuickCreateIntentForSend: (input) =>
      run(
        "CompositionTaskStore.claimMulticaQuickCreateIntentForSend",
        claimMulticaQuickCreateIntentRow(input).pipe(
          Effect.map(Option.map(toMulticaQuickCreateIntent)),
        ),
      ),
    acceptMulticaQuickCreateIntent: (input) =>
      run(
        "CompositionTaskStore.acceptMulticaQuickCreateIntent",
        acceptMulticaQuickCreateIntentRow(input).pipe(
          Effect.map(Option.map(toMulticaQuickCreateIntent)),
        ),
      ),
    listPendingMulticaQuickCreateIntents: (runtimeId) =>
      run(
        "CompositionTaskStore.listPendingMulticaQuickCreateIntents",
        listPendingMulticaQuickCreateIntentRows({ runtimeId: runtimeId ?? null }).pipe(
          Effect.map((rows) => rows.map(toMulticaQuickCreateIntent)),
        ),
      ),
    appendEvent: (event) =>
      Effect.gen(function* () {
        if (event.sourceEventId !== undefined) {
          const existing = yield* run(
            "CompositionTaskStore.findEventBySource",
            findEventBySourceRow({
              taskId: event.taskId,
              runId: event.runId,
              sourceEventId: event.sourceEventId,
            }),
          );
          if (Option.isSome(existing)) return event;
        }
        return yield* run(
          "CompositionTaskStore.appendEvent",
          appendEventRow({
            ...event,
            sourceEventId: event.sourceEventId ?? null,
            parentTaskId: event.parentTaskId ?? null,
            runtimeId: event.runtimeId ?? null,
            progress: event.progress ?? null,
            blockerCode: event.blockerCode ?? null,
            approvalRequestId: event.approvalRequestId ?? null,
            outputDelta: event.outputDelta ?? null,
            outputOffsetBytes: event.outputOffsetBytes ?? null,
            outputDigest: event.outputDigest ?? null,
          }).pipe(Effect.as(event)),
        );
      }),
    appendEventIfNew: (event) =>
      run(
        "CompositionTaskStore.appendEventIfNew",
        appendEventIfNewRow({
          ...event,
          parentTaskId: event.parentTaskId ?? null,
          runtimeId: event.runtimeId ?? null,
          progress: event.progress ?? null,
          blockerCode: event.blockerCode ?? null,
          approvalRequestId: event.approvalRequestId ?? null,
          outputDelta: event.outputDelta ?? null,
          outputOffsetBytes: event.outputOffsetBytes ?? null,
          outputDigest: event.outputDigest ?? null,
        }).pipe(Effect.map(Option.isSome)),
      ),
    withTransaction: (effect) =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(toPersistenceSqlError("CompositionTaskStore.withTransaction")(cause)),
          ),
        ),
    listEvents: (taskId, runId) =>
      run(
        "CompositionTaskStore.listEvents",
        listEventRows({ taskId, runId }).pipe(Effect.map((rows) => rows.map(toEvent))),
      ),
    upsertDependency: (dependency) =>
      run(
        "CompositionTaskStore.upsertDependency",
        upsertDependencyRow(dependency).pipe(Effect.as(dependency)),
      ),
    listDependencies: (taskId) =>
      run(
        "CompositionTaskStore.listDependencies",
        listDependencyRows({ taskId }).pipe(Effect.map((rows) => rows.map(toDependency))),
      ),
    upsertLease: (lease) =>
      run("CompositionTaskStore.upsertLease", upsertLeaseRow(lease).pipe(Effect.as(lease))),
    getLease: (leaseId) =>
      run(
        "CompositionTaskStore.getLease",
        getLeaseRow({ id: leaseId }).pipe(Effect.map(Option.map(toLease))),
      ),
    claimLease: ({ lease, nowUnixMs }) =>
      run(
        "CompositionTaskStore.claimLease",
        claimLeaseRow({ ...lease, nowUnixMs }).pipe(Effect.map(Option.map(toLease))),
      ),
    renewLease: (input) =>
      run(
        "CompositionTaskStore.renewLease",
        renewLeaseRow(input).pipe(Effect.map(Option.map(toLease))),
      ),
    releaseLease: (input) =>
      run(
        "CompositionTaskStore.releaseLease",
        releaseLeaseRow(input).pipe(Effect.map(Option.map(toLease))),
      ),
    reclaimExpiredLeases: (input) =>
      run(
        "CompositionTaskStore.reclaimExpiredLeases",
        reclaimExpiredLeaseRows(input).pipe(
          Effect.map((rows) =>
            rows.map(toLease).sort((left, right) => left.leaseId.localeCompare(right.leaseId)),
          ),
        ),
      ),
    upsertSquad: (squad) => {
      const createdAtUnixMs = squad.createdAtUnixMs ?? 0;
      const updatedAtUnixMs = squad.updatedAtUnixMs ?? createdAtUnixMs;
      const input = {
        squadId: squad.squadId,
        name: squad.name,
        leaderAgentId: squad.leaderAgentId,
        memberAgentIds: squad.memberAgentIds,
        instructions: squad.instructions ?? null,
        revision: squad.revision ?? 1,
        configurationJson: squad.members === undefined ? null : encodeCompositionSquad(squad),
        createdAtUnixMs,
        updatedAtUnixMs,
        revisionCreatedAtUnixMs: updatedAtUnixMs,
        archivedAtUnixMs: squad.archivedAtUnixMs ?? null,
      };
      return sql
        .withTransaction(
          Effect.gen(function* () {
            const revision = yield* upsertSquadRevisionRow(input);
            if (Option.isNone(revision)) {
              return yield* new CompositionSquadRevisionWriteError({
                detail: "Squad revision 已存在且内容不一致。",
              });
            }
            const current = yield* upsertSquadRow(input);
            if (Option.isNone(current)) {
              return yield* new CompositionSquadRevisionWriteError({
                detail: "Squad revision 必须从 1 开始并连续递增。",
              });
            }
            return squad;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("CompositionTaskStore.upsertSquad")));
    },
    getSquad: (squadId) =>
      run(
        "CompositionTaskStore.getSquad",
        getSquadRow({ id: squadId }).pipe(Effect.map(Option.map(toSquad))),
      ),
    listSquads: (options) =>
      run(
        "CompositionTaskStore.listSquads",
        listSquadRows({ includeArchived: options?.includeArchived === true ? 1 : 0 }).pipe(
          Effect.map((rows) => rows.map(toSquad)),
        ),
      ),
    listSquadRevisions: (squadId) =>
      run(
        "CompositionTaskStore.listSquadRevisions",
        listSquadRevisionRows({ squadId }).pipe(Effect.map((rows) => rows.map(toSquadRevision))),
      ),
  };

  return store;
});

export const CompositionTaskStoreLive = Layer.effect(CompositionTaskStore, makeStore);
