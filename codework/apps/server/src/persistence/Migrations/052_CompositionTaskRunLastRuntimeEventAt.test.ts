import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("052_CompositionTaskRunLastRuntimeEventAt", (it) => {
  it.effect("为已有 Composition Run 添加可空的 Runtime 活动水位", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 51 });
      yield* sql`
        INSERT INTO composition_task_runs (
          run_id, task_id, agent_id, runtime_id, status, attempt, capability_grant_ids_json
        ) VALUES (
          'run-before-52', 'task-before-52', 'agent-before-52', 'runtime-before-52',
          'running', 1, '[]'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 52 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(composition_task_runs)
      `;
      const watermark = columns.find((column) => column.name === "last_runtime_event_at_unix_ms");
      const runs = yield* sql<{
        readonly runId: string;
        readonly lastRuntimeEventAtUnixMs: number | null;
      }>`
        SELECT run_id AS "runId", last_runtime_event_at_unix_ms AS "lastRuntimeEventAtUnixMs"
        FROM composition_task_runs
        WHERE run_id = 'run-before-52'
      `;

      assert.equal(watermark?.name, "last_runtime_event_at_unix_ms");
      assert.equal(watermark?.notnull, 0);
      assert.deepEqual(runs, [{ runId: "run-before-52", lastRuntimeEventAtUnixMs: null }]);
    }),
  );
});
