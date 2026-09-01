import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("058_CompositionAutomationOperations", (it) => {
  it.effect("为手动运行建立 operation 与重试来源字段及唯一索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_automation_runs')
      `;
      assert.isTrue(columns.some((column) => column.name === "operation_id"));
      assert.isTrue(columns.some((column) => column.name === "source_automation_run_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_composition_automation_runs_operation'
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        ["idx_composition_automation_runs_operation"],
      );
    }),
  );

  it.effect("数据库拒绝重复 operation 和不匹配触发类型的身份字段", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* insertAutomation(sql);
      yield* insertManualRun(sql, {
        automationRunId: "manual-run-1",
        scheduledForUnixMs: 3_000,
        operationId: "operation-1",
      });

      const duplicateOperation = yield* Effect.result(
        insertManualRun(sql, {
          automationRunId: "manual-run-2",
          scheduledForUnixMs: 3_001,
          operationId: "operation-1",
        }),
      );
      const missingOperation = yield* Effect.result(sql`
        INSERT INTO composition_automation_runs (
          automation_run_id, automation_id, automation_revision,
          scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
          requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
          composition_task_id, composition_run_id, output_summary,
          error_code, error_detail, operation_id, source_automation_run_id
        ) VALUES (
          'manual-missing-operation', 'automation-1', 1,
          3002, 'composition-automation:automation-1:3002', 'run_once', 'queued', 1,
          3002, NULL, NULL,
          NULL, NULL, NULL,
          NULL, NULL, NULL, NULL
        )
      `);
      const scheduledWithOperation = yield* Effect.result(sql`
        INSERT INTO composition_automation_runs (
          automation_run_id, automation_id, automation_revision,
          scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
          requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
          composition_task_id, composition_run_id, output_summary,
          error_code, error_detail, operation_id, source_automation_run_id
        ) VALUES (
          'scheduled-with-operation', 'automation-1', 1,
          3003, 'composition-automation:automation-1:3003', 'scheduled', 'queued', 1,
          3003, NULL, NULL,
          NULL, NULL, NULL,
          NULL, NULL, 'operation-scheduled', NULL
        )
      `);
      const retryWithoutSource = yield* Effect.result(
        insertManualRun(sql, {
          automationRunId: "retry-missing-source",
          scheduledForUnixMs: 3_004,
          operationId: "operation-retry",
          trigger: "retry",
        }),
      );

      assert.equal(duplicateOperation._tag, "Failure");
      assert.equal(missingOperation._tag, "Failure");
      assert.equal(scheduledWithOperation._tag, "Failure");
      assert.equal(retryWithoutSource._tag, "Failure");
    }),
  );
});

const insertAutomation = (sql: SqlClient.SqlClient) =>
  sql`
    INSERT INTO composition_automations (
      automation_id, project_id, name, prompt, cadence_json, target_json,
      status, revision, max_runs, run_count,
      created_at_unix_ms, updated_at_unix_ms,
      next_run_at_unix_ms, last_run_at_unix_ms,
      paused_at_unix_ms, expires_at_unix_ms
    ) VALUES (
      'automation-1', 'project-1', '手动运行测试', '检查项目状态',
      '{"type":"every","intervalMs":60000}',
      '{"type":"agent","agentId":"agent-1","capabilityIds":[],"executionContext":{"mode":"existing_thread","threadId":"thread-1"}}',
      'active', 1, 10, 0,
      1000, 2000,
      3000, NULL,
      NULL, 9000
    )
  `;

const insertManualRun = (
  sql: SqlClient.SqlClient,
  input: {
    readonly automationRunId: string;
    readonly scheduledForUnixMs: number;
    readonly operationId: string;
    readonly trigger?: "run_once" | "retry";
    readonly sourceAutomationRunId?: string;
  },
) => sql`
  INSERT INTO composition_automation_runs (
    automation_run_id, automation_id, automation_revision,
    scheduled_for_unix_ms, idempotency_key, trigger, status, attempt,
    requested_at_unix_ms, started_at_unix_ms, finished_at_unix_ms,
    composition_task_id, composition_run_id, output_summary,
    error_code, error_detail, operation_id, source_automation_run_id
  ) VALUES (
    ${input.automationRunId}, 'automation-1', 1,
    ${input.scheduledForUnixMs},
    ${`composition-automation:automation-1:${input.scheduledForUnixMs}`},
    ${input.trigger ?? "run_once"}, 'queued', 1,
    ${input.scheduledForUnixMs}, NULL, NULL,
    NULL, NULL, NULL,
    NULL, NULL, ${input.operationId}, ${input.sourceAutomationRunId ?? null}
  )
`;
