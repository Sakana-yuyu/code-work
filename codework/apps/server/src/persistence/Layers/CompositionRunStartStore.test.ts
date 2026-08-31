import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionRunStartStoreLive } from "./CompositionRunStartStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  CompositionRunStartStore,
  CompositionRunStartStoreDomainError,
} from "../Services/CompositionRunStartStore.ts";

const layer = it.layer(
  CompositionRunStartStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const prepare = (runId: string, replayPolicy: "idempotent" | "fail_closed") => ({
  runId,
  taskId: `task:${runId}`,
  agentId: `agent:${runId}`,
  runtimeId: `runtime:${runId}`,
  attempt: 2,
  replayPolicy,
  createdAtUnixMs: 100,
});

layer("CompositionRunStartStore", (it) => {
  it.effect("同一 Run 的 start claim 只有一个赢家，并持久化 accepted receipt", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const runId = "run-start-claim";
      yield* store.prepareStart(prepare(runId, "fail_closed"));

      const claimed = yield* store.claimStart({
        runId,
        claimId: "claim-owner",
        claimedAtUnixMs: 110,
      });
      assert.equal(claimed.state, "dispatching");

      const conflict = yield* store
        .claimStart({ runId, claimId: "claim-other", claimedAtUnixMs: 120 })
        .pipe(Effect.flip);
      assert.instanceOf(conflict, CompositionRunStartStoreDomainError);
      assert.equal(conflict.code, "run_start_in_progress");

      const accepted = yield* store.markAccepted({
        runId,
        claimId: "claim-owner",
        runtimeTaskId: "runtime-task-start-claim",
        capabilityHandshakeId: "handshake-start-claim",
        acceptedAtUnixMs: 130,
      });
      assert.equal(accepted.state, "accepted");
      assert.equal(accepted.runtimeTaskId, "runtime-task-start-claim");
      assert.equal(accepted.capabilityHandshakeId, "handshake-start-claim");
      assert.deepEqual(Option.getOrThrow(yield* store.getStart(runId)), accepted);
    }),
  );

  it.effect("启动恢复仅重置明确幂等的 dispatching，非幂等转为 indeterminate", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const safeRunId = "run-start-recover-safe";
      const unsafeRunId = "run-start-recover-unsafe";
      const acceptedRunId = "run-start-recover-accepted";
      yield* store.prepareStart(prepare(safeRunId, "idempotent"));
      yield* store.prepareStart(prepare(unsafeRunId, "fail_closed"));
      yield* store.prepareStart(prepare(acceptedRunId, "fail_closed"));
      yield* store.claimStart({
        runId: safeRunId,
        claimId: "claim-safe",
        claimedAtUnixMs: 110,
      });
      yield* store.claimStart({
        runId: unsafeRunId,
        claimId: "claim-unsafe",
        claimedAtUnixMs: 110,
      });
      yield* store.claimStart({
        runId: acceptedRunId,
        claimId: "claim-accepted",
        claimedAtUnixMs: 110,
      });
      yield* store.markAccepted({
        runId: acceptedRunId,
        claimId: "claim-accepted",
        runtimeTaskId: "runtime-task-accepted",
        acceptedAtUnixMs: 120,
      });

      const receipt = yield* store.recoverInterruptedStarts({ recoveredAtUnixMs: 200 });

      assert.deepEqual(receipt.recoveredRunIds, [safeRunId, unsafeRunId]);
      assert.equal(Option.getOrThrow(yield* store.getStart(safeRunId)).state, "prepared");
      assert.equal(
        Option.getOrThrow(yield* store.getStart(unsafeRunId)).state,
        "indeterminate",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getStart(acceptedRunId)).state,
        "accepted",
      );
    }),
  );

  it.effect("accepted receipt 完成后保持可重放，且 release 不能清除其他 owner", () =>
    Effect.gen(function* () {
      const store = yield* CompositionRunStartStore;
      const runId = "run-start-complete";
      yield* store.prepareStart(prepare(runId, "idempotent"));
      yield* store.claimStart({ runId, claimId: "claim-owner", claimedAtUnixMs: 110 });

      const releaseConflict = yield* store
        .releaseStart({ runId, claimId: "claim-other" })
        .pipe(Effect.flip);
      assert.instanceOf(releaseConflict, CompositionRunStartStoreDomainError);
      assert.equal(releaseConflict.code, "run_start_in_progress");

      yield* store.markAccepted({
        runId,
        claimId: "claim-owner",
        runtimeTaskId: "runtime-task-complete",
        acceptedAtUnixMs: 120,
      });
      const completed = yield* store.markCompleted({ runId, completedAtUnixMs: 130 });
      assert.equal(completed.state, "completed");
      assert.equal(completed.runtimeTaskId, "runtime-task-complete");
    }),
  );
});
