import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("080_SpecWorkflowCapabilityFlags", (it) => {
  it.effect("能力表新增 flags_json 列并默认空数组，重复迁移不重复加列", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* sql`INSERT INTO thread_spec_workflow_capabilities (thread_id, enabled, revision, updated_at_unix_ms) VALUES ('flags-thread', 1, 2, 10)`;
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 80 }), [
        [80, "SpecWorkflowCapabilityFlags"],
      ]);
      const rows =
        yield* sql`SELECT enabled, revision, flags_json FROM thread_spec_workflow_capabilities WHERE thread_id = 'flags-thread'`;
      assert.deepEqual(rows, [{ enabled: 1, revision: 2, flags_json: "[]" }]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 80 }), []);
    }),
  );
});
