import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { RunStartRowSchema } from "./CompositionRunStartStoreRow.ts";

const IdRequest = Schema.Struct({ runId: Schema.String });
const CancellationRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  requestedAtUnixMs: Schema.Number,
  reason: Schema.String,
});
const CancellationClaimRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  claimedAtUnixMs: Schema.Number,
  leaseExpiresAtUnixMs: Schema.Number,
});
const CancellationReleaseRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  releasedAtUnixMs: Schema.Number,
});
const CancellationSourceFenceFields = {
  runId: Schema.String,
  sourceRevision: Schema.Number,
  sourceClaimId: Schema.NullOr(Schema.String),
  sourceOwnerEpoch: Schema.Number,
};
const CancellationStartAcceptedRequest = Schema.Struct({
  ...CancellationSourceFenceFields,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  acceptedAtUnixMs: Schema.Number,
});
const CancellationStartRejectedRequest = Schema.Struct({
  ...CancellationSourceFenceFields,
  outcomeCode: Schema.String,
  outcomeDetail: Schema.NullOr(Schema.String),
  rejectedAtUnixMs: Schema.Number,
});
const CancellationTerminalRequest = Schema.Struct({
  ...CancellationSourceFenceFields,
  expectedRevision: Schema.Number,
  runtimeTaskId: Schema.NullOr(Schema.String),
  capabilityHandshakeId: Schema.NullOr(Schema.String),
  terminalStatus: Schema.String,
  sourceEventId: Schema.String,
  observedAtUnixMs: Schema.Number,
});
const CancellationSettledRequest = Schema.Struct({
  runId: Schema.String,
  expectedRevision: Schema.Number,
  claimId: Schema.String,
  ownerEpoch: Schema.Number,
  settledAtUnixMs: Schema.Number,
});
const CancellationListRequest = Schema.Struct({
  limit: Schema.Number,
  afterRunId: Schema.NullOr(Schema.String),
  throughRunId: Schema.NullOr(Schema.String),
});

export const makeCompositionRunStartCancelStatements = (sql: SqlClient.SqlClient) => {
  const getCancellationRow = SqlSchema.findOneOption({
    Request: IdRequest,
    Result: RunStartRowSchema,
    execute: ({ runId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE run_id = ${runId}
      LIMIT 1
    `,
  });

  const requestCancellationRow = SqlSchema.findOneOption({
    Request: CancellationRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'cancel_pending', revision = revision + 1,
        cancel_requested_at_unix_ms = ${input.requestedAtUnixMs},
        cancel_reason = ${input.reason},
        cancel_source_state = CASE
          WHEN state = 'settled' THEN 'accepted_settled'
          ELSE state
        END,
        cancel_source_revision = revision,
        cancel_source_claim_id = claim_id,
        cancel_source_owner_epoch = owner_epoch,
        cancel_start_outcome = CASE
          WHEN state = 'dispatching' THEN 'pending'
          ELSE 'accepted'
        END,
        claim_id = NULL, owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.requestedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND revision = ${input.expectedRevision}
        AND cancel_requested_at_unix_ms IS NULL
        AND ${input.requestedAtUnixMs} >= created_at_unix_ms
        AND (
          state IN ('dispatching', 'accepted', 'manual_pending')
          OR (
            state = 'settled' AND outcome_code IS NULL AND outcome_detail IS NULL
          )
        )
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const claimCancellationRecoveryRow = SqlSchema.findOneOption({
    Request: CancellationClaimRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = ${input.claimId},
        owner_epoch = owner_epoch + 1,
        owner_lease_expires_at_unix_ms = ${input.leaseExpiresAtUnixMs},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.claimedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND revision = ${input.expectedRevision}
        AND (
          (claim_id IS NULL AND owner_lease_expires_at_unix_ms IS NULL)
          OR (
            claim_id IS NOT NULL AND owner_lease_expires_at_unix_ms IS NOT NULL
            AND owner_lease_expires_at_unix_ms <= ${input.claimedAtUnixMs}
          )
        )
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const releaseCancellationRecoveryRow = SqlSchema.findOneOption({
    Request: CancellationReleaseRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, claim_id = NULL,
        owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.releasedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.releasedAtUnixMs}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const recordCancellationStartAcceptedRow = SqlSchema.findOneOption({
    Request: CancellationStartAcceptedRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, runtime_task_id = ${input.runtimeTaskId},
        capability_handshake_id = ${input.capabilityHandshakeId},
        outcome_code = NULL, outcome_detail = NULL,
        cancel_start_outcome = 'accepted',
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.acceptedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND cancel_source_state = 'dispatching'
        AND cancel_start_outcome = 'pending'
        AND cancel_source_revision = ${input.sourceRevision}
        AND cancel_source_claim_id IS ${input.sourceClaimId}
        AND cancel_source_owner_epoch = ${input.sourceOwnerEpoch}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const recordCancellationStartRejectedRow = SqlSchema.findOneOption({
    Request: CancellationStartRejectedRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, runtime_task_id = NULL,
        capability_handshake_id = NULL, outcome_code = ${input.outcomeCode},
        outcome_detail = ${input.outcomeDetail}, cancel_start_outcome = 'rejected',
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.rejectedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND cancel_source_state = 'dispatching'
        AND cancel_start_outcome = 'pending'
        AND cancel_source_revision = ${input.sourceRevision}
        AND cancel_source_claim_id IS ${input.sourceClaimId}
        AND cancel_source_owner_epoch = ${input.sourceOwnerEpoch}
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const markCancellationTerminalObservedRow = SqlSchema.findOneOption({
    Request: CancellationTerminalRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET revision = revision + 1, cancel_terminal_status = ${input.terminalStatus},
        cancel_terminal_source_event_id = ${input.sourceEventId},
        cancel_terminal_observed_at_unix_ms = ${input.observedAtUnixMs},
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.observedAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND revision = ${input.expectedRevision}
        AND cancel_start_outcome = 'accepted'
        AND cancel_source_revision = ${input.sourceRevision}
        AND cancel_source_claim_id IS ${input.sourceClaimId}
        AND cancel_source_owner_epoch = ${input.sourceOwnerEpoch}
        AND runtime_task_id IS ${input.runtimeTaskId}
        AND capability_handshake_id IS ${input.capabilityHandshakeId}
        AND cancel_terminal_status IS NULL
        AND cancel_terminal_source_event_id IS NULL
        AND cancel_terminal_observed_at_unix_ms IS NULL
        AND ${input.observedAtUnixMs} >= cancel_requested_at_unix_ms
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const settleCancellationRow = SqlSchema.findOneOption({
    Request: CancellationSettledRequest,
    Result: RunStartRowSchema,
    execute: (input) => sql`
      UPDATE composition_run_start_intents
      SET state = 'settled', revision = revision + 1,
        owner_lease_expires_at_unix_ms = NULL,
        updated_at_unix_ms = MAX(updated_at_unix_ms, ${input.settledAtUnixMs})
      WHERE run_id = ${input.runId}
        AND state = 'cancel_pending' AND revision = ${input.expectedRevision}
        AND claim_id = ${input.claimId} AND owner_epoch = ${input.ownerEpoch}
        AND owner_lease_expires_at_unix_ms IS NOT NULL
        AND owner_lease_expires_at_unix_ms > ${input.settledAtUnixMs}
        AND (
          (
            cancel_start_outcome = 'rejected' AND cancel_terminal_status IS NULL
            AND cancel_terminal_source_event_id IS NULL
            AND cancel_terminal_observed_at_unix_ms IS NULL
          ) OR
          (
            cancel_start_outcome = 'accepted' AND cancel_terminal_status IS NOT NULL
            AND cancel_terminal_source_event_id IS NOT NULL
            AND cancel_terminal_observed_at_unix_ms IS NOT NULL
          )
        )
      RETURNING
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
    `,
  });

  const getCancellationRecoveryScanUpperBoundRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ runId: Schema.String }),
    execute: () => sql`
      SELECT run_id AS "runId"
      FROM composition_run_start_intents
      WHERE state = 'cancel_pending'
      ORDER BY run_id DESC
      LIMIT 1
    `,
  });

  const listCancellationRecoveryRows = SqlSchema.findAll({
    Request: CancellationListRequest,
    Result: RunStartRowSchema,
    execute: ({ limit, afterRunId, throughRunId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs",
        runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
        cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
        cancel_source_revision AS "cancelSourceRevision",
        cancel_source_claim_id AS "cancelSourceClaimId",
        cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
        cancel_start_outcome AS "cancelStartOutcome",
        cancel_terminal_status AS "cancelTerminalStatus",
        cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
        cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE state = 'cancel_pending'
        AND (${afterRunId} IS NULL OR run_id > ${afterRunId})
        AND (${throughRunId} IS NULL OR run_id <= ${throughRunId})
      ORDER BY run_id ASC
      LIMIT ${limit}
    `,
  });

  return {
    getCancellationRow,
    requestCancellationRow,
    claimCancellationRecoveryRow,
    releaseCancellationRecoveryRow,
    recordCancellationStartAcceptedRow,
    recordCancellationStartRejectedRow,
    markCancellationTerminalObservedRow,
    settleCancellationRow,
    getCancellationRecoveryScanUpperBoundRow,
    listCancellationRecoveryRows,
  };
};
