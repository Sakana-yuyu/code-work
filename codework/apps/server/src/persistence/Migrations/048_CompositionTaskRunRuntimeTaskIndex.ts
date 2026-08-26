import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_composition_runs_runtime_task
    ON composition_task_runs(runtime_id, runtime_task_id, attempt, run_id)
    WHERE runtime_task_id IS NOT NULL
  `;
});
