import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("056_CompositionSquadConfiguration", (it) => {
  it.effect("以加法迁移保留旧 Squad 并建立不可重复的 revision 历史", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO composition_squads (
          squad_id, name, leader_agent_id, member_agent_ids_json, instructions, archived_at_unix_ms
        ) VALUES (
          'squad-before-56', '迁移前协同组', 'agent-leader-56',
          '["agent-leader-56","agent-worker-56"]', '保留旧配置', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 56 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(composition_squads)
      `;
      assert.deepEqual(
        columns
          .map((column) => column.name)
          .filter((name) =>
            ["revision", "configuration_json", "created_at_unix_ms", "updated_at_unix_ms"].includes(
              name,
            ),
          )
          .sort(),
        ["configuration_json", "created_at_unix_ms", "revision", "updated_at_unix_ms"],
      );

      const squads = yield* sql<{
        readonly squadId: string;
        readonly revision: number;
        readonly configurationJson: string | null;
        readonly createdAtUnixMs: number;
        readonly updatedAtUnixMs: number;
      }>`
        SELECT squad_id AS "squadId", revision,
          configuration_json AS "configurationJson",
          created_at_unix_ms AS "createdAtUnixMs",
          updated_at_unix_ms AS "updatedAtUnixMs"
        FROM composition_squads
        WHERE squad_id = 'squad-before-56'
      `;
      assert.deepEqual(
        [...squads],
        [
          {
            squadId: "squad-before-56",
            revision: 1,
            configurationJson: null,
            createdAtUnixMs: 0,
            updatedAtUnixMs: 0,
          },
        ],
      );

      const revisions = yield* sql<{
        readonly squadId: string;
        readonly revision: number;
        readonly configurationJson: string | null;
        readonly createdAtUnixMs: number;
      }>`
        SELECT squad_id AS "squadId", revision,
          configuration_json AS "configurationJson",
          created_at_unix_ms AS "createdAtUnixMs"
        FROM composition_squad_revisions
        WHERE squad_id = 'squad-before-56'
      `;
      assert.deepEqual(
        [...revisions],
        [
          {
            squadId: "squad-before-56",
            revision: 1,
            configurationJson: null,
            createdAtUnixMs: 0,
          },
        ],
      );

      const duplicateRevision = yield* Effect.result(sql`
        INSERT INTO composition_squad_revisions (
          squad_id, revision, configuration_json, created_at_unix_ms
        ) VALUES ('squad-before-56', 1, NULL, 1)
      `);
      assert.equal(duplicateRevision._tag, "Failure");
    }),
  );
});
