import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ServerSettingsError } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";
import { ServerSettingsOriginCompensationError } from "./serverSettingsOriginCas.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const providerEnvironmentSecretNameForTest = (instanceId: string, name: string) =>
  `provider-env-${Buffer.from(instanceId, "utf8").toString("base64url")}-${Buffer.from(name, "utf8").toString("base64url")}`;

const providerWithSecrets = (
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) => ({
  driver: ProviderDriverKind.make("codex"),
  environment: environment.map((variable) => ({ ...variable, sensitive: true })),
  config: {},
});

it.layer(NodeServices.layer)("ServerSettings Secret 补偿边界", (it) => {
  it.effect("Secret 准备中途失败时补偿已写项并保留主失败分类", () => {
    const instanceId = ProviderInstanceId.make("codex_prepare_compensation");
    const firstName = providerEnvironmentSecretNameForTest(instanceId, "FIRST_TOKEN");
    const secondName = providerEnvironmentSecretNameForTest(instanceId, "SECOND_TOKEN");
    const values = new Map<string, Uint8Array>();
    const primaryFailure = new ServerSecretStore.SecretStorePersistError({
      resource: `secret ${secondName}`,
      cause: new Error("第二个 Secret 写入失败"),
    });
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
      set: (name, value) =>
        name === secondName
          ? Effect.fail(primaryFailure)
          : Effect.sync(() => {
              values.set(name, Uint8Array.from(value));
            }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      getOrCreateRandom: () => Effect.succeed(new Uint8Array([1])),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    });
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(
        Layer.fresh(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "codework-server-settings-prepare-compensation-",
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const error = yield* serverSettings
        .updateSettings({
          providerInstances: {
            [instanceId]: providerWithSecrets([
              { name: "FIRST_TOKEN", value: "first-value" },
              { name: "SECOND_TOKEN", value: "second-value" },
            ]),
          },
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, ServerSettingsError);
      assert.equal(error.operation, "write-secret");
      assert.strictEqual(error.cause, primaryFailure);
      assert.isFalse(values.has(firstName));
      assert.isFalse(values.has(secondName));
      assert.isFalse(yield* fileSystem.exists(serverConfig.settingsPath));
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("文件写入与 Secret 补偿同时失败时返回 compensate-secret", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const instanceId = ProviderInstanceId.make("codex_write_compensation");
      const variableName = "API_TOKEN";
      const secretName = providerEnvironmentSecretNameForTest(instanceId, variableName);
      const originalSecret = textEncoder.encode("old-secret");
      const values = new Map<string, Uint8Array>([[secretName, originalSecret]]);
      const compensationFailure = new ServerSecretStore.SecretStorePersistError({
        resource: `secret ${secretName}`,
        cause: new Error("Secret 补偿写回失败"),
      });
      let targetSetCalls = 0;
      const store = ServerSecretStore.ServerSecretStore.of({
        get: (name) =>
          Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
        set: (name, value) => {
          if (name === secretName) {
            targetSetCalls += 1;
            if (targetSetCalls === 2) return Effect.fail(compensationFailure);
          }
          return Effect.sync(() => {
            values.set(name, Uint8Array.from(value));
          });
        },
        create: (name, value) =>
          Effect.sync(() => {
            values.set(name, Uint8Array.from(value));
          }),
        getOrCreateRandom: () => Effect.succeed(new Uint8Array([1])),
        remove: (name) =>
          Effect.sync(() => {
            values.delete(name);
          }),
      });
      const renameFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: "settings.json",
        description: "拒绝测试中的 settings.json 原子替换。",
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        rename: (from, to) =>
          path.basename(String(to)) === "settings.json"
            ? Effect.fail(renameFailure)
            : fileSystem.rename(from, to),
      });
      const settingsLayer = ServerSettingsModule.layer.pipe(
        Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, store)),
        Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), {
              prefix: "codework-server-settings-write-compensation-",
            }),
          ),
        ),
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, failingFileSystem)),
      );

      return yield* Effect.gen(function* () {
        const serverConfig = yield* ServerConfig.ServerConfig;
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const originalRaw = "{}\n";
        yield* fileSystem.writeFileString(serverConfig.settingsPath, originalRaw);

        const error = yield* serverSettings
          .updateSettings({
            providerInstances: {
              [instanceId]: providerWithSecrets([{ name: variableName, value: "new-secret" }]),
            },
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, ServerSettingsError);
        assert.equal(error.operation, "compensate-secret");
        assert.instanceOf(error.cause, ServerSettingsOriginCompensationError);
        if (error.cause.primaryFailure._tag !== "ServerSettingsOriginError") {
          throw new Error("文件写入失败应保留 ServerSettingsOriginError 主因。", {
            cause: error.cause.primaryFailure,
          });
        }
        assert.equal(error.cause.primaryFailure.operation, "write-origin");
        assert.instanceOf(error.cause.compensationFailure, ServerSettingsError);
        assert.equal(error.cause.compensationFailure.operation, "compensate-secret");
        assert.strictEqual(error.cause.compensationFailure.cause, compensationFailure);
        assert.equal(targetSetCalls, 2);
        assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), originalRaw);
        assert.equal(textDecoder.decode(values.get(secretName)), "new-secret");
      }).pipe(Effect.provide(settingsLayer));
    }),
  );
});
