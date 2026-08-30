import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as PtyAdapter from "./PtyAdapter.ts";

export type PtyProcessTerminationSignal = "platform-default" | "SIGTERM" | "SIGKILL";

/** raw exit 取消信号升级；handled 保证 Manager 状态与事件流水线已收口。 */
export interface PtyProcessExitState {
  readonly exit: Deferred.Deferred<PtyAdapter.PtyExitEvent>;
  readonly handled: Deferred.Deferred<void>;
}

export const makeProcessExitState = () =>
  Effect.gen(function* () {
    return {
      exit: yield* Deferred.make<PtyAdapter.PtyExitEvent>(),
      handled: yield* Deferred.make<void>(),
    } satisfies PtyProcessExitState;
  });

export const signalProcessExit = (
  state: PtyProcessExitState,
  event: PtyAdapter.PtyExitEvent,
): void => {
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
  readonly mode: "platform-default" | "graceful" | "forced";
  readonly escalated: boolean;
  readonly exitEvent: PtyAdapter.PtyExitEvent;
}

export interface PtyProcessTerminationInput {
  readonly process: PtyAdapter.PtyProcess;
  readonly platform: NodeJS.Platform;
  readonly gracefulTimeoutMs: number;
  readonly forceExitTimeoutMs: number;
  readonly awaitExit: Effect.Effect<PtyAdapter.PtyExitEvent>;
  readonly isCurrent: Effect.Effect<boolean>;
}

const assertCurrent = (
  input: PtyProcessTerminationInput,
  phase: "initial" | "force",
): Effect.Effect<void, PtyProcessIdentityChangedError> =>
  input.isCurrent.pipe(
    Effect.filterOrFail(
      (current) => current,
      () =>
        new PtyProcessIdentityChangedError({
          phase,
          terminalPid: input.process.pid,
        }),
    ),
    Effect.asVoid,
  );

const sendSignal = (
  process: PtyAdapter.PtyProcess,
  signal: PtyProcessTerminationSignal,
): Effect.Effect<void, PtyProcessSignalError> =>
  Effect.try({
    try: () => {
      if (signal === "platform-default") {
        process.kill();
        return;
      }
      process.kill(signal);
    },
    catch: (cause) =>
      new PtyProcessSignalError({
        cause,
        signal,
        terminalPid: process.pid,
      }),
  });

const awaitExitWithin = (
  input: PtyProcessTerminationInput,
  phase: "platform-default" | "forced",
  timeoutMs: number,
): Effect.Effect<PtyAdapter.PtyExitEvent, PtyProcessExitTimeoutError> =>
  input.awaitExit.pipe(
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
  yield* assertCurrent(input, "initial");

  if (input.platform === "win32") {
    yield* sendSignal(input.process, "platform-default");
    const exitEvent = yield* awaitExitWithin(input, "platform-default", input.forceExitTimeoutMs);
    return { mode: "platform-default", escalated: false, exitEvent };
  }

  yield* sendSignal(input.process, "SIGTERM");
  const gracefulExit = yield* input.awaitExit.pipe(Effect.timeoutOption(input.gracefulTimeoutMs));
  if (Option.isSome(gracefulExit)) {
    return { mode: "graceful", escalated: false, exitEvent: gracefulExit.value };
  }

  yield* assertCurrent(input, "force");
  yield* sendSignal(input.process, "SIGKILL");
  const exitEvent = yield* awaitExitWithin(input, "forced", input.forceExitTimeoutMs);
  return { mode: "forced", escalated: true, exitEvent };
});
