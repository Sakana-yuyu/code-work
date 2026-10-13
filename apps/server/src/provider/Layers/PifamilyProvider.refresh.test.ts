import { PiAgentSettings, OmpAgentSettings, ZCodeAgentSettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import { expect, it } from "@effect/vitest";
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
import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import type { PifamilyDriverKind } from "./PifamilyProvider.ts";
import { fetchPifamilyRefreshCatalog } from "./PifamilyProvider.ts";

const decodePi = Schema.decodeEffect(PiAgentSettings),
  decodeOmp = Schema.decodeEffect(OmpAgentSettings),
  decodeZCode = Schema.decodeEffect(ZCodeAgentSettings);
const kinds = ["piAgent", "ompAgent", "zcodeAgent"] as const;
const makeFixture = Effect.fn(function* (driverKind: PifamilyDriverKind) {
  const native = yield* makeNativeProviderCatalog(),
    catalog = yield* makeCliProviderCatalog();
  const routes = [
    {
      adapterId: "route",
      displayName: "路由模型",
      modelId: "upstream",
      protocol: "openai",
      contextWindowTokens: 128000,
    },
  ] satisfies PifamilyModelRoute[];
  const controllers: AbortController[] = [],
    signals: AbortSignal[] = [],
    finalized: number[] = [],
    commands: ChildProcess.StandardCommand[] = [];
  const entered = {
    prepare: yield* Deferred.make<void>(),
    version: yield* Deferred.make<void>(),
    finish: yield* Deferred.make<void>(),
  };
  const release = {
    prepare: yield* Deferred.make<void>(),
    version: yield* Deferred.make<void>(),
    finish: yield* Deferred.make<void>(),
  };
  const state = {
    blockPrepare: false,
    blockVersion: false,
    blockFinish: false,
    version: "1.2.3",
    code: 0,
    account: "first",
    assumeInstalled: false,
    abortPrepare: false,
    defectPrepare: false,
  };
  const decoded = yield* driverKind === "piAgent"
    ? decodePi({ enabled: true })
    : driverKind === "ompAgent"
      ? decodeOmp({ enabled: true })
      : decodeZCode({ enabled: true });
  const settings = { ...decoded, binaryPath: "fixture-cli" };
  const environment = { PATH: "/bin", HOME: "/home", SYSTEMROOT: "/windows", MARKER: "first" };
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
      expect(command.args.at(-1)).toBe("--version");
      commands.push(command);
      const current = { ...state },
        pid = commands.length;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized.push(pid);
        }),
      );
      yield* Deferred.succeed(entered.version, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(current.code)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromEffect(
          (current.blockVersion ? Deferred.await(release.version) : Effect.void).pipe(
            Effect.as(new TextEncoder().encode("cli " + current.version)),
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const call = (revision = "one", completeEnvironment = true) =>
    fetchPifamilyRefreshCatalog({
      driverKind,
      settings,
      environment,
      completeEnvironment,
      routes,
      nativeCatalog: observed,
      catalog,
      preparationIdentity: { revision, home: "/isolated" },
      spawnArgsPrefix: driverKind === "zcodeAgent" ? ["bundle.cjs"] : [],
      assumeInstalled: state.assumeInstalled,
      prepareRoutes: (signal) =>
        Effect.gen(function* () {
          const snapshot = routes.map((route) => ({ ...route }));
          signals.push(signal);
          yield* Deferred.succeed(entered.prepare, undefined);
          if (state.abortPrepare) {
            controllers.at(-1)?.abort();
            return yield* Effect.interrupt;
          }
          if (state.defectPrepare) return yield* Effect.die("准备缺陷");
          if (state.blockPrepare) yield* Deferred.await(release.prepare);
          return snapshot;
        }),
      finish: (draft, signal) =>
        Effect.gen(function* () {
          signals.push(signal);
          yield* Deferred.succeed(entered.finish, undefined);
          const account = state.account;
          if (state.blockFinish) yield* Deferred.await(release.finish);
          return {
            ...draft,
            auth: { status: "authenticated" as const, type: "fixture", label: account },
          };
        }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, "/actual-cwd"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "/host-bin",
        SYSTEMROOT: "/host-windows",
        OPENAI_API_KEY: "synthetic-host",
        HOST_MARKER: "host",
      }),
    );
  return {
    call,
    state,
    settings,
    environment,
    routes,
    controllers,
    signals,
    commands,
    finalized,
    entered,
    release,
  };
});

for (const kind of kinds) {
  it.effect(`${kind} 准备、目录、版本和凭据共用十五秒，晚加入不续时`, () =>
    Effect.gen(function* () {
      const f = yield* makeFixture(kind);
      f.state.blockPrepare = true;
      f.state.blockVersion = true;
      f.state.blockFinish = true;
      const first = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.entered.prepare);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.succeed(f.release.prepare, undefined);
      yield* Deferred.await(f.entered.version);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.succeed(f.release.version, undefined);
      yield* Deferred.await(f.entered.finish);
      const second = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(0);
      yield* TestClock.adjust("5 seconds");
      const a = yield* Fiber.join(first),
        b = yield* Fiber.join(second);
      expect(a.message).toContain("15000ms");
      expect(b.message).toContain("15000ms");
      expect(a.installed).toBe(true);
      expect(a.version).toBe("1.2.3");
      expect(a.models[0]?.slug).toBe("route");
      expect(a.auth.status).toBe("unknown");
      expect(b.checkedAt).toBe(DateTime.formatIso(yield* DateTime.now));
      expect(f.controllers).toHaveLength(1);
      expect(f.signals.every((signal) => signal === f.controllers[0]?.signal)).toBe(true);
      expect(f.controllers[0]?.signal.aborted).toBe(true);
      expect(f.finalized).toEqual([1]);
      f.state.blockPrepare = false;
      f.state.blockVersion = false;
      f.state.blockFinish = false;
      expect((yield* f.call()).auth.label).toBe("first");
    }),
  );
  for (const all of [false, true])
    it.effect(`${kind} ${all ? "最后" : "首个"}等待者取消保持原生资源所有权`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture(kind);
        f.state.blockVersion = true;
        const a = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.entered.version);
        const b = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(0);
        yield* Fiber.interrupt(a);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        if (all) yield* Fiber.interrupt(b);
        else {
          yield* Deferred.succeed(f.release.version, undefined);
          expect((yield* Fiber.join(b)).version).toBe("1.2.3");
        }
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual([1]);
      }),
    );
  it.effect(`${kind} 顺序检查读取实时版本和账号，输入及执行环境保持冻结`, () =>
    Effect.gen(function* () {
      const f = yield* makeFixture(kind);
      f.state.blockPrepare = true;
      const first = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.entered.prepare);
      f.settings.binaryPath = "late-cli";
      f.routes[0]!.modelId = "late-model";
      f.environment.MARKER = "late";
      yield* Deferred.succeed(f.release.prepare, undefined);
      expect((yield* Fiber.join(first)).models[0]?.subProvider).toBe("upstream");
      expect(f.commands[0]?.options).toMatchObject({
        cwd: "/actual-cwd",
        extendEnv: false,
        forceKillAfter: "2 seconds",
        env: { MARKER: "first", SYSTEMROOT: "/windows" },
      });
      expect(f.commands[0]?.options.env?.OPENAI_API_KEY).toBeUndefined();
      expect(f.commands[0]?.options.env?.HOST_MARKER).toBeUndefined();
      f.state.blockPrepare = false;
      f.state.account = "next";
      f.state.version = "2.3.4";
      const next = yield* f.call();
      expect(next.version).toBe("2.3.4");
      expect(next.auth.label).toBe("next");
      expect(next.models[0]?.subProvider).toBe("late-model");
    }),
  );
}
it.effect("ZCode 内嵌运行时与禁用实例仍跳过版本探针", () =>
  Effect.gen(function* () {
    const bundled = yield* makeFixture("zcodeAgent");
    bundled.state.assumeInstalled = true;
    expect((yield* bundled.call()).installed).toBe(true);
    expect(bundled.commands).toHaveLength(0);
    const disabled = yield* makeFixture("piAgent");
    disabled.settings.enabled = false;
    expect((yield* disabled.call()).status).toBe("disabled");
    expect(disabled.commands).toHaveLength(0);
  }),
);
it.effect("旧部分环境调用继续继承必要系统变量，完整受管环境不重新引入宿主字段", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture("zcodeAgent");
    yield* f.call("partial", false);
    expect(f.commands[0]?.options.env?.HOST_MARKER).toBe("host");
    expect(f.commands[0]?.options.env?.SYSTEMROOT).toBe("/windows");
    yield* f.call("complete", true);
    expect(f.commands[1]?.options.env?.OPENAI_API_KEY).toBeUndefined();
  }),
);
it.effect("强刷新和路由代次不加入旧加载，旧结果不污染后续目录", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture("piAgent");
    f.state.blockVersion = true;
    const old = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(f.entered.version);
    f.state.blockVersion = false;
    f.routes[0]!.modelId = "new-model";
    expect(
      (yield* f.call().pipe(Effect.provideService(ProviderCatalogForceRefresh, true))).models[0]
        ?.subProvider,
    ).toBe("new-model");
    expect((yield* f.call("new-revision")).models[0]?.subProvider).toBe("new-model");
    yield* Deferred.succeed(f.release.version, undefined);
    expect((yield* Fiber.join(old)).models[0]?.subProvider).toBe("upstream");
  }),
);
it.effect("准备预算耗尽前不启动版本，取消和缺陷不会变成无路由成功", () =>
  Effect.gen(function* () {
    const f = yield* makeFixture("ompAgent");
    f.state.blockPrepare = true;
    const task = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(f.entered.prepare);
    yield* TestClock.adjust("15 seconds");
    expect((yield* Fiber.join(task)).installed).toBe(false);
    expect(f.commands).toHaveLength(0);
    f.state.blockPrepare = false;
    f.state.abortPrepare = true;
    expect(Exit.isFailure(yield* Effect.exit(f.call()))).toBe(true);
    f.state.abortPrepare = false;
    f.state.defectPrepare = true;
    expect(Exit.isFailure(yield* Effect.exit(f.call()))).toBe(true);
  }),
);
