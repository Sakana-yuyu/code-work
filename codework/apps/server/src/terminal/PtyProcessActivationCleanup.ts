import { TerminalProcessTerminationError } from "@codework/contracts";
import * as Effect from "effect/Effect";

import * as PtyProcessActivation from "./PtyProcessActivation.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

export interface PtyProcessActivationCleanupInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly activation: PtyProcessActivation.PendingPtyProcessActivation;
  readonly platform: NodeJS.Platform;
  readonly gracefulTimeoutMs: number;
  readonly forceExitTimeoutMs: number;
  readonly publishRetained: Effect.Effect<boolean>;
  readonly quarantine: (
    observerFailure?: TerminalProcessTerminationError,
  ) => Effect.Effect<void, TerminalProcessTerminationError>;
  readonly mapTerminationError: (
    error: PtyProcessTermination.PtyProcessTerminationError,
  ) => TerminalProcessTerminationError;
}

const retain = Effect.fn("PtyProcessActivationCleanup.retain")(function* (
  input: PtyProcessActivationCleanupInput,
) {
  const retained = yield* input.publishRetained;
  if (!retained) return false;

  input.activation.retained = true;
  input.activation.unsubscribeData = null;
  input.activation.unsubscribeExit = null;
  PtyProcessActivation.activate(input.activation);
  return true;
});

/** 未提交 handle 必须终止成功，或连同观察器一起转交给 Manager 继续监督。 */
export const cleanup = Effect.fn("PtyProcessActivationCleanup.cleanup")(function* (
  input: PtyProcessActivationCleanupInput,
) {
  const activation = input.activation;
  yield* PtyProcessActivation.disposeListener(activation, "data");
  let observerFailure: TerminalProcessTerminationError | null = null;

  if (!activation.unsubscribeExit) {
    const exitRegistration = yield* PtyProcessActivation.registerExitListener(activation).pipe(
      Effect.result,
    );
    if (exitRegistration._tag === "Success") {
      activation.unsubscribeExit = exitRegistration.success;
    } else {
      observerFailure = new TerminalProcessTerminationError({
        threadId: input.threadId,
        terminalId: input.terminalId,
        terminalPid: activation.process.pid,
        reason: "exit-observer-failed",
        signal: null,
        cause: exitRegistration.failure,
      });
      if (activation.process.exitObservation.status !== "gap") {
        const retained = yield* retain(input);
        yield* Effect.logError("failed to observe uncommitted terminal process exit", {
          threadId: input.threadId,
          terminalId: input.terminalId,
          terminalPid: activation.process.pid,
          retained,
          cause: observerFailure,
        });
        return;
      }
    }
  }

  if (activation.process.exitObservation.status === "gap") {
    const retained = yield* retain(input);
    const quarantineResult = retained
      ? yield* input.quarantine(observerFailure ?? undefined).pipe(Effect.result)
      : null;
    yield* Effect.logError("failed to activate quarantined terminal process", {
      threadId: input.threadId,
      terminalId: input.terminalId,
      terminalPid: activation.process.pid,
      retained,
      ...(quarantineResult?._tag === "Failure" ? { cause: quarantineResult.failure } : {}),
    });
    return;
  }

  const termination = yield* PtyProcessTermination.terminate({
    process: activation.process,
    platform: input.platform,
    gracefulTimeoutMs: input.gracefulTimeoutMs,
    forceExitTimeoutMs: input.forceExitTimeoutMs,
    exitState: activation.processExit,
    isCurrent: Effect.succeed(true),
  }).pipe(Effect.result);
  if (termination._tag === "Success") {
    yield* PtyProcessActivation.disposeListener(activation, "exit");
    yield* PtyProcessActivation.disposeListener(activation, "data");
    PtyProcessTermination.completeProcessExitHandling(activation.processExit);
    return;
  }

  const cleanupError = input.mapTerminationError(termination.failure);
  const retained = yield* retain(input);
  yield* Effect.logError("failed to terminate uncommitted terminal process", {
    threadId: input.threadId,
    terminalId: input.terminalId,
    terminalPid: activation.process.pid,
    retained,
    cause: cleanupError,
  });
});
