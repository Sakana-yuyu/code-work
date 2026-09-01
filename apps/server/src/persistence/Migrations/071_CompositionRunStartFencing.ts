import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE composition_run_start_intents
    ADD COLUMN owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (owner_epoch >= 0)
  `;
  yield* sql`
    ALTER TABLE composition_run_start_intents
    ADD COLUMN owner_lease_expires_at_unix_ms INTEGER CHECK (
      owner_lease_expires_at_unix_ms IS NULL OR owner_lease_expires_at_unix_ms >= 0
    )
  `;
});
