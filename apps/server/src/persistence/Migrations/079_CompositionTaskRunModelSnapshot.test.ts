import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("079_CompositionTaskRunModelSnapshot", (it) => {
  it.effect("为已有 Composition Run 添加可空的结构化模型快照", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 78 });
      yield* sql`
        INSERT INTO composition_task_runs (
          run_id, task_id, agent_id, runtime_id, status, attempt, capability_grant_ids_json
        ) VALUES (
          'run-before-79', 'task-before-79', 'agent-before-79', 'runtime-before-79',
          'running', 1, '[]'
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepEqual(executed, [[79, "CompositionTaskRunModelSnapshot"]]);

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(composition_task_runs)
      `;
      const modelSnapshot = columns.find((column) => column.name === "model_snapshot_json");
      const runs = yield* sql<{
        readonly runId: string;
        readonly modelSnapshotJson: string | null;
      }>`
        SELECT run_id AS "runId", model_snapshot_json AS "modelSnapshotJson"
        FROM composition_task_runs
        WHERE run_id = 'run-before-79'
      `;

      assert.equal(modelSnapshot?.name, "model_snapshot_json");
      assert.equal(modelSnapshot?.notnull, 0);
      assert.deepEqual(runs, [{ runId: "run-before-79", modelSnapshotJson: null }]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 79 }), []);
    }),
  );
});
