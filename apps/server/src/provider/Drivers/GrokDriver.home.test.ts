import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GrokDriver } from "./GrokDriver.ts";
import { resolveGrokHome } from "../grokHome.ts";

const driverTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-grok-home-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("目录不能请求真实上游")),
  ),
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

/** 内存文件与探针阶段都同步登记，避免操作系统调度掩盖写入/消费交错。 */
const makeFixture = Effect.fn("makeGrokSharedHomeFixture")(function* (personalAlias = false) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const base = yield* settings.getSettings;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-shared-" });
  const configFile = path.join(home, "config.toml");
  const serverConfig = yield* ServerConfig;
  const personalHome = resolveGrokHome({
    stateDir: serverConfig.stateDir,
    instanceId: "grok",
    routed: false,
  });
  let contents = "personal_flag = true\n";
  const temporary = new Map<string, string>();
  let temporaryId = 0;
  const fixtureFs = {
    ...fs,
    realPath: (file: string) =>
      Effect.succeed(personalAlias && file === home ? personalHome : path.resolve(file)),
    readFileString: (file: string) =>
      file === configFile ? Effect.sync(() => contents) : fs.readFileString(file),
    makeDirectory: () => Effect.void,
    makeTempDirectoryScoped: () => Effect.succeed(path.join(home, `temp-${++temporaryId}`)),
    writeFileString: (file: string, value: string) =>
      Effect.sync(() => {
        temporary.set(file, value);
      }),
    rename: (from: string, to: string) =>
      Effect.sync(() => {
        expect(to).toBe(configFile);
        contents = temporary.get(from)!;
        temporary.delete(from);
      }),
  };
  const routed = (model: string) => ({
    driver: ProviderDriverKind.make("byok"),
    enabled: true,
    config: {
      enabled: true,
      adapters: [
        {
          id: model,
          displayName: model,
          protocol: "openai",
          baseURL: "https://fixture.invalid/v1",
          apiKey: "synthetic",
          modelId: model,
        },
      ],
    },
  });
  const fixtureSettings = {
    ...settings,
    getSettings: Effect.succeed({
      ...base,
      providerInstances: { "source-a": routed("model-a"), "source-b": routed("model-b") },
    }),
  };
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const secondOwner = yield* Deferred.make<void>();
  const consumed: string[] = [];
  const finalized: number[] = [];
  let probes = 0;
  let armed = false;
  let blocked = false;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const id = ++probes;
      const block = armed && !blocked;
      if (block) blocked = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          finalized.push(id);
        }),
      );
      const stdout = Stream.fromEffect(
        Effect.gen(function* () {
          if (block) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          consumed.push(contents);
          return new TextEncoder().encode("grok-cli 1.0.45\n");
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(id),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        // 版本失败结束检查；仍覆盖从准备到探针读取配置和资源清理的完整区间。
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const native = yield* makeNativeProviderCatalog();
  let owners = 0;
  const observedNative: NativeProviderCatalog = {
    ...native,
    fetchCatalogWithError: (input) =>
      native.fetchCatalogWithError({
        ...input,
        load: (controller) =>
          Effect.gen(function* () {
            if (armed && ++owners === 2) yield* Deferred.succeed(secondOwner, undefined);
            return yield* input.load(controller);
          }),
      }),
  };
  const create = (id: string, source: string, routed = true, enabled = true) =>
    GrokDriver.create({
      instanceId: ProviderInstanceId.make(id),
      displayName: id,
      enabled,
      environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
      config: {
        ...GrokDriver.defaultConfig(),
        routeThroughByok: routed,
        byokSourceInstanceId: ProviderInstanceId.make(source),
      },
      nativeCatalog: observedNative,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fixtureFs),
      Effect.provideService(ServerSettingsService, fixtureSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
  return {
    create,
    entered,
    release,
    secondOwner,
    consumed,
    finalized,
    contents: () => contents,
    probes: () => probes,
    arm: Effect.sync(() => {
      armed = true;
      probes = 0;
      consumed.length = 0;
      finalized.length = 0;
    }),
  };
});

it.layer(driverTestLayer)("Grok 共享可写 home", (it) => {
  it.effect("显式目录别名指向个人 home 时拒绝代理写入，不访问真实个人配置", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(true);
      const result = yield* fixture.create("alias", "source-a").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.detail).toContain("不能写入个人默认账号目录");
      expect(fixture.contents()).toBe("personal_flag = true\n");
      expect(fixture.probes()).toBe(0);
    }),
  );
  it.effect("不同路由 owner 的配置写入与 CLI 消费串行，模型仍属于各自实例", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.create("first", "source-a");
      const second = yield* fixture.create("second", "source-b");
      yield* Effect.yieldNow;
      yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      yield* fixture.arm;
      const a = yield* first.snapshot.refresh.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(fixture.entered);
      const b = yield* second.snapshot.refresh.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(fixture.secondOwner);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(fixture.release, undefined);
      const results = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(fixture.consumed[0]).toContain("model-a");
      expect(fixture.consumed[0]).not.toContain("model-b");
      expect(fixture.consumed[1]).toContain("model-b");
      expect(results.map((snapshot) => snapshot.instanceId)).toEqual(["first", "second"]);
      expect(results[0]!.models.some((model) => model.subProvider === "model-a")).toBe(true);
      expect(results[1]!.models.some((model) => model.subProvider === "model-b")).toBe(true);
      expect(fixture.contents()).toContain("model-b");
      expect(fixture.finalized).toEqual([1, 2]);
    }),
  );

  for (const routed of [true, false]) {
    it.effect(`创建${routed ? "另一代理" : "非代理"}实例不能改写正在消费的配置`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        const first = yield* fixture.create("first", "source-a");
        yield* Effect.yieldNow;
        yield* first.snapshot.refresh;
        yield* fixture.arm;
        const a = yield* first.snapshot.refresh.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(fixture.entered);
        const creating = yield* fixture
          .create("second", "source-b", routed, false)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(fixture.release, undefined);
        yield* Fiber.join(a);
        yield* Fiber.join(creating);
        expect(fixture.consumed[0]).toContain("model-a");
        expect(fixture.contents().includes("model-b")).toBe(routed);
        expect(fixture.contents()).toContain("personal_flag = true");
        expect(fixture.probes()).toBe(1);
        expect(fixture.finalized).toEqual([1]);
      }),
    );
  }
});
