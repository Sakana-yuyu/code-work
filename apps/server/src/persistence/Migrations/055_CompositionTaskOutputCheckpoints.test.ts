import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_CompositionTaskOutputCheckpoints", (it) => {
  it.effect("为已经执行 054 的任务事件表补充可恢复输出 checkpoint 字段", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* runMigrations({ toMigrationInclusive: 55 });

      yield* sql`
        INSERT INTO composition_task_events (
          task_id, run_id, source_event_id, agent_id, runtime_id, status, sequence,
          event_type, summary, output_delta, output_offset_bytes, output_digest
        ) VALUES (
          'task-output-55', 'run-output-55', 'checkpoint-output-55', 'agent-output-55',
          'runtime-output-55', 'running', 0, 'message', 'BYOK Agent 已保存部分输出',
          ' 部分输出\n', 13, 'sha256:checkpoint-55'
        )
      `;

      const rows = yield* sql<{
        readonly outputDelta: string;
        readonly outputOffsetBytes: number;
        readonly outputDigest: string;
      }>`
        SELECT
          output_delta AS "outputDelta",
          output_offset_bytes AS "outputOffsetBytes",
          output_digest AS "outputDigest"
        FROM composition_task_events
        WHERE source_event_id = 'checkpoint-output-55'
      `;
      assert.deepEqual(
        [...rows],
        [
          {
            outputDelta: " 部分输出\n",
            outputOffsetBytes: 13,
            outputDigest: "sha256:checkpoint-55",
          },
        ],
      );
    }),
  );
});
