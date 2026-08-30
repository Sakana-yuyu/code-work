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
      assert.deepEqual(
        Option.getOrThrow(yield* store.getIntent("run-retry-stable-old")),
        prepared,
      );
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

      const dispatched = yield* store.markDispatched({
        previousRunId: "run-retry-phase-old",
        updatedAtUnixMs: 130,
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
          updatedAtUnixMs: 150,
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
});
