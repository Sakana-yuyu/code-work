import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_squad_executions
    ADD COLUMN plan_digest TEXT
    CHECK (plan_digest IS NULL OR length(trim(plan_digest)) > 0)
  `;
});
