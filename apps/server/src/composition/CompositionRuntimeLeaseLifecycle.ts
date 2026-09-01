import type {
  CompositionRuntimeLease,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

export const COMPOSITION_RUNTIME_LEASE_DURATION_MS = 60_000;

export const compositionRuntimeLeaseIdForRun = (runId: string): string =>
  `composition-runtime-lease:${runId}`;

const compositionRuntimeRecoveryLeaseId = (runId: string, nowUnixMs: number): string =>
  `${compositionRuntimeLeaseIdForRun(runId)}:recovery:${nowUnixMs}`;

class CompositionRunStartLeaseConflict extends Data.TaggedError(
  "CompositionRunStartLeaseConflict",
) {}

const rollbackLeaseConflict = <A, E, R>(
  effect: Effect.Effect<A, E | CompositionRunStartLeaseConflict, R>,
) =>
  effect.pipe(
    Effect.catchTag("CompositionRunStartLeaseConflict", () =>
      Effect.succeed(Option.none<CompositionTaskRun>()),
    ),
  );

const isRunStartSnapshot = (run: CompositionTaskRun): boolean =>
  run.status === "queued" &&
  run.runtimeTaskId === undefined &&
  run.capabilityHandshakeId === undefined &&
  run.cancelRequestedAtUnixMs === undefined &&
  run.finishedAtUnixMs === undefined &&
  run.failureCode === undefined;

export const claimCompositionRuntimeLease = Effect.fn("claimCompositionRuntimeLease")(function* (
  store: CompositionTaskStoreShape,
  input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly workspaceRootDigest: string;
    readonly nowUnixMs: number;
  },
) {
  return yield* rollbackLeaseConflict(
    store.withTransaction(
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
            const current = yield* store.compareAndSetRunStartResources({
              task: input.task,
              run: input.run,
              nextLeaseId: input.run.leaseId,
              nextCapabilityGrantIds: input.run.capabilityGrantIds ?? [],
            });
            if (Option.isNone(current)) return yield* new CompositionRunStartLeaseConflict();
            return current;
          }
          return yield* new CompositionRunStartLeaseConflict();
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
        if (Option.isNone(claimed)) return yield* new CompositionRunStartLeaseConflict();

        const leasedRun = yield* store.compareAndSetRunStartResources({
          task: input.task,
          run: input.run,
          nextLeaseId: leaseId,
          nextCapabilityGrantIds: input.run.capabilityGrantIds ?? [],
        });
        if (Option.isNone(leasedRun)) return yield* new CompositionRunStartLeaseConflict();
        return leasedRun;
      }),
    ),
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

export const recoverCompositionRuntimeLease = Effect.fn("recoverCompositionRuntimeLease")(
  function* (
    store: CompositionTaskStoreShape,
    input: {
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
      readonly nowUnixMs: number;
    },
  ) {
    const leaseId = input.run.leaseId;
    if (leaseId === undefined) return Option.some(input.run);

    return yield* rollbackLeaseConflict(
      store.withTransaction(
        Effect.gen(function* () {
          const currentLease = yield* store.getLease(leaseId);
          if (
            Option.isNone(currentLease) ||
            currentLease.value.runtimeId !== input.run.runtimeId ||
            currentLease.value.taskId !== input.task.taskId
          ) {
            return yield* new CompositionRunStartLeaseConflict();
          }

          if (
            currentLease.value.state === "active" &&
            currentLease.value.expiresAtUnixMs > input.nowUnixMs
          ) {
            const renewed = yield* store.renewLease({
              leaseId: currentLease.value.leaseId,
              runtimeId: input.run.runtimeId,
              heartbeatAtUnixMs: input.nowUnixMs,
              expiresAtUnixMs: input.nowUnixMs + COMPOSITION_RUNTIME_LEASE_DURATION_MS,
              nowUnixMs: input.nowUnixMs,
            });
            if (Option.isNone(renewed)) return yield* new CompositionRunStartLeaseConflict();
            const current = isRunStartSnapshot(input.run)
              ? yield* store.compareAndSetRunStartResources({
                  task: input.task,
                  run: input.run,
                  nextLeaseId: leaseId,
                  nextCapabilityGrantIds: input.run.capabilityGrantIds ?? [],
                })
              : yield* store.compareAndSetRunLease({
                  run: input.run,
                  nextLeaseId: leaseId,
                });
            if (Option.isNone(current)) return yield* new CompositionRunStartLeaseConflict();
            return current;
          }

          yield* store.reclaimExpiredLeases({ nowUnixMs: input.nowUnixMs });
          const replacementLeaseId = compositionRuntimeRecoveryLeaseId(
            input.run.runId,
            input.nowUnixMs,
          );
          const replacement: CompositionRuntimeLease = {
            leaseId: replacementLeaseId,
            runtimeId: input.run.runtimeId,
            taskId: input.task.taskId,
            workspaceRootDigest: currentLease.value.workspaceRootDigest,
            heartbeatAtUnixMs: input.nowUnixMs,
            expiresAtUnixMs: input.nowUnixMs + COMPOSITION_RUNTIME_LEASE_DURATION_MS,
            state: "active",
          };
          const claimed = yield* store.claimLease({
            lease: replacement,
            nowUnixMs: input.nowUnixMs,
          });
          if (Option.isNone(claimed)) return yield* new CompositionRunStartLeaseConflict();

          const recoveredRun = isRunStartSnapshot(input.run)
            ? yield* store.compareAndSetRunStartResources({
                task: input.task,
                run: input.run,
                nextLeaseId: replacementLeaseId,
                nextCapabilityGrantIds: input.run.capabilityGrantIds ?? [],
              })
            : yield* store.compareAndSetRunLease({
                run: input.run,
                nextLeaseId: replacementLeaseId,
              });
          if (Option.isNone(recoveredRun)) return yield* new CompositionRunStartLeaseConflict();
          return recoveredRun;
        }),
      ),
    );
  },
);

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
