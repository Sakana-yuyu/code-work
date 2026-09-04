import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "codework-server-settings-multica-secrets-test-",
        }),
      ),
    ),
  );

// 新版服务端会校验并发前置条件；旧版会安全地忽略这一扩展字段。
const multicaCreatePreconditions = (instanceIds: ReadonlyArray<ProviderInstanceId>) => ({
  multicaProviderInstancePreconditions: instanceIds.map((instanceId) => ({
    instanceId,
    expectedRevision: null,
  })),
});

it.layer(NodeServices.layer)("Multica 凭据持久化", (it) => {
  it.effect("将 Cookie 与 X-Auth 类 Header 的环境变量强制存入 secret store", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const headerNames = ["Cookie", "X-Auth", "X-Authorization"] as const;
      const instanceIds = headerNames.map((headerName) =>
        ProviderInstanceId.make(`multica_${headerName.toLowerCase().replace(/[^a-z]/gu, "_")}`),
      );
      const providerInstances = Object.fromEntries(
        headerNames.map((headerName, index) => {
          const instanceId = instanceIds[index]!;
          return [
            instanceId,
            {
              driver: ProviderDriverKind.make("multica"),
              environment: [{ name: "MULTICA_TOKEN", value: "fixture-secret", sensitive: false }],
              config: {
                runtimeId: `multica:daemon-${index}:runtime-${index}`,
                daemonId: `daemon-${index}`,
                daemonRuntimeId: `runtime-${index}`,
                baseUrl: "http://127.0.0.1:9000",
                headers: [{ headerName, environmentVariable: "MULTICA_TOKEN" }],
                assigneeRoutes: [],
              },
            },
          ];
        }),
      );

      const next = yield* serverSettings.updateSettings({
        providerInstances,
        ...multicaCreatePreconditions(instanceIds),
      });

      for (const instanceId of instanceIds) {
        assert.deepEqual(next.providerInstances[instanceId]?.environment, [
          { name: "MULTICA_TOKEN", value: "fixture-secret", sensitive: true, valueRedacted: true },
        ]);
      }

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "fixture-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw).providerInstances as Record<
        string,
        { readonly environment?: unknown }
      >;
      for (const instanceId of instanceIds) {
        assert.deepEqual(persisted[instanceId]?.environment, [
          { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
        ]);
      }
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
