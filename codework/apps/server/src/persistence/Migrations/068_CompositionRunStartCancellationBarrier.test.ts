import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const migrationLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

migrationLayer("068_CompositionRunStartCancellationBarrier", (it) => {
  it.effect("升级 067 行并补齐取消屏障列、accepted owner 与独立扫描索引", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
          payload_digest, capability_digest, state, revision, claim_id,
          runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
          created_at_unix_ms, updated_at_unix_ms, owner_epoch,
          owner_lease_expires_at_unix_ms
        ) VALUES
          (
            'run-accepted-owner-zero', 'task-accepted-owner-zero', NULL, 'agent', 'runtime', 1,
            'payload-accepted', 'capability-accepted', 'accepted', 4, NULL,
            NULL, NULL, NULL, NULL, 100, 140, 0, NULL
          ),
          (
            'run-settled-accepted-owner-zero', 'task-settled-accepted-owner-zero', NULL,
            'agent', 'runtime', 1, 'payload-settled-accepted', 'capability-settled-accepted',
            'settled', 5, NULL, NULL, NULL, NULL, NULL, 100, 150, 0, NULL
          ),
          (
            'run-settled-rejected', 'task-settled-rejected', NULL, 'agent', 'runtime', 1,
            'payload-rejected', 'capability-rejected', 'settled', 6, NULL,
            NULL, NULL, 'driver_rejected', 'Driver 拒绝启动。', 100, 160, 0, NULL
          )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 68 });
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('composition_run_start_intents')
      `;
      const rows = yield* sql<{
        readonly runId: string;
        readonly ownerEpoch: number;
        readonly cancelRequestedAtUnixMs: number | null;
        readonly cancelReason: string | null;
        readonly cancelSourceState: string | null;
        readonly cancelSourceRevision: number | null;
        readonly cancelSourceClaimId: string | null;
        readonly cancelSourceOwnerEpoch: number | null;
        readonly cancelStartOutcome: string | null;
        readonly cancelTerminalStatus: string | null;
        readonly cancelTerminalSourceEventId: string | null;
        readonly cancelTerminalObservedAtUnixMs: number | null;
      }>`
        SELECT run_id AS "runId", owner_epoch AS "ownerEpoch",
          cancel_requested_at_unix_ms AS "cancelRequestedAtUnixMs",
          cancel_reason AS "cancelReason", cancel_source_state AS "cancelSourceState",
          cancel_source_revision AS "cancelSourceRevision",
          cancel_source_claim_id AS "cancelSourceClaimId",
          cancel_source_owner_epoch AS "cancelSourceOwnerEpoch",
          cancel_start_outcome AS "cancelStartOutcome",
          cancel_terminal_status AS "cancelTerminalStatus",
          cancel_terminal_source_event_id AS "cancelTerminalSourceEventId",
          cancel_terminal_observed_at_unix_ms AS "cancelTerminalObservedAtUnixMs"
        FROM composition_run_start_intents
        ORDER BY run_id ASC
      `;
      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_composition_run_start_cancellation_recovery'
      `;

      assert.deepEqual(executed, [[68, "CompositionRunStartCancellationBarrier"]]);
      assert.deepEqual(
        columns.map((column) => column.name).filter((name) => name.startsWith("cancel_")),
        [
          "cancel_requested_at_unix_ms",
          "cancel_reason",
          "cancel_source_state",
          "cancel_source_revision",
          "cancel_source_claim_id",
          "cancel_source_owner_epoch",
          "cancel_start_outcome",
          "cancel_terminal_status",
          "cancel_terminal_source_event_id",
          "cancel_terminal_observed_at_unix_ms",
        ],
      );
      assert.deepEqual(rows, [
        {
          runId: "run-accepted-owner-zero",
          ownerEpoch: 1,
          cancelRequestedAtUnixMs: null,
          cancelReason: null,
          cancelSourceState: null,
          cancelSourceRevision: null,
          cancelSourceClaimId: null,
          cancelSourceOwnerEpoch: null,
          cancelStartOutcome: null,
          cancelTerminalStatus: null,
          cancelTerminalSourceEventId: null,
          cancelTerminalObservedAtUnixMs: null,
        },
        {
          runId: "run-settled-accepted-owner-zero",
          ownerEpoch: 1,
          cancelRequestedAtUnixMs: null,
          cancelReason: null,
          cancelSourceState: null,
          cancelSourceRevision: null,
          cancelSourceClaimId: null,
          cancelSourceOwnerEpoch: null,
          cancelStartOutcome: null,
          cancelTerminalStatus: null,
          cancelTerminalSourceEventId: null,
          cancelTerminalObservedAtUnixMs: null,
        },
        {
          runId: "run-settled-rejected",
          ownerEpoch: 0,
          cancelRequestedAtUnixMs: null,
          cancelReason: null,
          cancelSourceState: null,
          cancelSourceRevision: null,
          cancelSourceClaimId: null,
          cancelSourceOwnerEpoch: null,
          cancelStartOutcome: null,
          cancelTerminalStatus: null,
          cancelTerminalSourceEventId: null,
          cancelTerminalObservedAtUnixMs: null,
        },
      ]);
      assert.equal(indexes.length, 1);
      assert.isTrue(indexes[0]?.sql.includes("WHERE state = 'cancel_pending'"));
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 68 }), []);
    }),
  );

  it.effect("CHECK 拒绝未绑定来源、未决 receipt、半套终态和取消完成后丢失审计字段", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, agent_id, runtime_id, attempt,
          payload_digest, capability_digest, state, revision, claim_id,
          owner_epoch, owner_lease_expires_at_unix_ms,
          runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
          created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          'run-cancel-check', 'task-cancel-check', 'agent', 'runtime', 1,
          'payload', 'capability', 'dispatching', 3, 'claim-start', 1, 500,
          NULL, NULL, NULL, NULL, 100, 120
        )
      `;

      const missingSource = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET state = 'cancel_pending', revision = 4, claim_id = NULL,
          owner_lease_expires_at_unix_ms = NULL,
          cancel_requested_at_unix_ms = 130, cancel_reason = '用户取消',
          cancel_start_outcome = 'pending', updated_at_unix_ms = 130
        WHERE run_id = 'run-cancel-check'
      `);
      const pendingWithReceipt = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET state = 'cancel_pending', revision = 4, claim_id = NULL,
          owner_lease_expires_at_unix_ms = NULL, runtime_task_id = 'runtime-task',
          cancel_requested_at_unix_ms = 130, cancel_reason = '用户取消',
          cancel_source_state = 'dispatching', cancel_source_revision = 3,
          cancel_source_claim_id = 'claim-start', cancel_source_owner_epoch = 1,
          cancel_start_outcome = 'pending', updated_at_unix_ms = 130
        WHERE run_id = 'run-cancel-check'
      `);
      const halfTerminal = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET state = 'cancel_pending', revision = 4, claim_id = NULL,
          owner_lease_expires_at_unix_ms = NULL,
          cancel_requested_at_unix_ms = 130, cancel_reason = '用户取消',
          cancel_source_state = 'dispatching', cancel_source_revision = 3,
          cancel_source_claim_id = 'claim-start', cancel_source_owner_epoch = 1,
          cancel_start_outcome = 'accepted', cancel_terminal_status = 'cancelled',
          updated_at_unix_ms = 140
        WHERE run_id = 'run-cancel-check'
      `);
      const pendingSettled = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET state = 'settled', revision = 5, claim_id = 'claim-cancel', owner_epoch = 2,
          owner_lease_expires_at_unix_ms = NULL,
          cancel_requested_at_unix_ms = 130, cancel_reason = '用户取消',
          cancel_source_state = 'dispatching', cancel_source_revision = 3,
          cancel_source_claim_id = 'claim-start', cancel_source_owner_epoch = 1,
          cancel_start_outcome = 'pending', updated_at_unix_ms = 150
        WHERE run_id = 'run-cancel-check'
      `);

      assert.equal(missingSource._tag, "Failure");
      assert.equal(pendingWithReceipt._tag, "Failure");
      assert.equal(halfTerminal._tag, "Failure");
      assert.equal(pendingSettled._tag, "Failure");
    }),
  );
});
