import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { RunStartRowSchema } from "./CompositionRunStartStoreRow.ts";

const ManualRecoverySnapshotFields = {
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  outcomeCode: Schema.String,
  outcomeDetail: Schema.NullOr(Schema.String),
};
const AcceptedManualPendingRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  ...ManualRecoverySnapshotFields,
  manualAtUnixMs: Schema.Number,
});
const ManualClaimRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  expectedOwnerEpoch: Schema.Number,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
  leaseExpiresAtUnixMs: Schema.Number,
  ...ManualRecoverySnapshotFields,
});
const ManualReleaseRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  ...ManualRecoverySnapshotFields,
  releasedAtUnixMs: Schema.Number,
});
const ManualResumeRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  ...ManualRecoverySnapshotFields,
  resumedAtUnixMs: Schema.Number,
});
const ManualSettledRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  ...ManualRecoverySnapshotFields,
  settledAtUnixMs: Schema.Number,
});

export const makeCompositionRunStartManualStatements = (sql: SqlClient.SqlClient) => {
  const markAcceptedManualPendingRow = SqlSchema.findOneOption({
    Request: AcceptedManualPendingRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'manual_pending', revision = revision + 1, claim_id = NULL,
        owner_lease_expires_at_unix_ms = NULL,
        outcome_code = ${input.outcomeCode}, outcome_detail = ${input.outcomeDetail},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.manualAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'accepted' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.manualAtUnixMs}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimManualRecoveryRow = SqlSchema.findOneOption({
    Request: ManualClaimRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = ${input.claimId}, owner_epoch = owner_epoch + 1,
        owner_lease_expires_at_unix_ms = ${input.leaseExpiresAtUnixMs},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.claimedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'manual_pending' AND revision = ${input.expectedRevision}
        AND owner_epoch = ${input.expectedOwnerEpoch}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
        AND outcome_code = ${input.outcomeCode}
        AND outcome_detail IS ${input.outcomeDetail}
        AND (
          (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL)
          OR (
            claim_id IS NOT NULL
            AND owner_lease_expires_at_unix_ms IS NOT NULL
            AND owner_lease_expires_at_unix_ms <= ${input.claimedAtUnixMs}
          )
        )
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const releaseManualRecoveryRow = SqlSchema.findOneOption({
    Request: ManualReleaseRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = NULL, owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.releasedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'manual_pending' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.releasedAtUnixMs}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
        AND outcome_code = ${input.outcomeCode}
        AND outcome_detail IS ${input.outcomeDetail}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const resumeManualRecoveryToAcceptedRow = SqlSchema.findOneOption({
    Request: ManualResumeRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'accepted', revision = revision + 1,
        claim_id = NULL, owner_lease_expires_at_unix_ms = NULL,
        outcome_code = NULL, outcome_detail = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.resumedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'manual_pending' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.resumedAtUnixMs}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
        AND outcome_code = ${input.outcomeCode}
        AND outcome_detail IS ${input.outcomeDetail}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const settleManualRecoveryRow = SqlSchema.findOneOption({
    Request: ManualSettledRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1,
        owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.settledAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'manual_pending' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.settledAtUnixMs}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
        AND outcome_code = ${input.outcomeCode}
        AND outcome_detail IS ${input.outcomeDetail}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  return {
    markAcceptedManualPendingRow,
    claimManualRecoveryRow,
    releaseManualRecoveryRow,
    resumeManualRecoveryToAcceptedRow,
    settleManualRecoveryRow,
  };
};
