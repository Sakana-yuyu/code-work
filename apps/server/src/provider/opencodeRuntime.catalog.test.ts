import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const provideRuntime = <A, E>(effect: Effect.Effect<A, E, OpenCodeRuntime>) =>
  effect.pipe(Effect.provide(OpenCodeRuntimeLive.pipe(Layer.provide(NodeServices.layer))));

const makePendingSdk = () => {
  const entered = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const aborted: AbortSignal[] = [];
  const request = (_parameters: unknown, options: { signal: AbortSignal }) => {
    NodeAssert.ok(options.signal instanceof AbortSignal);
    signals.push(options.signal);
    if (signals.length === 3) entered.resolve();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          aborted.push(options.signal);
          reject(new Error("目录请求已取消"));
        },
        { once: true },
      );
    });
  };
  const client = {
    provider: { list: request },
    app: { agents: request, skills: request },
  } as unknown as OpencodeClient;
  return { client, entered, signals, aborted };
};

/** 使用真实 runtime 与 Scope，只替换子进程字节流及退出回执。 */
const makeCommandFixture = Effect.fn("makeOpenCodeCommandFixture")(function* (options?: {
  readonly blocked?: boolean;
  readonly holdFinalizer?: boolean;
  readonly failModels?: boolean;
  readonly failModelsOnce?: boolean;
}) {
  const entered = yield* Deferred.make<void>();
  const finalizerEntered = yield* Deferred.make<void>();
  const releaseFinalizer = yield* Deferred.make<void>();
  const commands: ChildProcess.StandardCommand[] = [];
  const finalized: number[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("需要普通命令");
      commands.push(command);
      const pid = commands.length;
      if (pid === 3) yield* Deferred.succeed(entered, undefined);
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(finalizerEntered, undefined);
          if (options?.holdFinalizer) yield* Deferred.await(releaseFinalizer);
          finalized.push(pid);
        }),
      );
      const isModels = command.args[0] === "models";
      const failModels =
        isModels &&
        (options?.failModels ||
          (options?.failModelsOnce &&
            commands.filter((entry) => entry.args[0] === "models").length === 1));
      const stdout = isModels
        ? 'openai/gpt-test\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\n'
        : command.args[0] === "debug"
          ? "[]"
          : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: options?.blocked
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(failModels ? 1 : 0)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, OpenCodeRuntime>) =>
    effect.pipe(
      Effect.provide(
        OpenCodeRuntimeLive.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
  return { entered, finalizerEntered, releaseFinalizer, commands, finalized, run, spawner };
});

describe("OpenCode 目录取消与执行上下文", () => {
  it.effect("SDK 三个请求使用调用者同一 signal，取消不会降为成功空技能", () =>
    Effect.gen(function* () {
      const sdk = makePendingSdk();
      const controller = new AbortController();
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadOpenCodeInventory(sdk.client, controller.signal);
      }).pipe(provideRuntime, Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => sdk.entered.promise);
      NodeAssert.equal(sdk.signals.length, 3);
      NodeAssert.ok(sdk.signals.every((signal) => signal === controller.signal));
      controller.abort();
      const exit = yield* Fiber.await(fiber);
      NodeAssert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      NodeAssert.equal(sdk.aborted.length, 3);
    }),
  );

  it.effect("旧 SDK 调用未传 signal 时仍共享本次 controller 并随 Effect 取消", () =>
    Effect.gen(function* () {
      const sdk = makePendingSdk();
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadOpenCodeInventory(sdk.client);
      }).pipe(provideRuntime, Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => sdk.entered.promise);
      NodeAssert.ok(sdk.signals.every((signal) => signal === sdk.signals[0]));
      yield* Fiber.interrupt(fiber);
      NodeAssert.equal(sdk.aborted.length, 3);
    }),
  );

  it.effect("预先取消的 SDK 发现不会发起请求", () =>
    Effect.gen(function* () {
      const sdk = makePendingSdk();
      const controller = new AbortController();
      controller.abort();
      const exit = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadOpenCodeInventory(sdk.client, controller.signal);
      }).pipe(provideRuntime, Effect.exit);
      NodeAssert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      NodeAssert.equal(sdk.signals.length, 0);
    }),
  );

  it.effect("Windows 命令解析与 spawn 使用同一 cwd 和完整环境，不重新继承宿主", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCommandFixture();
      const environment = { PATH: "relative-bin", ONLY_CHILD: "kept" };
      const cwd = "C:\\fixture\\work";
      const resolutions: unknown[] = [];
      yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        yield* runtime.runOpenCodeCommand({
          binaryPath: "opencode.cmd",
          args: ["--version"],
          environment,
          cwd,
          extendEnv: false,
        });
      }).pipe(
        Effect.provide(
          OpenCodeRuntimeLive.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fixture.spawner)),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, {
          PATH: "host-bin",
          HOST_ONLY: "must-not-leak",
        }),
        Effect.provideService(SpawnExecutableResolution, (binary, platform, env, directory) => {
          resolutions.push({ binary, platform, env, directory });
          return "C:\\fixture\\work\\opencode.cmd";
        }),
      );
      NodeAssert.deepEqual(resolutions, [
        { binary: "opencode.cmd", platform: "win32", env: environment, directory: cwd },
      ]);
      NodeAssert.equal(fixture.commands[0]?.options.cwd, cwd);
      NodeAssert.deepEqual(fixture.commands[0]?.options.env, environment);
      NodeAssert.equal(fixture.commands[0]?.options.extendEnv, false);
      NodeAssert.equal(fixture.commands[0]?.options.forceKillAfter, "2 seconds");
    }),
  );

  it.effect("省略 cwd 且仅传部分环境时继承 Effect 宿主上下文", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCommandFixture();
      const environment = { PATH: "/fixture/bin", CONTEXT_ONLY: "kept" };
      yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        yield* runtime.runOpenCodeCommand({
          binaryPath: "opencode",
          args: ["--version"],
          environment: { EXTRA: "added" },
        });
      }).pipe(
        fixture.run,
        Effect.provideService(HostProcessEnvironment, environment),
        Effect.provideService(HostProcessWorkingDirectory, "/fixture/work"),
      );
      NodeAssert.deepEqual(fixture.commands[0]?.options.env, { ...environment, EXTRA: "added" });
      NodeAssert.equal(fixture.commands[0]?.options.cwd, "/fixture/work");
      NodeAssert.equal(fixture.commands[0]?.options.extendEnv, false);
    }),
  );

  it.effect("CLI 取消中断全部目录命令，等待进程 finalizer 后才结束", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCommandFixture({ blocked: true, holdFinalizer: true });
      const controller = new AbortController();
      let returned = false;
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadInventoryFromCli({
          binaryPath: "opencode",
          cwd: "/fixture",
          signal: controller.signal,
        });
      }).pipe(
        fixture.run,
        Effect.ensuring(
          Effect.sync(() => {
            returned = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fixture.entered);
      controller.abort();
      yield* Deferred.await(fixture.finalizerEntered);
      NodeAssert.equal(returned, false);
      yield* Deferred.succeed(fixture.releaseFinalizer, undefined);
      const exit = yield* Fiber.await(fiber);
      NodeAssert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      NodeAssert.equal(fixture.finalized.length, 3);
      NodeAssert.equal(fixture.commands.length, 3);
    }),
  );

  it.effect("统一预算或显式取消覆盖 CLI 重试等待，不会启动第二轮模型命令", () =>
    Effect.gen(function* () {
      for (const cancellation of ["deadline", "signal"] as const) {
        const fixture = yield* makeCommandFixture({ failModels: true });
        const controller = new AbortController();
        const load = Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          return yield* runtime.loadInventoryFromCli({
            binaryPath: "opencode",
            cwd: "/fixture",
            signal: controller.signal,
          });
        }).pipe(fixture.run);
        const fiber = yield* (
          cancellation === "deadline" ? load.pipe(Effect.timeout("500 millis")) : load
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(fixture.entered);
        yield* TestClock.adjust("400 millis");
        NodeAssert.equal(fixture.commands.length, 3);
        if (cancellation === "signal") controller.abort();
        else yield* TestClock.adjust("100 millis");
        const exit = yield* Fiber.await(fiber);
        NodeAssert.ok(Exit.isFailure(exit));
        if (cancellation === "signal") NodeAssert.ok(Cause.hasInterrupts(exit.cause));
        yield* TestClock.adjust("1 second");
        NodeAssert.equal(fixture.commands.length, 3);
        NodeAssert.equal(fixture.finalized.length, 3);
      }
    }),
  );

  it.effect("CLI 正常重试仅重新执行失败命令，整轮保留首次解析的环境", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCommandFixture({ failModelsOnce: true });
      const hostEnvironment = { PATH: "/original/bin" };
      const environment = { ROUTE: "original" };
      const fiber = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.loadInventoryFromCli({
          binaryPath: "opencode",
          cwd: "/fixture",
          environment,
        });
      }).pipe(
        fixture.run,
        Effect.provideService(HostProcessEnvironment, hostEnvironment),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(fixture.entered);
      yield* TestClock.adjust("500 millis");
      environment.ROUTE = "changed";
      hostEnvironment.PATH = "/changed/bin";
      yield* TestClock.adjust("500 millis");
      const inventory = yield* Fiber.join(fiber);
      NodeAssert.deepEqual(inventory.providerList.connected, ["openai"]);
      NodeAssert.deepEqual(
        fixture.commands.map((command) => command.args[0]),
        ["models", "agent", "debug", "models"],
      );
      for (const command of fixture.commands) {
        NodeAssert.deepEqual(command.options.env, { PATH: "/original/bin", ROUTE: "original" });
        NodeAssert.equal(command.options.extendEnv, false);
      }
    }),
  );

  it.effect("预先取消的 CLI 调用不会 spawn", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCommandFixture();
      const controller = new AbortController();
      controller.abort();
      const exit = yield* Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        return yield* runtime.runOpenCodeCommand({
          binaryPath: "opencode",
          args: ["--version"],
          signal: controller.signal,
        });
      }).pipe(fixture.run, Effect.exit);
      NodeAssert.ok(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      NodeAssert.equal(fixture.commands.length, 0);
    }),
  );
});
