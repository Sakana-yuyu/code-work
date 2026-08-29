import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("064_CompositionToolInvocations", (it) => {
  it.effect("以追加迁移建立只保存摘要的 Tool Invocation 幂等投影", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'composition_tool_invocations'
      `;
      assert.deepEqual(before, []);

      const executed = yield* runMigrations({ toMigrationInclusive: 64 });
      assert.deepEqual(executed, [[64, "CompositionToolInvocations"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_tool_invocations')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "idempotency_key",
          "task_id",
          "run_id",
          "agent_id",
          "tool_call_id",
          "canonical_tool_name",
          "operation",
          "arguments_digest",
          "scope_digest",
          "status",
          "revision",
          "outcome_code",
          "created_at_unix_ms",
          "updated_at_unix_ms",
          "claimed_at_unix_ms",
          "finished_at_unix_ms",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'uq_composition_tool_invocations_run_tool_call',
            'idx_composition_tool_invocations_unknown'
          )
        ORDER BY name ASC
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        [
          "idx_composition_tool_invocations_unknown",
          "uq_composition_tool_invocations_run_tool_call",
        ],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 64 }), []);
    }),
  );

  it.effect("数据库拒绝身份重复、非法状态快照和原始参数列", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* insertInvocation(sql, { idempotencyKey: "tool-invocation-valid" });

      const duplicateRunTool = yield* Effect.result(
        insertInvocation(sql, {
          idempotencyKey: "tool-invocation-duplicate-run-tool",
          runId: "run-tool-invocation-valid",
          toolCallId: "tool-call-tool-invocation-valid",
        }),
      );
      const invalidExecuting = yield* Effect.result(
        insertInvocation(sql, {
          idempotencyKey: "tool-invocation-invalid-executing",
          status: "executing",
          revision: 2,
          updatedAtUnixMs: 110,
        }),
      );
      const invalidSucceeded = yield* Effect.result(
        insertInvocation(sql, {
          idempotencyKey: "tool-invocation-invalid-succeeded",
          status: "succeeded",
          revision: 3,
          claimedAtUnixMs: 110,
          updatedAtUnixMs: 120,
        }),
      );
      const invalidUnknown = yield* Effect.result(
        insertInvocation(sql, {
          idempotencyKey: "tool-invocation-invalid-unknown",
          status: "unknown",
          revision: 3,
          claimedAtUnixMs: 110,
          finishedAtUnixMs: 120,
          updatedAtUnixMs: 120,
        }),
      );

      assert.equal(duplicateRunTool._tag, "Failure");
      assert.equal(invalidExecuting._tag, "Failure");
      assert.equal(invalidSucceeded._tag, "Failure");
      assert.equal(invalidUnknown._tag, "Failure");

      const columns = columnsToNames(
        yield* sql<{ readonly name: string }>`PRAGMA table_info('composition_tool_invocations')`,
      );
      assert.isFalse(columns.includes("arguments"));
      assert.isFalse(columns.includes("arguments_json"));
      assert.isFalse(columns.includes("workspace_root"));
      assert.isFalse(columns.includes("environment_json"));
      assert.isFalse(columns.includes("secret"));
    }),
  );
});

interface InvocationInsertOverrides {
  readonly idempotencyKey: string;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly status?: string;
  readonly revision?: number;
  readonly outcomeCode?: string | null;
  readonly createdAtUnixMs?: number;
  readonly updatedAtUnixMs?: number;
  readonly claimedAtUnixMs?: number | null;
  readonly finishedAtUnixMs?: number | null;
}

const insertInvocation = (sql: SqlClient.SqlClient, overrides: InvocationInsertOverrides) => {
  const id = overrides.idempotencyKey;
  return sql`
    INSERT INTO composition_tool_invocations (
      idempotency_key, task_id, run_id, agent_id, tool_call_id,
      canonical_tool_name, operation, arguments_digest, scope_digest,
      status, revision, outcome_code,
      created_at_unix_ms, updated_at_unix_ms,
      claimed_at_unix_ms, finished_at_unix_ms
    ) VALUES (
      ${id}, ${`task-${id}`}, ${overrides.runId ?? `run-${id}`},
      ${`agent-${id}`}, ${overrides.toolCallId ?? `tool-call-${id}`},
      'filesystem.read', 'read', 'sha256:arguments', 'sha256:scope',
      ${overrides.status ?? "prepared"}, ${overrides.revision ?? 1},
      ${overrides.outcomeCode ?? null},
      ${overrides.createdAtUnixMs ?? 100}, ${overrides.updatedAtUnixMs ?? 100},
      ${overrides.claimedAtUnixMs ?? null}, ${overrides.finishedAtUnixMs ?? null}
    )
  `;
};

const columnsToNames = (columns: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
  columns.map((column) => column.name);
