import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("070_CompositionRunStartIntents", (it) => {
  it.effect("以追加迁移建立只保存摘要与稳定 receipt 的 Run Start 台账", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'composition_run_start_intents'
      `;
      assert.deepEqual(before, []);

      const executed = yield* runMigrations({ toMigrationInclusive: 65 });
      assert.deepEqual(executed, [[65, "CompositionRunStartIntents"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_run_start_intents')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "run_id",
          "task_id",
          "previous_run_id",
          "agent_id",
          "runtime_id",
          "attempt",
          "payload_digest",
          "capability_digest",
          "state",
          "revision",
          "claim_id",
          "runtime_task_id",
          "capability_handshake_id",
          "outcome_code",
          "outcome_detail",
          "created_at_unix_ms",
          "updated_at_unix_ms",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'uq_composition_run_start_task_attempt',
            'idx_composition_run_start_recoverable'
          )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        ["idx_composition_run_start_recoverable", "uq_composition_run_start_task_attempt"],
      );

      const names = columns.map((column) => column.name);
      assert.isFalse(names.includes("prompt"));
      assert.isFalse(names.includes("workspace_root"));
      assert.isFalse(names.includes("capability_ids"));
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 65 }), []);
    }),
  );
});
