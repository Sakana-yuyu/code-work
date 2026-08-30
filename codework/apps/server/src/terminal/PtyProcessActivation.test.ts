import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessActivation from "./PtyProcessActivation.ts";

it.effect("注册期间的同步 output/exit 会在激活后按到达顺序排空", () =>
  Effect.gen(function* () {
    const dataListener = { current: null as ((data: string) => void) | null };
    const exitListener = {
      current: null as ((event: PtyAdapter.PtyExitEvent) => void) | null,
    };
    const process: PtyAdapter.PtyProcess = {
      pid: 44_001,
      exitObservation: { status: "reliable" },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (listener) => {
        dataListener.current = listener;
        return () => {
          dataListener.current = null;
        };
      },
      onExit: (listener) => {
        exitListener.current = listener;
        return () => {
          exitListener.current = null;
        };
      },
    };
    const dispatched: PtyProcessActivation.PtyProcessActivationEvent[] = [];
    const activation = yield* PtyProcessActivation.make({
      process,
      shellLabel: "pwsh",
      processGeneration: 1,
      dispatch: (_processGeneration, _processExit, event) => dispatched.push(event),
    });
    activation.unsubscribeData = yield* PtyProcessActivation.registerDataListener(activation);
    activation.unsubscribeExit = yield* PtyProcessActivation.registerExitListener(activation);

    dataListener.current?.("ready");
    const exitEvent = { exitCode: 0, signal: null };
    exitListener.current?.(exitEvent);
    expect(dispatched).toEqual([]);

    PtyProcessActivation.activate(activation);

    expect(dispatched).toEqual([
      { type: "output", data: "ready" },
      { type: "exit", event: exitEvent },
    ]);
    expect(activation.processExit.observedExit.current).toEqual(exitEvent);
  }),
);
