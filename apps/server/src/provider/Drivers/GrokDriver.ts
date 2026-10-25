import {
  GrokSettings,
  ProviderDriverKind,
  type ServerProvider,
  ServerSettingsError,
} from "@codework/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { ChildProcessSpawner } from "effect/process";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeGrokTextGeneration } from "../../textGeneration/GrokTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeNativeProviderCatalog } from "../NativeProviderCatalog.ts";
import {
  BYOK_GATEWAY_TOKEN_ENV,
  prepareRoutedProviderSnapshot,
  applyRoutedProviderAvailability,
  routedServerProviderModels,
  ensureGatewayToken,
  gatewayAdapterRoutes,
  gatewayOrigin,
  grokGatewayConfigBlock,
  mergeGrokManagedConfig,
} from "../byok/modelGateway.ts";
import { makeGrokAdapter } from "../Layers/GrokAdapter.ts";
import {
  buildInitialGrokProviderSnapshot,
  fetchGrokCatalog,
  enrichGrokSnapshot,
} from "../Layers/GrokProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { isDefaultGrokHome, resolveGrokHome } from "../grokHome.ts";
import {
  acquireGrokHomeAccess,
  claimGrokHomeConfiguration,
  resolveGrokHomePath,
} from "../GrokHomeAccess.ts";
import {
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
    // x.ai ships per-platform installer scripts (no npm) — the official
    // one-liners from x.ai/cli, verbatim per platform.
    install: {
      lockKey: "grok-installer",
      win32: {
        executable: "powershell",
        args: ["-NoProfile", "-Command", "irm https://x.ai/cli/install.ps1 | iex"],
      },
      posix: {
        executable: "bash",
        args: ["-c", "curl -fsSL https://x.ai/cli/install.sh | bash"],
      },
    },
  }),
);

export type GrokDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSecretStore
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config: suppliedConfig,
    nativeCatalog,
    catalogRevision,
  }) =>
    Effect.gen(function* () {
      const config = { ...suppliedConfig, customModels: [...suppliedConfig.customModels] };
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const { cwd } = serverConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const secretStore = yield* ServerSecretStore;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const nativeProviderCatalog = nativeCatalog ?? (yield* makeNativeProviderCatalog());
      const inheritedEnv = mergeProviderInstanceEnvironment(environment);
      const routed = config.routeThroughByok === true;
      const requestedHome = resolveGrokHome({
        stateDir: serverConfig.stateDir,
        instanceId,
        routed,
        explicitHome: inheritedEnv.GROK_HOME,
      });
      const grokHome = yield* resolveGrokHomePath(requestedHome).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "无法解析 Grok 配置目录。",
              cause,
            }),
        ),
      );
      const personalHome = yield* resolveGrokHomePath(
        resolveGrokHome({
          stateDir: serverConfig.stateDir,
          instanceId: "grok",
          routed: false,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "无法解析 Grok 个人目录。",
              cause,
            }),
        ),
      );
      const personal = isDefaultGrokHome(grokHome) || grokHome === personalHome;
      if (routed && personal) {
        return yield* new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId,
          detail: "Grok 代理接管需要独立 GROK_HOME，不能写入个人默认账号目录。",
        });
      }
      if (!personal)
        yield* claimGrokHomeConfiguration(grokHome, {
          routed,
          ...(routed
            ? {
                source: config.byokSourceInstanceId,
                gatewayOrigin: gatewayOrigin(serverConfig.port),
              }
            : {}),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "GrokHomeConflict"
                    ? cause.message
                    : "无法取得 Grok 目录配置所有权。",
                cause,
              }),
          ),
        );
      const baseProcessEnv = { ...inheritedEnv, GROK_HOME: grokHome };
      // The grok CLI reads the gateway key from the env var that the managed
      // config.toml block references via `env_key`.
      const processEnv = routed
        ? {
            ...baseProcessEnv,
            [BYOK_GATEWAY_TOKEN_ENV]: yield* ensureGatewayToken(secretStore),
          }
        : baseProcessEnv;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      // 官方 GROK_HOME 同时隔离配置、认证和会话；只维护隔离目录中的模型块。
      const reconcileGrokRoutedConfigFile = Effect.gen(function* () {
        if (!personal) yield* acquireGrokHomeAccess(grokHome);
        const configFilePath = pathService.join(grokHome, "config.toml");
        const existing = yield* fileSystem
          .readFileString(configFilePath)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(undefined as string | undefined)
                : Effect.fail(error),
            ),
          );
        // 个人目录只读；内容参与目录身份，手工修改配置也不会误命中旧结果。
        if (personal) return { configFileContents: existing };
        if (existing === undefined && effectiveConfig.routeThroughByok !== true) return {};
        const currentSettings = effectiveConfig.routeThroughByok
          ? yield* serverSettings.getSettings
          : undefined;
        const managedBlock = currentSettings
          ? grokGatewayConfigBlock(
              gatewayOrigin(serverConfig.port),
              gatewayAdapterRoutes(currentSettings, effectiveConfig.byokSourceInstanceId),
              effectiveConfig.byokSourceInstanceId,
            )
          : null;
        const merged = mergeGrokManagedConfig(existing, managedBlock);
        if (merged !== (existing ?? "")) {
          yield* writeFileStringAtomically({ filePath: configFilePath, contents: merged }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, pathService),
          );
        }
        return {
          configFileContents: merged,
          ...(currentSettings
            ? {
                // 复用本轮路由快照，不在目录结束后另读设置；共享结果不携带首实例身份。
                mapSnapshot: (snapshot: ServerProviderDraft): ServerProviderDraft => {
                  const mapped = applyRoutedProviderAvailability({
                    ...stampIdentity(snapshot),
                    models: routedServerProviderModels(
                      currentSettings,
                      "openai",
                      effectiveConfig.byokSourceInstanceId,
                      snapshot.models,
                    ),
                    auth: { status: "authenticated" as const, type: "byok", label: "BYOK Gateway" },
                  });
                  const { message: _oldMessage, ...base } = snapshot;
                  return {
                    ...base,
                    models: mapped.models,
                    auth: mapped.auth,
                    status: mapped.status,
                    ...(mapped.message === undefined ? {} : { message: mapped.message }),
                  };
                },
              }
            : {}),
        };
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
        Effect.provideService(HostProcessPlatform, platform),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "无法保存 Grok 独立代理配置。",
              cause,
            }),
        ),
      );
      yield* reconcileGrokRoutedConfigFile.pipe(Effect.scoped);

      const adapter = yield* makeGrokAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);

      // 先更新实际模型路由，再用写入后的配置读取目录；键不选择执行环境。
      const checkProvider = fetchGrokCatalog({
        settings: effectiveConfig,
        environment: processEnv,
        skillsWorkingDirectory: cwd,
        nativeCatalog: nativeProviderCatalog,
        preparationIdentity: {
          grokHome,
          routed,
          source: effectiveConfig.byokSourceInstanceId,
          gatewayOrigin: gatewayOrigin(serverConfig.port),
          catalogRevision,
        },
        prepare: () => reconcileGrokRoutedConfigFile,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath: pathService.join(grokHome, "config.toml"),
              operation: "normalize",
              providerInstanceId: instanceId,
              cause: cause.cause,
            }),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGrokProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
            Effect.flatMap((snapshot) =>
              prepareRoutedProviderSnapshot(snapshot, effectiveConfig, serverSettings.getSettings),
            ),
          ),
        checkProvider,
        usesCatalogCache: true,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichGrokSnapshot({
            snapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Grok snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
