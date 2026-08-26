import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_capability_grants (
      grant_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      issued_at_unix_ms INTEGER NOT NULL,
      expires_at_unix_ms INTEGER NOT NULL,
      revoked_at_unix_ms INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_capability_grants_scope
    ON composition_capability_grants(task_id, agent_id, capability_id, expires_at_unix_ms)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_capability_audit (
      audit_id TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL,
      error_code TEXT,
      occurred_at_unix_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_capability_audit_task
    ON composition_capability_audit(task_id, occurred_at_unix_ms, audit_id)
  `;
});
