import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  AcceptedSchema,
  CapabilityHandshakeSchema,
  ClaimIdSchema,
  ClaimSchema,
  IdSchema,
  IndeterminateSchema,
  PrepareSchema,
  ReleaseSchema,
  ReleaseOperationIdSchema,
  ReleaseReceiptInsertSchema,
  RunStartReleaseReceiptRowSchema,
  RunStartRowSchema,
  RuntimeTaskSchema,
  SettleSchema,
  TaskAttemptSchema,
  UnsettledListSchema,
} from "./CompositionRunStartStoreInternal.ts";

export const makeCompositionRunStartStoreStatements = (sql: SqlClient.SqlClient) => {
  const getRow = SqlSchema.findOneOption({
    Request: IdSchema,
    Result: RunStartRowSchema,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE run_id = ${runId}
      LIMIT 1
    `,
  });

  const getByTaskAttemptRow = SqlSchema.findOneOption({
    Request: TaskAttemptSchema,
    Result: RunStartRowSchema,
    execute: ({ taskId, attempt }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE task_id = ${taskId} AND attempt = ${attempt}
      LIMIT 1
    `,
  });

  const listUnsettledRows = SqlSchema.findAll({
    Request: UnsettledListSchema,
    Result: RunStartRowSchema,
    execute: ({ limit }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE state IN ('prepared', 'dispatching', 'accepted', 'indeterminate')
      ORDER BY updated_at_unix_ms ASC, run_id ASC
      LIMIT ${limit}
    `,
  });

  const getByClaimRow = SqlSchema.findOneOption({
    Request: ClaimIdSchema,
    Result: RunStartRowSchema,
    execute: ({ claimId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE claim_id = ${claimId}
      LIMIT 1
    `,
  });

  const getReleaseReceiptRow = SqlSchema.findOneOption({
    Request: ReleaseOperationIdSchema,
    Result: RunStartReleaseReceiptRowSchema,
    execute: ({ releaseOperationId }) => sql`
      SELECT
        release_operation_id AS "releaseOperationId", run_id AS "runId", claim_id AS "claimId",
        released_at_unix_ms AS "releasedAtUnixMs", result_revision AS "resultRevision"
      FROM composition_run_start_release_receipts
      WHERE release_operation_id = ${releaseOperationId}
      LIMIT 1
    `,
  });

  const getByRuntimeTaskRow = SqlSchema.findOneOption({
    Request: RuntimeTaskSchema,
    Result: RunStartRowSchema,
    execute: ({ runtimeId, runtimeTaskId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE runtime_id = ${runtimeId} AND runtime_task_id = ${runtimeTaskId}
      LIMIT 1
    `,
  });

  const getByCapabilityHandshakeRow = SqlSchema.findOneOption({
    Request: CapabilityHandshakeSchema,
    Result: RunStartRowSchema,
    execute: ({ runtimeId, capabilityHandshakeId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE runtime_id = ${runtimeId} AND capability_handshake_id = ${capabilityHandshakeId}
      LIMIT 1
    `,
  });

  const insertRow = SqlSchema.findOneOption({
    Request: PrepareSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_run_start_intents (
        run_id, task_id, agent_id, runtime_id, attempt,
        payload_digest, capability_digest,
        state, revision, claim_id, claimed_at_unix_ms,
        last_release_claim_id, last_release_operation_id, last_released_at_unix_ms,
        runtime_task_id, capability_handshake_id, accepted_at_unix_ms,
        outcome_code, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
      ) VALUES (
        ${input.runId}, ${input.taskId}, ${input.agentId}, ${input.runtimeId}, ${input.attempt},
        ${input.payloadDigest}, ${input.capabilityDigest},
        'prepared', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ${input.createdAtUnixMs}, ${input.createdAtUnixMs}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimRow = SqlSchema.findOneOption({
    Request: ClaimSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE OR IGNORE composition_run_start_intents
      SET state = 'dispatching', revision = revision + 1,
        claim_id = ${input.claimId}, claimed_at_unix_ms = ${input.claimedAtUnixMs},
        updated_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'prepared'
        AND revision = ${input.expectedRevision} AND claim_id IS NULL
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const releaseRow = SqlSchema.findOneOption({
    Request: ReleaseSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE OR IGNORE composition_run_start_intents
      SET state = 'prepared', revision = revision + 1,
        claim_id = NULL, claimed_at_unix_ms = NULL,
        last_release_claim_id = ${input.claimId},
        last_release_operation_id = ${input.releaseOperationId},
        last_released_at_unix_ms = ${input.releasedAtUnixMs},
        updated_at_unix_ms = ${input.releasedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'dispatching'
        AND revision = ${input.expectedRevision} AND claim_id = ${input.claimId}
        AND ${input.releasedAtUnixMs} >= claimed_at_unix_ms
        AND ${input.releasedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const insertReleaseReceiptRow = SqlSchema.findOneOption({
    Request: ReleaseReceiptInsertSchema,
    Result: RunStartReleaseReceiptRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_run_start_release_receipts (
        release_operation_id, run_id, claim_id, released_at_unix_ms, result_revision
      ) VALUES (
        ${input.releaseOperationId}, ${input.runId}, ${input.claimId},
        ${input.releasedAtUnixMs}, ${input.resultRevision}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        release_operation_id AS "releaseOperationId", run_id AS "runId", claim_id AS "claimId",
        released_at_unix_ms AS "releasedAtUnixMs", result_revision AS "resultRevision"
    `,
  });

  const acceptRow = SqlSchema.findOneOption({
    Request: AcceptedSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE OR IGNORE composition_run_start_intents
      SET state = 'accepted', revision = revision + 1,
        runtime_task_id = ${input.runtimeTaskId},
        capability_handshake_id = ${input.capabilityHandshakeId},
        accepted_at_unix_ms = ${input.acceptedAtUnixMs},
        updated_at_unix_ms = ${input.acceptedAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'dispatching'
        AND revision = ${input.expectedRevision} AND claim_id = ${input.claimId}
        AND ${input.acceptedAtUnixMs} >= claimed_at_unix_ms
        AND ${input.acceptedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const indeterminateRow = SqlSchema.findOneOption({
    Request: IndeterminateSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'indeterminate', revision = revision + 1,
        outcome_code = ${input.outcomeCode},
        updated_at_unix_ms = ${input.indeterminateAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'dispatching'
        AND revision = ${input.expectedRevision} AND claim_id = ${input.claimId}
        AND ${input.indeterminateAtUnixMs} >= claimed_at_unix_ms
        AND ${input.indeterminateAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const settleRow = SqlSchema.findOneOption({
    Request: SettleSchema,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1,
        settled_at_unix_ms = ${input.settledAtUnixMs},
        updated_at_unix_ms = ${input.settledAtUnixMs}
      WHERE run_id = ${input.runId} AND state = 'accepted'
        AND revision = ${input.expectedRevision} AND claim_id = ${input.claimId}
        AND ${input.settledAtUnixMs} >= accepted_at_unix_ms
        AND ${input.settledAtUnixMs} >= updated_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", agent_id AS "agentId",
        runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", claimed_at_unix_ms AS "claimedAtUnixMs",
        last_release_claim_id AS "lastReleaseClaimId",
        last_release_operation_id AS "lastReleaseOperationId",
        last_released_at_unix_ms AS "lastReleasedAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        accepted_at_unix_ms AS "acceptedAtUnixMs", outcome_code AS "outcomeCode",
        settled_at_unix_ms AS "settledAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  return {
    getRow,
    getByTaskAttemptRow,
    listUnsettledRows,
    getByClaimRow,
    getReleaseReceiptRow,
    getByRuntimeTaskRow,
    getByCapabilityHandshakeRow,
    insertRow,
    claimRow,
    releaseRow,
    insertReleaseReceiptRow,
    acceptRow,
    indeterminateRow,
    settleRow,
  } as const;
};
