import {
  COMPOSITION_AUTOMATION_RUN_HISTORY_MAX_LIMIT,
  CompositionAutomation as CompositionAutomationSchema,
  CompositionAutomationCadence,
  CompositionAutomationRun as CompositionAutomationRunSchema,
  CompositionAutomationRunStatus,
  CompositionAutomationStatus,
  CompositionAutomationTarget,
  type CompositionAutomation,
  type CompositionAutomationRun,
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
  CompositionAutomationStore,
  CompositionAutomationStoreDomainError,
  type CompositionAutomationRunClaimResult,
  type CompositionAutomationStoreErrorCode,
  type CompositionAutomationStoreShape,
} from "../Services/CompositionAutomationStore.ts";

const AutomationJson = Schema.fromJsonString(CompositionAutomationSchema);
const CadenceJson = Schema.fromJsonString(CompositionAutomationCadence);
const TargetJson = Schema.fromJsonString(CompositionAutomationTarget);
const RunJson = Schema.fromJsonString(CompositionAutomationRunSchema);
const encodeAutomation = Schema.encodeSync(AutomationJson);
const encodeCadence = Schema.encodeSync(CadenceJson);
const encodeTarget = Schema.encodeSync(TargetJson);
const encodeRun = Schema.encodeSync(RunJson);
const decodeAutomation = Schema.decodeUnknownEffect(CompositionAutomationSchema);
const decodeRun = Schema.decodeUnknownEffect(CompositionAutomationRunSchema);

const AutomationRowSchema = Schema.Struct({
  automationId: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cadence: CadenceJson,
  target: TargetJson,
  status: CompositionAutomationStatus,
  revision: Schema.Number,
  maxRuns: Schema.NullOr(Schema.Number),
  runCount: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  nextRunAtUnixMs: Schema.NullOr(Schema.Number),
  lastRunAtUnixMs: Schema.NullOr(Schema.Number),
  pausedAtUnixMs: Schema.NullOr(Schema.Number),
  expiresAtUnixMs: Schema.NullOr(Schema.Number),
});

const AutomationWriteSchema = Schema.Struct({
  automationId: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
  cadenceJson: Schema.String,
  targetJson: Schema.String,
  status: CompositionAutomationStatus,
  revision: Schema.Number,
  maxRuns: Schema.NullOr(Schema.Number),
  runCount: Schema.Number,
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  nextRunAtUnixMs: Schema.NullOr(Schema.Number),
  lastRunAtUnixMs: Schema.NullOr(Schema.Number),
  pausedAtUnixMs: Schema.NullOr(Schema.Number),
  expiresAtUnixMs: Schema.NullOr(Schema.Number),
});

const AutomationRevisionRowSchema = Schema.Struct({
  automationId: Schema.String,
  revision: Schema.Number,
  snapshot: AutomationJson,
  createdAtUnixMs: Schema.Number,
});

const AutomationRevisionWriteSchema = Schema.Struct({
  automationId: Schema.String,
  revision: Schema.Number,
  snapshotJson: Schema.String,
  createdAtUnixMs: Schema.Number,
});

const AutomationRunRowSchema = Schema.Struct({
  automationRunId: Schema.String,
  automationId: Schema.String,
  automationRevision: Schema.Number,
  scheduledForUnixMs: Schema.Number,
  idempotencyKey: Schema.String,
  trigger: Schema.Literals(["scheduled", "run_once", "retry", "recovery"]),
  status: CompositionAutomationRunStatus,
  attempt: Schema.Number,
  requestedAtUnixMs: Schema.Number,
  startedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
  compositionTaskId: Schema.NullOr(Schema.String),
  compositionRunId: Schema.NullOr(Schema.String),
  outputSummary: Schema.NullOr(Schema.String),
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
});

const AutomationIdRequest = Schema.Struct({ automationId: Schema.String });
const AutomationRevisionRequest = Schema.Struct({
  automationId: Schema.String,
  revision: Schema.Number,
});
const AutomationListRequest = Schema.Struct({
  projectId: Schema.NullOr(Schema.String),
  filterStatuses: Schema.Number,
  includeActive: Schema.Number,
  includePaused: Schema.Number,
  includeCompleted: Schema.Number,
});
const AutomationRevisionUpdateRequest = Schema.Struct({
  ...AutomationWriteSchema.fields,
  expectedRevision: Schema.Number,
});
const AutomationDeleteRequest = Schema.Struct({
  automationId: Schema.String,
  expectedRevision: Schema.Number,
});
const AutomationDeleteRow = Schema.Struct({ automationId: Schema.String });

const AutomationRunIdRequest = Schema.Struct({ automationRunId: Schema.String });
const AutomationRunIdentityRequest = Schema.Struct({
  automationId: Schema.String,
  scheduledForUnixMs: Schema.Number,
});
const AutomationRunTransitionRequest = Schema.Struct({
  ...AutomationRunRowSchema.fields,
  expectedStatus: CompositionAutomationRunStatus,
});
const AutomationRunHistoryRequest = Schema.Struct({
  automationId: Schema.String,
  cursorRequestedAtUnixMs: Schema.NullOr(Schema.Number),
  cursorAutomationRunId: Schema.NullOr(Schema.String),
  limit: Schema.Number,
});

const HistoryCursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  automationId: Schema.String,
  requestedAtUnixMs: Schema.Number,
  automationRunId: Schema.String,
});
const HistoryCursorJson = Schema.fromJsonString(HistoryCursorSchema);
const encodeHistoryCursorJson = Schema.encodeSync(HistoryCursorJson);
const decodeHistoryCursorJson = Schema.decodeUnknownSync(HistoryCursorJson);

type AutomationRow = Schema.Schema.Type<typeof AutomationRowSchema>;
type AutomationRevisionRow = Schema.Schema.Type<typeof AutomationRevisionRowSchema>;
type AutomationRunRow = Schema.Schema.Type<typeof AutomationRunRowSchema>;

const toAutomationCandidate = (row: AutomationRow): CompositionAutomation => ({
  automationId: row.automationId,
  projectId: row.projectId,
  name: row.name,
  prompt: row.prompt,
  cadence: row.cadence,
  target: row.target,
  status: row.status,
  revision: row.revision,
  maxRuns: row.maxRuns,
  runCount: row.runCount,
  createdAtUnixMs: row.createdAtUnixMs,
  updatedAtUnixMs: row.updatedAtUnixMs,
  nextRunAtUnixMs: row.nextRunAtUnixMs,
  lastRunAtUnixMs: row.lastRunAtUnixMs,
  pausedAtUnixMs: row.pausedAtUnixMs,
  expiresAtUnixMs: row.expiresAtUnixMs,
});

const toRunCandidate = (row: AutomationRunRow): CompositionAutomationRun => ({
  automationRunId: row.automationRunId,
  automationId: row.automationId,
  automationRevision: row.automationRevision,
  scheduledForUnixMs: row.scheduledForUnixMs,
  idempotencyKey: row.idempotencyKey,
  trigger: row.trigger,
  status: row.status,
  attempt: row.attempt,
  requestedAtUnixMs: row.requestedAtUnixMs,
  startedAtUnixMs: row.startedAtUnixMs,
  finishedAtUnixMs: row.finishedAtUnixMs,
  compositionTaskId: row.compositionTaskId,
  compositionRunId: row.compositionRunId,
  outputSummary: row.outputSummary,
  errorCode: row.errorCode,
  errorDetail: row.errorDetail,
});

const toAutomationWrite = (automation: CompositionAutomation) => ({
  automationId: automation.automationId,
  projectId: automation.projectId,
  name: automation.name,
  prompt: automation.prompt,
  cadenceJson: encodeCadence(automation.cadence),
  targetJson: encodeTarget(automation.target),
  status: automation.status,
  revision: automation.revision,
  maxRuns: automation.maxRuns,
  runCount: automation.runCount,
  createdAtUnixMs: automation.createdAtUnixMs,
  updatedAtUnixMs: automation.updatedAtUnixMs,
  nextRunAtUnixMs: automation.nextRunAtUnixMs,
  lastRunAtUnixMs: automation.lastRunAtUnixMs,
  pausedAtUnixMs: automation.pausedAtUnixMs,
  expiresAtUnixMs: automation.expiresAtUnixMs,
});

const toRevisionWrite = (automation: CompositionAutomation) => ({
  automationId: automation.automationId,
  revision: automation.revision,
  snapshotJson: encodeAutomation(automation),
  createdAtUnixMs: automation.updatedAtUnixMs,
});

const sameAutomation = (left: CompositionAutomation, right: CompositionAutomation): boolean =>
  encodeAutomation(left) === encodeAutomation(right);

const sameRun = (left: CompositionAutomationRun, right: CompositionAutomationRun): boolean =>
  encodeRun(left) === encodeRun(right);

const sameRunIdentity = (
  left: CompositionAutomationRun,
  right: CompositionAutomationRun,
): boolean =>
  left.automationRunId === right.automationRunId &&
  left.automationId === right.automationId &&
  left.automationRevision === right.automationRevision &&
  left.scheduledForUnixMs === right.scheduledForUnixMs &&
  left.idempotencyKey === right.idempotencyKey &&
  left.trigger === right.trigger &&
  left.attempt === right.attempt &&
  left.requestedAtUnixMs === right.requestedAtUnixMs;

const sameClaimIdentity = (
  existing: CompositionAutomationRun,
  requested: CompositionAutomationRun,
): boolean =>
  existing.automationId === requested.automationId &&
  existing.automationRevision === requested.automationRevision &&
  existing.scheduledForUnixMs === requested.scheduledForUnixMs &&
  existing.idempotencyKey === requested.idempotencyKey;

const domainError = (
  code: CompositionAutomationStoreErrorCode,
  automationId: string,
  detail: string,
  metadata: {
    readonly automationRunId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedStatus?: string;
    readonly actualStatus?: string;
  } = {},
): CompositionAutomationStoreDomainError =>
  new CompositionAutomationStoreDomainError({ code, automationId, detail, ...metadata });

const mapQueryError =
  (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
  (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const encodeHistoryCursor = (run: CompositionAutomationRun): string =>
  Buffer.from(
    encodeHistoryCursorJson({
      version: 1,
      automationId: run.automationId,
      requestedAtUnixMs: run.requestedAtUnixMs,
      automationRunId: run.automationRunId,
    }),
    "utf8",
  ).toString("base64url");

const decodeHistoryCursor = (automationId: string, encoded: string) =>
  Effect.try({
    try: () => {
      const cursor = decodeHistoryCursorJson(Buffer.from(encoded, "base64url").toString("utf8"));
      if (
        cursor.automationId !== automationId ||
        !Number.isSafeInteger(cursor.requestedAtUnixMs) ||
        cursor.requestedAtUnixMs < 0 ||
        cursor.automationRunId.length === 0
      ) {
        throw new Error("cursor scope or boundary is invalid");
      }
      return cursor;
    },
    catch: () =>
      domainError(
        "automation_history_cursor_invalid",
        automationId,
        "运行历史 cursor 无效、已损坏或属于其他 Automation。",
      ),
  });

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getAutomationRow = SqlSchema.findOneOption({
    Request: AutomationIdRequest,
    Result: AutomationRowSchema,
    execute: ({ automationId }) => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        name,
        prompt,
        cadence_json AS cadence,
        target_json AS target,
        status,
        revision,
        max_runs AS "maxRuns",
        run_count AS "runCount",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        next_run_at_unix_ms AS "nextRunAtUnixMs",
        last_run_at_unix_ms AS "lastRunAtUnixMs",
        paused_at_unix_ms AS "pausedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs"
      FROM composition_automations
      WHERE automation_id = ${automationId}
    `,
  });

  const listAutomationRows = SqlSchema.findAll({
    Request: AutomationListRequest,
    Result: AutomationRowSchema,
    execute: (request) => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        name,
        prompt,
        cadence_json AS cadence,
        target_json AS target,
        status,
        revision,
        max_runs AS "maxRuns",
        run_count AS "runCount",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        next_run_at_unix_ms AS "nextRunAtUnixMs",
        last_run_at_unix_ms AS "lastRunAtUnixMs",
        paused_at_unix_ms AS "pausedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs"
      FROM composition_automations
      WHERE (${request.projectId} IS NULL OR project_id = ${request.projectId})
        AND (
          ${request.filterStatuses} = 0 OR
          (status = 'active' AND ${request.includeActive} = 1) OR
          (status = 'paused' AND ${request.includePaused} = 1) OR
          (status = 'completed' AND ${request.includeCompleted} = 1)
        )
      ORDER BY updated_at_unix_ms DESC, automation_id ASC
    `,
  });

  const getRevisionRow = SqlSchema.findOneOption({
    Request: AutomationRevisionRequest,
    Result: AutomationRevisionRowSchema,
    execute: ({ automationId, revision }) => sql`
      SELECT
        automation_id AS "automationId",
        revision,
        snapshot_json AS snapshot,
        created_at_unix_ms AS "createdAtUnixMs"
      FROM composition_automation_revisions
      WHERE automation_id = ${automationId} AND revision = ${revision}
    `,
  });

  const insertRevisionRow = SqlSchema.findOneOption({
    Request: AutomationRevisionWriteSchema,
    Result: AutomationRevisionRowSchema,
    execute: (request) => sql`
      INSERT INTO composition_automation_revisions (
        automation_id, revision, snapshot_json, created_at_unix_ms
      ) VALUES (
        ${request.automationId}, ${request.revision}, ${request.snapshotJson},
        ${request.createdAtUnixMs}
      )
      ON CONFLICT (automation_id, revision) DO NOTHING
      RETURNING
        automation_id AS "automationId",
        revision,
        snapshot_json AS snapshot,
        created_at_unix_ms AS "createdAtUnixMs"
    `,
  });

  const insertAutomationRow = SqlSchema.findOneOption({
    Request: AutomationWriteSchema,
    Result: AutomationRowSchema,
    execute: (request) => sql`
      INSERT INTO composition_automations (
        automation_id, project_id, name, prompt, cadence_json, target_json,
        status, revision, max_runs, run_count,
        created_at_unix_ms, updated_at_unix_ms,
        next_run_at_unix_ms, last_run_at_unix_ms,
        paused_at_unix_ms, expires_at_unix_ms
      ) VALUES (
        ${request.automationId}, ${request.projectId}, ${request.name}, ${request.prompt},
        ${request.cadenceJson}, ${request.targetJson}, ${request.status}, ${request.revision},
        ${request.maxRuns}, ${request.runCount}, ${request.createdAtUnixMs},
        ${request.updatedAtUnixMs}, ${request.nextRunAtUnixMs}, ${request.lastRunAtUnixMs},
        ${request.pausedAtUnixMs}, ${request.expiresAtUnixMs}
      )
      ON CONFLICT (automation_id) DO NOTHING
      RETURNING
        automation_id AS "automationId",
        project_id AS "projectId",
        name,
        prompt,
        cadence_json AS cadence,
        target_json AS target,
        status,
        revision,
        max_runs AS "maxRuns",
        run_count AS "runCount",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        next_run_at_unix_ms AS "nextRunAtUnixMs",
        last_run_at_unix_ms AS "lastRunAtUnixMs",
        paused_at_unix_ms AS "pausedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs"
    `,
  });

  const updateAutomationRow = SqlSchema.findOneOption({
    Request: AutomationRevisionUpdateRequest,
    Result: AutomationRowSchema,
    execute: (request) => sql`
      UPDATE composition_automations
      SET
        project_id = ${request.projectId},
        name = ${request.name},
        prompt = ${request.prompt},
        cadence_json = ${request.cadenceJson},
        target_json = ${request.targetJson},
        status = ${request.status},
        revision = ${request.revision},
        max_runs = ${request.maxRuns},
        run_count = ${request.runCount},
        created_at_unix_ms = ${request.createdAtUnixMs},
        updated_at_unix_ms = ${request.updatedAtUnixMs},
        next_run_at_unix_ms = ${request.nextRunAtUnixMs},
        last_run_at_unix_ms = ${request.lastRunAtUnixMs},
        paused_at_unix_ms = ${request.pausedAtUnixMs},
        expires_at_unix_ms = ${request.expiresAtUnixMs}
      WHERE automation_id = ${request.automationId}
        AND revision = ${request.expectedRevision}
      RETURNING
        automation_id AS "automationId",
        project_id AS "projectId",
        name,
        prompt,
        cadence_json AS cadence,
        target_json AS target,
        status,
        revision,
        max_runs AS "maxRuns",
        run_count AS "runCount",
        created_at_unix_ms AS "createdAtUnixMs",
        updated_at_unix_ms AS "updatedAtUnixMs",
        next_run_at_unix_ms AS "nextRunAtUnixMs",
        last_run_at_unix_ms AS "lastRunAtUnixMs",
        paused_at_unix_ms AS "pausedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs"
    `,
  });

  const deleteAutomationRow = SqlSchema.findOneOption({
    Request: AutomationDeleteRequest,
    Result: AutomationDeleteRow,
    execute: ({ automationId, expectedRevision }) => sql`
      DELETE FROM composition_automations
      WHERE automation_id = ${automationId} AND revision = ${expectedRevision}
      RETURNING automation_id AS "automationId"
    `,
  });

  const getRunRow = SqlSchema.findOneOption({
    Request: AutomationRunIdRequest,
    Result: AutomationRunRowSchema,
    execute: ({ automationRunId }) => sql`
      SELECT
        automation_run_id AS "automationRunId",
        automation_id AS "automationId",
        automation_revision AS "automationRevision",
        scheduled_for_unix_ms AS "scheduledForUnixMs",
        idempotency_key AS "idempotencyKey",
        trigger,
        status,
        attempt,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        output_summary AS "outputSummary",
        error_code AS "errorCode",
        error_detail AS "errorDetail"
      FROM composition_automation_runs
      WHERE automation_run_id = ${automationRunId}
    `,
  });

  const getRunByIdentityRow = SqlSchema.findOneOption({
    Request: AutomationRunIdentityRequest,
    Result: AutomationRunRowSchema,
    execute: ({ automationId, scheduledForUnixMs }) => sql`
      SELECT
        automation_run_id AS "automationRunId",
        automation_id AS "automationId",
        automation_revision AS "automationRevision",
        scheduled_for_unix_ms AS "scheduledForUnixMs",
        idempotency_key AS "idempotencyKey",
        trigger,
        status,
        attempt,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        output_summary AS "outputSummary",
        error_code AS "errorCode",
        error_detail AS "errorDetail"
      FROM composition_automation_runs
      WHERE automation_id = ${automationId}
        AND scheduled_for_unix_ms = ${scheduledForUnixMs}
    `,
  });

  const insertRunRow = SqlSchema.findOneOption({
    Request: AutomationRunRowSchema,
    Result: AutomationRunRowSchema,
    execute: (run) => sql`
      INSERT INTO composition_automation_runs (
        automation_run_id, automation_id, automation_revision,
        scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
        requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
        composition_task_id, composition_run_id, output_summary,
        error_code, error_detail
      ) VALUES (
        ${run.automationRunId}, ${run.automationId}, ${run.automationRevision},
        ${run.scheduledForUnixMs}, ${run.idempotencyKey}, ${run.trigger}, ${run.status},
        ${run.attempt}, ${run.requestedAtUnixMs}, ${run.startedAtUnixMs},
        ${run.finishedAtUnixMs}, ${run.compositionTaskId}, ${run.compositionRunId},
        ${run.outputSummary}, ${run.errorCode}, ${run.errorDetail}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        automation_run_id AS "automationRunId",
        automation_id AS "automationId",
        automation_revision AS "automationRevision",
        scheduled_for_unix_ms AS "scheduledForUnixMs",
        idempotency_key AS "idempotencyKey",
        trigger,
        status,
        attempt,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        output_summary AS "outputSummary",
        error_code AS "errorCode",
        error_detail AS "errorDetail"
    `,
  });

  const updateRunRow = SqlSchema.findOneOption({
    Request: AutomationRunTransitionRequest,
    Result: AutomationRunRowSchema,
    execute: (run) => sql`
      UPDATE composition_automation_runs
      SET
        status = ${run.status},
        started_at_unix_ms = ${run.startedAtUnixMs},
        finished_at_unix_ms = ${run.finishedAtUnixMs},
        composition_task_id = ${run.compositionTaskId},
        composition_run_id = ${run.compositionRunId},
        output_summary = ${run.outputSummary},
        error_code = ${run.errorCode},
        error_detail = ${run.errorDetail}
      WHERE automation_run_id = ${run.automationRunId}
        AND status = ${run.expectedStatus}
      RETURNING
        automation_run_id AS "automationRunId",
        automation_id AS "automationId",
        automation_revision AS "automationRevision",
        scheduled_for_unix_ms AS "scheduledForUnixMs",
        idempotency_key AS "idempotencyKey",
        trigger,
        status,
        attempt,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        output_summary AS "outputSummary",
        error_code AS "errorCode",
        error_detail AS "errorDetail"
    `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: AutomationRunHistoryRequest,
    Result: AutomationRunRowSchema,
    execute: (request) => sql`
      SELECT
        automation_run_id AS "automationRunId",
        automation_id AS "automationId",
        automation_revision AS "automationRevision",
        scheduled_for_unix_ms AS "scheduledForUnixMs",
        idempotency_key AS "idempotencyKey",
        trigger,
        status,
        attempt,
        requested_at_unix_ms AS "requestedAtUnixMs",
        started_at_unix_ms AS "startedAtUnixMs",
        finished_at_unix_ms AS "finishedAtUnixMs",
        composition_task_id AS "compositionTaskId",
        composition_run_id AS "compositionRunId",
        output_summary AS "outputSummary",
        error_code AS "errorCode",
        error_detail AS "errorDetail"
      FROM composition_automation_runs
      WHERE automation_id = ${request.automationId}
        AND (
          ${request.cursorRequestedAtUnixMs} IS NULL OR
          requested_at_unix_ms < ${request.cursorRequestedAtUnixMs} OR
          (
            requested_at_unix_ms = ${request.cursorRequestedAtUnixMs} AND
            automation_run_id < ${request.cursorAutomationRunId}
          )
        )
      ORDER BY requested_at_unix_ms DESC, automation_run_id DESC
      LIMIT ${request.limit}
    `,
  });

  const query = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(toPersistenceSqlError("CompositionAutomationStore.withTransaction")(cause)),
        ),
      );

  const decodeAutomationRow = (operation: string, row: AutomationRow) =>
    decodeAutomation(toAutomationCandidate(row)).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:automation`)),
    );

  const decodeRunRow = (operation: string, row: AutomationRunRow) =>
    decodeRun(toRunCandidate(row)).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:run`)),
    );

  const readAutomation = (automationId: string) =>
    query("CompositionAutomationStore.getAutomation", getAutomationRow({ automationId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionAutomation>()),
          onSome: (row) =>
            decodeAutomationRow("CompositionAutomationStore.getAutomation", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const readRevision = (automationId: string, revision: number) =>
    query(
      "CompositionAutomationStore.getAutomationRevision",
      getRevisionRow({ automationId, revision }),
    ).pipe(Effect.map(Option.map((row: AutomationRevisionRow) => row.snapshot)));

  const readRun = (automationRunId: string) =>
    query("CompositionAutomationStore.getRun", getRunRow({ automationRunId })).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionAutomationRun>()),
          onSome: (row) =>
            decodeRunRow("CompositionAutomationStore.getRun", row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const readRunByIdentity = (automationId: string, scheduledForUnixMs: number) =>
    query(
      "CompositionAutomationStore.getRunByIdentity",
      getRunByIdentityRow({ automationId, scheduledForUnixMs }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionAutomationRun>()),
          onSome: (row) =>
            decodeRunRow("CompositionAutomationStore.getRunByIdentity", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const revisionConflict = (
    automationId: string,
    expectedRevision: number,
    actualRevision: number,
  ) =>
    domainError(
      "automation_revision_conflict",
      automationId,
      `预期 revision ${expectedRevision}，实际为 ${actualRevision}。`,
      { expectedRevision, actualRevision },
    );

  const createAutomation: CompositionAutomationStoreShape["createAutomation"] = (automation) => {
    if (automation.revision !== 1) {
      return Effect.fail(
        domainError(
          "automation_revision_invalid",
          automation.automationId,
          "新 Automation 必须从 revision 1 开始。",
          { expectedRevision: 1, actualRevision: automation.revision },
        ),
      );
    }
    return withTransaction(
      Effect.gen(function* () {
        const current = yield* readAutomation(automation.automationId);
        if (Option.isSome(current)) {
          if (sameAutomation(current.value, automation)) return current.value;
          return yield* domainError(
            "automation_already_exists",
            automation.automationId,
            "Automation 已存在且保存快照不同。",
            { actualRevision: current.value.revision },
          );
        }

        const historical = yield* readRevision(automation.automationId, 1);
        if (Option.isSome(historical)) {
          return yield* domainError(
            "automation_already_exists",
            automation.automationId,
            "Automation ID 已存在历史记录，删除后不能复用。",
            { actualRevision: historical.value.revision },
          );
        }

        yield* query(
          "CompositionAutomationStore.createAutomation.insertRevision",
          insertRevisionRow(toRevisionWrite(automation)),
        );
        const inserted = yield* query(
          "CompositionAutomationStore.createAutomation.insertCurrent",
          insertAutomationRow(toAutomationWrite(automation)),
        );
        if (Option.isSome(inserted)) {
          return yield* decodeAutomationRow(
            "CompositionAutomationStore.createAutomation.insertCurrent",
            inserted.value,
          );
        }
        const latest = yield* readAutomation(automation.automationId);
        if (Option.isSome(latest) && sameAutomation(latest.value, automation)) return latest.value;
        return yield* domainError(
          "automation_already_exists",
          automation.automationId,
          "并发创建写入了不同的 Automation 快照。",
          { actualRevision: Option.isSome(latest) ? latest.value.revision : 0 },
        );
      }),
    );
  };

  const saveAutomationRevision: CompositionAutomationStoreShape["saveAutomationRevision"] = (
    input,
  ) => {
    if (input.automation.revision !== input.expectedRevision + 1) {
      return Effect.fail(
        domainError(
          "automation_revision_invalid",
          input.automation.automationId,
          "Automation revision 必须连续递增。",
          {
            expectedRevision: input.expectedRevision + 1,
            actualRevision: input.automation.revision,
          },
        ),
      );
    }

    return withTransaction(
      Effect.gen(function* () {
        const current = yield* readAutomation(input.automation.automationId);
        if (Option.isNone(current)) {
          return yield* domainError(
            "automation_not_found",
            input.automation.automationId,
            "Automation 不存在。",
          );
        }
        if (sameAutomation(current.value, input.automation)) return current.value;
        if (current.value.revision !== input.expectedRevision) {
          return yield* revisionConflict(
            input.automation.automationId,
            input.expectedRevision,
            current.value.revision,
          );
        }

        const existingRevision = yield* readRevision(
          input.automation.automationId,
          input.automation.revision,
        );
        if (
          Option.isSome(existingRevision) &&
          !sameAutomation(existingRevision.value, input.automation)
        ) {
          return yield* revisionConflict(
            input.automation.automationId,
            input.expectedRevision,
            existingRevision.value.revision,
          );
        }
        if (Option.isNone(existingRevision)) {
          yield* query(
            "CompositionAutomationStore.saveAutomationRevision.insertRevision",
            insertRevisionRow(toRevisionWrite(input.automation)),
          );
        }

        const updated = yield* query(
          "CompositionAutomationStore.saveAutomationRevision.updateCurrent",
          updateAutomationRow({
            ...toAutomationWrite(input.automation),
            expectedRevision: input.expectedRevision,
          }),
        );
        if (Option.isSome(updated)) {
          return yield* decodeAutomationRow(
            "CompositionAutomationStore.saveAutomationRevision.updateCurrent",
            updated.value,
          );
        }
        const latest = yield* readAutomation(input.automation.automationId);
        if (Option.isSome(latest) && sameAutomation(latest.value, input.automation))
          return latest.value;
        return yield* revisionConflict(
          input.automation.automationId,
          input.expectedRevision,
          Option.isSome(latest) ? latest.value.revision : 0,
        );
      }),
    );
  };

  const deleteAutomation: CompositionAutomationStoreShape["deleteAutomation"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const current = yield* readAutomation(input.automationId);
        if (Option.isNone(current)) {
          return yield* domainError(
            "automation_not_found",
            input.automationId,
            "Automation 不存在。",
          );
        }
        if (current.value.revision !== input.expectedRevision) {
          return yield* revisionConflict(
            input.automationId,
            input.expectedRevision,
            current.value.revision,
          );
        }
        const deleted = yield* query(
          "CompositionAutomationStore.deleteAutomation",
          deleteAutomationRow({
            automationId: input.automationId,
            expectedRevision: input.expectedRevision,
          }),
        );
        if (Option.isNone(deleted)) {
          const latest = yield* readAutomation(input.automationId);
          return yield* revisionConflict(
            input.automationId,
            input.expectedRevision,
            Option.isSome(latest) ? latest.value.revision : 0,
          );
        }
        return {
          automationId: input.automationId,
          deletedAtUnixMs: input.deletedAtUnixMs,
        };
      }),
    );

  const claimRun: CompositionAutomationStoreShape["claimRun"] = (run) =>
    withTransaction(
      Effect.gen(function* () {
        const existingByIdentity = yield* readRunByIdentity(
          run.automationId,
          run.scheduledForUnixMs,
        );
        if (Option.isSome(existingByIdentity)) {
          if (sameClaimIdentity(existingByIdentity.value, run)) {
            return { run: existingByIdentity.value, claimed: false };
          }
          return yield* domainError(
            "automation_run_conflict",
            run.automationId,
            "同一计划时间已经绑定到不同 Automation revision。",
            { automationRunId: existingByIdentity.value.automationRunId },
          );
        }

        const existingById = yield* readRun(run.automationRunId);
        if (Option.isSome(existingById)) {
          if (sameRun(existingById.value, run)) {
            return { run: existingById.value, claimed: false };
          }
          return yield* domainError(
            "automation_run_conflict",
            run.automationId,
            "automationRunId 已被其他计划占用。",
            { automationRunId: run.automationRunId },
          );
        }

        const revision = yield* readRevision(run.automationId, run.automationRevision);
        if (Option.isNone(revision)) {
          return yield* domainError(
            "automation_revision_invalid",
            run.automationId,
            `Automation revision ${run.automationRevision} 不存在。`,
            { actualRevision: run.automationRevision },
          );
        }

        const inserted = yield* query(
          "CompositionAutomationStore.claimRun.insert",
          insertRunRow(run),
        );
        if (Option.isSome(inserted)) {
          const decoded = yield* decodeRunRow(
            "CompositionAutomationStore.claimRun.insert",
            inserted.value,
          );
          return { run: decoded, claimed: true } satisfies CompositionAutomationRunClaimResult;
        }
        const winner = yield* readRunByIdentity(run.automationId, run.scheduledForUnixMs);
        if (Option.isSome(winner) && sameClaimIdentity(winner.value, run)) {
          return { run: winner.value, claimed: false };
        }
        return yield* domainError(
          "automation_run_conflict",
          run.automationId,
          "Run claim 与既有记录冲突。",
          { automationRunId: run.automationRunId },
        );
      }),
    );

  const saveRunTransition: CompositionAutomationStoreShape["saveRunTransition"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const current = yield* readRun(input.run.automationRunId);
        if (Option.isNone(current)) {
          return yield* domainError(
            "automation_run_not_found",
            input.run.automationId,
            "Automation Run 不存在。",
            { automationRunId: input.run.automationRunId },
          );
        }
        if (sameRun(current.value, input.run)) return current.value;
        if (!sameRunIdentity(current.value, input.run)) {
          return yield* domainError(
            "automation_run_conflict",
            input.run.automationId,
            "Run transition 试图修改不可变身份字段。",
            { automationRunId: input.run.automationRunId },
          );
        }
        if (current.value.status !== input.expectedStatus) {
          return yield* domainError(
            "automation_run_status_conflict",
            input.run.automationId,
            `预期状态 ${input.expectedStatus}，实际为 ${current.value.status}。`,
            {
              automationRunId: input.run.automationRunId,
              expectedStatus: input.expectedStatus,
              actualStatus: current.value.status,
            },
          );
        }

        const updated = yield* query(
          "CompositionAutomationStore.saveRunTransition.update",
          updateRunRow({ ...input.run, expectedStatus: input.expectedStatus }),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRunRow(
            "CompositionAutomationStore.saveRunTransition.update",
            updated.value,
          );
        }
        const latest = yield* readRun(input.run.automationRunId);
        if (Option.isSome(latest) && sameRun(latest.value, input.run)) return latest.value;
        return yield* domainError(
          "automation_run_status_conflict",
          input.run.automationId,
          "Run 状态已被其他执行者推进。",
          {
            automationRunId: input.run.automationRunId,
            expectedStatus: input.expectedStatus,
            actualStatus: Option.isSome(latest) ? latest.value.status : "missing",
          },
        );
      }),
    );

  const store: CompositionAutomationStoreShape = {
    createAutomation,
    saveAutomationRevision,
    getAutomation: readAutomation,
    getAutomationRevision: readRevision,
    listAutomations: (request) => {
      const statuses = request.statuses ?? [];
      return query(
        "CompositionAutomationStore.listAutomations",
        listAutomationRows({
          projectId: request.projectId ?? null,
          filterStatuses: request.statuses === undefined ? 0 : 1,
          includeActive: statuses.includes("active") ? 1 : 0,
          includePaused: statuses.includes("paused") ? 1 : 0,
          includeCompleted: statuses.includes("completed") ? 1 : 0,
        }),
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeAutomationRow("CompositionAutomationStore.listAutomations", row),
          ),
        ),
      );
    },
    deleteAutomation,
    claimRun,
    saveRunTransition,
    getRun: readRun,
    listRuns: (request) =>
      Effect.gen(function* () {
        const limit = request.limit ?? 50;
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > COMPOSITION_AUTOMATION_RUN_HISTORY_MAX_LIMIT
        ) {
          return yield* domainError(
            "automation_history_limit_invalid",
            request.automationId,
            `运行历史 limit 必须在 1 到 ${COMPOSITION_AUTOMATION_RUN_HISTORY_MAX_LIMIT} 之间。`,
          );
        }
        const cursor =
          request.cursor === undefined
            ? null
            : yield* decodeHistoryCursor(request.automationId, request.cursor);
        const rows = yield* query(
          "CompositionAutomationStore.listRuns",
          listRunRows({
            automationId: request.automationId,
            cursorRequestedAtUnixMs: cursor?.requestedAtUnixMs ?? null,
            cursorAutomationRunId: cursor?.automationRunId ?? null,
            limit: limit + 1,
          }),
        );
        const decoded = yield* Effect.forEach(rows, (row) =>
          decodeRunRow("CompositionAutomationStore.listRuns", row),
        );
        const hasMore = decoded.length > limit;
        const runs = decoded.slice(0, limit);
        return {
          runs,
          nextCursor: hasMore ? encodeHistoryCursor(runs[runs.length - 1]!) : null,
        };
      }),
  };

  return store;
});

export const CompositionAutomationStoreLive = Layer.effect(CompositionAutomationStore, makeStore);
