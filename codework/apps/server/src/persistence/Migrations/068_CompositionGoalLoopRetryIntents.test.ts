import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const applyFrozenGoalLoopRetryTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE composition_goal_loop_retry_intents (
      previous_run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      new_run_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('prepared', 'settled', 'dispatched')),
      revision INTEGER NOT NULL,
      created_at_unix_ms INTEGER NOT NULL,
      updated_at_unix_ms INTEGER NOT NULL,
      dispatch_claim_id TEXT,
      dispatch_claimed_at_unix_ms INTEGER
    )
  `;
  yield* sql`
    INSERT INTO composition_goal_loop_retry_intents (
      previous_run_id, task_id, new_run_id, phase, revision,
      created_at_unix_ms, updated_at_unix_ms,
      dispatch_claim_id, dispatch_claimed_at_unix_ms
    ) VALUES (
      'legacy-previous-run', 'legacy-task', 'legacy-new-run', 'settled', 2,
      100, 110, 'legacy-process-claim', 110
    )
  `;
});

describe("068_CompositionGoalLoopRetryIntents", () => {
  it.effect("clean main 创建 retry intent、恢复索引与 quarantine 表", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 68 }), [
          [68, "CompositionGoalLoopRetryIntents"],
        ]);

        const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
          PRAGMA index_list('composition_goal_loop_retry_intents')
        `;
        assert.ok(
          indexes.some(
            (index) =>
              index.name === "composition_goal_loop_retry_intents_recoverable_scan" &&
              index.partial === 1,
          ),
        );
        assert.deepEqual(
          (yield* sql<{ readonly name: string }>`
            PRAGMA table_info('composition_goal_loop_retry_quarantine')
          `).map((column) => column.name),
          ["previous_run_id", "outcome_code", "quarantined_at_unix_ms"],
        );
      }),
    ),
  );

  it.effect("旧 b7 表与遗留 dispatch claim 原样保留，由上层按 Run Start 证据恢复", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 67 });
        yield* applyFrozenGoalLoopRetryTable;
        yield* runMigrations({ toMigrationInclusive: 68 });

        const rows = yield* sql<{
          readonly previousRunId: string;
          readonly phase: string;
          readonly dispatchClaimId: string | null;
        }>`
          SELECT previous_run_id AS "previousRunId", phase,
            dispatch_claim_id AS "dispatchClaimId"
          FROM composition_goal_loop_retry_intents
        `;
        assert.deepEqual(rows, [
          {
            previousRunId: "legacy-previous-run",
            phase: "settled",
            dispatchClaimId: "legacy-process-claim",
          },
        ]);
      }),
    ),
  );
});
