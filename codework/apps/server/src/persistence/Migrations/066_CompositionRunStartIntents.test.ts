import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("066_CompositionRunStartIntents", (it) => {
  it.effect("以追加迁移建立 Run Start claim 与 receipt 合同", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'composition_run_start_intents'
      `;
      assert.deepEqual(before, []);

      const executed = yield* runMigrations({ toMigrationInclusive: 66 });
      assert.deepEqual(executed, [[66, "CompositionRunStartIntents"]]);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_run_start_intents')
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "run_id",
          "task_id",
          "agent_id",
          "runtime_id",
          "attempt",
          "replay_policy",
          "state",
          "claim_id",
          "claimed_at_unix_ms",
          "runtime_task_id",
          "capability_handshake_id",
          "created_at_unix_ms",
          "updated_at_unix_ms",
        ],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 66 }), []);
    }),
  );

  it.effect("数据库拒绝非法 claim、receipt 与恢复状态组合", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });

      const preparedWithClaim = yield* Effect.result(
        insertIntent(sql, {
          runId: "run-start-invalid-prepared-claim",
          state: "prepared",
          claimId: "claim-invalid",
          claimedAtUnixMs: 100,
        }),
      );
      const dispatchingWithoutClaim = yield* Effect.result(
        insertIntent(sql, {
          runId: "run-start-invalid-dispatching",
          state: "dispatching",
        }),
      );
      const acceptedWithClaim = yield* Effect.result(
        insertIntent(sql, {
          runId: "run-start-invalid-accepted-claim",
          state: "accepted",
          claimId: "claim-invalid",
          claimedAtUnixMs: 100,
          runtimeTaskId: "runtime-task-invalid",
        }),
      );
      const invalidPolicy = yield* Effect.result(
        insertIntent(sql, {
          runId: "run-start-invalid-policy",
          replayPolicy: "unsafe",
        }),
      );

      assert.equal(preparedWithClaim._tag, "Failure");
      assert.equal(dispatchingWithoutClaim._tag, "Failure");
      assert.equal(acceptedWithClaim._tag, "Failure");
      assert.equal(invalidPolicy._tag, "Failure");
    }),
  );
});

const insertIntent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string;
    readonly replayPolicy?: string;
    readonly state?: string;
    readonly claimId?: string;
    readonly claimedAtUnixMs?: number;
    readonly runtimeTaskId?: string;
  },
) =>
  sql`
    INSERT INTO composition_run_start_intents (
      run_id, task_id, agent_id, runtime_id, attempt, replay_policy, state,
      claim_id, claimed_at_unix_ms, runtime_task_id, capability_handshake_id,
      created_at_unix_ms, updated_at_unix_ms
    ) VALUES (
      ${input.runId}, 'task-run-start', 'agent-run-start', 'runtime-run-start', 2,
      ${input.replayPolicy ?? "fail_closed"}, ${input.state ?? "prepared"},
      ${input.claimId ?? null}, ${input.claimedAtUnixMs ?? null},
      ${input.runtimeTaskId ?? null}, NULL, 100, 100
    )
  `;
