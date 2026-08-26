import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS composition_task_inputs (
      task_id TEXT PRIMARY KEY,
      encrypted_payload TEXT NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      updated_at_unix_ms INTEGER NOT NULL
    )
  `;
});
