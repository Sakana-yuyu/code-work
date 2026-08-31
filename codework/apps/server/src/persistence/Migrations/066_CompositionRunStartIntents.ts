import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_run_start_intents (
      run_id TEXT PRIMARY KEY CHECK (length(trim(run_id)) > 0 AND length(run_id) <= 512),
      task_id TEXT NOT NULL CHECK (length(trim(task_id)) > 0 AND length(task_id) <= 512),
      agent_id TEXT NOT NULL CHECK (length(trim(agent_id)) > 0 AND length(agent_id) <= 512),
      runtime_id TEXT NOT NULL CHECK (length(trim(runtime_id)) > 0 AND length(runtime_id) <= 512),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      replay_policy TEXT NOT NULL CHECK (replay_policy IN ('idempotent', 'fail_closed')),
      state TEXT NOT NULL CHECK (
        state IN ('prepared', 'dispatching', 'accepted', 'completed', 'indeterminate')
      ),
      claim_id TEXT,
      claimed_at_unix_ms INTEGER,
      runtime_task_id TEXT,
      capability_handshake_id TEXT,
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
      CHECK (
        (
          state = 'dispatching' AND
          claim_id IS NOT NULL AND claimed_at_unix_ms IS NOT NULL AND
          length(trim(claim_id)) > 0 AND length(claim_id) <= 512 AND
          claimed_at_unix_ms >= updated_at_unix_ms
        ) OR
        (
          state <> 'dispatching' AND claim_id IS NULL AND claimed_at_unix_ms IS NULL
        )
      ),
      CHECK (
        runtime_task_id IS NULL OR
        (length(trim(runtime_task_id)) > 0 AND length(runtime_task_id) <= 2048)
      ),
      CHECK (
        capability_handshake_id IS NULL OR
        (
          length(trim(capability_handshake_id)) > 0 AND
          length(capability_handshake_id) <= 2048
        )
      )
    )
  `;
});
