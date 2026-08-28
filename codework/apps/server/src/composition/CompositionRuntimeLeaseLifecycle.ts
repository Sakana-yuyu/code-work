import type {
  CompositionRuntimeLease,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

export const COMPOSITION_RUNTIME_LEASE_DURATION_MS = 60_000;

export const compositionRuntimeLeaseIdForRun = (runId: string): string =>
  `composition-runtime-lease:${runId}`;

export const claimCompositionRuntimeLease = Effect.fn("claimCompositionRuntimeLease")(function* (
  store: CompositionTaskStoreShape,
  input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly workspaceRootDigest: string;
    readonly nowUnixMs: number;
  },
) {
  return yield* store.withTransaction(
    Effect.gen(function* () {
      if (input.run.leaseId !== undefined) {
        const existing = yield* store.getLease(input.run.leaseId);
        if (
          Option.isSome(existing) &&
          existing.value.runtimeId === input.run.runtimeId &&
          existing.value.taskId === input.task.taskId &&
          existing.value.workspaceRootDigest === input.workspaceRootDigest &&
          existing.value.state === "active" &&
          existing.value.expiresAtUnixMs > input.nowUnixMs
        ) {
          return Option.some(input.run);
        }
        return Option.none<CompositionTaskRun>();
      }

      const leaseId = compositionRuntimeLeaseIdForRun(input.run.runId);
      const lease: CompositionRuntimeLease = {
        leaseId,
        runtimeId: input.run.runtimeId,
        taskId: input.task.taskId,
        workspaceRootDigest: input.workspaceRootDigest,
        heartbeatAtUnixMs: input.nowUnixMs,
        expiresAtUnixMs: input.nowUnixMs + COMPOSITION_RUNTIME_LEASE_DURATION_MS,
        state: "active",
      };
      const claimed = yield* store.claimLease({ lease, nowUnixMs: input.nowUnixMs });
      if (Option.isNone(claimed)) return Option.none<CompositionTaskRun>();

      const leasedRun: CompositionTaskRun = { ...input.run, leaseId };
      yield* store.upsertRun(leasedRun);
      return Option.some(leasedRun);
    }),
  );
});

export const renewCompositionRuntimeLease = Effect.fn("renewCompositionRuntimeLease")(function* (
  store: CompositionTaskStoreShape,
  run: CompositionTaskRun,
  nowUnixMs: number,
) {
  if (run.leaseId === undefined) return Option.none<CompositionRuntimeLease>();
  return yield* store.renewLease({
    leaseId: run.leaseId,
    runtimeId: run.runtimeId,
    heartbeatAtUnixMs: nowUnixMs,
    expiresAtUnixMs: nowUnixMs + COMPOSITION_RUNTIME_LEASE_DURATION_MS,
    nowUnixMs,
  });
});

export const releaseCompositionRuntimeLease = Effect.fn("releaseCompositionRuntimeLease")(
  function* (store: CompositionTaskStoreShape, run: CompositionTaskRun, releasedAtUnixMs: number) {
    if (run.leaseId === undefined) return Option.none<CompositionRuntimeLease>();
    return yield* store.releaseLease({
      leaseId: run.leaseId,
      runtimeId: run.runtimeId,
      releasedAtUnixMs,
    });
  },
);
