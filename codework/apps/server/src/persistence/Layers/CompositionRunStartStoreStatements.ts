import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { CompositionRunStartState } from "../Services/CompositionRunStartStore.ts";

export const RunStartRowSchema = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  previousRunId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
  state: CompositionRunStartState,
  revision: Schema.Number,
  claimId: Schema.NullOr(Schema.String),
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  outcomeCode: Schema.NullOr(Schema.String),
  outcomeDetail: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
});
export type RunStartRow = typeof RunStartRowSchema.Type;

const PrepareRequest = Schema.Struct({
  runId: Schema.String,
  taskId: Schema.String,
  previousRunId: Schema.NullOr(Schema.String),
  agentId: Schema.String,
  runtimeId: Schema.String,
  attempt: Schema.Number,
  payloadDigest: Schema.String,
  capabilityDigest: Schema.String,
  createdAtUnixMs: Schema.Number,
});
const IdRequest = Schema.Struct({ runId: Schema.String });
const TaskAttemptRequest = Schema.Struct({ taskId: Schema.String, attempt: Schema.Number });
const ClaimRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
});
const ReleaseRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  releasedAtUnixMs: Schema.Number,
});
const ResetRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  resetAtUnixMs: Schema.Number,
});
const DispatchRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  dispatchedAtUnixMs: Schema.Number,
});
const AcceptedRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.Number,
});
const SettledRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  settledAtUnixMs: Schema.Number,
});
const RejectedRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  outcomeCode: Schema.String,
  outcomeDetail: Schema.NullOr(Schema.String),
  settledAtUnixMs: Schema.Number,
});
const QuarantineRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  outcomeCode: Schema.String,
  outcomeDetail: Schema.NullOr(Schema.String),
  quarantinedAtUnixMs: Schema.Number,
});
const ListRequest = Schema.Struct({ limit: Schema.Number });

export const makeCompositionRunStartStoreStatements = (sql: SqlClient.SqlClient) => {
  const getRow = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: RunStartRowSchema,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE run_id = ${runId}
      LIMIT 1
    `,
  });

  const getRowByTaskAttempt = SqlSchema.findOneOption({
    Request: TaskAttemptRequest,
    Result: RunStartRowSchema,
    execute: ({ taskId, attempt }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE task_id = ${taskId} AND attempt = ${attempt}
      LIMIT 1
    `,
  });

  const insertPreparedRow = SqlSchema.findOneOption({
    Request: PrepareRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_run_start_intents (
        run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
        payload_digest, capability_digest, state, revision, claim_id,
        runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
        created_at_unix_ms, updated_at_unix_ms
      ) VALUES (
        ${input.runId}, ${input.taskId}, ${input.previousRunId}, ${input.agentId},
        ${input.runtimeId}, ${input.attempt}, ${input.payloadDigest},
        ${input.capabilityDigest}, 'prepared', 1, NULL, NULL, NULL, NULL, NULL,
        ${input.createdAtUnixMs}, ${input.createdAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimPreparedRow = SqlSchema.findOneOption({
    Request: ClaimRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'preparing', revision = revision + 1, claim_id = ${input.claimId},
        updated_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'prepared' AND revision = ${input.expectedRevision} AND claim_id IS NULL
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const releasePreparationRow = SqlSchema.findOneOption({
    Request: ReleaseRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'prepared', revision = revision + 1, claim_id = NULL,
        updated_at_unix_ms = ${input.releasedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'preparing' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND ${input.releasedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const resetPreparationRow = SqlSchema.findOneOption({
    Request: ResetRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'prepared', revision = revision + 1, claim_id = NULL,
        updated_at_unix_ms = ${input.resetAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'preparing' AND revision = ${input.expectedRevision}
        AND ${input.resetAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const markDispatchingRow = SqlSchema.findOneOption({
    Request: DispatchRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'dispatching', revision = revision + 1,
        updated_at_unix_ms = ${input.dispatchedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'preparing' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND ${input.dispatchedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimDispatchRecoveryRow = SqlSchema.findOneOption({
    Request: ClaimRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = ${input.claimId},
        updated_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'dispatching' AND revision = ${input.expectedRevision}
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const recordAcceptedRow = SqlSchema.findOneOption({
    Request: AcceptedRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'accepted', revision = revision + 1, claim_id = NULL,
        runtime_task_id = ${input.runtimeTaskId},
        capability_handshake_id = ${input.capabilityHandshakeId},
        updated_at_unix_ms = ${input.acceptedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'dispatching' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND ${input.acceptedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const settleAcceptedRow = SqlSchema.findOneOption({
    Request: SettledRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1,
        updated_at_unix_ms = ${input.settledAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'accepted' AND revision = ${input.expectedRevision}
        AND ${input.settledAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const settleRejectedRow = SqlSchema.findOneOption({
    Request: RejectedRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1, claim_id = NULL,
        outcome_code = ${input.outcomeCode}, outcome_detail = ${input.outcomeDetail},
        updated_at_unix_ms = ${input.settledAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state = 'dispatching' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND ${input.settledAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const quarantineRow = SqlSchema.findOneOption({
    Request: QuarantineRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'quarantined', revision = revision + 1, claim_id = NULL,
        outcome_code = ${input.outcomeCode}, outcome_detail = ${input.outcomeDetail},
        updated_at_unix_ms = ${input.quarantinedAtUnixMs}
      WHERE run_id = ${input.runId}
        AND state IN ('prepared', 'preparing', 'dispatching')
        AND revision = ${input.expectedRevision}
        AND ${input.quarantinedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: RunStartRowSchema,
    execute: ({ limit }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
      ORDER BY updated_at_unix_ms ASC, run_id ASC
      LIMIT ${limit}
    `,
  });

  return {
    getRow,
    getRowByTaskAttempt,
    insertPreparedRow,
    claimPreparedRow,
    releasePreparationRow,
    resetPreparationRow,
    markDispatchingRow,
    claimDispatchRecoveryRow,
    recordAcceptedRow,
    settleAcceptedRow,
    settleRejectedRow,
    quarantineRow,
    listRecoverableRows,
  };
};
