import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as PtyAdapter from "./PtyAdapter.ts";

export type PtyProcessTerminationSignal = "platform-default" | "SIGTERM" | "SIGKILL";

/** raw exit 取消信号升级；handled 等待 Manager 完成状态与事件收口。 */
export interface PtyProcessExitState {
  readonly exit: Deferred.Deferred<PtyAdapter.PtyExitEvent>;
  readonly handled: Deferred.Deferred<void>;
  readonly observedExit: { current: PtyAdapter.PtyExitEvent | null };
}

export const makeProcessExitState = () =>
  Effect.gen(function* () {
    return {
      exit: yield* Deferred.make<PtyAdapter.PtyExitEvent>(),
      handled: yield* Deferred.make<void>(),
      observedExit: { current: null },
    } satisfies PtyProcessExitState;
  });

export const signalProcessExit = (
  state: PtyProcessExitState,
  event: PtyAdapter.PtyExitEvent,
): void => {
  if (state.observedExit.current !== null) {
    return;
  }
  state.observedExit.current = event;
  Deferred.doneUnsafe(state.exit, Effect.succeed(event));
};

export const awaitProcessExit = (state: PtyProcessExitState) => Deferred.await(state.exit);

export const completeProcessExitHandling = (state: PtyProcessExitState): void => {
  Deferred.doneUnsafe(state.handled, Effect.void);
};

export const awaitProcessExitHandling = (state: PtyProcessExitState) =>
  Deferred.await(state.handled);

export class PtyProcessSignalError extends Schema.TaggedErrorClass<PtyProcessSignalError>()(
  "PtyProcessSignalError",
  {
    cause: Schema.Defect(),
    signal: Schema.Literals(["platform-default", "SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

export class PtyProcessExitTimeoutError extends Schema.TaggedErrorClass<PtyProcessExitTimeoutError>()(
  "PtyProcessExitTimeoutError",
  {
    phase: Schema.Literals(["platform-default", "forced"]),
    terminalPid: Schema.Number,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Terminal process ${this.terminalPid} did not exit during ${this.phase} termination within ${this.timeoutMs}ms`;
  }
}

export class PtyProcessIdentityChangedError extends Schema.TaggedErrorClass<PtyProcessIdentityChangedError>()(
  "PtyProcessIdentityChangedError",
  {
    phase: Schema.Literals(["initial", "force"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Terminal process ${this.terminalPid} is no longer the supervised process during ${this.phase} termination`;
  }
}

export type PtyProcessTerminationError =
  | PtyProcessSignalError
  | PtyProcessExitTimeoutError
  | PtyProcessIdentityChangedError;

export interface PtyProcessTerminationOutcome {
  readonly mode: "already-exited" | "platform-default" | "graceful" | "forced";
  readonly escalated: boolean;
  readonly exitEvent: PtyAdapter.PtyExitEvent;
}

export interface PtyProcessTerminationInput {
  readonly process: PtyAdapter.PtyProcess;
  readonly platform: NodeJS.Platform;
  readonly gracefulTimeoutMs: number;
  readonly forceExitTimeoutMs: number;
  readonly exitState: PtyProcessExitState;
  readonly isCurrent: Effect.Effect<boolean>;
}

const observeExitOrAssertCurrent = (
  input: PtyProcessTerminationInput,
  phase: "initial" | "force",
): Effect.Effect<PtyAdapter.PtyExitEvent | null, PtyProcessIdentityChangedError> =>
  Effect.gen(function* () {
    const observedBeforeValidation = input.exitState.observedExit.current;
    if (observedBeforeValidation !== null) {
      return observedBeforeValidation;
    }

    const current = yield* input.isCurrent;
    if (current) {
      return null;
    }

    const observedAfterValidation = input.exitState.observedExit.current;
    if (observedAfterValidation !== null) {
      return observedAfterValidation;
    }

    return yield* new PtyProcessIdentityChangedError({
      phase,
      terminalPid: input.process.pid,
    });
  });

const sendSignalUnlessExited = (
  input: PtyProcessTerminationInput,
  signal: PtyProcessTerminationSignal,
): Effect.Effect<PtyAdapter.PtyExitEvent | null, PtyProcessSignalError> =>
  Effect.try({
    try: () => {
      const observedExit = input.exitState.observedExit.current;
      if (observedExit !== null) {
        return observedExit;
      }
      if (signal === "platform-default") {
        input.process.kill();
        return null;
      }
      input.process.kill(signal);
      return null;
    },
    catch: (cause) =>
      new PtyProcessSignalError({
        cause,
        signal,
        terminalPid: input.process.pid,
      }),
  });

const awaitExitWithin = (
  input: PtyProcessTerminationInput,
  phase: "platform-default" | "forced",
  timeoutMs: number,
): Effect.Effect<PtyAdapter.PtyExitEvent, PtyProcessExitTimeoutError> =>
  awaitProcessExit(input.exitState).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new PtyProcessExitTimeoutError({
              phase,
              terminalPid: input.process.pid,
              timeoutMs,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

export const terminate = Effect.fn("PtyProcessTermination.terminate")(function* (
  input: PtyProcessTerminationInput,
): Effect.fn.Return<PtyProcessTerminationOutcome, PtyProcessTerminationError> {
  const observedBeforeInitialSignal = yield* observeExitOrAssertCurrent(input, "initial");
  if (observedBeforeInitialSignal !== null) {
    return {
      mode: "already-exited",
      escalated: false,
      exitEvent: observedBeforeInitialSignal,
    };
  }

  if (input.platform === "win32") {
    const observedExit = yield* sendSignalUnlessExited(input, "platform-default");
    if (observedExit !== null) {
      return { mode: "already-exited", escalated: false, exitEvent: observedExit };
    }
    const exitEvent = yield* awaitExitWithin(input, "platform-default", input.forceExitTimeoutMs);
    return { mode: "platform-default", escalated: false, exitEvent };
  }

  const observedExit = yield* sendSignalUnlessExited(input, "SIGTERM");
  if (observedExit !== null) {
    return { mode: "already-exited", escalated: false, exitEvent: observedExit };
  }

  const gracefulExit = yield* awaitProcessExit(input.exitState).pipe(
    Effect.timeoutOption(input.gracefulTimeoutMs),
  );
  if (Option.isSome(gracefulExit)) {
    return { mode: "graceful", escalated: false, exitEvent: gracefulExit.value };
  }

  const observedBeforeForce = yield* observeExitOrAssertCurrent(input, "force");
  if (observedBeforeForce !== null) {
    return { mode: "graceful", escalated: false, exitEvent: observedBeforeForce };
  }
  const exitBeforeForce = yield* sendSignalUnlessExited(input, "SIGKILL");
  if (exitBeforeForce !== null) {
    return { mode: "graceful", escalated: false, exitEvent: exitBeforeForce };
  }

  const exitEvent = yield* awaitExitWithin(input, "forced", input.forceExitTimeoutMs);
  return { mode: "forced", escalated: true, exitEvent };
});
