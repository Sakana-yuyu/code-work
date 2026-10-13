import { ProviderInstanceId } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
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
