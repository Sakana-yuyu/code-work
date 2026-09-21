/**
 * ByokDriver — `ProviderDriver` for the built-in BYOK engine.
 *
 * The engine is fully in-process TypeScript calling user-configured model
 * adapters directly, so there is no binary and no update channel: the
 * maintenance resolver is static/manual-only and the snapshot is purely a
 * configuration health-check (`Layers/ByokProvider.ts`).
 *
 * @module provider/Drivers/ByokDriver
 */
import {
  ByokSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSkill,
} from "@codework/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { discoverByokSkills } from "../../skillDiscovery.ts";
import { CompositionMcpToolRegistry } from "../../composition/CompositionMcpToolRegistry.ts";
import { makeByokTextGeneration } from "../../textGeneration/ByokTextGeneration.ts";
import { makeByokModelDriver } from "../../composition/OpenAiByokModelDriver.ts";
import { CompositionAgentServiceError } from "../../composition/CompositionAgentService.ts";
import * as ToolBroker from "../../composition/ToolBroker.ts";
import {
  byokCompositionAdapterForModel,
  listByokCompositionModelDescriptors,
} from "../byok/ByokCompositionModel.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeByokAdapter } from "../Layers/ByokAdapter.ts";
import {
  buildInitialByokProviderSnapshot,
  checkByokProviderStatus,
} from "../Layers/ByokProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
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
const decodeByokSettings = Schema.decodeSync(ByokSettings);

const DRIVER_KIND = ProviderDriverKind.make("byok");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type ByokDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerConfig
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

export const ByokDriver: ProviderDriver<ByokSettings, ByokDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Custom model service",
    supportsMultipleInstances: true,
  },
  configSchema: ByokSettings,
  defaultConfig: (): ByokSettings => decodeByokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const toolBroker = yield* Effect.serviceOption(ToolBroker.ToolBroker);
      const mcpToolRegistry = yield* Effect.serviceOption(CompositionMcpToolRegistry);
      // BYOK 是内置引擎、没有宿主 CLI 帮忙解析技能目录：快照列出用户级 +
      // 服务器 cwd 项目级技能，composer 的 $ 与 / 技能菜单由此取数。
      const discoverSkills = discoverByokSkills(serverConfig.cwd).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed((): ReadonlyArray<ServerProviderSkill> => []),
      );
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      const effectiveConfig = { ...config, enabled } satisfies ByokSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        env: processEnv,
      });

      const adapter = yield* makeByokAdapter(effectiveConfig, {
        instanceId,
        ...(toolBroker._tag === "Some" ? { toolBroker: toolBroker.value } : {}),
        ...(mcpToolRegistry._tag === "Some" ? { mcpToolRegistry: mcpToolRegistry.value } : {}),
        getServerSettings: serverSettings.getSettings,
      });
      const textGeneration = yield* makeByokTextGeneration(effectiveConfig);

      const checkProvider = Effect.zipWith(
        checkByokProviderStatus(effectiveConfig),
        discoverSkills,
        (draft, skills) => ({ ...draft, skills: [...skills] }),
      ).pipe(Effect.map(stampIdentity), Effect.provideService(HttpClient.HttpClient, httpClient));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ByokSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Effect.zipWith(
            buildInitialByokProviderSnapshot(settings.provider),
            discoverSkills,
            (draft, skills) => ({ ...draft, skills: [...skills] }),
          ).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build BYOK snapshot: ${cause.message ?? String(cause)}`,
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
        composition: {
          modelDescriptors: listByokCompositionModelDescriptors(effectiveConfig),
          defaultModelId: effectiveConfig.adapters[0]?.id,
          defaultModelName: effectiveConfig.adapters[0]?.displayName,
          resolveModelDriver: ({ modelId, signal }) => {
            const modelAdapter = byokCompositionAdapterForModel(effectiveConfig, modelId);
            if (modelAdapter === undefined) {
              return Effect.fail(
                new CompositionAgentServiceError({
                  code: "model_not_configured",
                  detail: `BYOK model '${modelId}' is not configured.`,
                }),
              );
            }
            return Effect.succeed(
              makeByokModelDriver(httpClient, {
                protocol: modelAdapter.protocol,
                baseURL: modelAdapter.baseURL,
                apiKey: modelAdapter.apiKey,
                modelId: modelAdapter.modelId,
                contextWindowTokens: modelAdapter.contextWindowTokens,
                ...(modelAdapter.maxOutputTokens !== undefined
                  ? { maxOutputTokens: modelAdapter.maxOutputTokens }
                  : {}),
                ...(modelAdapter.customHeaders !== undefined &&
                modelAdapter.customHeaders.trim().length > 0
                  ? { customHeaders: modelAdapter.customHeaders }
                  : {}),
                ...(signal === undefined ? {} : { signal }),
              }),
            );
          },
        },
      } satisfies ProviderInstance;
    }),
};
