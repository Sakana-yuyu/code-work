import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("076_SpecWorkflowEvents", (it) => {
  it.effect("创建事件表、最新状态索引并保持重复迁移幂等", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });

      const executed = yield* runMigrations({ toMigrationInclusive: 76 });
      const repeated = yield* runMigrations({ toMigrationInclusive: 76 });
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('thread_spec_workflow_events')
      `;
      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_thread_spec_workflow_events_latest'
      `;
      const invalidRevision = yield* Effect.result(sql`
        INSERT INTO thread_spec_workflow_events (
          thread_id, workflow_id, revision, event_json, state_json, created_at_unix_ms
        ) VALUES ('thread-1', 'workflow-1', 0, '{}', '{}', 1)
      `);

      assert.deepEqual(executed, [[76, "SpecWorkflowEvents"]]);
      assert.deepEqual(repeated, []);
      assert.deepEqual(
        columns.map((column) => column.name),
        ["thread_id", "workflow_id", "revision", "event_json", "state_json", "created_at_unix_ms"],
      );
      assert.equal(indexes.length, 1);
      assert.isTrue(indexes[0]?.sql.includes("revision"));
      assert.equal(invalidRevision._tag, "Failure");
    }),
  );
});
