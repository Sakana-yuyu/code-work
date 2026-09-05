import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("077_SpecWorkflowSelectedIntent", (it) => {
  it.effect("旧开关迁移为完整流程，保留版本与启用状态，重复迁移不修改记录", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* sql`INSERT INTO thread_spec_workflow_capabilities (thread_id, enabled, revision, updated_at_unix_ms) VALUES ('legacy-thread', 1, 4, 10)`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 77 }), [
        [77, "SpecWorkflowSelectedIntent"],
      ]);
      const rows =
        yield* sql`SELECT enabled, revision, selected_intent FROM thread_spec_workflow_capabilities WHERE thread_id = 'legacy-thread'`;
      assert.deepEqual(rows, [{ enabled: 1, revision: 4, selected_intent: "workflow" }]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 77 }), []);
    }),
  );
});
