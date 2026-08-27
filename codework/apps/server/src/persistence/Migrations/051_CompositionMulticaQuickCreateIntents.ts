import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_multica_quick_create_intents (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'sending', 'accepted')),
      remote_task_id TEXT,
      created_at_unix_ms INTEGER NOT NULL,
      updated_at_unix_ms INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_multica_quick_create_pending
    ON composition_multica_quick_create_intents(runtime_id, state, updated_at_unix_ms)
    WHERE state IN ('prepared', 'sending')
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_multica_quick_create_idempotency_key
    ON composition_multica_quick_create_intents(runtime_id, idempotency_key)
  `;
});
