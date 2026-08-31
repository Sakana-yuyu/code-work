import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { RunStartRowSchema } from "./CompositionRunStartStoreRow.ts";

const AcceptedClaimRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
  leaseExpiresAtUnixMs: Schema.Number,
});
const AcceptedReleaseRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  releasedAtUnixMs: Schema.Number,
  ownerEpoch: Schema.Number,
});
const OwnerLeaseRenewRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  renewedAtUnixMs: Schema.Number,
  leaseExpiresAtUnixMs: Schema.Number,
});
const AcceptedRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.Number,
  ownerEpoch: Schema.Number,
});
const SettledRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  settledAtUnixMs: Schema.Number,
});

export const makeCompositionRunStartAcceptedStatements = (sql: SqlClient.SqlClient) => {
  const renewOwnerLeaseRow = SqlSchema.findOneOption({
    Request: OwnerLeaseRenewRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET owner_lease_expires_at_unix_ms = ${input.leaseExpiresAtUnixMs},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.renewedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state IN ('dispatching', 'accepted', 'manual_pending')
        AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.renewedAtUnixMs}
        AND owner_lease_expires_at_unix_ms <= ${input.leaseExpiresAtUnixMs}
        AND ${input.leaseExpiresAtUnixMs} > ${input.renewedAtUnixMs}
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

  const recordAcceptedRow = SqlSchema.findOneOption({
    Request: AcceptedRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'accepted', revision = revision + 1,
        runtime_task_id = ${input.runtimeTaskId},
        capability_handshake_id = ${input.capabilityHandshakeId},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.acceptedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'dispatching' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
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

  const claimAcceptedRecoveryRow = SqlSchema.findOneOption({
    Request: AcceptedClaimRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = ${input.claimId}, owner_epoch = owner_epoch + 1,
        owner_lease_expires_at_unix_ms = ${input.leaseExpiresAtUnixMs},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.claimedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'accepted' AND revision = ${input.expectedRevision}
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

  const releaseAcceptedRecoveryRow = SqlSchema.findOneOption({
    Request: AcceptedReleaseRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = NULL,
        owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.releasedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'accepted' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
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

  const settleAcceptedRow = SqlSchema.findOneOption({
    Request: SettledRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1,
        owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.settledAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'accepted' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId}
        AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
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
    renewOwnerLeaseRow,
    recordAcceptedRow,
    claimAcceptedRecoveryRow,
    releaseAcceptedRecoveryRow,
    settleAcceptedRow,
  };
};
