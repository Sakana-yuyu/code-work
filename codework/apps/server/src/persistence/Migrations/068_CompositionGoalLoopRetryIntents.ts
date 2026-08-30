import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 兼容旧 b7 留下的同名表；旧 dispatch claim 只保留证据，不再作为启动所有权。
  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_goal_loop_retry_intents (
      previous_run_id TEXT PRIMARY KEY CHECK (
        length(trim(previous_run_id)) > 0 AND length(previous_run_id) <= 512
      ),
      task_id TEXT NOT NULL CHECK (
        length(trim(task_id)) > 0 AND length(task_id) <= 512
      ),
      new_run_id TEXT NOT NULL CHECK (
        length(trim(new_run_id)) > 0 AND length(new_run_id) <= 512
      ),
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'settled', 'dispatched')),
      revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 3),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= created_at_unix_ms),
      dispatch_claim_id TEXT,
      dispatch_claimed_at_unix_ms INTEGER,
      CHECK (previous_run_id <> new_run_id),
      CHECK (
        (phase = 'prepared' AND revision = 1 AND updated_at_unix_ms = created_at_unix_ms) OR
        (phase = 'settled' AND revision = 2) OR
        (phase = 'dispatched' AND revision = 3)
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS composition_goal_loop_retry_intents_new_run_unique
    ON composition_goal_loop_retry_intents(new_run_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS composition_goal_loop_retry_intents_recoverable_scan
    ON composition_goal_loop_retry_intents(updated_at_unix_ms, previous_run_id)
    WHERE phase IN ('prepared', 'settled')
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_goal_loop_retry_quarantine (
      previous_run_id TEXT PRIMARY KEY REFERENCES composition_goal_loop_retry_intents(previous_run_id)
        ON DELETE CASCADE,
      outcome_code TEXT NOT NULL CHECK (
        length(outcome_code) BETWEEN 1 AND 128 AND
        outcome_code NOT GLOB '*[^a-z0-9_.:-]*'
      ),
      quarantined_at_unix_ms INTEGER NOT NULL CHECK (quarantined_at_unix_ms >= 0)
    )
  `;
});
