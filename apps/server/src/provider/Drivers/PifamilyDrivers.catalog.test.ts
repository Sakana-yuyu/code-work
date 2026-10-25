import { ProviderInstanceId, ServerSettingsError } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { resolveZCodeDataDir } from "../zcode/zcodeByokConfig.ts";
import { encryptZCodeValue, zcodeCredentialsPath } from "../zcode/zcodeCredentials.ts";
import { OmpDriver, PiDriver } from "./PifamilyDrivers.ts";
import { ZCodeDriver } from "./ZCodeDriver.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const driverTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-pifamily-catalog-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest(),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("目录检查不能请求模型服务。")),
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

const createInput = (id: string, catalog?: CliProviderCatalog) => ({
  instanceId: ProviderInstanceId.make(id),
  displayName: id,
  environment: [{ name: "CATALOG_TEST_ACCOUNT", value: id, sensitive: false }],
  enabled: false,
  ...(catalog === undefined ? {} : { catalog }),
});

it.layer(driverTestLayer)("Pi 系 Driver 完整准备边界", (it) => {
  const checks = [
    {
      driverKind: PiDriver.driverKind,
      create: (id: string, nativeCatalog: NativeProviderCatalog) =>
        PiDriver.create({
          ...createInput(id),
          enabled: true,
          nativeCatalog,
          config: { ...PiDriver.defaultConfig(), binaryPath: "fixture-cli" },
        }),
    },
    {
      driverKind: OmpDriver.driverKind,
      create: (id: string, nativeCatalog: NativeProviderCatalog) =>
        OmpDriver.create({
          ...createInput(id),
          enabled: true,
          nativeCatalog,
          config: { ...OmpDriver.defaultConfig(), binaryPath: "fixture-cli" },
        }),
    },
    {
      driverKind: ZCodeDriver.driverKind,
      create: (id: string, nativeCatalog: NativeProviderCatalog) =>
        ZCodeDriver.create({
          ...createInput(id),
          enabled: true,
          nativeCatalog,
          config: { ...ZCodeDriver.defaultConfig(), binaryPath: "fixture-cli" },
        }),
    },
  ];
  for (const driver of checks) {
    for (const budget of [false, true]) {
      it.effect(
        `${driver.driverKind} ${budget ? "路由读取纳入十五秒预算" : "路由读取失败仍如实检查安装"}`,
        () =>
          Effect.gen(function* () {
            const service = yield* ServerSettingsService;
            const native = yield* makeNativeProviderCatalog();
            const entered = yield* Deferred.make<void>(),
              finalized = yield* Deferred.make<void>();
            let active = false,
              intercept = false,
              probes = 0;
            const observed: NativeProviderCatalog = {
              ...native,
              fetchCatalog: (input) =>
                native.fetchCatalog({
                  ...input,
                  load: (controller) =>
                    Effect.sync(() => {
                      active = true;
                    }).pipe(
                      Effect.andThen(input.load(controller)),
                      Effect.ensuring(
                        Effect.sync(() => {
                          active = false;
                        }),
                      ),
                    ),
                }),
            };
            const settings = {
              ...service,
              getSettings: Effect.gen(function* () {
                if (!active || !intercept) return yield* service.getSettings;
                if (!budget)
                  return yield* new ServerSettingsError({
                    settingsPath: "/fixture/settings.json",
                    operation: "read-file",
                    cause: "受控路由读取失败",
                  });
                yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }),
            };
            const spawner = ChildProcessSpawner.make((command) =>
              Effect.sync(() => {
                if (!ChildProcess.isStandardCommand(command)) throw Error("只允许版本命令");
                expect(command.args).toEqual(["--version"]);
                probes++;
                return ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(probes),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.encodeText(Stream.make("fixture 1.2.3")),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                });
              }),
            );
            const instance = yield* driver
              .create(`full-${driver.driverKind}`, observed)
              .pipe(
                Effect.provideService(ServerSettingsService, settings),
                Effect.provideService(HostProcessPlatform, "linux"),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              );
            yield* instance.snapshot.refresh;
            intercept = true;
            probes = 0;
            if (budget) {
              const refresh = yield* instance.snapshot.refresh.pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Deferred.await(entered);
              yield* TestClock.adjust("15 seconds");
              expect((yield* Fiber.join(refresh)).message).toContain("15000ms");
              yield* Deferred.await(finalized);
              expect(probes).toBe(0);
            } else {
              const refreshed = yield* instance.snapshot.refresh;
              expect(refreshed.installed).toBe(true);
              expect(refreshed.models).toEqual([]);
              expect(refreshed.status).toBe("warning");
              expect(probes).toBe(1);
            }
          }),
      );
    }
  }
  it.effect("ZCode 实际官方凭据读取在版本之后继续占用同一预算", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem,
        config = yield* ServerConfig;
      const instanceId = ProviderInstanceId.make("zcode-full-auth");
      const credentials = zcodeCredentialsPath(
        resolveZCodeDataDir({ stateDir: config.stateDir, instanceId }),
      );
      const entered = yield* Deferred.make<void>(),
        finalized = yield* Deferred.make<void>();
      let block = false;
      const fixtureFs = {
        ...fs,
        readFileString: (file: string) =>
          file === credentials && block
            ? Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Deferred.succeed(finalized, undefined));
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              })
            : fs.readFileString(file),
      };
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("zcode 1.2.3")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const instance = yield* ZCodeDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: {
          ...ZCodeDriver.defaultConfig(),
          binaryPath: "fixture-zcode",
          authMode: "official",
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fixtureFs),
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* instance.snapshot.refresh;
      block = true;
      const refresh = yield* instance.snapshot.refresh.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      const snapshot = yield* Fiber.join(refresh);
      expect(snapshot.message).toContain("15000ms");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.auth.status).toBe("unknown");
      yield* Deferred.await(finalized);
    }),
  );
});

const drivers = [
  {
    name: "Pi",
    create: (id: string, catalog?: CliProviderCatalog) =>
      PiDriver.create({ ...createInput(id, catalog), config: PiDriver.defaultConfig() }),
  },
  {
    name: "OhMyPi",
    create: (id: string, catalog?: CliProviderCatalog) =>
      OmpDriver.create({ ...createInput(id, catalog), config: OmpDriver.defaultConfig() }),
  },
  {
    name: "ZCode",
    create: (id: string, catalog?: CliProviderCatalog) =>
      ZCodeDriver.create({ ...createInput(id, catalog), config: ZCodeDriver.defaultConfig() }),
  },
];

it.layer(driverTestLayer)("Pi 系驱动目录接入", (it) => {
  for (const driver of drivers) {
    it.effect(`${driver.name} 跨实例共用目录，适配器独立且手动刷新绕过目录缓存`, () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const first = yield* driver.create(`${driver.name}-catalog-first`, catalog);
        const firstInitial = yield* first.snapshot.getSnapshot;
        const second = yield* driver.create(`${driver.name}-catalog-second`, catalog);
        const secondInitial = yield* second.snapshot.getSnapshot;
        expect(secondInitial.models).toBe(firstInitial.models);
        expect(secondInitial.instanceId).not.toBe(firstInitial.instanceId);
        expect(second.adapter).not.toBe(first.adapter);
        const refreshed = yield* first.snapshot.refresh;
        expect(refreshed.models).toEqual(firstInitial.models);
        expect(refreshed.models).not.toBe(firstInitial.models);
        const next = yield* driver.create(`${driver.name}-catalog-next`, catalog);
        expect((yield* next.snapshot.getSnapshot).models).toBe(refreshed.models);
        const privateInstance = yield* driver.create(`${driver.name}-catalog-private`);
        expect((yield* privateInstance.snapshot.getSnapshot).models).not.toBe(refreshed.models);
      }),
    );
  }

  it.effect("ZCode 目录复用期间仍读取当前官方凭据，版本探针不创建会话", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const catalog = yield* makeCliProviderCatalog();
      // 固定读取有效目录以隔离认证实时性；手动刷新失效由上面的驱动用例覆盖。
      const cachedCatalog: CliProviderCatalog = {
        fetchCatalog: (input) => catalog.fetchCatalog({ ...input, forceRefresh: false }),
      };
      const instanceId = ProviderInstanceId.make("zcode-catalog-auth");
      const credentialFile = zcodeCredentialsPath(
        resolveZCodeDataDir({ stateDir: serverConfig.stateDir, instanceId }),
      );
      const calls: Array<ChildProcess.StandardCommand> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("仅接受版本命令。");
          expect(command.args).toEqual(["--version"]);
          calls.push(command);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("zcode 1.2.3")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const instance = yield* ZCodeDriver.create({
        ...createInput(instanceId, cachedCatalog),
        enabled: true,
        config: {
          ...ZCodeDriver.defaultConfig(),
          authMode: "official",
          binaryPath: "catalog-zcode",
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      const refresh = instance.snapshot.refresh.pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      const beforeLogin = yield* refresh;
      expect(beforeLogin.installed).toBe(true);
      expect(beforeLogin.auth.status).toBe("unauthenticated");
      yield* fs.makeDirectory(path.dirname(credentialFile), { recursive: true });
      const writeAccount = (label: string) =>
        fs.writeFileString(
          credentialFile,
          encodeJson({
            "oauth:active_provider": encryptZCodeValue("zai"),
            "oauth:zai:user_info": encryptZCodeValue(encodeJson({ name: label })),
            "account-provider:coding-plan:account:zai-individual-coding-plan:api-key":
              encryptZCodeValue("synthetic-plan-key"),
          }),
        );
      yield* writeAccount("测试账号 A");
      const loggedIn = yield* refresh;
      expect(loggedIn.models).toBe(beforeLogin.models);
      expect(loggedIn.auth).toMatchObject({
        status: "authenticated",
        type: "zai",
        label: "测试账号 A",
      });
      yield* writeAccount("测试账号 B");
      const switched = yield* refresh;
      expect(switched.models).toBe(loggedIn.models);
      expect(switched.auth.label).toBe("测试账号 B");
      yield* fs.writeFileString(credentialFile, "{}");
      expect((yield* refresh).auth.status).toBe("unauthenticated");
      expect(calls.length).toBeGreaterThanOrEqual(4);
      expect(
        calls.every((command) => command.args.length === 1 && command.args[0] === "--version"),
      ).toBe(true);
    }),
  );
});
