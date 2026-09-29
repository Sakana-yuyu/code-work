/**
 * ZCodeDriver — ZCode CLI 供应商驱动（BYOK-only，同 Pi 的受管配置思路）。
 *
 *  1. 受管数据根（`ZCODE_DATA_BASE_DIR`）+ `provider_config.json`：只注册指向
 *     本地 BYOK 网关的个人 Provider，凭据物理隔离；
 *  2. 环境清洗（剥掉第三方供应商密钥与 ZCODE_* 配置指回变量）；
 *  3. 模型路由 / 快照 / 文本生成全部以 BYOK 源实例为权威；号池（本地 CLI
 *     账号）路由随网关路由一并发布。
 *
 * @module provider/Drivers/ZCodeDriver
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";

import {
  ByokSettings,
  ProviderDriverKind,
  ZCodeAgentSettings,
  type ServerProvider,
  type ServerSettings,
} from "@codework/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeByokTextGeneration } from "../../textGeneration/ByokTextGeneration.ts";
import {
  anthropicGatewayBase,
  ensureGatewayToken,
  gatewayAdapterRoutes,
  gatewayOrigin,
  openaiGatewayBase,
} from "../byok/modelGateway.ts";
import { pifamilyModelRoutes, type PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import { resolveZCodeSpawnTarget, zcodeSpawnEnv } from "../zcode/zcodeBundledRuntime.ts";
import {
  buildZCodeProviderConfig,
  resolveZCodeDataDir,
  scrubZCodeEnvironment,
  writeZCodeProviderConfig,
  zcodeByokSelection,
} from "../zcode/zcodeByokConfig.ts";
import {
  readZCodeCredentials,
  zcodeAccountEmail,
  zcodeAccountLabel,
  zcodeFamilyOf,
  zcodePlanApiKey,
  ZCODE_OFFICIAL_MODELS,
  ZCODE_OFFICIAL_PROVIDER_ID,
} from "../zcode/zcodeCredentials.ts";
import { ProviderAdapterValidationError, ProviderDriverError } from "../Errors.ts";
import { makeZCodeAdapter } from "../Layers/ZCodeAdapter.ts";
import {
  buildInitialPifamilyProviderSnapshot,
  checkPifamilyProviderStatus,
  enrichPifamilySnapshot,
} from "../Layers/PifamilyProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

export type ZCodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | ServerSecretStore;

const DRIVER_KIND = ProviderDriverKind.make("zcodeAgent");
const MAINTENANCE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
);
const decodeByokSettings = Schema.decodeUnknownSync(ByokSettings);
const decodeZCodeSettings = Schema.decodeSync(ZCodeAgentSettings);

/** BYOK 源实例的设置（用于共享的文本生成通道）；读不到就用空配置。 */
const readSourceByokSettings = (
  settings: ServerSettings,
  sourceInstanceId: string,
): ByokSettings => {
  const entry = Object.entries(settings.providerInstances).find(
    ([instanceId]) => instanceId === sourceInstanceId,
  )?.[1];
  if (entry?.driver === "byok" && entry.config !== undefined) {
    try {
      return decodeByokSettings(entry.config);
    } catch {
      // 配置异常时退回 legacy/空配置；快照层会如实呈现无路由。
    }
  }
  return settings.providers?.byok ?? decodeByokSettings({});
};

export const ZCodeDriver: ProviderDriver<ZCodeAgentSettings, ZCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ZCode", supportsMultipleInstances: true },
  configSchema: ZCodeAgentSettings,
  defaultConfig: (): ZCodeAgentSettings => decodeZCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const secretStore = yield* ServerSecretStore;
      const processEnv = mergeProviderInstanceEnvironment(environment);

      // 官方账号模式：`zcode login` 的凭据落在同一受管数据根，模型走官方 Coding Plan。
      const official = config.authMode === "official";
      const officialRoutes: ReadonlyArray<PifamilyModelRoute> = ZCODE_OFFICIAL_MODELS.map(
        (modelId) => ({
          adapterId: modelId,
          protocol: "anthropic" as const,
          displayName: modelId,
          modelId,
          contextWindowTokens: 200_000,
        }),
      );

      // 未指定来源时读全部通道（含号池发布的本地账号路由）；指定后只读该 BYOK 实例。
      const sourceInstanceId = config.byokSourceInstanceId;
      const origin = gatewayOrigin(serverConfig.port);
      const dataDir = resolveZCodeDataDir({ stateDir: serverConfig.stateDir, instanceId });
      const managedEnv: Record<string, string> = {
        ...scrubZCodeEnvironment(processEnv),
        ZCODE_DATA_BASE_DIR: dataDir,
      };
      const managedProcessEnv = managedEnv as NodeJS.ProcessEnv;

      // 每次 yield* 都重新读取 settings；BYOK 源变化 → fingerprint → 实例重建。
      const resolveRoutes: Effect.Effect<
        ReadonlyArray<PifamilyModelRoute>,
        ProviderAdapterValidationError
      > = official
        ? Effect.succeed(officialRoutes)
        : Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings;
            return pifamilyModelRoutes(gatewayAdapterRoutes(settings, sourceInstanceId), settings);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterValidationError({
                  provider: DRIVER_KIND,
                  operation: "resolveRoutes",
                  issue: `Failed to read BYOK gateway routes: ${cause.message}`,
                }),
            ),
          );

      // 写受管 provider_config.json；selected 决定 defaultModelSelection。官方模式
      // 的 selection 指向内置 Coding Plan Provider（zai/bigmodel 取决于已登录账号），
      // 受管 Provider 声明保持存在，切换回 BYOK 时不会丢配置。
      const writeConfig = (selected: PifamilyModelRoute | undefined) =>
        Effect.gen(function* () {
          const routes = yield* resolveRoutes;
          const gatewayToken = yield* ensureGatewayToken(secretStore);
          const target = selected ?? routes[0];
          const family = official
            ? (Option.match(yield* readZCodeCredentials(dataDir), {
                onNone: () => undefined,
                onSome: zcodeFamilyOf,
              }) ?? "zai")
            : undefined;
          yield* writeZCodeProviderConfig({
            dataDir,
            config: buildZCodeProviderConfig({
              routes,
              openaiBaseUrl: openaiGatewayBase(origin, sourceInstanceId),
              anthropicBaseUrl: anthropicGatewayBase(origin, sourceInstanceId),
              gatewayToken,
              defaultModelSelection:
                target === undefined
                  ? undefined
                  : official
                    ? {
                        providerId: ZCODE_OFFICIAL_PROVIDER_ID[family ?? "zai"],
                        modelId: target.adapterId,
                      }
                    : zcodeByokSelection(target),
            }),
          });
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterValidationError({
                provider: DRIVER_KIND,
                operation: "writeManagedConfig",
                issue: `无法写入 ZCode 受管 BYOK 配置：${cause.message}`,
              }),
          ),
        );
      yield* writeConfig(undefined).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.issue,
            }),
        ),
      );

      const effectiveConfig = { ...config, enabled } satisfies ZCodeAgentSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        MAINTENANCE,
        { binaryPath: effectiveConfig.binaryPath, env: managedProcessEnv },
      );

      // spawn 目标：显式 binaryPath → 内嵌 bundle（释放到 stateDir）→ PATH。
      const spawnTarget = yield* resolveZCodeSpawnTarget({
        binaryPath: effectiveConfig.binaryPath,
        stateDir: serverConfig.stateDir,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const adapter = yield* makeZCodeAdapter(effectiveConfig, {
        instanceId,
        environment: managedEnv,
        spawnTarget,
        resolveRoutes,
        prepareTurnConfig: (selected) => writeConfig(selected),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      // 文本生成直接复用 BYOK 源通道（同一模型、同一路由）。
      const textGenerationSettings = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => readSourceByokSettings(settings, sourceInstanceId ?? "byok")),
        Effect.orElseSucceed(() => decodeByokSettings({})),
      );
      const textGeneration = yield* makeByokTextGeneration(textGenerationSettings);

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      // 官方模式用受管凭据文件上报登录状态与账号信息（label/email）。
      const decorateOfficialAuth = (draft: ServerProviderDraft) =>
        !official || !draft.enabled || !draft.installed
          ? Effect.succeed(draft)
          : readZCodeCredentials(dataDir).pipe(
              Effect.map((credentials) => {
                const record = Option.isSome(credentials) ? credentials.value : undefined;
                if (record === undefined || zcodePlanApiKey(record) === undefined) {
                  return {
                    ...draft,
                    status: "warning" as const,
                    auth: { status: "unauthenticated" as const },
                    message: "ZCode CLI 已安装，但还没有登录官方账号；请登录 Z.AI 账号。",
                  };
                }
                const label = zcodeAccountLabel(record);
                const email = zcodeAccountEmail(record);
                return {
                  ...draft,
                  auth: {
                    status: "authenticated" as const,
                    type: zcodeFamilyOf(record) ?? "zai",
                    ...(label === undefined ? {} : { label }),
                    ...(email === undefined ? {} : { email }),
                  },
                };
              }),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.orElseSucceed(() => draft),
            );

      const checkProvider = Effect.gen(function* () {
        const routes = yield* resolveRoutes;
        return yield* checkPifamilyProviderStatus({
          driverKind: "zcodeAgent",
          settings: { ...effectiveConfig, binaryPath: spawnTarget.command },
          routes,
          environment: { ...managedProcessEnv, ...zcodeSpawnEnv(spawnTarget) },
          spawnArgsPrefix: spawnTarget.argsPrefix,
          displayBinaryPath: spawnTarget.displayPath,
          // 内嵌运行时常驻，不跑 --version 探针，卡片不会再报"CLI 版本命令返回失败"。
          assumeInstalled: spawnTarget.source === "bundled",
        });
      }).pipe(
        Effect.flatMap(decorateOfficialAuth),
        Effect.map(stampIdentity),
        Effect.catchCause(() =>
          buildInitialPifamilyProviderSnapshot({
            driverKind: "zcodeAgent",
            settings: effectiveConfig,
            routes: [],
          }).pipe(Effect.map(stampIdentity)),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ZCodeAgentSettings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () =>
          resolveRoutes.pipe(
            Effect.catchCause(() => Effect.succeed([])),
            Effect.flatMap((routes) =>
              buildInitialPifamilyProviderSnapshot({
                driverKind: "zcodeAgent",
                settings: effectiveConfig,
                routes,
              }),
            ),
            Effect.flatMap(decorateOfficialAuth),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ snapshot: currentSnapshot, publishSnapshot }) =>
          enrichPifamilySnapshot({ snapshot: stampIdentity(currentSnapshot), publishSnapshot }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ZCode snapshot: ${cause.message ?? String(cause)}`,
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
