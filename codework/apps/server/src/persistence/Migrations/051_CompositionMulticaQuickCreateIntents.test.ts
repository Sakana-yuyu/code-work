import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("051_CompositionMulticaQuickCreateIntents", (it) => {
  it.effect("为已有数据库添加不含 prompt 或凭据的 quick-create 发送账本", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* runMigrations({ toMigrationInclusive: 51 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(composition_multica_quick_create_intents)
      `;
      const names = columns.map((column) => column.name);
      assert.deepEqual(names, [
        "run_id",
        "task_id",
        "runtime_id",
        "idempotency_key",
        "state",
        "remote_task_id",
        "created_at_unix_ms",
        "updated_at_unix_ms",
      ]);
      assert.isFalse(names.includes("prompt"));
      assert.isFalse(names.includes("headers"));
      assert.isFalse(names.includes("credential"));

      yield* sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-before-51', 'task-before-51', 'multica:runtime-1', 'run-before-51', 'prepared',
          1, 1
        )
      `;
      const invalid = yield* Effect.result(sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-invalid-51', 'task-invalid-51', 'multica:runtime-1', 'run-invalid-51', 'unknown',
          1, 1
        )
      `);
      assert.equal(invalid._tag, "Failure");

      const duplicateRuntimeKey = yield* Effect.result(sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-duplicate-key-51', 'task-duplicate-key-51',
          'multica:runtime-1', 'run-before-51', 'prepared', 2, 2
        )
      `);
      assert.equal(duplicateRuntimeKey._tag, "Failure");

      const sameKeyOtherRuntime = yield* Effect.result(sql`
        INSERT INTO composition_multica_quick_create_intents (
          run_id, task_id, runtime_id, idempotency_key, state,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-other-runtime-51', 'task-other-runtime-51',
          'multica:runtime-2', 'run-before-51', 'prepared', 2, 2
        )
      `);
      assert.equal(sameKeyOtherRuntime._tag, "Success");
    }),
  );
});
