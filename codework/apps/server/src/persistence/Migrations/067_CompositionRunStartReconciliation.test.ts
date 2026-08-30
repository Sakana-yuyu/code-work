import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  applyFrozenGoalLoopLedger65,
  applyFrozenRunStartHistory,
  type FrozenRunStartHistory,
} from "./CompositionRunStartMigrationHistory.fixture.ts";

const withFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const expectedIntentColumns = [
  "run_id",
  "task_id",
  "agent_id",
  "runtime_id",
  "attempt",
  "payload_digest",
  "capability_digest",
  "state",
  "revision",
  "claim_id",
  "claimed_at_unix_ms",
  "last_release_claim_id",
  "last_release_operation_id",
  "last_released_at_unix_ms",
  "runtime_task_id",
  "capability_handshake_id",
  "accepted_at_unix_ms",
  "outcome_code",
  "settled_at_unix_ms",
  "created_at_unix_ms",
  "updated_at_unix_ms",
] as const;

const assertFinalSchema = Effect.fn("assertFinalRunStartSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const intentColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info('composition_run_start_intents')
  `;
  const receiptColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info('composition_run_start_release_receipts')
  `;
  const quarantineColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info('composition_run_start_migration_quarantine')
  `;
  const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
    PRAGMA index_list('composition_run_start_intents')
  `;
  assert.deepEqual(
    intentColumns.map((column) => column.name),
    [...expectedIntentColumns],
  );
  assert.deepEqual(
    receiptColumns.map((column) => column.name),
    ["release_operation_id", "run_id", "claim_id", "released_at_unix_ms", "result_revision"],
  );
  assert.includeMembers(
    quarantineColumns.map((column) => column.name),
    ["run_id", "state", "revision", "claim_id", "claimed_at_unix_ms", "reason_code"],
  );
  for (const name of [
    "composition_run_start_intents_capability_handshake_unique",
    "composition_run_start_intents_active_scan",
    "composition_run_start_intents_indeterminate_scan",
  ]) {
    assert.ok(
      indexes.some((index) => index.name === name),
      `缺少索引 ${name}`,
    );
  }
  assert.equal(
    indexes.find((index) => index.name === "composition_run_start_intents_active_scan")?.partial,
    1,
  );
  assert.equal(
    indexes.find((index) => index.name === "composition_run_start_intents_indeterminate_scan")
      ?.partial,
    1,
  );
});

describe("067_CompositionRunStartReconciliation", () => {
  it.effect("clean main 从 064 连续执行 canonical、compatibility 与 reconciliation", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 64 });
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 67 }), [
          [65, "CompositionRunStartIntents"],
          [66, "CompositionRunStartCompatibility"],
          [67, "CompositionRunStartReconciliation"],
        ]);
        yield* assertFinalSchema();
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 67 }), []);
      }),
    ),
  );

  it.effect("旧 b7 只记录 ledger 65 且没有 Run Start 表时仍建立最终 schema", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 64 });
        yield* applyFrozenGoalLoopLedger65;
        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 67 }), [
          [66, "CompositionRunStartCompatibility"],
          [67, "CompositionRunStartReconciliation"],
        ]);
        yield* assertFinalSchema();
      }),
    ),
  );

  for (const history of [
    "8f-065",
    "8d-066",
    "2eb-066-release",
    "689-066-strict-replay",
    "30c-066-strict",
    "992-066-old-scan",
  ] as const satisfies ReadonlyArray<FrozenRunStartHistory>) {
    it.effect(`升级 ${history} 并保留未收口 intent、claim 与 receipt`, () =>
      withFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 64 });
          yield* applyFrozenRunStartHistory(history);
          yield* runMigrations({ toMigrationInclusive: 67 });
          yield* assertFinalSchema();

          const rows = yield* sql<{
            readonly runId: string;
            readonly state: string;
            readonly claimId: string | null;
          }>`
            SELECT run_id AS "runId", state, claim_id AS "claimId"
            FROM composition_run_start_intents
          `;
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.runId, `legacy-${history}`);
          if (history !== "2eb-066-release") {
            assert.equal(rows[0]?.claimId, `claim-${history}`);
          }

          const receipts = yield* sql<{
            readonly releaseOperationId: string;
            readonly runId: string;
            readonly claimId: string;
            readonly resultRevision: number;
          }>`
            SELECT release_operation_id AS "releaseOperationId", run_id AS "runId",
              claim_id AS "claimId", result_revision AS "resultRevision"
            FROM composition_run_start_release_receipts
          `;
          if (history === "2eb-066-release") {
            assert.deepEqual(receipts, [
              {
                releaseOperationId: `release-${history}`,
                runId: `legacy-${history}`,
                claimId: `claim-${history}`,
                resultRevision: 3,
              },
            ]);
          } else {
            assert.deepEqual(receipts, []);
          }
        }),
      ),
    );
  }

  it.effect("旧非规范摘要不会被伪造成 sha256，未收口 claim 进入脱敏 quarantine", () =>
    withFreshDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 64 });
        yield* applyFrozenRunStartHistory("8f-065-invalid-digest");
        yield* runMigrations({ toMigrationInclusive: 67 });

        assert.deepEqual(yield* sql`SELECT run_id FROM composition_run_start_intents`, []);
        const quarantine = yield* sql<{
          readonly runId: string;
          readonly state: string;
          readonly claimId: string;
          readonly reasonCode: string;
        }>`
          SELECT run_id AS "runId", state, claim_id AS "claimId", reason_code AS "reasonCode"
          FROM composition_run_start_migration_quarantine
        `;
        assert.deepEqual(quarantine, [
          {
            runId: "legacy-8f-065-invalid-digest",
            state: "dispatching",
            claimId: "claim-8f-065-invalid-digest",
            reasonCode: "legacy_digest_invalid",
          },
        ]);
        const quarantinedRows = yield* sql<Record<string, unknown>>`
          SELECT * FROM composition_run_start_migration_quarantine
        `;
        const serialized = Object.values(quarantinedRows[0] ?? {}).join("\n");
        assert.notInclude(serialized, "执行旧版原始 prompt");
        assert.notInclude(serialized, "filesystem.write");
      }),
    ),
  );
});
