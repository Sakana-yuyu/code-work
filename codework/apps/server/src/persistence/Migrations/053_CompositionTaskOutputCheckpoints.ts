import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_task_events
    ADD COLUMN output_delta TEXT
  `;
  yield* sql`
    ALTER TABLE composition_task_events
    ADD COLUMN output_offset_bytes INTEGER
  `;
  yield* sql`
    ALTER TABLE composition_task_events
    ADD COLUMN output_digest TEXT
  `;
});
