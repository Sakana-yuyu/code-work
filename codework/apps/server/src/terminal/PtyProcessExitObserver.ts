import { TerminalProcessTerminationError } from "@codework/contracts";
import * as Effect from "effect/Effect";

import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

export interface PtyProcessExitObserverInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly process: PtyAdapter.PtyProcess;
  readonly processGeneration: number;
  readonly publish: (
    processExit: PtyProcessTermination.PtyProcessExitState,
    unsubscribeExit: () => void,
  ) => Effect.Effect<PtyProcessTermination.PtyProcessExitState | null>;
  readonly dispatch: (
    processExit: PtyProcessTermination.PtyProcessExitState,
    event: PtyAdapter.PtyExitEvent,
  ) => void;
  readonly afterPublished: Effect.Effect<void>;
}

/** observer 发布后必须先激活同步事件转发，才能重新允许取消。 */
export const install = Effect.fn("PtyProcessExitObserver.install")(function* (
  input: PtyProcessExitObserverInput,
): Effect.fn.Return<PtyProcessTermination.PtyProcessExitState, TerminalProcessTerminationError> {
  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const processExit = yield* PtyProcessTermination.makeProcessExitState();
      const pendingBeforeInstall: PtyAdapter.PtyExitEvent[] = [];
      let installedProcessExit: PtyProcessTermination.PtyProcessExitState | null = null;
      const dispatchExit = (event: PtyAdapter.PtyExitEvent) => {
        const targetProcessExit = installedProcessExit;
        if (!targetProcessExit) {
          PtyProcessTermination.signalProcessExit(processExit, event);
          pendingBeforeInstall.push(event);
          return;
        }
        PtyProcessTermination.signalProcessExit(targetProcessExit, event);
        input.dispatch(targetProcessExit, event);
      };
      const unsubscribeExit = yield* Effect.try({
        try: () => input.process.onExit(dispatchExit),
        catch: (cause) =>
          new PtyAdapter.PtyProcessListenerRegistrationError({
            listener: "exit",
            terminalPid: input.process.pid,
            cause,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TerminalProcessTerminationError({
              threadId: input.threadId,
              terminalId: input.terminalId,
              terminalPid: input.process.pid,
              reason: "exit-observer-failed",
              signal: null,
              cause,
            }),
        ),
      );
      const selectedProcessExit = yield* input.publish(processExit, unsubscribeExit);

      if (!selectedProcessExit) {
        yield* Effect.sync(unsubscribeExit).pipe(Effect.ignoreCause({ log: true }));
        PtyProcessTermination.completeProcessExitHandling(processExit);
        if (processExit.observedExit.current !== null) {
          return processExit;
        }
        return yield* new TerminalProcessTerminationError({
          threadId: input.threadId,
          terminalId: input.terminalId,
          terminalPid: input.process.pid,
          reason: "session-replaced",
          signal: null,
        });
      }
      yield* input.afterPublished;
      installedProcessExit = selectedProcessExit;
      if (selectedProcessExit !== processExit) {
        yield* Effect.sync(unsubscribeExit).pipe(Effect.ignoreCause({ log: true }));
        PtyProcessTermination.completeProcessExitHandling(processExit);
      }
      for (const event of pendingBeforeInstall) {
        dispatchExit(event);
      }
      return selectedProcessExit;
    }),
  );
});
