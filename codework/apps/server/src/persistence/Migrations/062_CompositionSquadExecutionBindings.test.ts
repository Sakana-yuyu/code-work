import { CompositionSquadExecutionNode } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const encodeExecutionNodes = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(CompositionSquadExecutionNode)),
);

layer("062_CompositionSquadExecutionBindings", (it) => {
  it.effect("从已应用 061 的数据库追加全局 Task/Run 身份预留", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 61 });
      const before = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_execution_bindings')
      `;
      assert.deepEqual(before, []);
      yield* insertQueuedExecution(sql, "execution-binding-backfill", {
        nodesJson: encodeExecutionNodes([
          {
            nodeId: "node-backfill",
            agentId: "agent-backfill",
            taskId: "node-task-backfill",
            runId: "node-run-backfill",
            promptDigest: "sha256:node-backfill",
            dependsOnNodeIds: [],
          },
        ]),
      });

      const executed = yield* runMigrations({ toMigrationInclusive: 62 });
      assert.deepEqual(executed, [[62, "CompositionSquadExecutionBindings"]]);

      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info('composition_squad_execution_bindings')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        ["execution_id", "identity_kind", "identity_id", "role", "node_id"],
      );
      assert.deepEqual(
        columns.filter((column) => column.pk > 0).map((column) => [column.name, column.pk]),
        [
          ["identity_kind", 1],
          ["identity_id", 2],
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND (
            name LIKE 'idx_composition_squad_execution_bindings_%' OR
            name LIKE 'uq_composition_squad_execution_bindings_%'
          )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_composition_squad_execution_bindings_execution",
          "uq_composition_squad_execution_bindings_node_slot",
          "uq_composition_squad_execution_bindings_top_level_slot",
        ],
      );

      const foreignKeys = yield* sql<{
        readonly from: string;
        readonly table: string;
        readonly to: string;
        readonly onDelete: string;
      }>`
        SELECT "from", "table", "to", on_delete AS "onDelete"
        FROM pragma_foreign_key_list('composition_squad_execution_bindings')
      `;
      assert.deepEqual(foreignKeys, [
        {
          from: "execution_id",
          table: "composition_squad_executions",
          to: "execution_id",
          onDelete: "CASCADE",
        },
      ]);
      const backfilled = yield* sql<{
        readonly identityId: string;
        readonly identityKind: string;
        readonly nodeId: string | null;
        readonly role: string;
      }>`
        SELECT
          identity_id AS "identityId",
          identity_kind AS "identityKind",
          node_id AS "nodeId",
          role
        FROM composition_squad_execution_bindings
        WHERE execution_id = 'execution-binding-backfill'
        ORDER BY role ASC
      `;
      assert.deepEqual(backfilled, [
        {
          identityId: "goal-task-execution-binding-backfill",
          identityKind: "task",
          nodeId: null,
          role: "goal_task",
        },
        {
          identityId: "leader-run-execution-binding-backfill",
          identityKind: "run",
          nodeId: null,
          role: "leader_run",
        },
        {
          identityId: "leader-task-execution-binding-backfill",
          identityKind: "task",
          nodeId: null,
          role: "leader_task",
        },
        {
          identityId: "node-run-backfill",
          identityKind: "run",
          nodeId: "node-backfill",
          role: "node_run",
        },
        {
          identityId: "node-task-backfill",
          identityKind: "task",
          nodeId: "node-backfill",
          role: "node_task",
        },
      ]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 62 }), []);
    }),
  );

  it.effect("数据库拒绝跨 execution、跨角色、非法槽位与孤立 binding", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 62 });
      yield* insertQueuedExecution(sql, "execution-binding-owner");
      yield* insertQueuedExecution(sql, "execution-binding-peer");
      yield* insertExecutionBinding(sql, {
        executionId: "execution-binding-owner",
        identityKind: "task",
        identityId: "shared-task-identity",
        role: "goal_task",
      });
      yield* insertExecutionBinding(sql, {
        executionId: "execution-binding-owner",
        identityKind: "task",
        identityId: "node-task-owner",
        role: "node_task",
        nodeId: "node-one",
      });

      const crossRoleIdentity = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-peer",
          identityKind: "task",
          identityId: "shared-task-identity",
          role: "leader_task",
        }),
      );
      const duplicateTopLevelSlot = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-owner",
          identityKind: "task",
          identityId: "different-goal-task",
          role: "goal_task",
        }),
      );
      const duplicateNodeSlot = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-owner",
          identityKind: "task",
          identityId: "different-node-task",
          role: "node_task",
          nodeId: "node-one",
        }),
      );
      const invalidRoleKind = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-peer",
          identityKind: "run",
          identityId: "run-used-as-goal-task",
          role: "goal_task",
        }),
      );
      const missingNodeId = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-peer",
          identityKind: "run",
          identityId: "node-run-without-node",
          role: "node_run",
        }),
      );
      const unexpectedNodeId = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-binding-peer",
          identityKind: "run",
          identityId: "leader-run-with-node",
          role: "leader_run",
          nodeId: "node-one",
        }),
      );
      const missingExecution = yield* Effect.result(
        insertExecutionBinding(sql, {
          executionId: "execution-missing",
          identityKind: "task",
          identityId: "orphan-task",
          role: "goal_task",
        }),
      );

      for (const result of [
        crossRoleIdentity,
        duplicateTopLevelSlot,
        duplicateNodeSlot,
        invalidRoleKind,
        missingNodeId,
        unexpectedNodeId,
        missingExecution,
      ]) {
        assert.equal(result._tag, "Failure");
      }

      yield* sql`
        DELETE FROM composition_squad_executions
        WHERE execution_id = 'execution-binding-owner'
      `;
      const remaining = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM composition_squad_execution_bindings
        WHERE execution_id = 'execution-binding-owner'
      `;
      assert.deepEqual(remaining, [{ count: 0 }]);
    }),
  );
});

const conflictLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

conflictLayer("062_CompositionSquadExecutionBindings 冲突回填", (it) => {
  it.effect("旧 execution 身份冲突时原子拒绝记录 062", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 61 });
      const beforeRecorded = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM effect_sql_migrations
        WHERE migration_id = 62
      `;
      const beforeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_execution_bindings')
      `;
      assert.deepEqual(beforeRecorded, [{ count: 0 }]);
      assert.deepEqual(beforeColumns, []);

      yield* insertQueuedExecution(sql, "execution-binding-conflict-first", {
        leaderTaskId: "shared-backfill-task",
      });
      yield* insertQueuedExecution(sql, "execution-binding-conflict-second", {
        goalTaskId: "shared-backfill-task",
      });

      const migration = yield* Effect.exit(runMigrations({ toMigrationInclusive: 62 }));
      assert.equal(migration._tag, "Failure");
      const recorded = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count
        FROM effect_sql_migrations
        WHERE migration_id = 62
      `;
      const bindingColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_squad_execution_bindings')
      `;
      assert.deepEqual(recorded, [{ count: 0 }]);
      assert.deepEqual(bindingColumns, []);
    }),
  );
});

interface ExecutionInsertOverrides {
  readonly goalTaskId?: string;
  readonly leaderTaskId?: string;
  readonly leaderRunId?: string;
  readonly nodesJson?: string | null;
}

const insertQueuedExecution = (
  sql: SqlClient.SqlClient,
  executionId: string,
  overrides: ExecutionInsertOverrides = {},
) => sql`
  INSERT INTO composition_squad_executions (
    execution_id, squad_id, squad_revision, project_id, thread_id,
    goal_digest, goal_task_id, workspace_root_digest,
    status, revision, nodes_json, leader_task_id, leader_run_id,
    pending_approvals_json, paused_from_status,
    result_summary, failure_code, failure_detail,
    created_at_unix_ms, updated_at_unix_ms, started_at_unix_ms,
    paused_at_unix_ms, cancel_requested_at_unix_ms, finished_at_unix_ms
  ) VALUES (
    ${executionId}, 'squad-62', 1, 'project-62', NULL,
    'sha256:goal-62', ${overrides.goalTaskId ?? `goal-task-${executionId}`},
    'sha256:workspace-62',
    'queued', 1, ${overrides.nodesJson ?? null},
    ${overrides.leaderTaskId ?? `leader-task-${executionId}`},
    ${overrides.leaderRunId ?? `leader-run-${executionId}`},
    '[]', NULL, NULL, NULL, NULL,
    100, 100, NULL, NULL, NULL, NULL
  )
`;

interface ExecutionBindingInsert {
  readonly executionId: string;
  readonly identityKind: "task" | "run";
  readonly identityId: string;
  readonly role: "goal_task" | "leader_task" | "leader_run" | "node_task" | "node_run";
  readonly nodeId?: string;
}

const insertExecutionBinding = (sql: SqlClient.SqlClient, binding: ExecutionBindingInsert) => sql`
  INSERT INTO composition_squad_execution_bindings (
    execution_id, identity_kind, identity_id, role, node_id
  ) VALUES (
    ${binding.executionId}, ${binding.identityKind}, ${binding.identityId},
    ${binding.role}, ${binding.nodeId ?? null}
  )
`;
