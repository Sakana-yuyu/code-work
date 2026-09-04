import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("075_SpecWorkflowCapabilities", (it) => {
  it.effect("创建默认关闭能力表、索引并保持重复迁移幂等", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });

      const executed = yield* runMigrations({ toMigrationInclusive: 75 });
      const repeated = yield* runMigrations({ toMigrationInclusive: 75 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('thread_spec_workflow_capabilities')
      `;
      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_thread_spec_workflow_capabilities_enabled'
      `;
      const invalidEnabled = yield* Effect.result(sql`
        INSERT INTO thread_spec_workflow_capabilities (thread_id, enabled, revision, updated_at_unix_ms)
        VALUES ('thread-1', 2, 1, 1)
      `);

      assert.deepEqual(executed, [[75, "SpecWorkflowCapabilities"]]);
      assert.deepEqual(repeated, []);
      assert.deepEqual(
        columns.map((column) => column.name),
        ["thread_id", "enabled", "revision", "updated_at_unix_ms"],
      );
      assert.equal(indexes.length, 1);
      assert.isTrue(indexes[0]?.sql.includes("enabled"));
      assert.equal(invalidEnabled._tag, "Failure");
    }),
  );
});
