import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import type * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly killSignals: Array<string | undefined> = [];
  readonly killFailures = new Map<string | undefined, unknown>();
  readonly pid: number;

  constructor(pid = 9_000) {
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

const makeTerminationInput = (input: {
  readonly process: FakePtyProcess;
  readonly platform: NodeJS.Platform;
  readonly exitState: PtyProcessTermination.PtyProcessExitState;
  readonly isCurrent: Effect.Effect<boolean>;
  readonly gracefulTimeoutMs?: number;
  readonly forceExitTimeoutMs?: number;
}) => ({
  process: input.process,
  platform: input.platform,
  gracefulTimeoutMs: input.gracefulTimeoutMs ?? 1_000,
  forceExitTimeoutMs: input.forceExitTimeoutMs ?? 1_000,
  exitState: input.exitState,
  isCurrent: input.isCurrent,
});

it.effect("原始退出与 Manager 处理完成可分别等待", () =>
  Effect.gen(function* () {
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const handled = yield* Ref.make(false);
    const handledFiber = yield* PtyProcessTermination.awaitProcessExitHandling(exitState).pipe(
      Effect.ensuring(Ref.set(handled, true)),
      Effect.forkChild,
    );
    const exitEvent = { exitCode: 0, signal: 15 } as const;

    PtyProcessTermination.signalProcessExit(exitState, exitEvent);

    expect(yield* PtyProcessTermination.awaitProcessExit(exitState)).toEqual(exitEvent);
    assert.isFalse(yield* Ref.get(handled));

    PtyProcessTermination.completeProcessExitHandling(exitState);
    yield* Fiber.join(handledFiber);
    assert.isTrue(yield* Ref.get(handled));
  }),
);

it.effect("单个退出 listener defect 不得阻断其他订阅者或事后回放", () =>
  Effect.gen(function* () {
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const listenerFailure = new Error("expected exit listener failure");
    const observed: PtyAdapter.PtyExitEvent[] = [];
    PtyProcessTermination.subscribeProcessExit(exitState, () => {
      throw listenerFailure;
    });
    PtyProcessTermination.subscribeProcessExit(exitState, (event) => {
      observed.push(event);
    });
    const exitEvent = { exitCode: 17, signal: 9 } as const;

    PtyProcessTermination.signalProcessExit(exitState, exitEvent);
    PtyProcessTermination.subscribeProcessExit(exitState, (event) => {
      observed.push(event);
    });

    expect(observed).toEqual([exitEvent, exitEvent]);
    expect(exitState.listenerDefects).toEqual([listenerFailure]);
  }),
);

it.effect("win32 使用无参数 kill 并等待同一 handle 的真实退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const completed = yield* Ref.make(false);
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "win32",
        exitState,
        isCurrent: Effect.succeed(true),
      }),
    ).pipe(Effect.ensuring(Ref.set(completed, true)), Effect.forkChild);

    yield* Effect.yieldNow;
    expect(process.killSignals).toEqual([undefined]);
    assert.isFalse(yield* Ref.get(completed));

    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 0, signal: null });
    const outcome = yield* Fiber.join(terminationFiber);

    expect(outcome).toMatchObject({ mode: "platform-default", escalated: false });
  }),
);

it.effect("Unix TERM 后自然退出会取消 SIGKILL 升级", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Effect.succeed(true),
      }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    expect(process.killSignals).toEqual(["SIGTERM"]);
    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 0, signal: 15 });
    yield* TestClock.adjust("1 second");

    const outcome = yield* Fiber.join(terminationFiber);
    expect(process.killSignals).toEqual(["SIGTERM"]);
    expect(outcome).toMatchObject({ mode: "graceful", escalated: false });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("Unix grace 到期后强杀并继续等待真实退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const completed = yield* Ref.make(false);
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Effect.succeed(true),
      }),
    ).pipe(Effect.ensuring(Ref.set(completed, true)), Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("1 second");
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    assert.isFalse(yield* Ref.get(completed));

    PtyProcessTermination.signalProcessExit(exitState, { exitCode: 137, signal: 9 });
    const outcome = yield* Fiber.join(terminationFiber);
    expect(outcome).toMatchObject({ mode: "forced", escalated: true });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("同 PID 的 handle 或 generation 已替换时禁止延迟 SIGKILL", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess(4_242);
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const current = yield* Ref.make(true);
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Ref.get(current),
      }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* Ref.set(current, false);
    yield* TestClock.adjust("1 second");
    const error = yield* Fiber.join(terminationFiber).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessIdentityChangedError");
    expect(process.killSignals).toEqual(["SIGTERM"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("signal 抛错时返回结构化失败而不等待或假报退出", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    process.killFailures.set(undefined, new Error("signal unsupported"));
    const exitState = yield* PtyProcessTermination.makeProcessExitState();

    const error = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "win32",
        exitState,
        isCurrent: Effect.succeed(true),
      }),
    ).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessSignalError");
    expect(error).toMatchObject({ signal: "platform-default", terminalPid: 9_000 });
  }),
);

it.effect("已观察到 raw exit 时即使 session 身份已变化也直接收口", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const exitEvent = { exitCode: 0, signal: null } as const;
    PtyProcessTermination.signalProcessExit(exitState, exitEvent);

    const outcome = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Effect.succeed(false),
      }),
    );

    expect(process.killSignals).toEqual([]);
    expect(outcome).toEqual({ mode: "already-exited", escalated: false, exitEvent });
  }),
);

it.effect("初始身份校验期间 raw exit 到达时按已退出收口", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const exitEvent = { exitCode: 0, signal: null } as const;
    const isCurrent = Effect.sync(() => {
      PtyProcessTermination.signalProcessExit(exitState, exitEvent);
      return false;
    });

    const outcome = yield* PtyProcessTermination.terminate(
      makeTerminationInput({ process, platform: "linux", exitState, isCurrent }),
    );

    expect(process.killSignals).toEqual([]);
    expect(outcome).toEqual({ mode: "already-exited", escalated: false, exitEvent });
  }),
);

it.effect("强杀 signal 抛错时返回结构化失败", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    process.killFailures.set("SIGKILL", new Error("force kill failed"));
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Effect.succeed(true),
        gracefulTimeoutMs: 10,
      }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 millis");
    const error = yield* Fiber.join(terminationFiber).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessSignalError");
    expect(error).toMatchObject({ signal: "SIGKILL", terminalPid: 9_000 });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("强杀后未收到 onExit 时返回结构化超时", () =>
  Effect.gen(function* () {
    const process = new FakePtyProcess();
    const exitState = yield* PtyProcessTermination.makeProcessExitState();
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent: Effect.succeed(true),
        gracefulTimeoutMs: 10,
        forceExitTimeoutMs: 20,
      }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("30 millis");
    const error = yield* Fiber.join(terminationFiber).pipe(Effect.flip);

    assert.equal(error._tag, "PtyProcessExitTimeoutError");
    expect(error).toMatchObject({ phase: "forced", terminalPid: 9_000, timeoutMs: 20 });
    expect(process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("force 身份校验期间观察到退出时不再发送 SIGKILL", () =>
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
      Effect.map((count) => count === 1),
    );
    const terminationFiber = yield* PtyProcessTermination.terminate(
      makeTerminationInput({
        process,
        platform: "linux",
        exitState,
        isCurrent,
        gracefulTimeoutMs: 10,
      }),
    ).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 millis");
    const outcome = yield* Fiber.join(terminationFiber);

    expect(process.killSignals).toEqual(["SIGTERM"]);
    expect(outcome).toEqual({ mode: "graceful", escalated: false, exitEvent });
  }).pipe(Effect.provide(TestClock.layer())),
);
