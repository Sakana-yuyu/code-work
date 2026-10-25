import { ProviderInstanceId } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeNativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";

const driverTestLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-antigravity-driver-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
);
it.layer(driverTestLayer)("Antigravity Driver 完整目录", (it) => {
  it.effect("等价实例共用完整检查而各自发布身份，不同配置独立执行", () =>
    Effect.gen(function* () {
      const native = yield* makeNativeProviderCatalog();
      const commands: ChildProcess.StandardCommand[] = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw Error("只允许版本探针");
          expect(command.args).toEqual(["--version"]);
          commands.push(command);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(commands.length),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make("agy 1.1.27")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const create = (id: string, models = ["model"]) =>
        AntigravityDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          environment: [],
          enabled: false,
          config: {
            ...AntigravityDriver.defaultConfig(),
            binaryPath: "fixture-agy",
            customModels: models,
          },
          nativeCatalog: native,
        }).pipe(
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
      const first = yield* create("first"),
        second = yield* create("second", [" model ", "model"]);
      yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      const before = commands.length;
      const results = yield* Effect.all([first.snapshot.refresh, second.snapshot.refresh], {
        concurrency: "unbounded",
      });
      expect(results.map((s) => s.instanceId)).toEqual(["first", "second"]);
      expect(
        results.every(
          (s) => s.installed && s.status === "disabled" && s.models[0]?.slug === "model",
        ),
      ).toBe(true);
      expect(commands.length - before).toBe(1);
      expect(first.adapter).not.toBe(second.adapter);
      const next = yield* create("next", ["other-model"]);
      expect((yield* next.snapshot.refresh).models.map((m) => m.slug)).toEqual(["other-model"]);
    }),
  );
});
