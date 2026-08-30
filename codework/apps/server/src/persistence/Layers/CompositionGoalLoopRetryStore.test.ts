import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CompositionGoalLoopRetryStore,
  CompositionGoalLoopRetryStoreDomainError,
} from "../Services/CompositionGoalLoopRetryStore.ts";
import { CompositionGoalLoopRetryStoreLive } from "./CompositionGoalLoopRetryStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CompositionGoalLoopRetryStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const isDomainError = Schema.is(CompositionGoalLoopRetryStoreDomainError);
const errorCode = (error: unknown): string | undefined =>
  isDomainError(error) ? error.code : undefined;

layer("CompositionGoalLoopRetryStore", (it) => {
  it.effect("首次请求固定 newRunId，重放候选值不能改写已持久身份", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      const prepared = yield* store.prepareIntent({
        taskId: "task-goal-retry-stable",
        previousRunId: "run-goal-retry-stable-old",
        newRunId: "run-goal-retry-stable-new",
        createdAtUnixMs: 100,
      });
      const replayed = yield* store.prepareIntent({
        taskId: prepared.taskId,
        previousRunId: prepared.previousRunId,
        newRunId: "run-goal-retry-ignored-candidate",
        createdAtUnixMs: 999,
      });
      const conflictingOwner = yield* store
        .prepareIntent({
          taskId: "task-goal-retry-conflict",
          previousRunId: "run-goal-retry-conflict-old",
          newRunId: prepared.newRunId,
          createdAtUnixMs: 101,
        })
        .pipe(Effect.flip);

      assert.deepEqual(prepared, {
        taskId: "task-goal-retry-stable",
        previousRunId: "run-goal-retry-stable-old",
        newRunId: "run-goal-retry-stable-new",
        phase: "prepared",
        revision: 1,
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
        quarantineCode: null,
        quarantinedAtUnixMs: null,
      });
      assert.deepEqual(replayed, prepared);
      assert.equal(errorCode(conflictingOwner), "goal_loop_retry_identity_conflict");
    }),
  );

  it.effect("阶段推进使用 revision CAS，禁止跳过 settled 且允许相同收据幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      const prepared = yield* store.prepareIntent({
        taskId: "task-goal-retry-phase",
        previousRunId: "run-goal-retry-phase-old",
        newRunId: "run-goal-retry-phase-new",
        createdAtUnixMs: 200,
      });
      const skipped = yield* store
        .markDispatched({
          previousRunId: prepared.previousRunId,
          expectedRevision: prepared.revision,
          updatedAtUnixMs: 210,
        })
        .pipe(Effect.flip);
      const settled = yield* store.markSettled({
        previousRunId: prepared.previousRunId,
        expectedRevision: prepared.revision,
        updatedAtUnixMs: 210,
      });
      const settledReplay = yield* store.markSettled({
        previousRunId: prepared.previousRunId,
        expectedRevision: prepared.revision,
        updatedAtUnixMs: 210,
      });
      const dispatched = yield* store.markDispatched({
        previousRunId: prepared.previousRunId,
        expectedRevision: settled.revision,
        updatedAtUnixMs: 220,
      });
      const dispatchedReplay = yield* store.markDispatched({
        previousRunId: prepared.previousRunId,
        expectedRevision: settled.revision,
        updatedAtUnixMs: 220,
      });

      assert.equal(errorCode(skipped), "goal_loop_retry_phase_conflict");
      assert.equal(settled.phase, "settled");
      assert.equal(settled.revision, 2);
      assert.deepEqual(settledReplay, settled);
      assert.equal(dispatched.phase, "dispatched");
      assert.equal(dispatched.revision, 3);
      assert.deepEqual(dispatchedReplay, dispatched);
    }),
  );

  it.effect("恢复扫描在数据库内分页并排除 dispatched 与 quarantine", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      for (const [index, suffix] of ["a", "b", "c", "d", "e"].entries()) {
        yield* store.prepareIntent({
          taskId: `task-goal-retry-page-${suffix}`,
          previousRunId: `run-goal-retry-page-${suffix}-old`,
          newRunId: `run-goal-retry-page-${suffix}-new`,
          createdAtUnixMs: 300 + index,
        });
      }
      const quarantined = Option.getOrThrow(yield* store.getIntent("run-goal-retry-page-b-old"));
      yield* store.quarantineIntent({
        previousRunId: quarantined.previousRunId,
        expectedRevision: quarantined.revision,
        outcomeCode: "legacy_capability_ids_missing",
        quarantinedAtUnixMs: 400,
      });
      const settled = yield* store.markSettled({
        previousRunId: "run-goal-retry-page-d-old",
        expectedRevision: 1,
        updatedAtUnixMs: 410,
      });
      yield* store.markDispatched({
        previousRunId: settled.previousRunId,
        expectedRevision: settled.revision,
        updatedAtUnixMs: 420,
      });

      const first = yield* store.listRecoverableIntents({ limit: 2 });
      const second = yield* store.listRecoverableIntents({
        limit: 2,
        after: {
          updatedAtUnixMs: first[1]!.updatedAtUnixMs,
          previousRunId: first[1]!.previousRunId,
        },
      });

      assert.deepEqual(
        [...first, ...second]
          .map((intent) => intent.previousRunId)
          .filter((previousRunId) => previousRunId.startsWith("run-goal-retry-page-")),
        ["run-goal-retry-page-a-old", "run-goal-retry-page-c-old", "run-goal-retry-page-e-old"],
      );
    }),
  );

  it.effect("quarantine 只保存稳定诊断码，并拒绝同一 intent 的诊断漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      const prepared = yield* store.prepareIntent({
        taskId: "task-goal-retry-quarantine",
        previousRunId: "run-goal-retry-quarantine-old",
        newRunId: "run-goal-retry-quarantine-new",
        createdAtUnixMs: 500,
      });
      const quarantined = yield* store.quarantineIntent({
        previousRunId: prepared.previousRunId,
        expectedRevision: prepared.revision,
        outcomeCode: "run_start_indeterminate",
        quarantinedAtUnixMs: 510,
      });
      const replayed = yield* store.quarantineIntent({
        previousRunId: prepared.previousRunId,
        expectedRevision: prepared.revision,
        outcomeCode: "run_start_indeterminate",
        quarantinedAtUnixMs: 510,
      });
      const drift = yield* store
        .quarantineIntent({
          previousRunId: prepared.previousRunId,
          expectedRevision: prepared.revision,
          outcomeCode: "driver_replay_unsupported",
          quarantinedAtUnixMs: 511,
        })
        .pipe(Effect.flip);
      const invalid = yield* store
        .quarantineIntent({
          previousRunId: prepared.previousRunId,
          expectedRevision: prepared.revision,
          outcomeCode: "原始 prompt: sk-secret-value",
          quarantinedAtUnixMs: 510,
        })
        .pipe(Effect.flip);

      assert.equal(quarantined.quarantineCode, "run_start_indeterminate");
      assert.equal(quarantined.quarantinedAtUnixMs, 510);
      assert.deepEqual(replayed, quarantined);
      assert.equal(errorCode(drift), "goal_loop_retry_quarantine_conflict");
      assert.equal(errorCode(invalid), "goal_loop_retry_input_invalid");
      assert.isFalse(
        (yield* store.listRecoverableIntents({ limit: 20 })).some(
          (intent) => intent.previousRunId === prepared.previousRunId,
        ),
      );
    }),
  );

  it.effect("恢复查询命中 partial index 且不创建临时排序表", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT previous_run_id
        FROM composition_goal_loop_retry_intents
        WHERE phase IN ('prepared', 'settled')
          AND (updated_at_unix_ms, previous_run_id) > (100, '')
        ORDER BY updated_at_unix_ms ASC, previous_run_id ASC
        LIMIT 50
      `;
      const details = plan.map((row) => row.detail).join("\n");

      assert.include(details, "composition_goal_loop_retry_intents_recoverable_scan");
      assert.notInclude(details, "USE TEMP B-TREE");
    }),
  );
});
