import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_CompositionMulticaQuickCreateIdempotencyKey", (it) => {
  it.effect("为已经执行 051 的数据库补充 Runtime 作用域幂等键唯一索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        DROP INDEX IF EXISTS idx_composition_multica_quick_create_idempotency_key
      `;
      yield* sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-before-52', 'task-before-52', 'multica:runtime-52', 'shared-key-52',
          'prepared', 1, 1
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const indexes = yield* sql<{ readonly name: string; readonly unique: number }>`
        PRAGMA index_list(composition_multica_quick_create_intents)
      `;
      const uniqueIndex = indexes.find(
        (index) => index.name === "idx_composition_multica_quick_create_idempotency_key",
      );
      assert.equal(uniqueIndex?.unique, 1);

      const duplicateRuntimeKey = yield* Effect.result(sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-after-52', 'task-after-52', 'multica:runtime-52', 'shared-key-52',
          'prepared', 2, 2
        )
      `);
      assert.equal(duplicateRuntimeKey._tag, "Failure");
    }),
  );
});
