import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("057_CompositionAutomations", (it) => {
  it.effect("建立 Automation、revision 与运行历史表及调度索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 57 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'composition_automations',
            'composition_automation_revisions',
            'composition_automation_runs'
          )
        ORDER BY name
      `;
      assert.deepEqual(
        tables.map((table) => table.name),
        [
          "composition_automation_revisions",
          "composition_automation_runs",
          "composition_automations",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name LIKE 'idx_composition_automation%'
        ORDER BY name
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_composition_automation_revisions_latest",
          "idx_composition_automation_runs_active",
          "idx_composition_automation_runs_history",
          "idx_composition_automations_due",
          "idx_composition_automations_project_status",
        ],
      );
    }),
  );

  it.effect("用 automationId 与 scheduledFor 唯一约束阻止跨重启重复触发", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* insertAutomation(sql);

      yield* sql`
        INSERT INTO composition_automation_runs (
          automation_run_id, automation_id, automation_revision,
          scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
          requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
          composition_task_id, composition_run_id, output_summary,
          error_code, error_detail
        ) VALUES (
          'automation-run-1', 'automation-1', 1,
          3000, 'composition-automation:automation-1:3000', 'scheduled', 'running', 1,
          3001, 3002, NULL,
          'task-1', 'run-1', NULL,
          NULL, NULL
        )
      `;

      const duplicatePlan = yield* Effect.result(sql`
        INSERT INTO composition_automation_runs (
          automation_run_id, automation_id, automation_revision,
          scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
          requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
          composition_task_id, composition_run_id, output_summary,
          error_code, error_detail
        ) VALUES (
          'automation-run-2', 'automation-1', 1,
          3000, 'composition-automation:automation-1:recovery:3000', 'recovery', 'running', 2,
          3003, 3004, NULL,
          'task-2', 'run-2', NULL,
          NULL, NULL
        )
      `);
      assert.equal(duplicatePlan._tag, "Failure");
    }),
  );

  it.effect("在数据库层拒绝非法状态时间和超过 maxRuns 的快照", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });

      const exceededRunLimit = yield* Effect.result(sql`
        INSERT INTO composition_automations (
          automation_id, project_id, name, prompt, cadence_json, target_json,
          status, revision, max_runs, run_count,
          created_at_unix_ms, updated_at_unix_ms,
          next_run_at_unix_ms, last_run_at_unix_ms,
          paused_at_unix_ms, expires_at_unix_ms
        ) VALUES (
          'automation-invalid-limit', 'project-1', '错误次数', '检查限制', '{}', '{}',
          'completed', 1, 1, 2,
          1000, 2000,
          NULL, 1500,
          NULL, 9000
        )
      `);
      assert.equal(exceededRunLimit._tag, "Failure");

      yield* insertAutomation(sql, "automation-constraints");
      const invalidTerminalTime = yield* Effect.result(sql`
        INSERT INTO composition_automation_runs (
          automation_run_id, automation_id, automation_revision,
          scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
          requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
          composition_task_id, composition_run_id, output_summary,
          error_code, error_detail
        ) VALUES (
          'automation-run-invalid', 'automation-constraints', 1,
          3000, 'composition-automation:automation-constraints:3000', 'scheduled', 'succeeded', 1,
          3001, 3002, NULL,
          'task-1', 'run-1', '完成',
          NULL, NULL
        )
      `);
      assert.equal(invalidTerminalTime._tag, "Failure");
    }),
  );
});

const insertAutomation = (sql: SqlClient.SqlClient, automationId = "automation-1") =>
  sql`
    INSERT INTO composition_automations (
      automation_id, project_id, name, prompt, cadence_json, target_json,
      status, revision, max_runs, run_count,
      created_at_unix_ms, updated_at_unix_ms,
      next_run_at_unix_ms, last_run_at_unix_ms,
      paused_at_unix_ms, expires_at_unix_ms
    ) VALUES (
      ${automationId}, 'project-1', '每日检查', '检查项目状态',
      '{"type":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}',
      '{"type":"agent","agentId":"agent-1"}',
      'active', 1, 10, 0,
      1000, 2000,
      3000, NULL,
      NULL, 9000
    )
  `;
