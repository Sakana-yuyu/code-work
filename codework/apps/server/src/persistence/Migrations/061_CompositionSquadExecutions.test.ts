import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("061_CompositionSquadExecutions", (it) => {
  it.effect("以追加迁移建立可恢复的 Squad execution 当前投影与查询索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* runMigrations({ toMigrationInclusive: 61 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_executions')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "execution_id",
          "squad_id",
          "squad_revision",
          "project_id",
          "thread_id",
          "goal_digest",
          "goal_task_id",
          "workspace_root_digest",
          "status",
          "revision",
          "nodes_json",
          "leader_task_id",
          "leader_run_id",
          "pending_approvals_json",
          "paused_from_status",
          "result_summary",
          "failure_code",
          "failure_detail",
          "created_at_unix_ms",
          "updated_at_unix_ms",
          "started_at_unix_ms",
          "paused_at_unix_ms",
          "cancel_requested_at_unix_ms",
          "finished_at_unix_ms",
        ],
      );
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND (
            name LIKE 'idx_composition_squad_executions_%' OR
            name LIKE 'uq_composition_squad_executions_%'
          )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_composition_squad_executions_project_history",
          "idx_composition_squad_executions_squad_history",
          "idx_composition_squad_executions_thread_history",
          "idx_composition_squad_executions_unsettled",
          "uq_composition_squad_executions_goal_task",
          "uq_composition_squad_executions_leader_run",
          "uq_composition_squad_executions_leader_task",
        ],
      );
      const rerun = yield* runMigrations({ toMigrationInclusive: 61 });
      assert.deepEqual(rerun, []);
    }),
  );

  it.effect("数据库拒绝非法 JSON、状态时间线与重复执行身份", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });

      yield* insertQueuedExecution(sql, { executionId: "execution-valid" });
      const invalidStatus = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-invalid-status",
          status: "unknown",
        }),
      );
      const invalidJson = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-invalid-json",
          nodesJson: "not-json",
        }),
      );
      const invalidTimeline = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-invalid-timeline",
          createdAtUnixMs: 200,
          updatedAtUnixMs: 100,
        }),
      );
      const invalidTerminal = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-invalid-terminal",
          status: "completed",
          nodesJson: "[]",
          startedAtUnixMs: 100,
        }),
      );
      const pausedBeforeStartWithStarted = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-paused-before-start-with-started",
          status: "paused",
          startedAtUnixMs: 110,
          pausedFromStatus: "queued",
          pausedAtUnixMs: 120,
          updatedAtUnixMs: 120,
        }),
      );
      const duplicateGoalTask = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-duplicate-goal",
          goalTaskId: "goal-task-execution-valid",
        }),
      );
      const duplicateLeaderTask = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-duplicate-leader-task",
          leaderTaskId: "leader-task-execution-valid",
        }),
      );
      const duplicateLeaderRun = yield* Effect.result(
        insertQueuedExecution(sql, {
          executionId: "execution-duplicate-leader-run",
          leaderRunId: "leader-run-execution-valid",
        }),
      );
      assert.equal(invalidStatus._tag, "Failure");
      assert.equal(invalidJson._tag, "Failure");
      assert.equal(invalidTimeline._tag, "Failure");
      assert.equal(invalidTerminal._tag, "Failure");
      assert.equal(pausedBeforeStartWithStarted._tag, "Failure");
      assert.equal(duplicateGoalTask._tag, "Failure");
      assert.equal(duplicateLeaderTask._tag, "Failure");
      assert.equal(duplicateLeaderRun._tag, "Failure");
    }),
  );
});

interface ExecutionInsertOverrides {
  readonly executionId: string;
  readonly goalTaskId?: string;
  readonly leaderTaskId?: string;
  readonly leaderRunId?: string;
  readonly status?: string;
  readonly nodesJson?: string | null;
  readonly createdAtUnixMs?: number;
  readonly updatedAtUnixMs?: number;
  readonly startedAtUnixMs?: number | null;
  readonly pausedFromStatus?: string | null;
  readonly pausedAtUnixMs?: number | null;
}

const insertQueuedExecution = (sql: SqlClient.SqlClient, overrides: ExecutionInsertOverrides) => {
  const executionId = overrides.executionId;
  return sql`
    INSERT INTO composition_squad_executions (
      execution_id, squad_id, squad_revision, project_id, thread_id,
      goal_digest, goal_task_id, workspace_root_digest,
      status, revision, nodes_json, leader_task_id, leader_run_id,
      pending_approvals_json, paused_from_status,
      result_summary, failure_code, failure_detail,
      created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms,
      paused_at_unix_ms, cancel_requested_at_unix_ms, finished_at_unix_ms
    ) VALUES (
      ${executionId}, 'squad-61', 1, 'project-61', NULL,
      'sha256:goal-61', ${overrides.goalTaskId ?? `goal-task-${executionId}`},
      'sha256:workspace-61',
      ${overrides.status ?? "queued"}, 1, ${overrides.nodesJson ?? null},
      ${overrides.leaderTaskId ?? `leader-task-${executionId}`},
      ${overrides.leaderRunId ?? `leader-run-${executionId}`},
      '[]', ${overrides.pausedFromStatus ?? null},
      NULL, NULL, NULL,
      ${overrides.createdAtUnixMs ?? 100}, ${overrides.updatedAtUnixMs ?? 100},
      ${overrides.startedAtUnixMs ?? null},
      ${overrides.pausedAtUnixMs ?? null}, NULL, NULL
    )
  `;
};
