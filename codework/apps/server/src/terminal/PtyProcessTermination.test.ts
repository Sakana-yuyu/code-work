import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  readonly pid: number;

  constructor(pid = 9000) {
    this.pid = pid;
  }

  write(): void {}

  resize(): void {}

  kill(signal?: string): void {
    this.killSignals.push(signal);
    const failure = this.killFailures.get(signal);
    if (failure !== undefined) {
      throw failure;
    }
  }

  onData(): () => void {
    return () => undefined;
  }

  onExit(): () => void {
    return () => undefined;
  }
}

const terminationInput = (input: {
  readonly process: FakePtyProcess;
  readonly platform: NodeJS.Platform;
  readonly exitState: PtyProcessTermination.PtyProcessExitState;
  readonly current: Ref.Ref<boolean>;
}) => ({
  process: input.process,
  platform: input.platform,
  gracefulTimeoutMs: 1_000,
  forceExitTimeoutMs: 1_000,
  exitState: input.exitState,
  isCurrent: Ref.get(input.current),
});

it.effect("原始退出信号与事件处理完成状态相互独立", () =>
  Effect.gen(function* () {
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const handlingFinished = yield* Ref.make(false);
    const handlingFiber = yield* PtyProcessTermination.awaitProcessExitHandling(exitState).pipe(
      Effect.ensuring(Ref.set(handlingFinished, true)),
      Effect.forkChild,
    );
    const exitEvent = { exitCode: 0, signal: 15 } as const;

    PtyProcessTermination.signalProcessExit(exitState, exitEvent);

    expect(yield* PtyProcessTermination.awaitProcessExit(exitState)).toEqual(exitEvent);
    assert.isFalse(yield* Ref.get(handlingFinished));

    PtyProcessTermination.completeProcessExitHandling(exitState);
    yield* Fiber.join(handlingFiber);
    assert.isTrue(yield* Ref.get(handlingFinished));
  }),
);

it.effect("win32 使用无参数 kill 并等待同一 handle 的真实退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const finished = yield* Ref.make(false);
    const termination = yield* PtyProcessTermination.terminate(
      terminationInput({ process, platform: "win32", exitState, current }),
    ).pipe(Effect.ensuring(Ref.set(finished, true)), Effect.forkChild);

    yield* Effect.yieldNow;
    expect(process.killSignals).toEqual([undefined]);
    assert.isFalse(yield* Ref.get(finished));

    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 0, signal: null });
    const outcome = yield* Fiber.join(termination);

    expect(outcome).toMatchObject({ mode: "platform-default", escalated: false });
  }),
);

it.effect("Unix TERM 后自然退出会取消强杀升级", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const finished = yield* Ref.make(false);
    const termination = yield* PtyProcessTermination.terminate(
      terminationInput({ process, platform: "linux", exitState, current }),
    ).pipe(Effect.ensuring(Ref.set(finished, true)), Effect.forkChild);

    yield* Effect.yieldNow;
    expect(process.killSignals).toEqual(["SIGTERM"]);
    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 0, signal: 15 });
    yield* TestClock.adjust("1 second");
    const outcome = yield* Fiber.join(termination);

    expect(process.killSignals).toEqual(["SIGTERM"]);
    expect(outcome).toMatchObject({ mode: "graceful", escalated: false });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("Unix grace 到期后强杀且仍等待真实退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const finished = yield* Ref.make(false);
    const termination = yield* PtyProcessTermination.terminate(
      terminationInput({ process, platform: "linux", exitState, current }),
    ).pipe(Effect.ensuring(Ref.set(finished, true)), Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    assert.isFalse(yield* Ref.get(finished));

    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 137, signal: 9 });
    const outcome = yield* Fiber.join(termination);
    expect(outcome).toMatchObject({ mode: "forced", escalated: true });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("相同 PID 的 handle 或 generation 已替换时禁止延迟 SIGKILL", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess(4242);
    const replacement = new FakePtyProcess(4242);
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const termination = yield* PtyProcessTermination.terminate(
      terminationInput({ process, platform: "linux", exitState, current }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* Ref.set(current, false);
    yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(termination).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessIdentityChangedError");
    expect(process.killSignals).toEqual(["SIGTERM"]);
    expect(replacement.killSignals).toEqual([]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("signal 抛错返回结构化失败而不等待或假报退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    process.killFailures.set(undefined, new Error("signal unsupported"));
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);

    const error = yield* PtyProcessTermination.terminate(
      terminationInput({ process, platform: "win32", exitState, current }),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessSignalError");
    expect(error).toMatchObject({ signal: "platform-default", terminalPid: 9000 });
  }),
);

it.effect("Unix force kill 抛错返回结构化失败", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    process.killFailures.set("SIGKILL", new Error("force kill failed"));
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const termination = yield* PtyProcessTermination.terminate({
      ...terminationInput({ process, platform: "linux", exitState, current }),
      gracefulTimeoutMs: 10,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 millis");
    const error = yield* Fiber.join(termination).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessSignalError");
    expect(error).toMatchObject({ signal: "SIGKILL", terminalPid: 9000 });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("强杀后未收到 onExit 返回结构化超时", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const termination = yield* PtyProcessTermination.terminate({
      ...terminationInput({ process, platform: "linux", exitState, current }),
      gracefulTimeoutMs: 10,
      forceExitTimeoutMs: 20,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("30 millis");
    const error = yield* Fiber.join(termination).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessExitTimeoutError");
    expect(error).toMatchObject({ phase: "forced", terminalPid: 9000 });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("首次信号前已观察到 raw exit 时不再发送终止信号", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const currentChecks = yield* Ref.make(0);
    const exitEvent = { exitCode: 23, signal: null } as const;
    const isCurrent = Ref.updateAndGet(currentChecks, (count) => count + 1).pipe(
      Effect.tap((count) =>
        count === 1
          ? Effect.sync(() => PtyProcessTermination.signalProcessExit(exitState, exitEvent))
          : Effect.void,
      ),
      Effect.as(true),
    );

    const outcome = yield* PtyProcessTermination.terminate({
      process,
      platform: "linux",
      gracefulTimeoutMs: 1_000,
      forceExitTimeoutMs: 1_000,
      exitState,
      isCurrent,
    });

    expect(process.killSignals).toEqual([]);
    expect(outcome).toEqual({ mode: "already-exited", escalated: false, exitEvent });
  }),
);

it.effect("force 校验期间 raw exit 到达时不再发送 SIGKILL", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const currentChecks = yield* Ref.make(0);
    const exitEvent = { exitCode: 0, signal: 15 } as const;
    const isCurrent = Ref.updateAndGet(currentChecks, (count) => count + 1).pipe(
      Effect.tap((count) =>
        count === 2
          ? Effect.sync(() => PtyProcessTermination.signalProcessExit(exitState, exitEvent))
          : Effect.void,
      ),
      Effect.as(true),
    );
    const termination = yield* PtyProcessTermination.terminate({
      process,
      platform: "linux",
      gracefulTimeoutMs: 10,
      forceExitTimeoutMs: 1_000,
      exitState,
      isCurrent,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    expect(process.killSignals).toEqual(["SIGTERM"]);
    yield* TestClock.adjust("10 millis");
    const outcome = yield* Fiber.join(termination);

    expect(process.killSignals).toEqual(["SIGTERM"]);
    expect(outcome).toEqual({ mode: "graceful", escalated: false, exitEvent });
  }).pipe(Effect.provide(TestClock.layer())),
);
