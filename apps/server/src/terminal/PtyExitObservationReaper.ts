import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as PtyProcessTermination from "./PtyProcessTermination.ts";

export class PtyExitObservationOperationError extends Schema.TaggedErrorClass<PtyExitObservationOperationError>()(
  "PtyExitObservationOperationError",
  {
    adapter: Schema.String,
    cause: Schema.Defect(),
    operation: Schema.Literals(["register", "release", "terminate"]),
    processPid: Schema.Number,
  },
) {}

export class PtyExitObservationRetainedError extends Schema.TaggedErrorClass<PtyExitObservationRetainedError>()(
  "PtyExitObservationRetainedError",
  {
    adapter: Schema.String,
    cause: Schema.Defect(),
    cleanupCause: Schema.optional(Schema.Defect()),
    processPid: Schema.Number,
    reaperId: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to observe ${this.adapter} process ${this.processPid} exit; retained by reaper ${this.reaperId}.`;
  }
}

export const operationError = (input: {
  readonly adapter: string;
  readonly cause: unknown;
  readonly operation: "register" | "release" | "terminate";
  readonly processPid: number;
}) => new PtyExitObservationOperationError(input);

const exitObserverRetryDelayMs = (attempt: number): number =>
  Math.min(100 * 2 ** Math.min(attempt, 8), 30_000);

export const make = Effect.fn("PtyExitObservationReaper.make")(function* () {
  const workerScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
    Scope.close(scope, Exit.void),
  );
  let nextReaperId = 1;

  const retain = Effect.fn("PtyExitObservationReaper.retain")(function* (input: {
    readonly adapter: string;
    readonly processPid: number;
    readonly processExit: PtyProcessTermination.PtyProcessExitState;
    readonly initialCause: PtyExitObservationOperationError;
    readonly register: Effect.Effect<() => void, PtyExitObservationOperationError>;
  }) {
    const reaperId = nextReaperId++;
    yield* Effect.gen(function* () {
      let attempt = 0;
      while (true) {
        yield* Effect.sleep(exitObserverRetryDelayMs(attempt));
        attempt += 1;
        const registration = yield* input.register.pipe(Effect.result);
        if (registration._tag === "Failure") {
          yield* Effect.logWarning("PTY exit reaper could not restore observation", {
            adapter: input.adapter,
            attempt,
            cause: registration.failure,
            processPid: input.processPid,
            reaperId,
          });
          continue;
        }

        yield* Effect.logWarning("PTY exit reaper restored observation", {
          adapter: input.adapter,
          attempt,
          processPid: input.processPid,
          reaperId,
        });
        yield* PtyProcessTermination.awaitProcessExit(input.processExit).pipe(
          Effect.ensuring(
            Effect.try({
              try: registration.success,
              catch: (cause) =>
                operationError({
                  adapter: input.adapter,
                  cause,
                  operation: "release",
                  processPid: input.processPid,
                }),
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("PTY exit reaper failed to release observation", {
                  adapter: input.adapter,
                  cause,
                  processPid: input.processPid,
                  reaperId,
                }),
              ),
            ),
          ),
        );
        yield* Effect.logWarning("PTY exit reaper observed process exit", {
          adapter: input.adapter,
          processPid: input.processPid,
          reaperId,
        });
        return;
      }
    }).pipe(Effect.forkIn(workerScope), Effect.asVoid);
    yield* Effect.logError("PTY exit observation failed; handle retained by reaper", {
      adapter: input.adapter,
      cause: input.initialCause,
      processPid: input.processPid,
      reaperId,
    });
    return reaperId;
  });

  return { retain } as const;
});
