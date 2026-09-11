/**
 * PiDriver / OmpDriver — pi-family 供应商驱动。
 *
 * 共同职责（由 {@link makePifamilyDriver} 承载）：
 *  1. 受管 agent 目录（`PI_CODING_AGENT_DIR`）+ models.json —— 只注册指向
 *     本地 BYOK 网关的 provider，凭据物理隔离；
 *  2. 环境清洗（剥掉第三方供应商密钥与 PI_* 指回变量）；
 *  3. 模型路由 / 快照 / 文本生成全部以 BYOK 源实例为权威。
 *
 * @module provider/Drivers/PifamilyDrivers
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ByokSettings,
  OmpAgentSettings,
  PiAgentSettings,
  ProviderDriverKind,
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
import {
  buildPifamilyModelsJson,
  pifamilyModelRoutes,
  resolvePifamilyAgentDir,
  scrubPifamilyEnvironment,
  writePifamilyByokConfig,
  type PifamilyModelRoute,
} from "../pifamily/byokProviderConfig.ts";
import { ProviderAdapterValidationError, ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter, type OmpAdapterOptions } from "../Layers/OmpAdapter.ts";
import { makePiAdapter, type PiAdapterOptions } from "../Layers/PiAdapter.ts";
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

export type PifamilyDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
  | ServerSettingsService
  | ServerSecretStore;

type PifamilySettings = PiAgentSettings | OmpAgentSettings;

interface PifamilyAdapterOptionsCommon {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly environment: Readonly<Record<string, string>>;
  readonly resolveRoutes: Effect.Effect<
    ReadonlyArray<PifamilyModelRoute>,
    ProviderAdapterValidationError
  >;
}

interface PifamilyDriverSpec<Settings extends PifamilySettings> {
  readonly driverKind: "piAgent" | "ompAgent";
  readonly displayName: string;
  readonly configSchema: Schema.Codec<Settings, unknown>;
  readonly defaultConfig: () => Settings;
  readonly makeAdapter: (
    config: Settings,
    options: PiAdapterOptions | OmpAdapterOptions,
  ) => Effect.Effect<
    ProviderInstance["adapter"],
    never,
    | Crypto.Crypto
    | ChildProcessSpawner.ChildProcessSpawner
    | ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >;
}

const decodeByokSettings = Schema.decodeUnknownSync(ByokSettings);

const pifamilyByokSourceInstanceId = (config: PifamilySettings): string =>
  config.byokSourceInstanceId ?? "byok";

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
  const legacy = settings.providers?.byok;
  if (legacy !== undefined) return legacy;
  return decodeByokSettings({});
};

function makePifamilyDriver<Settings extends PifamilySettings>(
  spec: PifamilyDriverSpec<Settings>,
): ProviderDriver<Settings, PifamilyDriverEnv> {
  const DRIVER_KIND = ProviderDriverKind.make(spec.driverKind);
  const MAINTENANCE = makeStaticProviderMaintenanceResolver(
    makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null }),
  );

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

  return {
    driverKind: DRIVER_KIND,
    metadata: { displayName: spec.displayName, supportsMultipleInstances: true },
    configSchema: spec.configSchema,
    defaultConfig: spec.defaultConfig,
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

        const sourceInstanceId = pifamilyByokSourceInstanceId(config);
        const origin = gatewayOrigin(serverConfig.port);

        // 受管 agent 目录 + 清洗环境：目录里没有 auth.json，环境里没有第三方
        // 供应商密钥，CLI 物理上只能走网关。
        const agentDir = resolvePifamilyAgentDir({
          stateDir: serverConfig.stateDir,
          driverKind: spec.driverKind,
          instanceId,
        });
        const managedEnv: Record<string, string> = {
          ...scrubPifamilyEnvironment(processEnv),
          PI_CODING_AGENT_DIR: agentDir,
        };
        const managedProcessEnv = managedEnv as NodeJS.ProcessEnv;

        // 每次 yield* 都重新读取 settings；BYOK 源变化 → fingerprint → 实例重建。
        const resolveRoutes: Effect.Effect<
          ReadonlyArray<PifamilyModelRoute>,
          ProviderAdapterValidationError
        > = Effect.gen(function* () {
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

        // 写受管 models.json；BYOK 源变化 → hydration fingerprint → 实例重建 → 重写。
        yield* Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const routes = pifamilyModelRoutes(
            gatewayAdapterRoutes(settings, sourceInstanceId),
            settings,
          );
          const gatewayToken = yield* ensureGatewayToken(secretStore);
          const modelsJson = buildPifamilyModelsJson({
            routes,
            openaiBaseUrl: openaiGatewayBase(origin, sourceInstanceId),
            anthropicBaseUrl: anthropicGatewayBase(origin, sourceInstanceId),
            gatewayToken,
          });
          yield* writePifamilyByokConfig({ agentDir, modelsJson });
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `无法写入 ${spec.displayName} 受管 BYOK 配置：${cause.message}`,
              }),
          ),
        );

        const effectiveConfig = { ...config, enabled } satisfies Settings;
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          MAINTENANCE,
          { binaryPath: effectiveConfig.binaryPath, env: managedProcessEnv },
        );

        const adapterOptions: PifamilyAdapterOptionsCommon = {
          instanceId,
          environment: managedEnv,
          resolveRoutes,
        };
        const adapter = yield* spec
          .makeAdapter(
            effectiveConfig,
            spec.driverKind === "piAgent"
              ? (adapterOptions as PiAdapterOptions)
              : (adapterOptions as OmpAdapterOptions),
          )
          .pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(ServerConfig, serverConfig),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );

        // 文本生成直接复用 BYOK 源通道（同一模型、同一路由）。
        const textGenerationSettings = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => readSourceByokSettings(settings, sourceInstanceId)),
          Effect.orElseSucceed(() => decodeByokSettings({})),
        );
        const textGeneration = yield* makeByokTextGeneration(textGenerationSettings);

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
        const checkProvider = Effect.gen(function* () {
          const routes = yield* resolveRoutes;
          return yield* checkPifamilyProviderStatus({
            driverKind: spec.driverKind,
            settings: effectiveConfig,
            routes,
            environment: managedProcessEnv,
          });
        }).pipe(
          Effect.map(stampIdentity),
          // 设置读取失败时退回无路由草稿；探照灯照常报告 CLI 状态。
          Effect.catchCause(() =>
            buildInitialPifamilyProviderSnapshot({
              driverKind: spec.driverKind,
              settings: effectiveConfig,
              routes: [],
            }).pipe(Effect.map(stampIdentity)),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const snapshotSettings = makeProviderSnapshotSettingsSource(
          effectiveConfig,
          serverSettings,
        );
        const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<Settings>>({
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: () =>
            resolveRoutes.pipe(
              Effect.catchCause(() => Effect.succeed([])),
              Effect.flatMap((routes) =>
                buildInitialPifamilyProviderSnapshot({
                  driverKind: spec.driverKind,
                  settings: effectiveConfig,
                  routes,
                }),
              ),
              Effect.map(stampIdentity),
            ),
          checkProvider,
          enrichSnapshot: ({ snapshot: currentSnapshot, publishSnapshot }) =>
            enrichPifamilySnapshot({
              snapshot: stampIdentity(currentSnapshot),
              publishSnapshot,
            }),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ${spec.displayName} snapshot: ${cause.message ?? String(cause)}`,
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
}

const decodePiSettings = Schema.decodeSync(PiAgentSettings);
const decodeOmpSettings = Schema.decodeSync(OmpAgentSettings);

export const PiDriver: ProviderDriver<PiAgentSettings, PifamilyDriverEnv> = makePifamilyDriver({
  driverKind: "piAgent",
  displayName: "Pi",
  configSchema: PiAgentSettings,
  defaultConfig: (): PiAgentSettings => decodePiSettings({}),
  makeAdapter: (config, options) => makePiAdapter(config, options as PiAdapterOptions),
});

export const OmpDriver: ProviderDriver<OmpAgentSettings, PifamilyDriverEnv> = makePifamilyDriver({
  driverKind: "ompAgent",
  displayName: "OhMyPi",
  configSchema: OmpAgentSettings,
  defaultConfig: (): OmpAgentSettings => decodeOmpSettings({}),
  makeAdapter: (config, options) => makeOmpAdapter(config, options as OmpAdapterOptions),
});
