import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE thread_spec_workflow_capabilities
    ADD COLUMN selected_intent TEXT NOT NULL DEFAULT 'workflow'
  `;
});
