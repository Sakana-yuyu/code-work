import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_CompositionSquadExecutionPlanDigest", (it) => {
  it.effect("为既有 execution 追加可选 plan 摘要并约束新值", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* insertLegacyQueuedExecution(sql, "execution-plan-legacy");

      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_executions')
      `;
      assert.isFalse(before.some((column) => column.name === "plan_digest"));

      const executed = yield* runMigrations({ toMigrationInclusive: 63 });
      assert.deepEqual(executed, [[63, "CompositionSquadExecutionPlanDigest"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_executions')
      `;
      assert.isTrue(columns.some((column) => column.name === "plan_digest"));
      const legacy = yield* sql<{ readonly planDigest: string | null }>`
        SELECT plan_digest AS "planDigest"
        FROM composition_squad_executions
        WHERE execution_id = 'execution-plan-legacy'
      `;
      assert.deepEqual(legacy, [{ planDigest: null }]);

      yield* insertQueuedExecution(sql, "execution-plan-new", "sha256:explicit-plan");
      const invalid = yield* Effect.result(
        insertQueuedExecution(sql, "execution-plan-invalid", "   "),
      );
      assert.equal(invalid._tag, "Failure");
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 63 }), []);
    }),
  );
});

const insertQueuedExecution = (
  sql: SqlClient.SqlClient,
  executionId: string,
  planDigest: string,
) => sql`
  INSERT INTO composition_squad_executions (
    execution_id, squad_id, squad_revision, project_id, thread_id,
    goal_digest, plan_digest, goal_task_id, workspace_root_digest,
    status, revision, nodes_json, leader_task_id, leader_run_id,
    pending_approvals_json, paused_from_status,
    result_summary, failure_code, failure_detail,
    created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms,
    paused_at_unix_ms, cancel_requested_at_unix_ms, finished_at_unix_ms
  ) VALUES (
    ${executionId}, 'squad-63', 1, 'project-63', NULL,
    'sha256:goal-63', ${planDigest},
    ${`goal-task-${executionId}`}, 'sha256:workspace-63',
    'queued', 1, NULL, ${`leader-task-${executionId}`},
    ${`leader-run-${executionId}`}, '[]', NULL, NULL, NULL, NULL,
    100, 100, NULL, NULL, NULL, NULL
  )
`;

const insertLegacyQueuedExecution = (sql: SqlClient.SqlClient, executionId: string) => sql`
  INSERT INTO composition_squad_executions (
    execution_id, squad_id, squad_revision, project_id, thread_id,
    goal_digest, goal_task_id, workspace_root_digest,
    status, revision, nodes_json, leader_task_id, leader_run_id,
    pending_approvals_json, paused_from_status,
    result_summary, failure_code, failure_detail,
    created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms,
    paused_at_unix_ms, cancel_requested_at_unix_ms, finished_at_unix_ms
  ) VALUES (
    ${executionId}, 'squad-63', 1, 'project-63', NULL,
    'sha256:goal-63', ${`goal-task-${executionId}`}, 'sha256:workspace-63',
    'queued', 1, NULL, ${`leader-task-${executionId}`},
    ${`leader-run-${executionId}`}, '[]', NULL, NULL, NULL, NULL,
    100, 100, NULL, NULL, NULL, NULL
  )
`;
