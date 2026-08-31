import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE workspace_script_runs
    ADD COLUMN stop_claim_owner_id TEXT
      CHECK (stop_claim_owner_id IS NULL OR length(trim(stop_claim_owner_id)) > 0)
  `;
  yield* sql`
    ALTER TABLE workspace_script_runs
    ADD COLUMN stop_claim_epoch INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(stop_claim_epoch) = 'integer' AND stop_claim_epoch >= 0)
  `;
  yield* sql`
    ALTER TABLE workspace_script_runs
    ADD COLUMN stop_claim_expires_at_unix_ms INTEGER
      CHECK (
        stop_claim_expires_at_unix_ms IS NULL
        OR (
          typeof(stop_claim_expires_at_unix_ms) = 'integer'
          AND stop_claim_expires_at_unix_ms >= 0
        )
      )
  `;

  yield* sql`
    CREATE INDEX idx_workspace_script_runs_stop_claim_expiry
    ON workspace_script_runs(stop_claim_expires_at_unix_ms, workspace_script_run_id)
    WHERE stop_claim_owner_id IS NOT NULL
  `;

  yield* sql`
    CREATE TRIGGER trg_workspace_script_stop_claim_insert
    BEFORE INSERT ON workspace_script_runs
    WHEN
      (NEW.stop_claim_owner_id IS NULL) <> (NEW.stop_claim_expires_at_unix_ms IS NULL)
      OR (
        NEW.stop_claim_owner_id IS NOT NULL
        AND (
          NEW.stop_claim_epoch <= 0
          OR NEW.stop_operation_id IS NULL
          OR NEW.status NOT IN ('starting', 'stopping')
          OR NEW.stop_claim_expires_at_unix_ms <= NEW.updated_at_unix_ms
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'workspace_script_stop_claim_invalid');
    END
  `;
  yield* sql`
    CREATE TRIGGER trg_workspace_script_stop_claim_update
    BEFORE UPDATE ON workspace_script_runs
    WHEN
      (NEW.stop_claim_owner_id IS NULL) <> (NEW.stop_claim_expires_at_unix_ms IS NULL)
      OR (
        NEW.stop_claim_owner_id IS NOT NULL
        AND (
          NEW.stop_claim_epoch <= 0
          OR NEW.stop_operation_id IS NULL
          OR NEW.status NOT IN ('starting', 'stopping')
          OR NEW.stop_claim_expires_at_unix_ms <= NEW.updated_at_unix_ms
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'workspace_script_stop_claim_invalid');
    END
  `;
});
