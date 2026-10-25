import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";
import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@codework/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNativeProviderCatalog } from "../NativeProviderCatalog.ts";

import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { KimiDriver } from "./KimiDriver.ts";

const driverTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-kimi-driver-" }).pipe(
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

it.layer(driverTestLayer)("Kimi Driver 路由目录", (it) => {
  it.effect("两个等价实例共享路由准备，但发布各自身份；重建代次更新模型", () =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      let current = routedSettings(yield* service.getSettings, "first-model"),
        reads = 0;
      const settings = {
        ...service,
        getSettings: Effect.sync(() => {
          reads++;
          return current;
        }),
      };
      const native = yield* makeNativeProviderCatalog();
      const commands: ChildProcess.StandardCommand[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw Error("仅允许版本探针");
          commands.push(command);
          expect(command.args).toEqual(["--version"]);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(commands.length),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("kimi 0.41.0")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const create = (id: string, revision: string) =>
        KimiDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          environment: [],
          enabled: true,
          config: {
            ...KimiDriver.defaultConfig(),
            binaryPath: "fixture-kimi",
            routeThroughByok: true,
            byokSourceInstanceId: ProviderInstanceId.make("source"),
          },
          nativeCatalog: native,
          catalogRevision: revision,
        }).pipe(
          Effect.provideService(ServerSettingsService, settings),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
      const first = yield* create("first", "one"),
        second = yield* create("second", "one");
      yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      const before = reads,
        probes = commands.length;
      const snapshots = yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      expect(snapshots.map((s) => s.instanceId)).toEqual(["first", "second"]);
      expect(
        snapshots.every(
          (s) =>
            s.models.some((m) => m.slug === "first-model") &&
            s.auth.type === "byok" &&
            s.status === "ready",
        ),
      ).toBe(true);
      expect(commands.length - probes).toBe(1);
      expect(reads - before).toBe(9);
      current = routedSettings(current, "next-model");
      const next = yield* create("next", "two");
      expect((yield* next.snapshot.refresh).models.map((m) => m.slug)).toEqual(["next-model"]);
    }),
  );
});
