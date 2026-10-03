// @effect-diagnostics nodeBuiltinImport:off - 驱动测试使用 NodeServices 提供临时文件系统。
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderInstanceId } from "@codework/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ZCodeDriver } from "./ZCodeDriver.ts";

describe("ZCodeDriver", () => {
  it.effect("禁用实例创建时不写受管配置也不释放 bundle", () =>
    Effect.gen(function* () {
      const testEpoch = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
      const writes = { file: 0, fileString: 0, copy: 0 };
      const fileSystemLayer = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return new Proxy(fileSystem, {
            get(target, property, receiver) {
              if (property === "writeFile") {
                return (...args: Parameters<typeof fileSystem.writeFile>) => {
                  writes.file += 1;
                  return fileSystem.writeFile(...args);
                };
              }
              if (property === "writeFileString") {
                return (...args: Parameters<typeof fileSystem.writeFileString>) => {
                  writes.fileString += 1;
                  return fileSystem.writeFileString(...args);
                };
              }
              if (property === "copy") {
                return (...args: Parameters<typeof fileSystem.copy>) => {
                  writes.copy += 1;
                  return fileSystem.copy(...args);
                };
              }
              return Reflect.get(target, property, receiver);
            },
          });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
      const secretStoreLayer = Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          get: () => Effect.succeed(Option.none()),
          set: () => Effect.void,
          create: () => Effect.void,
          getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
          remove: () => Effect.void,
        }),
      );
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("disabled ZCode must not call HTTP")),
      );
      const backgroundPolicyLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        reportClientActivity: () => Effect.void,
        removeRpcClient: () => Effect.void,
        reportHostPowerState: () => Effect.void,
        snapshot: Effect.succeed({
          hostPower: {
            source: "unknown",
            idle: "unknown",
            idleSeconds: null,
            locked: "unknown",
            suspended: false,
            onBattery: "unknown",
            lowPowerMode: "unknown",
            thermalState: "unknown",
            stale: true,
            updatedAt: testEpoch,
          },
          leases: [],
          activeForegroundLeaseCount: 0,
          activeScopeKeys: [],
          shouldRunOpportunisticWork: true,
          updatedAt: testEpoch,
        }),
        streamChanges: Stream.empty,
        hasDemand: () => Effect.succeed(true),
        shouldRunScopeWork: () => Effect.succeed(true),
        shouldRunOpportunisticWork: Effect.succeed(true),
      });
      const instance = yield* ZCodeDriver.create({
        instanceId: ProviderInstanceId.make("zcode-disabled"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: ZCodeDriver.defaultConfig(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            fileSystemLayer,
            ServerConfig.layerTest(process.cwd(), { prefix: "codework-zcode-driver-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
            ServerSettings.layerTest(),
            secretStoreLayer,
            httpClientLayer,
            backgroundPolicyLayer,
          ),
        ),
        Effect.scoped,
      );

      expect(instance.enabled).toBe(false);
      expect(writes).toEqual({ file: 0, fileString: 0, copy: 0 });
    }),
  );
});
