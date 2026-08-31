import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { RunStartRowSchema } from "./CompositionRunStartStoreRow.ts";

const ListRequest = Schema.Struct({
  limit: Schema.Number,
  afterRunId: Schema.NullOr(Schema.String),
  throughRunId: Schema.NullOr(Schema.String),
});

export const makeCompositionRunStartScanStatements = (sql: SqlClient.SqlClient) => {
  const getRecoverableScanUpperBoundRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ runId: Schema.String }),
    execute: () => sql`
      SELECT run_id AS "runId"
      FROM composition_run_start_intents
      WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
      ORDER BY run_id DESC
      LIMIT 1
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: RunStartRowSchema,
    execute: ({ limit, afterRunId, throughRunId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
        AND (${afterRunId} IS NULL OR run_id > ${afterRunId})
        AND (${throughRunId} IS NULL OR run_id <= ${throughRunId})
      ORDER BY run_id ASC
      LIMIT ${limit}
    `,
  });

  const getManualRecoveryScanUpperBoundRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ runId: Schema.String }),
    execute: () => sql`
      SELECT run_id AS "runId"
      FROM composition_run_start_intents
      WHERE state = 'manual_pending'
      ORDER BY run_id DESC
      LIMIT 1
    `,
  });

  const listManualRecoveryRows = SqlSchema.findAll({
    Request: ListRequest,
    Result: RunStartRowSchema,
    execute: ({ limit, afterRunId, throughRunId }) => sql`
      SELECT
        run_id AS "runId", task_id AS "taskId", previous_run_id AS "previousRunId",
        agent_id AS "agentId", runtime_id AS "runtimeId", attempt,
        payload_digest AS "payloadDigest", capability_digest AS "capabilityDigest",
        state, revision, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
        owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs", runtime_task_id AS "runtimeTaskId",
        capability_handshake_id AS "capabilityHandshakeId",
        outcome_code AS "outcomeCode", outcome_detail AS "outcomeDetail",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs"
      FROM composition_run_start_intents
      WHERE state = 'manual_pending'
        AND (${afterRunId} IS NULL OR run_id > ${afterRunId})
        AND (${throughRunId} IS NULL OR run_id <= ${throughRunId})
      ORDER BY run_id ASC
      LIMIT ${limit}
    `,
  });

  return {
    getRecoverableScanUpperBoundRow,
    listRecoverableRows,
    getManualRecoveryScanUpperBoundRow,
    listManualRecoveryRows,
  };
};
