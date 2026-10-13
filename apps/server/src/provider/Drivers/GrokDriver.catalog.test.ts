import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsError,
  type ServerSettings,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
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
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { resolveGrokHome } from "../grokHome.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GrokDriver } from "./GrokDriver.ts";

const driverTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-grok-driver-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("目录不能请求上游模型")),
  ),
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

const routedSettings = (settings: ServerSettings, modelId: string): ServerSettings => ({
  ...settings,
  providerInstances: {
    [ProviderInstanceId.make("source")]: {
      driver: ProviderDriverKind.make("byok"),
      enabled: true,
      config: {
        enabled: true,
        adapters: [
          {
            id: modelId,
            displayName: "测试路由",
            groupName: "",
            protocol: "openai",
            baseURL: "https://example.invalid/v1",
            apiKey: "synthetic",
            apiKeyRedacted: false,
            modelId,
            contextWindowTokens: 128000,
            supplierID: "custom",
          },
        ],
      },
    },
  },
});

it.layer(driverTestLayer)("Grok Driver 完整目录边界", (it) => {
  it.effect("默认个人目录只读取配置，初始化和刷新都不写入账号目录", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const home = resolveGrokHome({
        stateDir: config.stateDir,
        instanceId: "grok",
        routed: false,
      });
      const configFile = path.join(home, "config.toml");
      let reads = 0;
      const fixtureFs = {
        ...fs,
        readFileString: (file: string) =>
          file === configFile
            ? Effect.sync(() => {
                reads++;
                return "personal = true";
              })
            : fs.readFileString(file),
        writeFileString: (file: string, contents: string) =>
          file.startsWith(home + path.sep)
            ? Effect.die("禁止写入个人目录")
            : fs.writeFileString(file, contents),
        rename: (from: string, to: string) =>
          to.startsWith(home + path.sep) ? Effect.die("禁止替换个人配置") : fs.rename(from, to),
      };
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: GrokDriver.defaultConfig(),
      }).pipe(Effect.provideService(FileSystem.FileSystem, fixtureFs));
      expect((yield* instance.snapshot.refresh).instanceId).toBe("grok");
      expect(reads).toBeGreaterThanOrEqual(2);
    }),
  );
  it.effect("路由准备和模型覆盖使用同一轮设置，实例身份独立且不创建会话", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      let current = routedSettings(yield* settings.getSettings, "first-model");
      let reads = 0;
      const observedSettings = {
        ...settings,
        getSettings: Effect.sync(() => {
          reads++;
          return current;
        }),
      };
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-route-" });
      const native = yield* makeNativeProviderCatalog();
      let preparations = 0;
      const observedFs = {
        ...fs,
        readFileString: (file: string) => {
          if (file === path.join(home, "config.toml")) preparations++;
          return fs.readFileString(file);
        },
      };
      const create = (id: string, revision: string) =>
        GrokDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          enabled: false,
          environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
          config: {
            ...GrokDriver.defaultConfig(),
            routeThroughByok: true,
            byokSourceInstanceId: ProviderInstanceId.make("source"),
          },
          nativeCatalog: native,
          catalogRevision: revision,
        }).pipe(
          Effect.provideService(ServerSettingsService, observedSettings),
          Effect.provideService(FileSystem.FileSystem, observedFs),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("停用目录不能启动进程")),
          ),
        );
      const first = yield* create("first", "one");
      const second = yield* create("second", "one");
      yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      const before = reads;
      const preparedBefore = preparations;
      const snapshots = yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      expect(snapshots.map((s) => s.instanceId)).toEqual(["first", "second"]);
      expect(
        snapshots.every(
          (s) => s.auth.type === "byok" && s.models.some((m) => m.subProvider === "first-model"),
        ),
      ).toBe(true);
      // 每个 managed 外壳读开始/准入/发布/补充发布设置；共享路由准备只再读一次。
      expect(reads - before).toBe(9);
      expect(preparations - preparedBefore).toBe(1);
      current = routedSettings(current, "next-model");
      const next = yield* create("next", "two");
      const refreshed = yield* next.snapshot.refresh;
      expect(refreshed.models.some((m) => m.subProvider === "next-model")).toBe(true);
      expect(yield* fs.readFileString(path.join(home, "config.toml"))).toContain("next-model");
    }),
  );

  it.effect("共享准备失败保留原 cause，并在每个等待者边界恢复自己的错误身份", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-error-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let fail = false;
      let reads = 0;
      const observedFs = {
        ...fs,
        readFileString: (file: string) =>
          file === path.join(home, "config.toml") && fail
            ? Effect.gen(function* () {
                reads++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* fs.readFileString(home);
              })
            : fs.readFileString(file),
      };
      const native = yield* makeNativeProviderCatalog();
      const create = (id: string) =>
        GrokDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          enabled: false,
          environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
          config: GrokDriver.defaultConfig(),
          nativeCatalog: native,
        }).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
      const first = yield* create("error-first");
      const second = yield* create("error-second");
      yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      fail = true;
      const a = yield* first.snapshot.refresh.pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      const b = yield* second.snapshot.refresh.pipe(
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const results = [yield* Fiber.join(a), yield* Fiber.join(b)];
      expect(results.every(Exit.isFailure)).toBe(true);
      // managed 的公开刷新沿用 never 错误契约，领域错误由 defect 承载。
      const errors = results
        .filter(Exit.isFailure)
        .map((r) => Cause.squash(r.cause))
        .filter(Schema.is(ServerSettingsError));
      expect(errors.map((e) => e.providerInstanceId)).toEqual(["error-first", "error-second"]);
      expect(
        errors.every(
          (e) =>
            e._tag === "ServerSettingsError" &&
            e.operation === "normalize" &&
            e.settingsPath === path.join(home, "config.toml"),
        ),
      ).toBe(true);
      expect(errors[0]?.cause).toBe(errors[1]?.cause);
      expect(reads).toBe(1);
      fail = false;
      expect((yield* second.snapshot.refresh).instanceId).toBe("error-second");
    }),
  );

  it.effect("Driver 的准备阶段占用同一个十五秒预算，超时后仍能恢复", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-budget-" });
      const entered = yield* Deferred.make<void>();
      let block = false;
      const observedFs = {
        ...fs,
        readFileString: (file: string) =>
          file === path.join(home, "config.toml") && block
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : fs.readFileString(file),
      };
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("budget"),
        displayName: undefined,
        enabled: false,
        environment: [{ name: "GROK_HOME", value: home, sensitive: false }],
        config: GrokDriver.defaultConfig(),
      }).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
      block = true;
      const refresh = yield* instance.snapshot.refresh.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      expect((yield* Fiber.join(refresh)).message).toContain("15000ms");
      block = false;
      expect((yield* instance.snapshot.refresh).message).not.toContain("15000ms");
    }),
  );
});
