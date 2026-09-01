import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("065_CompositionGoalLoopRetryIntents", (it) => {
  it.effect("以追加迁移建立 Goal Loop retry 持久阶段合同", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'composition_goal_loop_retry_intents'
      `;
      assert.deepEqual(before, []);

      const executed = yield* runMigrations({ toMigrationInclusive: 65 });
      assert.deepEqual(executed, [[65, "CompositionGoalLoopRetryIntents"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_goal_loop_retry_intents')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "previous_run_id",
          "task_id",
          "new_run_id",
          "phase",
          "revision",
          "created_at_unix_ms",
          "updated_at_unix_ms",
          "dispatch_claim_id",
          "dispatch_claimed_at_unix_ms",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'uq_composition_goal_loop_retry_new_run'
      `;
      assert.deepEqual(
        indexes.map((index) => index.name),
        ["uq_composition_goal_loop_retry_new_run"],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 65 }), []);
    }),
  );

  it.effect("数据库拒绝重复新 Run、非法阶段快照和相同的新旧 Run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* insertIntent(sql, { previousRunId: "run-old-1", newRunId: "run-new-1" });

      const duplicateNewRun = yield* Effect.result(
        insertIntent(sql, { previousRunId: "run-old-2", newRunId: "run-new-1" }),
      );
      const invalidSettled = yield* Effect.result(
        insertIntent(sql, {
          previousRunId: "run-old-invalid-settled",
          newRunId: "run-new-invalid-settled",
          phase: "settled",
          revision: 1,
        }),
      );
      const sameRun = yield* Effect.result(
        insertIntent(sql, { previousRunId: "run-same", newRunId: "run-same" }),
      );
      const incompleteClaim = yield* Effect.result(
        insertIntent(sql, {
          previousRunId: "run-old-incomplete-claim",
          newRunId: "run-new-incomplete-claim",
          phase: "settled",
          revision: 2,
          dispatchClaimId: "claim-incomplete",
        }),
      );
      const preparedClaim = yield* Effect.result(
        insertIntent(sql, {
          previousRunId: "run-old-prepared-claim",
          newRunId: "run-new-prepared-claim",
          dispatchClaimId: "claim-prepared",
          dispatchClaimedAtUnixMs: 100,
        }),
      );

      assert.equal(duplicateNewRun._tag, "Failure");
      assert.equal(invalidSettled._tag, "Failure");
      assert.equal(sameRun._tag, "Failure");
      assert.equal(incompleteClaim._tag, "Failure");
      assert.equal(preparedClaim._tag, "Failure");
    }),
  );
});

const insertIntent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly previousRunId: string;
    readonly newRunId: string;
    readonly phase?: string;
    readonly revision?: number;
    readonly dispatchClaimId?: string;
    readonly dispatchClaimedAtUnixMs?: number;
  },
) =>
  sql`
    INSERT INTO composition_goal_loop_retry_intents (
      previous_run_id, task_id, new_run_id, phase, revision,
      created_at_unix_ms, updated_at_unix_ms,
      dispatch_claim_id, dispatch_claimed_at_unix_ms
    ) VALUES (
      ${input.previousRunId}, 'task-goal-loop-retry', ${input.newRunId},
      ${input.phase ?? "prepared"}, ${input.revision ?? 1}, 100, 100,
      ${input.dispatchClaimId ?? null}, ${input.dispatchClaimedAtUnixMs ?? null}
    )
  `;
