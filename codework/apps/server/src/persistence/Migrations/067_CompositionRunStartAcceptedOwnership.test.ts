import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const legacyStateLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

legacyStateLayer("067_CompositionRunStartAcceptedOwnership 历史状态", (it) => {
  it.effect("归一化 065/066 历史状态并阻止无围栏 dispatch 自动重放", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
          payload_digest, capability_digest, state, revision, claim_id,
          runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
          created_at_unix_ms, updated_at_unix_ms, owner_epoch,
          owner_lease_expires_at_unix_ms
        ) VALUES
          (
            'run-prepared', 'task-prepared', NULL, 'agent', 'runtime', 1,
            'payload-prepared', 'capability-prepared', 'prepared', 1, NULL,
            NULL, NULL, NULL, NULL, 100, 110, 3, 500
          ),
          (
            'run-preparing-legacy', 'task-preparing-legacy', NULL, 'agent', 'runtime', 1,
            'payload-preparing-legacy', 'capability-preparing-legacy', 'preparing', 2,
            'claim-preparing-legacy', NULL, NULL, NULL, NULL, 100, 120, 0, NULL
          ),
          (
            'run-dispatching-legacy', 'task-dispatching-legacy', NULL, 'agent', 'runtime', 1,
            'payload-dispatching-legacy', 'capability-dispatching-legacy', 'dispatching', 3,
            'claim-dispatching-legacy', NULL, NULL, NULL, NULL, 100, 130, 0, NULL
          ),
          (
            'run-preparing-owned', 'task-preparing-owned', NULL, 'agent', 'runtime', 1,
            'payload-preparing-owned', 'capability-preparing-owned', 'preparing', 4,
            'claim-preparing-owned', NULL, NULL, NULL, NULL, 100, 140, 2, 600
          ),
          (
            'run-dispatching-owned', 'task-dispatching-owned', NULL, 'agent', 'runtime', 1,
            'payload-dispatching-owned', 'capability-dispatching-owned', 'dispatching', 5,
            'claim-dispatching-owned', NULL, NULL, NULL, NULL, 100, 150, 3, 700
          ),
          (
            'run-accepted', 'task-accepted', NULL, 'agent', 'runtime', 1,
            'payload-accepted', 'capability-accepted', 'accepted', 6, NULL,
            'runtime-task-accepted', NULL, NULL, NULL, 100, 160, 4, 800
          ),
          (
            'run-settled-success', 'task-settled-success', NULL, 'agent', 'runtime', 1,
            'payload-settled-success', 'capability-settled-success', 'settled', 7, NULL,
            'runtime-task-settled', NULL, NULL, NULL, 100, 170, 5, 900
          ),
          (
            'run-settled-rejected', 'task-settled-rejected', NULL, 'agent', 'runtime', 1,
            'payload-settled-rejected', 'capability-settled-rejected', 'settled', 8, NULL,
            NULL, NULL, 'driver_rejected', 'Driver 拒绝启动。', 100, 180, 0, NULL
          ),
          (
            'run-settled-inconsistent', 'task-settled-inconsistent', NULL,
            'agent', 'runtime', 1, 'payload-settled-inconsistent',
            'capability-settled-inconsistent', 'settled', 9, NULL,
            'runtime-task-conflict', NULL, 'driver_rejected', '冲突旧数据。',
            100, 190, 0, NULL
          ),
          (
            'run-quarantined', 'task-quarantined', NULL, 'agent', 'runtime', 1,
            'payload-quarantined', 'capability-quarantined', 'quarantined', 10, NULL,
            NULL, NULL, 'manual_required', '等待人工核对。', 100, 200, 6, 1000
          )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 67 });
      assert.deepEqual(executed, [[67, "CompositionRunStartAcceptedOwnership"]]);

      const rows = yield* sql<{
        readonly runId: string;
        readonly state: string;
        readonly revision: number;
        readonly claimId: string | null;
        readonly runtimeTaskId: string | null;
        readonly outcomeCode: string | null;
        readonly ownerEpoch: number;
        readonly ownerLeaseExpiresAtUnixMs: number | null;
      }>`
        SELECT run_id AS "runId", state, revision, claim_id AS "claimId",
          runtime_task_id AS "runtimeTaskId", outcome_code AS "outcomeCode",
          owner_epoch AS "ownerEpoch",
          owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs"
        FROM composition_run_start_intents
        ORDER BY run_id ASC
      `;

      assert.deepEqual(rows, [
        {
          runId: "run-accepted",
          state: "accepted",
          revision: 6,
          claimId: null,
          runtimeTaskId: "runtime-task-accepted",
          outcomeCode: null,
          ownerEpoch: 4,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-dispatching-legacy",
          state: "quarantined",
          revision: 4,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: "run_start_legacy_dispatch_unfenced",
          ownerEpoch: 0,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-dispatching-owned",
          state: "dispatching",
          revision: 5,
          claimId: "claim-dispatching-owned",
          runtimeTaskId: null,
          outcomeCode: null,
          ownerEpoch: 3,
          ownerLeaseExpiresAtUnixMs: 700,
        },
        {
          runId: "run-prepared",
          state: "prepared",
          revision: 1,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: null,
          ownerEpoch: 3,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-preparing-legacy",
          state: "prepared",
          revision: 3,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: null,
          ownerEpoch: 0,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-preparing-owned",
          state: "preparing",
          revision: 4,
          claimId: "claim-preparing-owned",
          runtimeTaskId: null,
          outcomeCode: null,
          ownerEpoch: 2,
          ownerLeaseExpiresAtUnixMs: 600,
        },
        {
          runId: "run-quarantined",
          state: "quarantined",
          revision: 10,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: "manual_required",
          ownerEpoch: 6,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-settled-inconsistent",
          state: "quarantined",
          revision: 10,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: "run_start_legacy_settled_inconsistent",
          ownerEpoch: 0,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-settled-rejected",
          state: "settled",
          revision: 8,
          claimId: null,
          runtimeTaskId: null,
          outcomeCode: "driver_rejected",
          ownerEpoch: 0,
          ownerLeaseExpiresAtUnixMs: null,
        },
        {
          runId: "run-settled-success",
          state: "settled",
          revision: 7,
          claimId: null,
          runtimeTaskId: "runtime-task-settled",
          outcomeCode: null,
          ownerEpoch: 5,
          ownerLeaseExpiresAtUnixMs: null,
        },
      ]);
    }),
  );
});

const acceptedOwnershipLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

acceptedOwnershipLayer("067_CompositionRunStartAcceptedOwnership accepted owner", (it) => {
  it.effect("保留旧 accepted 行并允许持久 owner 围栏 receipt 收口", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, previous_run_id, agent_id, runtime_id, attempt,
          payload_digest, capability_digest, state, revision, claim_id,
          runtime_task_id, capability_handshake_id, outcome_code, outcome_detail,
          created_at_unix_ms, updated_at_unix_ms, owner_epoch,
          owner_lease_expires_at_unix_ms
        ) VALUES (
          'run-accepted-legacy', 'task-accepted-legacy', NULL,
          'agent-accepted-legacy', 'runtime-accepted-legacy', 1,
          'sha256:payload-accepted-legacy', 'sha256:capability-accepted-legacy',
          'accepted', 4, NULL, 'runtime-task-accepted-legacy', NULL, NULL, NULL,
          100, 120, 1, NULL
        )
      `;

      const executed = yield* runMigrations({ toMigrationInclusive: 67 });
      assert.deepEqual(executed, [[67, "CompositionRunStartAcceptedOwnership"]]);
      const preserved = yield* sql<{
        readonly state: string;
        readonly runtimeTaskId: string;
        readonly claimId: string | null;
      }>`
        SELECT state, runtime_task_id AS "runtimeTaskId", claim_id AS "claimId"
        FROM composition_run_start_intents
        WHERE run_id = 'run-accepted-legacy'
      `;
      assert.deepEqual(preserved, [
        {
          state: "accepted",
          runtimeTaskId: "runtime-task-accepted-legacy",
          claimId: null,
        },
      ]);

      yield* sql`
        UPDATE composition_run_start_intents
        SET claim_id = 'claim-accepted-recovery', owner_epoch = 2,
          owner_lease_expires_at_unix_ms = 220, revision = 5
        WHERE run_id = 'run-accepted-legacy'
      `;
      yield* sql`
        UPDATE composition_run_start_intents
        SET state = 'settled', owner_lease_expires_at_unix_ms = NULL, revision = 6
        WHERE run_id = 'run-accepted-legacy'
      `;
      const invalidHalfOwner = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET state = 'accepted', owner_lease_expires_at_unix_ms = NULL
        WHERE run_id = 'run-accepted-legacy'
      `);
      const settled = yield* sql<{
        readonly state: string;
        readonly claimId: string;
        readonly ownerEpoch: number;
        readonly ownerLeaseExpiresAtUnixMs: number | null;
      }>`
        SELECT state, claim_id AS "claimId", owner_epoch AS "ownerEpoch",
          owner_lease_expires_at_unix_ms AS "ownerLeaseExpiresAtUnixMs"
        FROM composition_run_start_intents
        WHERE run_id = 'run-accepted-legacy'
      `;

      assert.equal(invalidHalfOwner._tag, "Failure");
      assert.deepEqual(settled, [
        {
          state: "settled",
          claimId: "claim-accepted-recovery",
          ownerEpoch: 2,
          ownerLeaseExpiresAtUnixMs: null,
        },
      ]);
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 67 }), []);
    }),
  );
});

const manualPendingLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

manualPendingLayer("067_CompositionRunStartAcceptedOwnership manual pending", (it) => {
  it.effect("约束 manual_pending owner/结果并提供相互隔离的 keyset 索引", () =>
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
            'run-manual-a', 'task-manual-a', NULL, 'agent', 'runtime', 1,
            'payload-manual-a', 'capability-manual-a', 'manual_pending', 4, NULL,
            'runtime-task-manual-a', 'handshake-manual-a', 'manual_a', '等待人工核对 A。',
            100, 140, 1, NULL
          ),
          (
            'run-manual-b', 'task-manual-b', NULL, 'agent', 'runtime', 1,
            'payload-manual-b', 'capability-manual-b', 'manual_pending', 6,
            'claim-manual-b', 'runtime-task-manual-b', NULL, 'manual_b', NULL,
            100, 160, 3, 260
          ),
          (
            'run-recoverable-a', 'task-recoverable-a', NULL, 'agent', 'runtime', 1,
            'payload-recoverable-a', 'capability-recoverable-a', 'prepared', 1, NULL,
            NULL, NULL, NULL, NULL, 100, 120, 0, NULL
          ),
          (
            'run-recoverable-b', 'task-recoverable-b', NULL, 'agent', 'runtime', 1,
            'payload-recoverable-b', 'capability-recoverable-b', 'accepted', 5, NULL,
            'runtime-task-recoverable-b', NULL, NULL, NULL, 100, 150, 2, NULL
          )
      `;

      const missingOutcome = yield* Effect.result(sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, agent_id, runtime_id, attempt, payload_digest, capability_digest,
          state, revision, claim_id, runtime_task_id, capability_handshake_id,
          outcome_code, outcome_detail, created_at_unix_ms, updated_at_unix_ms,
          owner_epoch, owner_lease_expires_at_unix_ms
        ) VALUES (
          'run-manual-invalid-outcome', 'task-manual-invalid-outcome', 'agent', 'runtime', 1,
          'payload', 'capability', 'manual_pending', 1, NULL, 'runtime-task', NULL,
          NULL, NULL, 100, 100, 1, NULL
        )
      `);
      const halfOwner = yield* Effect.result(sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, agent_id, runtime_id, attempt, payload_digest, capability_digest,
          state, revision, claim_id, runtime_task_id, capability_handshake_id,
          outcome_code, outcome_detail, created_at_unix_ms, updated_at_unix_ms,
          owner_epoch, owner_lease_expires_at_unix_ms
        ) VALUES (
          'run-manual-invalid-owner', 'task-manual-invalid-owner', 'agent', 'runtime', 1,
          'payload', 'capability', 'manual_pending', 1, 'claim-invalid', 'runtime-task', NULL,
          'manual_invalid', NULL, 100, 100, 1, NULL
        )
      `);
      const zeroEpochOwner = yield* Effect.result(sql`
        INSERT INTO composition_run_start_intents (
          run_id, task_id, agent_id, runtime_id, attempt, payload_digest, capability_digest,
          state, revision, claim_id, runtime_task_id, capability_handshake_id,
          outcome_code, outcome_detail, created_at_unix_ms, updated_at_unix_ms,
          owner_epoch, owner_lease_expires_at_unix_ms
        ) VALUES (
          'run-manual-invalid-epoch', 'task-manual-invalid-epoch', 'agent', 'runtime', 1,
          'payload', 'capability', 'manual_pending', 1, 'claim-invalid', 'runtime-task', NULL,
          'manual_invalid', NULL, 100, 100, 0, 200
        )
      `);

      yield* sql`
        UPDATE composition_run_start_intents
        SET state = 'settled', owner_lease_expires_at_unix_ms = NULL, revision = revision + 1
        WHERE run_id = 'run-manual-b'
      `;
      const invalidSettledReceiptOutcome = yield* Effect.result(sql`
        UPDATE composition_run_start_intents
        SET claim_id = NULL
        WHERE run_id = 'run-manual-b'
      `);

      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql
        FROM sqlite_master
        WHERE type = 'index' AND name IN (
          'idx_composition_run_start_recoverable',
          'idx_composition_run_start_manual_recovery'
        )
        ORDER BY name ASC
      `;
      const manualRows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId"
        FROM composition_run_start_intents INDEXED BY idx_composition_run_start_manual_recovery
        WHERE state = 'manual_pending' AND run_id > 'run-manual-0' AND run_id <= 'run-manual-a'
        ORDER BY run_id ASC
      `;
      const recoverableRows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId"
        FROM composition_run_start_intents INDEXED BY idx_composition_run_start_recoverable
        WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')
          AND run_id > 'run-recoverable-0' AND run_id <= 'run-recoverable-z'
        ORDER BY run_id ASC
      `;

      assert.equal(missingOutcome._tag, "Failure");
      assert.equal(halfOwner._tag, "Failure");
      assert.equal(zeroEpochOwner._tag, "Failure");
      assert.equal(invalidSettledReceiptOutcome._tag, "Failure");
      assert.equal(indexes.length, 2);
      assert.isTrue(indexes[0]?.sql.includes("WHERE state = 'manual_pending'"));
      assert.isTrue(
        indexes[1]?.sql.includes(
          "WHERE state IN ('prepared', 'preparing', 'dispatching', 'accepted')",
        ),
      );
      assert.deepEqual(manualRows, [{ runId: "run-manual-a" }]);
      assert.deepEqual(recoverableRows, [
        { runId: "run-recoverable-a" },
        { runId: "run-recoverable-b" },
      ]);
    }),
  );
});
