import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("071_CompositionRunStartFencing", (it) => {
  it.effect("以追加迁移为 Run Start 持久 owner epoch 与 lease", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_run_start_intents')
      `;
      assert.isFalse(before.map((column) => column.name).includes("owner_epoch"));
      assert.isFalse(
        before.map((column) => column.name).includes("owner_lease_expires_at_unix_ms"),
      );

      const executed = yield* runMigrations({ toMigrationInclusive: 66 });
      assert.deepEqual(executed, [[66, "CompositionRunStartFencing"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_run_start_intents')
      `;
      assert.deepEqual(
        columns.slice(-2).map((column) => column.name),
        ["owner_epoch", "owner_lease_expires_at_unix_ms"],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 66 }), []);
    }),
  );
});
