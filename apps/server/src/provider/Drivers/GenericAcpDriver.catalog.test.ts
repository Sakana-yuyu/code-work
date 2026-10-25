import { AcpAgentSettings, ProviderInstanceId } from "@codework/contracts";
import { HostProcessPlatform, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GenericAcpDriver } from "./GenericAcpDriver.ts";

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-generic-catalog-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  Layer.succeed(
    ServerSecretStore,
    ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
      remove: () => Effect.void,
    }),
  ),
);
const decodeSettings = Schema.decodeEffect(AcpAgentSettings);
const makeFixture = Effect.fn(function* () {
  const native = yield* makeNativeProviderCatalog();
  const pure = yield* makeCliProviderCatalog();
  const controllers: AbortController[] = [],
    finalized: number[] = [],
    commands: ChildProcess.StandardCommand[] = [];
  const modelsEntered = yield* Deferred.make<void>(),
    modelsRelease = yield* Deferred.make<void>();
  const versionEntered = yield* Deferred.make<void>(),
    versionRelease = yield* Deferred.make<void>();
  const state = { blockModels: false, blockVersion: false, code: 0, stdout: "fixture 1.0.0" };
  const catalog: CliProviderCatalog = {
    fetchCatalog: (input) =>
      pure.fetchCatalog({
        ...input,
        load: Effect.gen(function* () {
          if (state.blockModels) {
            yield* Deferred.succeed(modelsEntered, undefined);
            yield* Deferred.await(modelsRelease);
          }
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
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("仅允许版本探针");
      expect(command.args.at(-1)).toBe("--version");
      commands.push(command);
      const current = { ...state },
        pid = commands.length;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized.push(pid);
        }),
      );
      if (current.blockVersion) yield* Deferred.succeed(versionEntered, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(current.code)),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromEffect(
          (current.blockVersion ? Deferred.await(versionRelease) : Effect.void).pipe(
            Effect.as(new TextEncoder().encode(current.stdout)),
          ),
        ),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const config = {
    ...(yield* decodeSettings({ command: 'fixture-agent --label "a b"' })),
    customModels: ["model"],
  };
  const create = (
    id: string,
    scope: Scope.Scope,
    models = config.customModels,
    account = "first",
  ) =>
    GenericAcpDriver.create({
      instanceId: ProviderInstanceId.make(id),
      displayName: id,
      enabled: true,
      environment: [{ name: "ACCOUNT", value: account, sensitive: false }],
      config: { ...config, customModels: models },
      catalog,
      nativeCatalog: observed,
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, "/actual-cwd"),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const firstScope = yield* Scope.make(),
    secondScope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
  yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
  const first = yield* create("first", firstScope),
    second = yield* create("second", secondScope, [" model ", "model"]);
  const call = (which = first) =>
    which.snapshot.refresh.pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, "/actual-cwd"),
    );
  yield* Effect.all([call(first), call(second)], { concurrency: "unbounded" });
  controllers.length = 0;
  finalized.length = 0;
  commands.length = 0;
  return {
    call,
    first,
    second,
    firstScope,
    secondScope,
    controllers,
    commands,
    finalized,
    state,
    config,
    create,
    modelsEntered,
    modelsRelease,
    versionEntered,
    versionRelease,
  };
});

it.layer(layer)("通用 ACP 完整目录加载", (it) => {
  it.effect("目录三秒后版本只剩五秒，跨实例晚加入不续时且超时后恢复", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockModels = true;
      f.state.blockVersion = true;
      const first = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelsEntered);
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.succeed(f.modelsRelease, undefined);
      yield* Deferred.await(f.versionEntered);
      yield* TestClock.adjust("2 seconds");
      const second = yield* f.call(f.second).pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust(0);
      yield* TestClock.adjust("3 seconds");
      const a = yield* Fiber.join(first),
        b = yield* Fiber.join(second);
      expect(a.message).toContain("8000ms");
      expect(b.message).toContain("8000ms");
      expect(b.models.map((m) => m.slug)).toEqual(["default", "model"]);
      expect(b.instanceId).toBe("second");
      expect(b.checkedAt).toBe(DateTime.formatIso(yield* DateTime.now));
      expect(a.installed).toBe(true);
      expect(f.controllers).toHaveLength(1);
      expect(f.controllers[0]?.signal.aborted).toBe(true);
      expect(f.finalized).toEqual([1]);
      f.state.blockModels = false;
      f.state.blockVersion = false;
      expect((yield* f.call()).status).toBe("ready");
    }),
  );
  for (const all of [false, true])
    it.effect(`${all ? "最后" : "首个"}实例作用域关闭遵守共享探针所有权`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blockVersion = true;
        const a = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(f.versionEntered);
        const b = yield* f.call(f.second).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(0);
        yield* Scope.close(f.firstScope, Exit.void);
        expect(Exit.isFailure(yield* Fiber.await(a))).toBe(true);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        if (all) {
          yield* Scope.close(f.secondScope, Exit.void);
          expect(Exit.isFailure(yield* Fiber.await(b))).toBe(true);
        } else {
          yield* Deferred.succeed(f.versionRelease, undefined);
          expect((yield* Fiber.join(b)).instanceId).toBe("second");
        }
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual([1]);
      }),
    );
  it.effect("执行冻结原生带空格参数与模型，环境变化只影响新实例", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockModels = true;
      const task = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.modelsEntered);
      f.config.command = "late-command";
      f.config.customModels.push("late-model");
      yield* Deferred.succeed(f.modelsRelease, undefined);
      expect((yield* Fiber.join(task)).models.map((m) => m.slug)).toEqual(["default", "model"]);
      expect(f.commands[0]?.args).toEqual(["--label", "a b", "--version"]);
      expect(f.commands[0]?.options).toMatchObject({
        cwd: "/actual-cwd",
        extendEnv: false,
        forceKillAfter: "2 seconds",
        env: { ACCOUNT: "first" },
      });
    }),
  );
  it.effect("失败与不支持版本参数保留原来的就绪判别，顺序刷新重新检查", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.code = 2;
      f.state.stdout = "E404 Not Found";
      expect((yield* f.call()).status).toBe("error");
      f.state.stdout = "unknown option --version";
      expect((yield* f.call()).status).toBe("ready");
      f.state.code = 0;
      f.state.stdout = "new-output";
      expect((yield* f.call()).message).toContain("new-output");
      expect(f.commands).toHaveLength(3);
    }),
  );
  it.effect("不同环境不能加入旧探针", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockVersion = true;
      const old = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(f.versionEntered);
      f.state.blockVersion = false;
      f.state.stdout = "different-account";
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const other = yield* f.create("other", scope, ["model"], "other");
      expect((yield* f.call(other)).message).toContain("different-account");
      yield* Deferred.succeed(f.versionRelease, undefined);
      expect((yield* Fiber.join(old)).message).not.toContain("different-account");
      expect(f.commands.some((c) => c.options.env?.ACCOUNT === "other")).toBe(true);
    }),
  );
  it.effect("手动强刷新不加入另一实例的自动普通检查", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blockVersion = true;
      f.state.stdout = "ordinary-old";
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      yield* f.create("automatic", scope);
      yield* Deferred.await(f.versionEntered);
      f.state.blockVersion = false;
      f.state.stdout = "forced-new";
      expect((yield* f.call()).message).toContain("forced-new");
      expect(f.controllers).toHaveLength(2);
      expect(f.controllers[0]?.signal.aborted).toBe(false);
      expect(f.controllers[1]?.signal.aborted).toBe(true);
      yield* Scope.close(scope, Exit.void);
      expect(f.controllers[0]?.signal.aborted).toBe(true);
    }),
  );
});
