import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_spec_workflow_capabilities (
      thread_id TEXT PRIMARY KEY
        CHECK (length(trim(thread_id)) > 0 AND length(thread_id) <= 512),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
      updated_at_unix_ms INTEGER NOT NULL CHECK (updated_at_unix_ms >= 0)
    )
  `;

  yield* sql`
    CREATE INDEX idx_thread_spec_workflow_capabilities_enabled
    ON thread_spec_workflow_capabilities(enabled, updated_at_unix_ms DESC)
  `;
});
