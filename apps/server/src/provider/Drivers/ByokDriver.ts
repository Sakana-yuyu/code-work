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
import { ByokSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeByokTextGeneration } from "../../textGeneration/ByokTextGeneration.ts";
import { makeByokModelDriver } from "../../composition/OpenAiByokModelDriver.ts";
import { CompositionAgentServiceError } from "../../composition/CompositionAgentService.ts";
import { byokAdapterForModel } from "../Layers/byokChatClient.ts";
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
    displayName: "Cursor BYOK",
    supportsMultipleInstances: true,
  },
  configSchema: ByokSettings,
  defaultConfig: (): ByokSettings => decodeByokSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
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

      const adapter = yield* makeByokAdapter(effectiveConfig, { instanceId });
      const textGeneration = yield* makeByokTextGeneration(effectiveConfig);

      const checkProvider = checkByokProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ByokSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialByokProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
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
          resolveModelDriver: ({ modelId }) => {
            const modelAdapter = byokAdapterForModel(effectiveConfig, modelId);
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
              }),
            );
          },
        },
      } satisfies ProviderInstance;
    }),
};
