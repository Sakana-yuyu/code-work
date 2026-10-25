import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Provider-native goals (Codex/Claude `/goal`) keep their authoritative state
// provider-side; the flag marks mirrored rows so Code Work's own goal loop
// does not double-drive them.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE thread_goals
    ADD COLUMN provider_native INTEGER NOT NULL DEFAULT 0
      CHECK (provider_native IN (0, 1))
  `;
});
