import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(composition_task_events)
  `;

  if (!columns.some((column) => column.name === "output_delta")) {
    yield* sql`
      ALTER TABLE composition_task_events
      ADD COLUMN output_delta TEXT
    `;
  }
  if (!columns.some((column) => column.name === "output_offset_bytes")) {
    yield* sql`
      ALTER TABLE composition_task_events
      ADD COLUMN output_offset_bytes INTEGER
    `;
  }
  if (!columns.some((column) => column.name === "output_digest")) {
    yield* sql`
      ALTER TABLE composition_task_events
      ADD COLUMN output_digest TEXT
    `;
  }
});
