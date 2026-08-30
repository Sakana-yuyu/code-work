import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE composition_goal_loop_retry_intents (
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
      CHECK (previous_run_id <> new_run_id),
      CHECK (
        (phase = 'prepared' AND revision = 1 AND updated_at_unix_ms = created_at_unix_ms) OR
        (phase = 'settled' AND revision = 2) OR
        (phase = 'dispatched' AND revision = 3)
      )
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX uq_composition_goal_loop_retry_new_run
    ON composition_goal_loop_retry_intents(new_run_id)
  `;
});
