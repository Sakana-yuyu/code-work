import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_spec_workflow_events (
      thread_id TEXT NOT NULL
        CHECK (length(trim(thread_id)) > 0 AND length(thread_id) <= 512),
      workflow_id TEXT NOT NULL
        CHECK (length(trim(workflow_id)) > 0 AND length(workflow_id) <= 512),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      event_json TEXT NOT NULL CHECK (length(trim(event_json)) > 0),
      state_json TEXT NOT NULL CHECK (length(trim(state_json)) > 0),
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      PRIMARY KEY (thread_id, revision)
    )
  `;

  yield* sql`
    CREATE INDEX idx_thread_spec_workflow_events_latest
    ON thread_spec_workflow_events(thread_id, revision DESC)
  `;
});
