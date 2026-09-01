import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE composition_squads
    ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
  `;
  yield* sql`
    ALTER TABLE composition_squads
    ADD COLUMN configuration_json TEXT
  `;
  yield* sql`
    ALTER TABLE composition_squads
    ADD COLUMN created_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (created_at_unix_ms >= 0)
  `;
  yield* sql`
    ALTER TABLE composition_squads
    ADD COLUMN updated_at_unix_ms INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_unix_ms >= 0)
  `;
  yield* sql`
    CREATE TABLE composition_squad_revisions (
      squad_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      configuration_json TEXT,
      created_at_unix_ms INTEGER NOT NULL CHECK (created_at_unix_ms >= 0),
      PRIMARY KEY (squad_id, revision)
    )
  `;
  yield* sql`
    INSERT INTO composition_squad_revisions (
      squad_id, revision, configuration_json, created_at_unix_ms
    )
    SELECT squad_id, revision, configuration_json, updated_at_unix_ms
    FROM composition_squads
  `;
  yield* sql`
    CREATE INDEX idx_composition_squad_revisions_latest
    ON composition_squad_revisions(squad_id, revision DESC)
  `;
});
