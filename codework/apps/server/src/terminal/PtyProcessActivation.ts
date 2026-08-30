import * as Effect from "effect/Effect";

import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

export type PtyProcessActivationEvent =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "exit"; readonly event: PtyAdapter.PtyExitEvent };

export interface PendingPtyProcessActivation {
  readonly process: PtyAdapter.PtyProcess;
  readonly shellLabel: string;
  readonly processGeneration: number;
  readonly processExit: PtyProcessTermination.PtyProcessExitState;
  readonly pendingBeforeActivation: PtyProcessActivationEvent[];
  activated: boolean;
  committed: boolean;
  retained: boolean;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  dispatchProcessEvent: (event: PtyProcessActivationEvent) => void;
}

export const make = Effect.fn("PtyProcessActivation.make")(function* (input: {
  readonly process: PtyAdapter.PtyProcess;
  readonly shellLabel: string;
  readonly processGeneration: number;
  readonly dispatch: (
    processGeneration: number,
    processExit: PtyProcessTermination.PtyProcessExitState,
    event: PtyProcessActivationEvent,
  ) => void;
}) {
  const activation: PendingPtyProcessActivation = {
    process: input.process,
    shellLabel: input.shellLabel,
    processGeneration: input.processGeneration,
    processExit: yield* PtyProcessTermination.makeProcessExitState(),
    pendingBeforeActivation: [],
    activated: false,
    committed: false,
    retained: false,
    unsubscribeData: null,
    unsubscribeExit: null,
    dispatchProcessEvent: () => undefined,
  };
  activation.dispatchProcessEvent = (event) => {
    if (!activation.activated) {
      activation.pendingBeforeActivation.push(event);
      return;
    }
    input.dispatch(activation.processGeneration, activation.processExit, event);
  };
  return activation;
});

export const registerDataListener = (
  activation: PendingPtyProcessActivation,
): Effect.Effect<() => void, PtyAdapter.PtyProcessListenerRegistrationError> =>
  Effect.try({
    try: () =>
      activation.process.onData((data) => {
        activation.dispatchProcessEvent({ type: "output", data });
      }),
    catch: (cause) =>
      new PtyAdapter.PtyProcessListenerRegistrationError({
        listener: "data",
        terminalPid: activation.process.pid,
        cause,
      }),
  });

export const registerExitListener = (
  activation: PendingPtyProcessActivation,
): Effect.Effect<() => void, PtyAdapter.PtyProcessListenerRegistrationError> =>
  Effect.try({
    try: () =>
      activation.process.onExit((event) => {
        PtyProcessTermination.signalProcessExit(activation.processExit, event);
        activation.dispatchProcessEvent({ type: "exit", event });
      }),
    catch: (cause) =>
      new PtyAdapter.PtyProcessListenerRegistrationError({
        listener: "exit",
        terminalPid: activation.process.pid,
        cause,
      }),
  });

export const disposeListener = Effect.fn("PtyProcessActivation.disposeListener")(function* (
  activation: PendingPtyProcessActivation,
  listener: "data" | "exit",
) {
  const unsubscribe = listener === "data" ? activation.unsubscribeData : activation.unsubscribeExit;
  if (!unsubscribe) return true;
  const disposal = yield* Effect.try({
    try: unsubscribe,
    catch: (cause) =>
      new PtyAdapter.PtyProcessListenerDisposalError({
        listener,
        terminalPid: activation.process.pid,
        cause,
      }),
  }).pipe(Effect.result);
  if (disposal._tag === "Failure") {
    yield* Effect.logWarning("failed to dispose uncommitted terminal listener", {
      listener,
      terminalPid: activation.process.pid,
      cause: disposal.failure,
    });
    return false;
  }
  if (listener === "data") {
    activation.unsubscribeData = null;
  } else {
    activation.unsubscribeExit = null;
  }
  return true;
});

/** 激活只执行一次，并按原始到达顺序排空注册期间的同步事件。 */
export function activate(activation: PendingPtyProcessActivation): void {
  if (activation.activated) return;
  activation.activated = true;
  const pendingEvents = activation.pendingBeforeActivation.splice(0);
  for (const pendingEvent of pendingEvents) {
    activation.dispatchProcessEvent(pendingEvent);
  }
}
