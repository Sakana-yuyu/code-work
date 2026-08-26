import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_task_events
    ADD COLUMN source_event_id TEXT
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_events_source_event
    ON composition_task_events(task_id, run_id, source_event_id)
    WHERE source_event_id IS NOT NULL
  `;
});
