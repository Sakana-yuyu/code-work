import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("065_CompositionRunStartIntents", (it) => {
  it.effect("以追加迁移建立带身份摘要和 CAS revision 的 Run Start 合同", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });

      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name = 'composition_run_start_intents'
        `,
        [],
      );

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 65 }), [
        [65, "CompositionRunStartIntents"],
      ]);

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
          "payload_digest",
          "capability_digest",
          "state",
          "revision",
          "claim_id",
          "claimed_at_unix_ms",
          "runtime_task_id",
          "capability_handshake_id",
          "accepted_at_unix_ms",
          "outcome_code",
          "settled_at_unix_ms",
          "created_at_unix_ms",
          "updated_at_unix_ms",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'composition_run_start_intents'
        ORDER BY name ASC
      `;
      assert.includeMembers(
        indexes.map((index) => index.name),
        [
          "composition_run_start_intents_claim_id_unique",
          "composition_run_start_intents_runtime_task_unique",
          "composition_run_start_intents_task_attempt_unique",
        ],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 65 }), []);
    }),
  );

  it.effect("数据库拒绝非法 state、claim、receipt 与时间组合", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const invalidRows = [
        insertIntent(sql, {
          runId: "run-invalid-prepared-claim",
          state: "prepared",
          claimId: "claim-invalid",
          claimedAtUnixMs: 110,
        }),
        insertIntent(sql, {
          runId: "run-invalid-dispatching-owner",
          state: "dispatching",
        }),
        insertIntent(sql, {
          runId: "run-invalid-accepted-time",
          state: "accepted",
          claimId: "claim-invalid-accepted",
          claimedAtUnixMs: 110,
        }),
        insertIntent(sql, {
          runId: "run-invalid-indeterminate-code",
          state: "indeterminate",
          claimId: "claim-invalid-indeterminate",
          claimedAtUnixMs: 110,
        }),
        insertIntent(sql, {
          runId: "run-invalid-settled-order",
          state: "settled",
          claimId: "claim-invalid-settled",
          claimedAtUnixMs: 130,
          acceptedAtUnixMs: 120,
          settledAtUnixMs: 140,
        }),
        insertIntent(sql, {
          runId: "run-invalid-policy",
          replayPolicy: "unsafe",
        }),
        insertIntent(sql, {
          runId: "run-invalid-attempt-fraction",
          attempt: 1.5,
        }),
        insertIntent(sql, {
          runId: "run-invalid-revision-fraction",
          revision: 1.5,
        }),
      ];

      for (const row of invalidRows) {
        assert.equal((yield* Effect.result(row))._tag, "Failure");
      }
    }),
  );

  it.effect("数据库拒绝 task/attempt、claim 和 runtime receipt 的重复身份", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      yield* insertIntent(sql, { runId: "run-unique-owner" });
      assert.equal(
        (yield* Effect.result(
          insertIntent(sql, {
            runId: "run-unique-task-attempt-conflict",
          }),
        ))._tag,
        "Failure",
      );

      yield* insertIntent(sql, {
        runId: "run-unique-claim-owner",
        taskId: "task-unique-claim-owner",
        claimId: "claim-unique",
        claimedAtUnixMs: 110,
        state: "dispatching",
      });
      assert.equal(
        (yield* Effect.result(
          insertIntent(sql, {
            runId: "run-unique-claim-conflict",
            taskId: "task-unique-claim-conflict",
            claimId: "claim-unique",
            claimedAtUnixMs: 110,
            state: "dispatching",
          }),
        ))._tag,
        "Failure",
      );

      yield* insertIntent(sql, {
        runId: "run-unique-receipt-owner",
        taskId: "task-unique-receipt-owner",
        runtimeId: "runtime-unique-receipt",
        runtimeTaskId: "runtime-task-unique",
        claimId: "claim-unique-receipt-owner",
        claimedAtUnixMs: 110,
        acceptedAtUnixMs: 120,
        state: "accepted",
      });
      assert.equal(
        (yield* Effect.result(
          insertIntent(sql, {
            runId: "run-unique-receipt-conflict",
            taskId: "task-unique-receipt-conflict",
            runtimeId: "runtime-unique-receipt",
            runtimeTaskId: "runtime-task-unique",
            claimId: "claim-unique-receipt-conflict",
            claimedAtUnixMs: 110,
            acceptedAtUnixMs: 120,
            state: "accepted",
          }),
        ))._tag,
        "Failure",
      );
    }),
  );
});

const insertIntent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly runId: string;
    readonly taskId?: string;
    readonly runtimeId?: string;
    readonly replayPolicy?: string;
    readonly attempt?: number;
    readonly revision?: number;
    readonly state?: string;
    readonly claimId?: string;
    readonly claimedAtUnixMs?: number;
    readonly runtimeTaskId?: string;
    readonly acceptedAtUnixMs?: number;
    readonly outcomeCode?: string;
    readonly settledAtUnixMs?: number;
  },
) =>
  sql`
    INSERT INTO composition_run_start_intents (
      run_id, task_id, agent_id, runtime_id, attempt,
      replay_policy, payload_digest, capability_digest,
      state, revision, claim_id, claimed_at_unix_ms,
      runtime_task_id, capability_handshake_id, accepted_at_unix_ms,
      outcome_code, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
    ) VALUES (
      ${input.runId}, ${input.taskId ?? "task-run-start"}, 'agent-run-start',
      ${input.runtimeId ?? "runtime-run-start"}, ${input.attempt ?? 2},
      ${input.replayPolicy ?? "fail_closed"}, 'sha256:payload', 'sha256:capabilities',
      ${input.state ?? "prepared"}, ${input.revision ?? 1}, ${input.claimId ?? null},
      ${input.claimedAtUnixMs ?? null}, ${input.runtimeTaskId ?? null}, NULL,
      ${input.acceptedAtUnixMs ?? null}, ${input.outcomeCode ?? null},
      ${input.settledAtUnixMs ?? null}, 100,
      ${Math.max(
        100,
        input.claimedAtUnixMs ?? 0,
        input.acceptedAtUnixMs ?? 0,
        input.settledAtUnixMs ?? 0,
      )}
    )
  `;
