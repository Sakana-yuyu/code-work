import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 053 已经执行过的数据库也必须获得同一 Runtime 下的幂等键唯一约束。
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_composition_multica_quick_create_idempotency_key
    ON composition_multica_quick_create_intents(runtime_id, idempotency_key)
  `;
});
