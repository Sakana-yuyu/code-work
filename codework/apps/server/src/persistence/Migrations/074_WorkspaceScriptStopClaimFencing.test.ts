import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("074_WorkspaceScriptStopClaimFencing", (it) => {
  it.effect("为既有 Workspace Script Run 追加可过期且可 fence 的停止 claim", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 73 });
      yield* insertLegacyRun(sql);

      const executed = yield* runMigrations({ toMigrationInclusive: 74 });
      assert.deepEqual(executed, [[74, "WorkspaceScriptStopClaimFencing"]]);

      const columns = yield* sql<{
        readonly dfltValue: string | null;
        readonly name: string;
        readonly notNull: number;
      }>`
        SELECT
          name,
          dflt_value AS "dfltValue",
          "notnull" AS "notNull"
        FROM pragma_table_info('workspace_script_runs')
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));
      assert.deepEqual(byName.get("stop_claim_owner_id"), {
        dfltValue: null,
        name: "stop_claim_owner_id",
        notNull: 0,
      });
      assert.deepEqual(byName.get("stop_claim_epoch"), {
        dfltValue: "0",
        name: "stop_claim_epoch",
        notNull: 1,
      });
      assert.deepEqual(byName.get("stop_claim_expires_at_unix_ms"), {
        dfltValue: null,
        name: "stop_claim_expires_at_unix_ms",
        notNull: 0,
      });

      const legacy = yield* sql<{
        readonly epoch: number;
        readonly expiresAtUnixMs: number | null;
        readonly ownerId: string | null;
      }>`
        SELECT
          stop_claim_owner_id AS "ownerId",
          stop_claim_epoch AS epoch,
          stop_claim_expires_at_unix_ms AS "expiresAtUnixMs"
        FROM workspace_script_runs
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `;
      assert.deepEqual(legacy, [{ ownerId: null, epoch: 0, expiresAtUnixMs: null }]);

      yield* sql`
        UPDATE workspace_script_runs
        SET
          status = 'stopping',
          revision = revision + 1,
          stop_operation_id = 'stop-operation-claim',
          stop_claim_owner_id = 'service-a:attempt-1',
          stop_claim_epoch = stop_claim_epoch + 1,
          stop_claim_expires_at_unix_ms = 5000,
          updated_at_unix_ms = 2000
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `;

      const partialClaim = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET stop_claim_owner_id = NULL
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `);
      const runningClaim = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET status = 'running'
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `);
      const staleExpiry = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET stop_claim_expires_at_unix_ms = updated_at_unix_ms
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `);
      const fractionalEpoch = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET stop_claim_epoch = 1.5
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `);
      const fractionalExpiry = yield* Effect.result(sql`
        UPDATE workspace_script_runs
        SET stop_claim_expires_at_unix_ms = 5000.5
        WHERE workspace_script_run_id = 'run-stop-claim-legacy'
      `);

      assert.equal(partialClaim._tag, "Failure");
      assert.equal(runningClaim._tag, "Failure");
      assert.equal(staleExpiry._tag, "Failure");
      assert.equal(fractionalEpoch._tag, "Failure");
      assert.equal(fractionalExpiry._tag, "Failure");
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 74 }), []);
    }),
  );
});

const insertLegacyRun = (sql: SqlClient.SqlClient) => sql`
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
    'run-stop-claim-legacy', 'key-stop-claim-legacy',
    'project-1', 'thread-1', 'serve', '启动服务',
    'terminal-stop-claim-legacy', 'E:/workspace/project-1', NULL,
    'running', 'unknown', NULL, NULL,
    '[]', 2,
    1000, 1100, NULL,
    NULL, NULL, NULL, NULL,
    NULL, NULL, NULL,
    1200
  )
`;
