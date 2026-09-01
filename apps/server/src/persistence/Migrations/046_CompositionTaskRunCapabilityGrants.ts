import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(composition_task_runs)
  `;

  if (!columns.some((column) => column.name === "capability_grant_ids_json")) {
    yield* sql`
      ALTER TABLE composition_task_runs
      ADD COLUMN capability_grant_ids_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
