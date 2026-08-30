import { TerminalProcessTerminationError } from "@codework/contracts";
import * as Effect from "effect/Effect";

import type * as PtyAdapter from "./PtyAdapter.ts";

export type PtyExitObservationGapSignal = "platform-default" | null;

export interface PtyExitObservationGapClaim {
  readonly observationCause: unknown;
  readonly shouldSignal: boolean;
  readonly signal: PtyExitObservationGapSignal;
}

export interface PtyExitObservationGapSignalResult {
  readonly signalAttempted: boolean;
  readonly signalFailure: unknown | undefined;
}

export interface PtyExitObservationGapInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly process: PtyAdapter.PtyProcess;
  readonly processGeneration: number;
  readonly observerFailure?: unknown;
  readonly claim: Effect.Effect<PtyExitObservationGapClaim | null>;
  readonly afterClaimed: Effect.Effect<void>;
  readonly signalIfCurrent: (
    signal: Exclude<PtyExitObservationGapSignal, null>,
  ) => Effect.Effect<PtyExitObservationGapSignalResult>;
}

/** 隔离领取与同一 handle 的同步 signal 之间不允许取消。 */
export const failIfPresent = Effect.fn("PtyExitObservationGap.failIfPresent")(function* (
  input: PtyExitObservationGapInput,
): Effect.fn.Return<void, TerminalProcessTerminationError> {
  const resolution = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const action = yield* input.claim;
      if (!action) return null;
      if (!action.shouldSignal || action.signal === null) {
        return { action, signalAttempted: false as const, signalFailure: undefined };
      }
      yield* input.afterClaimed;
      const signalResult = yield* input.signalIfCurrent(action.signal);
      return { action, ...signalResult };
    }),
  );
  if (!resolution) return;

  if (resolution.signalAttempted) {
    yield* Effect.logError("terminal process quarantined after exit observation gap", {
      threadId: input.threadId,
      terminalId: input.terminalId,
      terminalPid: input.process.pid,
      processGeneration: input.processGeneration,
      signal: resolution.action.signal,
      ...(resolution.signalFailure === undefined
        ? {}
        : { signalFailure: resolution.signalFailure }),
    });
  }

  return yield* new TerminalProcessTerminationError({
    threadId: input.threadId,
    terminalId: input.terminalId,
    terminalPid: input.process.pid,
    reason: "exit-observation-gap",
    signal: resolution.action.signal,
    cause: resolution.signalFailure ?? input.observerFailure ?? resolution.action.observationCause,
  });
});
