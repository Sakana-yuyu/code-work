import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";
import type { TerminalSessionOwner } from "./TerminalSessionOwnership.ts";

export interface PtyProcessTerminationRecord {
  readonly processGeneration: number;
  readonly owner: TerminalSessionOwner | null;
  readonly result: Deferred.Deferred<
    PtyProcessTermination.PtyProcessTerminationOutcome,
    PtyProcessTermination.PtyProcessTerminationError
  >;
}

export type PtyProcessTerminationSelection =
  | { readonly type: "created"; readonly record: PtyProcessTerminationRecord }
  | { readonly type: "existing"; readonly record: PtyProcessTerminationRecord }
  | { readonly type: "identity-changed" };

export interface PtyProcessTerminationCoordinatorInput {
  readonly process: PtyAdapter.PtyProcess;
  readonly processGeneration: number;
  readonly processExit: PtyProcessTermination.PtyProcessExitState;
  readonly owner: TerminalSessionOwner | null;
  readonly platform: NodeJS.Platform;
  readonly gracefulTimeoutMs: number;
  readonly forceExitTimeoutMs: number;
  readonly terminationScope: Scope.Scope;
  readonly select: (
    candidate: PtyProcessTerminationRecord,
  ) => Effect.Effect<PtyProcessTerminationSelection>;
  readonly remove: (record: PtyProcessTerminationRecord) => Effect.Effect<void>;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly afterRecordPublished: Effect.Effect<void>;
  readonly onWorkerDrained: () => void;
}

/** 发布单飞记录与启动 worker 必须属于同一不可中断临界区。 */
export const terminate = Effect.fn("PtyProcessTerminationCoordinator.terminate")(function* (
  input: PtyProcessTerminationCoordinatorInput,
): Effect.fn.Return<
  PtyProcessTermination.PtyProcessTerminationOutcome,
  PtyProcessTermination.PtyProcessTerminationError
> {
  const candidate: PtyProcessTerminationRecord = {
    processGeneration: input.processGeneration,
    owner: input.owner,
    result: yield* Deferred.make<
      PtyProcessTermination.PtyProcessTerminationOutcome,
      PtyProcessTermination.PtyProcessTerminationError
    >(),
  };
  const selection = yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const selected = yield* input.select(candidate);
      if (selected.type === "created") {
        yield* input.afterRecordPublished;
        const worker = Effect.uninterruptibleMask((restoreWorker) =>
          Effect.gen(function* () {
            const terminationExit = yield* restoreWorker(
              PtyProcessTermination.terminate({
                process: input.process,
                platform: input.platform,
                gracefulTimeoutMs: input.gracefulTimeoutMs,
                forceExitTimeoutMs: input.forceExitTimeoutMs,
                exitState: input.processExit,
                isCurrent: input.isCurrent,
              }).pipe(
                Effect.tap(() => PtyProcessTermination.awaitProcessExitHandling(input.processExit)),
              ),
            ).pipe(Effect.exit);
            yield* input.remove(selected.record);
            if (Exit.isSuccess(terminationExit)) {
              yield* Deferred.succeed(selected.record.result, terminationExit.value);
            } else {
              yield* Deferred.failCause(selected.record.result, terminationExit.cause);
            }
            input.onWorkerDrained();
          }),
        );
        yield* restore(worker).pipe(Effect.forkIn(input.terminationScope));
      }
      return selected;
    }),
  );

  if (selection.type === "identity-changed") {
    return yield* new PtyProcessTermination.PtyProcessIdentityChangedError({
      phase: "initial",
      terminalPid: input.process.pid,
    });
  }
  return yield* Deferred.await(selection.record.result);
});
