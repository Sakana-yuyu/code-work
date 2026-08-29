import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("059_WorkspaceScriptRuns", (it) => {
  it.effect("建立 Workspace Script Run、停止幂等身份与查询索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('workspace_script_runs')
      `;
      const columnNames = columns.map((column) => column.name);
      assert.includeMembers(columnNames, [
        "workspace_script_run_id",
        "idempotency_key",
        "terminal_id",
        "status",
        "health_status",
        "ports_json",
        "revision",
        "stop_operation_id",
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name LIKE 'idx_workspace_script_runs_%'
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_workspace_script_runs_active",
          "idx_workspace_script_runs_project_history",
          "idx_workspace_script_runs_stop_operation",
          "idx_workspace_script_runs_thread_history",
        ],
      );
    }),
  );

  it.effect("数据库拒绝重复幂等键、非法终态和不成对关联身份", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* insertRun(sql, { workspaceScriptRunId: "run-1", idempotencyKey: "key-1" });

      const duplicateIdempotency = yield* Effect.result(
        insertRun(sql, { workspaceScriptRunId: "run-2", idempotencyKey: "key-1" }),
      );
      const invalidFinished = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET status = 'exited', finished_at_unix_ms = NULL
        WHERE workspace_script_run_id = 'run-1'
      `);
      const invalidRelation = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET composition_task_id = 'task-1', composition_run_id = NULL
        WHERE workspace_script_run_id = 'run-1'
      `);

      assert.equal(duplicateIdempotency._tag, "Failure");
      assert.equal(invalidFinished._tag, "Failure");
      assert.equal(invalidRelation._tag, "Failure");
    }),
  );
});

const insertRun = (
  sql: SqlClient.SqlClient,
  input: { readonly workspaceScriptRunId: string; readonly idempotencyKey: string },
) => sql`
  INSERT INTO workspace_script_runs (
    workspace_script_run_id, idempotency_key,
    project_id, thread_id, script_id, script_name,
    terminal_id, cwd, worktree_path,
    status, health_status, health_checked_at_unix_ms, health_detail,
    ports_json, revision,
    requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
    exit_code, exit_signal, error_code, error_detail,
    composition_task_id, composition_run_id, stop_operation_id,
    updated_at_unix_ms
  ) VALUES (
    ${input.workspaceScriptRunId}, ${input.idempotencyKey},
    'project-1', 'thread-1', 'serve', '启动服务',
    'terminal-1', 'E:/workspace/project-1', NULL,
    'running', 'unknown', NULL, NULL,
    '[]', 2,
    1000, 1100, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL,
    1200
  )
`;
