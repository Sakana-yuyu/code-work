import { AntigravitySettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { fetchAntigravityProviderCatalog } from "./AntigravityProvider.ts";

const decodeSettings = Schema.decodeEffect(AntigravitySettings);
const makeFixture = Effect.fn(function* () {
  const native = yield* makeNativeProviderCatalog();
  const pure = yield* makeCliProviderCatalog();
  const modelsEntered = yield* Deferred.make<void>();
  const modelsRelease = yield* Deferred.make<void>();
  const versionEntered = yield* Deferred.make<void>();
  const versionRelease = yield* Deferred.make<void>();
  const controllers: AbortController[] = [];
  const finalized: number[] = [];
  const commands: ChildProcess.StandardCommand[] = [];
  const state = { blockModels: false, blockVersion: false, version: "1.1.27", code: 0 };
  const settings = {
    ...(yield* decodeSettings({ enabled: true, binaryPath: "agy" })),
    customModels: ["model"],
  };
  const environment = { PATH: "/bin", ACCOUNT: "first" };
  const catalog: CliProviderCatalog = {
    fetchCatalog: (input) =>
      pure.fetchCatalog({
        ...input,
        load: Effect.gen(function* () {
          yield* Deferred.succeed(modelsEntered, undefined);
          if (state.blockModels) yield* Deferred.await(modelsRelease);
          return yield* input.load;
        }),
      }),
  };
  const observed: NativeProviderCatalog = {
    ...native,
    fetchCatalog: (input) =>
      native.fetchCatalog({
        ...input,
        load: (controller) => {
          controllers.push(controller);
          return input.load(controller);
        },
      }),
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("只允许版本探针");
      expect(command.args).toEqual(["--version"]);
      commands.push(command);
      const current = { ...state },
        pid = commands.length;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized.push(pid);
        }),
      );
      yield* Deferred.succeed(versionEntered, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(current.code)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromEffect(
          (current.blockVersion ? Deferred.await(versionRelease) : Effect.void).pipe(
            Effect.as(new TextEncoder().encode("agy " + current.version)),
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const call = () =>
    fetchAntigravityProviderCatalog({
      settings,
      environment,
      catalog,
      nativeCatalog: observed,
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.provideService(HostProcessWorkingDirectory, "/actual-cwd"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  return {
    state,
    settings,
    environment,
    call,
    controllers,
    finalized,
    commands,
    modelsEntered,
    modelsRelease,
    versionEntered,
    versionRelease,
  };
});

describe("Antigravity 完整刷新所有权", () => {
  it.effect("配置目录六秒后版本只剩九秒，晚加入不续时且超时后能恢复", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockModels = true;
      f.state.blockVersion = true;
      const first = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelsEntered);
      yield* TestClock.adjust("6 seconds");
      yield* Deferred.succeed(f.modelsRelease, undefined);
      yield* Deferred.await(f.versionEntered);
      yield* TestClock.adjust("4 seconds");
      const second = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(0);
      yield* TestClock.adjust("5 seconds");
      const a = yield* Fiber.join(first),
        b = yield* Fiber.join(second);
      expect(a.message).toContain("15000ms");
      expect(b.message).toContain("15000ms");
      expect(a.models.map((m) => m.slug)).toEqual(["model"]);
      expect(b.checkedAt).toBe(DateTime.formatIso(yield* DateTime.now));
      expect(f.controllers).toHaveLength(1);
      expect(f.controllers[0]?.signal.aborted).toBe(true);
      expect(f.finalized).toEqual([1]);
      f.state.blockModels = false;
      f.state.blockVersion = false;
      expect((yield* f.call()).version).toBe("1.1.27");
      expect(f.controllers).toHaveLength(2);
    }),
  );
  for (const all of [false, true])
    it.effect(`${all ? "最后" : "首个"}等待者取消遵守完整 owner 生命周期`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blockVersion = true;
        const a = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.versionEntered);
        const b = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(0);
        yield* Fiber.interrupt(a);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        if (all) yield* Fiber.interrupt(b);
        else {
          yield* Deferred.succeed(f.versionRelease, undefined);
          expect((yield* Fiber.join(b)).version).toBe("1.1.27");
        }
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual([1]);
      }),
    );
  it.effect("等待时冻结配置与实际环境，禁用实例仍检查安装且顺序刷新读实时版本", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockModels = true;
      const task = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelsEntered);
      f.settings.customModels.push("late-model");
      f.environment.ACCOUNT = "late";
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.succeed(f.modelsRelease, undefined);
      const first = yield* Fiber.join(task);
      expect(first.models.map((m) => m.slug)).toEqual(["model"]);
      expect(f.commands[0]?.options).toMatchObject({
        cwd: "/actual-cwd",
        extendEnv: false,
        forceKillAfter: "2 seconds",
        env: { ACCOUNT: "first" },
      });
      f.state.blockModels = false;
      f.state.version = "1.1.28";
      f.settings.enabled = false;
      const disabled = yield* f.call();
      expect(disabled.installed).toBe(true);
      expect(disabled.status).toBe("disabled");
      expect(f.commands).toHaveLength(2);
    }),
  );
  it.effect("强刷新不加入普通旧加载，不同配置各自执行", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockVersion = true;
      const old = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.versionEntered);
      f.state.blockVersion = false;
      f.state.version = "1.1.28";
      const strong = yield* f.call().pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      expect(strong.version).toBe("1.1.28");
      f.settings.customModels.push("next-model");
      expect((yield* f.call()).models.map((m) => m.slug)).toEqual(["model", "next-model"]);
      yield* Deferred.succeed(f.versionRelease, undefined);
      expect((yield* Fiber.join(old)).version).toBe("1.1.27");
      expect(f.controllers).toHaveLength(3);
    }),
  );
  it.effect("规范化后等价的自定义模型配置共享同一次实际探针", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockVersion = true;
      const first = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.versionEntered);
      f.settings.customModels = [" model ", "model", ""];
      const second = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(0);
      expect(f.controllers).toHaveLength(1);
      yield* Deferred.succeed(f.versionRelease, undefined);
      expect((yield* Fiber.join(first)).models.map((m) => m.slug)).toEqual(["model"]);
      expect((yield* Fiber.join(second)).models.map((m) => m.slug)).toEqual(["model"]);
      expect(f.commands).toHaveLength(1);
    }),
  );
  it.effect("版本失败保持错误并释放资源，调用者取消不是成功降级", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.code = 2;
      expect((yield* f.call()).status).toBe("error");
      expect(f.finalized).toEqual([1]);
      f.state.code = 0;
      f.state.blockVersion = true;
      const task = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(task);
      expect(Exit.isFailure(yield* Fiber.await(task))).toBe(true);
    }),
  );
});
