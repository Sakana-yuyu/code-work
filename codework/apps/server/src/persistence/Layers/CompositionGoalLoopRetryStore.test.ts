import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionGoalLoopRetryStoreLive } from "./CompositionGoalLoopRetryStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  CompositionGoalLoopRetryStore,
  CompositionGoalLoopRetryStoreDomainError,
} from "../Services/CompositionGoalLoopRetryStore.ts";

const layer = it.layer(
  CompositionGoalLoopRetryStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("CompositionGoalLoopRetryStore", (it) => {
  it.effect("首次请求持久化稳定 newRunId，后续不同候选值仍复用原意图", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      const prepared = yield* store.prepareIntent({
        taskId: "task-retry-stable",
        previousRunId: "run-retry-stable-old",
        newRunId: "run-retry-stable-new",
        createdAtUnixMs: 100,
      });
      const recovered = yield* store.prepareIntent({
        taskId: "task-retry-stable",
        previousRunId: "run-retry-stable-old",
        newRunId: "run-retry-stable-other-candidate",
        createdAtUnixMs: 200,
      });

      assert.deepEqual(recovered, prepared);
      assert.deepEqual(prepared, {
        taskId: "task-retry-stable",
        previousRunId: "run-retry-stable-old",
        newRunId: "run-retry-stable-new",
        phase: "prepared",
        revision: 1,
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
      });
      assert.deepEqual(Option.getOrThrow(yield* store.getIntent("run-retry-stable-old")), prepared);
    }),
  );

  it.effect("阶段只能 prepared 到 settled 再到 dispatched，重复推进保持同一快照", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      yield* store.prepareIntent({
        taskId: "task-retry-phase",
        previousRunId: "run-retry-phase-old",
        newRunId: "run-retry-phase-new",
        createdAtUnixMs: 100,
      });

      const settled = yield* store.markSettled({
        previousRunId: "run-retry-phase-old",
        updatedAtUnixMs: 110,
      });
      assert.equal(settled.phase, "settled");
      assert.equal(settled.revision, 2);
      assert.deepEqual(
        yield* store.markSettled({
          previousRunId: "run-retry-phase-old",
          updatedAtUnixMs: 120,
        }),
        settled,
      );

      yield* store.claimDispatch({
        previousRunId: "run-retry-phase-old",
        claimId: "claim-retry-phase",
        claimedAtUnixMs: 130,
      });
      const dispatched = yield* store.markDispatched({
        previousRunId: "run-retry-phase-old",
        claimId: "claim-retry-phase",
        updatedAtUnixMs: 140,
      });
      assert.equal(dispatched.phase, "dispatched");
      assert.equal(dispatched.revision, 3);
      assert.deepEqual(
        yield* store.markSettled({
          previousRunId: "run-retry-phase-old",
          updatedAtUnixMs: 140,
        }),
        dispatched,
      );
      assert.deepEqual(
        yield* store.markDispatched({
          previousRunId: "run-retry-phase-old",
          claimId: "claim-retry-phase-replay",
          updatedAtUnixMs: 160,
        }),
        dispatched,
      );
    }),
  );

  it.effect("禁止跳过 settled，并禁止不同旧 Run 复用同一 newRunId", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      yield* store.prepareIntent({
        taskId: "task-retry-conflict",
        previousRunId: "run-retry-conflict-old",
        newRunId: "run-retry-conflict-new",
        createdAtUnixMs: 100,
      });

      const phaseFailure = yield* store
        .markDispatched({
          previousRunId: "run-retry-conflict-old",
          claimId: "claim-retry-conflict",
          updatedAtUnixMs: 110,
        })
        .pipe(Effect.flip);
      assert.instanceOf(phaseFailure, CompositionGoalLoopRetryStoreDomainError);
      assert.equal(phaseFailure.code, "goal_loop_retry_phase_conflict");

      const identityFailure = yield* store
        .prepareIntent({
          taskId: "task-retry-conflict-other",
          previousRunId: "run-retry-conflict-other-old",
          newRunId: "run-retry-conflict-new",
          createdAtUnixMs: 120,
        })
        .pipe(Effect.flip);
      assert.instanceOf(identityFailure, CompositionGoalLoopRetryStoreDomainError);
      assert.equal(identityFailure.code, "goal_loop_retry_identity_conflict");
    }),
  );

  it.effect("settled intent 的 dispatch claim 只有一个赢家，owner 可释放并由下一调用接管", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      yield* store.prepareIntent({
        taskId: "task-retry-claim",
        previousRunId: "run-retry-claim-old",
        newRunId: "run-retry-claim-new",
        createdAtUnixMs: 100,
      });
      yield* store.markSettled({
        previousRunId: "run-retry-claim-old",
        updatedAtUnixMs: 110,
      });

      const claimed = yield* store.claimDispatch({
        previousRunId: "run-retry-claim-old",
        claimId: "claim-retry-a",
        claimedAtUnixMs: 120,
      });
      const concurrent = yield* store
        .claimDispatch({
          previousRunId: "run-retry-claim-old",
          claimId: "claim-retry-b",
          claimedAtUnixMs: 120,
        })
        .pipe(Effect.flip);

      assert.equal(claimed.phase, "settled");
      assert.instanceOf(concurrent, CompositionGoalLoopRetryStoreDomainError);
      assert.equal(concurrent.code, "goal_loop_retry_dispatch_in_progress");

      yield* store.releaseDispatch({
        previousRunId: "run-retry-claim-old",
        claimId: "claim-retry-a",
      });
      yield* store.claimDispatch({
        previousRunId: "run-retry-claim-old",
        claimId: "claim-retry-b",
        claimedAtUnixMs: 130,
      });
      const dispatched = yield* store.markDispatched({
        previousRunId: "run-retry-claim-old",
        claimId: "claim-retry-b",
        updatedAtUnixMs: 140,
      });
      assert.equal(dispatched.phase, "dispatched");
    }),
  );

  it.effect("启动恢复会释放进程崩溃遗留的 dispatch claim", () =>
    Effect.gen(function* () {
      const store = yield* CompositionGoalLoopRetryStore;
      yield* store.prepareIntent({
        taskId: "task-retry-claim-recovery",
        previousRunId: "run-retry-claim-recovery-old",
        newRunId: "run-retry-claim-recovery-new",
        createdAtUnixMs: 100,
      });
      yield* store.markSettled({
        previousRunId: "run-retry-claim-recovery-old",
        updatedAtUnixMs: 110,
      });
      yield* store.claimDispatch({
        previousRunId: "run-retry-claim-recovery-old",
        claimId: "claim-retry-before-restart",
        claimedAtUnixMs: 120,
      });

      const receipt = yield* store.recoverInterruptedDispatches({ recoveredAtUnixMs: 130 });
      assert.equal(receipt.recoveredCount, 1);
      assert.equal(receipt.recoveredAtUnixMs, 130);

      const recovered = yield* store.claimDispatch({
        previousRunId: "run-retry-claim-recovery-old",
        claimId: "claim-retry-after-restart",
        claimedAtUnixMs: 140,
      });
      assert.equal(recovered.phase, "settled");
    }),
  );
});
