/**
 * ServerSettings - Server-authoritative settings service.
 *
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  type CompositionMcpRuntimeServerConfig,
  type CompositionMcpSecretValue,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsConflictError,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@codework/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerConfig from "./config.ts";
import { type DeepPartial, deepMerge } from "@codework/shared/Struct";
import { fromJsonStringPretty, fromLenientJson } from "@codework/shared/schemaJson";
import {
  applyServerSettingsPatch,
  isModelSelectionProviderEnabled,
} from "@codework/shared/serverSettings";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import {
  applyMulticaProviderInstanceMutation,
  assignMulticaProviderInstanceRevisions,
  multicaSecretEnvironmentNames,
  normalizeMulticaProviderInstances,
  validateMulticaProviderInstancePreconditions,
} from "./serverSettingsMulticaCas.ts";
import {
  commitServerSettingsOriginCas,
  readServerSettingsOriginSnapshot,
  ServerSettingsOriginCommitHook,
  type ServerSettingsOriginSnapshot,
} from "./serverSettingsOriginCas.ts";
import { makeServerSettingsSecretTransaction } from "./serverSettingsSecretTransaction.ts";

export { resolveSourceControlWriterModelSelection } from "@codework/shared/serverSettings";

const encodeServerSettings = Schema.encodeEffect(ServerSettings);
const encodeServerSettingsJson = Schema.encodeUnknownEffect(fromJsonStringPretty(ServerSettings));
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type ServerSettingsUpdateError = ServerSettingsError | ServerSettingsConflictError;
type ServerSettingsDiskSnapshot = ServerSettingsOriginSnapshot & {
  readonly settings: ServerSettings;
};

const normalizeServerSettings = (
  settings: ServerSettings,
  settingsPath = "<memory>",
): Effect.Effect<ServerSettings, ServerSettingsError> =>
  encodeServerSettings(settings).pipe(
    Effect.flatMap(decodeServerSettings),
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "normalize",
          cause,
        }),
    ),
    Effect.flatMap((normalized) => normalizeMulticaProviderInstances(settingsPath, normalized)),
  );

function providerEnvironmentSecretName(input: {
  readonly instanceId: string;
  readonly name: string;
}): string {
  return `provider-env-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.name, "utf8").toString("base64url")}`;
}

function byokApiKeySecretName(input: {
  readonly instanceId: string;
  readonly adapterId: string;
}): string {
  return `provider-byok-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.adapterId, "utf8").toString("base64url")}-api-key`;
}

function byokBalanceTokenSecretName(input: {
  readonly instanceId: string;
  readonly adapterId: string;
}): string {
  return `provider-byok-${Buffer.from(input.instanceId, "utf8").toString("base64url")}-${Buffer.from(input.adapterId, "utf8").toString("base64url")}-balance-token`;
}

function mcpSecretName(input: {
  readonly serverId: string;
  readonly kind: "header" | "environment";
  readonly name: string;
}): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `mcp-${encode(input.serverId)}-${input.kind}-${encode(input.name)}`;
}

function redactByokConfig(config: unknown): unknown {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return config;
  const record = config as Record<string, unknown>;
  if (!Array.isArray(record["adapters"])) return config;
  return {
    ...record,
    adapters: record["adapters"].map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const adapter = entry as Record<string, unknown>;
      const apiKey = typeof adapter["apiKey"] === "string" ? adapter["apiKey"] : "";
      const balanceToken =
        typeof adapter["balanceAccessToken"] === "string" ? adapter["balanceAccessToken"] : "";
      return {
        ...adapter,
        apiKey: "",
        ...(apiKey.length > 0 || adapter["apiKeyRedacted"] === true
          ? { apiKeyRedacted: true }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(adapter, "balanceAccessToken")
          ? {
              balanceAccessToken: "",
              ...(balanceToken.length > 0 || adapter["balanceAccessTokenRedacted"] === true
                ? { balanceAccessTokenRedacted: true }
                : {}),
            }
          : {}),
      };
    }),
  };
}

function redactProviderEnvironmentVariable(
  variable: ProviderInstanceEnvironmentVariable,
  forceSecret = false,
): ProviderInstanceEnvironmentVariable {
  if (!forceSecret && !variable.sensitive) {
    const { valueRedacted: _omit, ...rest } = variable;
    return rest;
  }
  return {
    ...variable,
    ...(forceSecret ? { sensitive: true } : {}),
    value: "",
    ...(variable.value.length > 0 || variable.valueRedacted ? { valueRedacted: true } : {}),
  };
}

function redactMcpSecretValue(value: CompositionMcpSecretValue): CompositionMcpSecretValue {
  if (!value.sensitive) {
    const { valueRedacted: _omit, ...rest } = value;
    return rest;
  }
  return {
    ...value,
    value: "",
    ...(value.value.length > 0 || value.valueRedacted ? { valueRedacted: true } : {}),
  };
}

function redactMcpServerConfig(
  config: CompositionMcpRuntimeServerConfig,
): CompositionMcpRuntimeServerConfig {
  return {
    ...config,
    headers: config.headers.map(redactMcpSecretValue),
    environment: config.environment.map(redactMcpSecretValue),
  };
}

export function redactServerSettingsForClient(settings: ServerSettings): ServerSettings {
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => {
      const secretEnvironmentNames = multicaSecretEnvironmentNames(instance);
      return [
        instanceId,
        {
          ...instance,
          ...(instance.driver === "byok" ? { config: redactByokConfig(instance.config) } : {}),
          ...(instance.environment
            ? {
                environment: instance.environment.map((variable) =>
                  redactProviderEnvironmentVariable(
                    variable,
                    secretEnvironmentNames.has(variable.name),
                  ),
                ),
              }
            : {}),
        },
      ];
    }),
  );
  const mcpServers = Object.fromEntries(
    Object.entries(settings.mcpServers).map(([serverId, config]) => [
      serverId,
      redactMcpServerConfig(config),
    ]),
  );
  return { ...settings, providerInstances, mcpServers };
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  {
    /** Start the settings runtime and attach file watching. */
    readonly start: Effect.Effect<void, ServerSettingsError>;

    /** Await settings runtime readiness. */
    readonly ready: Effect.Effect<void, ServerSettingsError>;

    /** Read the current settings. */
    readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

    /** Patch settings and persist. Returns the new full settings object. */
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => Effect.Effect<ServerSettings, ServerSettingsUpdateError>;

    /** Stream of settings change events. */
    readonly streamChanges: Stream.Stream<ServerSettings>;

    /**
     * Acquire a settings change subscription synchronously in the current
     * fiber. Use this before reading a snapshot when changes between the
     * snapshot and a lazily started stream must not be lost.
     */
    readonly subscribeChanges: Effect.Effect<Stream.Stream<ServerSettings>, never, Scope.Scope>;
  }
>()("codework/serverSettings/ServerSettingsService") {
  /** @deprecated Import and use `layerTest` from this module. */
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) => layerTest(overrides);
}

const makeTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Effect.gen(function* () {
    const { automaticGitFetchInterval, providerHealthRefreshInterval, ...overridesForMerge } =
      overrides;
    const merged = deepMerge(DEFAULT_SERVER_SETTINGS, overridesForMerge);
    const initialSettings = yield* normalizeServerSettings({
      ...merged,
      ...(automaticGitFetchInterval !== undefined
        ? { automaticGitFetchInterval: automaticGitFetchInterval as Duration.Duration }
        : {}),
      ...(providerHealthRefreshInterval !== undefined
        ? { providerHealthRefreshInterval: providerHealthRefreshInterval as Duration.Duration }
        : {}),
    });
    const currentSettingsRef = yield* Ref.make<ServerSettings>(initialSettings);

    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(currentSettingsRef).pipe(Effect.map(resolveTextGenerationProvider)),
      updateSettings: (patch) =>
        Ref.get(currentSettingsRef).pipe(
          Effect.map((currentSettings) => applyServerSettingsPatch(currentSettings, patch)),
          Effect.flatMap(normalizeServerSettings),
          Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
          Effect.map(resolveTextGenerationProvider),
        ),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.succeed(Stream.empty),
    } satisfies ServerSettingsService["Service"];
  });

export const layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
  Layer.effect(ServerSettingsService, makeTest(overrides));

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJsonExit = Schema.decodeUnknownExit(ServerSettingsJson);
const PersistedOptionalProviderSettings = Schema.Struct({
  providers: Schema.optionalKey(
    Schema.Struct({
      cursor: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      grok: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
      opencode: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })),
    }),
  ),
});
const decodePersistedOptionalProviderSettingsJsonExit = Schema.decodeUnknownExit(
  fromLenientJson(PersistedOptionalProviderSettings),
);

function restoreUsedProviders(
  settings: ServerSettings,
  persisted: typeof PersistedOptionalProviderSettings.Type,
  providerHistory: ReadonlyArray<{
    readonly providerName: string;
    readonly providerInstanceId: string | null;
  }>,
): ServerSettings {
  const usedProviders = new Set(providerHistory.map(({ providerName }) => providerName));
  const usedProviderInstances = new Set(
    providerHistory.map(
      ({ providerName, providerInstanceId }) => providerInstanceId ?? providerName,
    ),
  );
  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
      instanceId,
      instance.enabled === undefined &&
      (instance.driver === "cursor" ||
        instance.driver === "grok" ||
        instance.driver === "opencode") &&
      usedProviderInstances.has(instanceId)
        ? { ...instance, enabled: true }
        : instance,
    ]),
  );

  return {
    ...settings,
    providers: {
      ...settings.providers,
      cursor: {
        ...settings.providers.cursor,
        enabled: persisted.providers?.cursor?.enabled ?? usedProviders.has("cursor"),
      },
      grok: {
        ...settings.providers.grok,
        enabled: persisted.providers?.grok?.enabled ?? usedProviders.has("grok"),
      },
      opencode: {
        ...settings.providers.opencode,
        enabled: persisted.providers?.opencode?.enabled ?? usedProviders.has("opencode"),
      },
    },
    providerInstances,
  };
}

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  return isModelSelectionProviderEnabled(settings, settings.textGenerationModelSelection)
    ? settings
    : fallbackTextGenerationProvider(settings);
}

function fallbackTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const fallbackEntry = Object.entries(settings.providers).find(([, provider]) => provider.enabled);
  const fallback = fallbackEntry ? ProviderDriverKind.make(fallbackEntry[0]) : undefined;
  if (!fallback) {
    return settings;
  }

  return {
    ...settings,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make(fallback),
      model:
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_MODEL_BY_PROVIDER[fallback] ??
        DEFAULT_TEXT_GENERATION_MODEL,
    } satisfies ModelSelection,
  };
}

// Values under these keys are compared as a whole — never stripped field-by-field.
const ATOMIC_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "backgroundActivity",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "sourceControlWriterModelSelection",
  "textGenerationModelSelection",
]);

// Preserve both enabled states because provider history cannot recover a new opt-in.
const PERSISTED_SERVER_SETTINGS_DEFAULTS = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: undefined },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: undefined },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: undefined },
  },
};

function stripDefaultServerSettings(current: unknown, defaults: unknown): unknown | undefined {
  if (Array.isArray(current) || Array.isArray(defaults)) {
    return Equal.equals(current, defaults) ? undefined : current;
  }

  if (
    current !== null &&
    defaults !== null &&
    typeof current === "object" &&
    typeof defaults === "object"
  ) {
    const currentRecord = current as Record<string, unknown>;
    const defaultsRecord = defaults as Record<string, unknown>;
    const next: Record<string, unknown> = {};

    for (const key of Object.keys(currentRecord)) {
      if (ATOMIC_SETTINGS_KEYS.has(key)) {
        if (!Equal.equals(currentRecord[key], defaultsRecord[key])) {
          next[key] = currentRecord[key];
        }
      } else {
        const stripped = stripDefaultServerSettings(currentRecord[key], defaultsRecord[key]);
        if (stripped !== undefined) {
          next[key] = stripped;
        }
      }
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  return Object.is(current, defaults) ? undefined : current;
}

const make = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const originCommitHook = yield* ServerSettingsOriginCommitHook;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const hydrateSettingsOrigin = Effect.fnUntraced(function* (origin: ServerSettingsOriginSnapshot) {
    let settings = DEFAULT_SERVER_SETTINGS;
    let persisted: typeof PersistedOptionalProviderSettings.Type = {};

    if (origin.raw !== null) {
      const decoded = decodeServerSettingsJsonExit(origin.raw);
      const persistedSettings = decodePersistedOptionalProviderSettingsJsonExit(origin.raw);
      if (persistedSettings._tag === "Success") {
        persisted = persistedSettings.value;
      }
      if (decoded._tag === "Failure" || persistedSettings._tag === "Failure") {
        const failure = decoded._tag === "Failure" ? decoded : persistedSettings;
        if (failure._tag === "Failure") {
          yield* Effect.logWarning("failed to parse settings.json, using defaults", {
            path: settingsPath,
            issues: Cause.pretty(failure.cause),
            cause: failure.cause,
          });
        }
      } else {
        settings = decoded.value;
      }
    }

    const providerHistory = yield* sql<{
      readonly providerName: string;
      readonly providerInstanceId: string | null;
    }>`
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM projection_thread_sessions
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
      UNION
      SELECT DISTINCT
        provider_name AS "providerName",
        provider_instance_id AS "providerInstanceId"
      FROM provider_session_runtime
      WHERE provider_name IN ('cursor', 'grok', 'opencode')
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "read-provider-history",
            cause,
          }),
      ),
    );

    const normalized = yield* normalizeServerSettings(
      restoreUsedProviders(settings, persisted, providerHistory),
      settingsPath,
    );
    return { ...origin, settings: normalized } satisfies ServerSettingsDiskSnapshot;
  });

  const loadSettingsFromDisk = readServerSettingsOriginSnapshot(settingsPath).pipe(
    Effect.provideService(Crypto.Crypto, crypto),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.catchTag("ServerSettingsOriginError", (cause) =>
      Effect.fail(
        new ServerSettingsError({
          settingsPath,
          operation: "read-file",
          cause,
        }),
      ),
    ),
    Effect.flatMap(hydrateSettingsOrigin),
  );

  const settingsCache = yield* Cache.make<
    typeof cacheKey,
    ServerSettingsDiskSnapshot,
    ServerSettingsError
  >({ capacity: 1, lookup: () => loadSettingsFromDisk });

  const getSettingsSnapshotFromCache = Cache.get(settingsCache, cacheKey);
  const getSettingsFromCache = getSettingsSnapshotFromCache.pipe(
    Effect.map((snapshot) => snapshot.settings),
  );

  const materializeMcpSecretValues = (
    serverId: string,
    kind: "header" | "environment",
    values: ReadonlyArray<CompositionMcpSecretValue>,
  ): Effect.Effect<ReadonlyArray<CompositionMcpSecretValue>, ServerSettingsError> =>
    Effect.forEach(values, (value) => {
      if (!value.sensitive || value.valueRedacted !== true) return Effect.succeed(value);
      return secretStore.get(mcpSecretName({ serverId, kind, name: value.name })).pipe(
        Effect.map((secret) => ({
          ...value,
          value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
        })),
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "read-secret",
              environmentVariable: `mcp:${serverId}:${kind}:${value.name}`,
              cause,
            }),
        ),
      );
    });

  const materializeMcpServerSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const mcpServers: Record<string, CompositionMcpRuntimeServerConfig> = {};
      for (const [serverId, config] of Object.entries(settings.mcpServers)) {
        mcpServers[serverId] = {
          ...config,
          headers: yield* materializeMcpSecretValues(serverId, "header", config.headers),
          environment: yield* materializeMcpSecretValues(
            serverId,
            "environment",
            config.environment,
          ),
        };
      }
      return { ...settings, mcpServers };
    });

  const persistMcpSecretValues = (
    serverId: string,
    kind: "header" | "environment",
    values: ReadonlyArray<CompositionMcpSecretValue>,
    nextSecretNames: Set<string>,
    writeSecretStore: ServerSecretStore.ServerSecretStore["Service"],
  ): Effect.Effect<ReadonlyArray<CompositionMcpSecretValue>, ServerSettingsError> =>
    Effect.gen(function* () {
      const persisted: CompositionMcpSecretValue[] = [];
      for (const value of values) {
        const secretName = mcpSecretName({ serverId, kind, name: value.name });
        if (!value.sensitive) {
          yield* writeSecretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-secret",
                  environmentVariable: `mcp:${serverId}:${kind}:${value.name}`,
                  cause,
                }),
            ),
          );
          persisted.push(redactMcpSecretValue(value));
          continue;
        }

        nextSecretNames.add(secretName);
        if (value.valueRedacted === true && value.value.length === 0) {
          persisted.push(redactMcpSecretValue(value));
          continue;
        }
        if (value.value.length > 0) {
          yield* writeSecretStore.set(secretName, textEncoder.encode(value.value)).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "write-secret",
                  environmentVariable: `mcp:${serverId}:${kind}:${value.name}`,
                  cause,
                }),
            ),
          );
          persisted.push({ ...value, value: "", valueRedacted: true });
        } else {
          yield* writeSecretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-secret",
                  environmentVariable: `mcp:${serverId}:${kind}:${value.name}`,
                  cause,
                }),
            ),
          );
          const { valueRedacted: _omit, ...rest } = value;
          persisted.push(rest);
        }
      }
      return persisted;
    });

  const persistMcpServerSecrets = (
    current: ServerSettings,
    next: ServerSettings,
    writeSecretStore: ServerSecretStore.ServerSecretStore["Service"],
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const mcpServers: Record<string, CompositionMcpRuntimeServerConfig> = {};
      const nextSecretNames = new Set<string>();
      for (const [serverId, config] of Object.entries(next.mcpServers)) {
        mcpServers[serverId] = {
          ...config,
          headers: yield* persistMcpSecretValues(
            serverId,
            "header",
            config.headers,
            nextSecretNames,
            writeSecretStore,
          ),
          environment: yield* persistMcpSecretValues(
            serverId,
            "environment",
            config.environment,
            nextSecretNames,
            writeSecretStore,
          ),
        };
      }

      for (const [serverId, config] of Object.entries(current.mcpServers)) {
        for (const kind of ["header", "environment"] as const) {
          for (const value of config[kind === "header" ? "headers" : "environment"]) {
            const secretName = mcpSecretName({ serverId, kind, name: value.name });
            if (value.sensitive && !nextSecretNames.has(secretName)) {
              yield* writeSecretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-stale-secret",
                      environmentVariable: `mcp:${serverId}:${kind}:${value.name}`,
                      cause,
                    }),
                ),
              );
            }
          }
        }
      }

      return { ...next, mcpServers };
    });

  const materializeByokSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (instance.driver !== "byok") continue;
        const config = instance.config;
        if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
        const record = config as Record<string, unknown>;
        if (!Array.isArray(record["adapters"])) continue;
        const adapters: unknown[] = [];
        const adapterIDs = new Set(
          record["adapters"].flatMap((entry) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
            const adapterId = (entry as Record<string, unknown>)["id"];
            return typeof adapterId === "string" && adapterId.length > 0 ? [adapterId] : [];
          }),
        );
        for (const entry of record["adapters"]) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            adapters.push(entry);
            continue;
          }
          const adapter = entry as Record<string, unknown>;
          const adapterId = typeof adapter["id"] === "string" ? adapter["id"] : "";
          let materialized: Record<string, unknown> = adapter;
          if (adapterId !== "" && adapter["apiKeyRedacted"] === true) {
            const secret = yield* secretStore
              .get(byokApiKeySecretName({ instanceId, adapterId }))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "read-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: `byok:${adapterId}:apiKey`,
                      cause,
                    }),
                ),
              );
            let resolvedSecret = secret;
            if (Option.isNone(resolvedSecret)) {
              const sourceAdapterId =
                typeof adapter["apiKeySourceAdapterId"] === "string"
                  ? adapter["apiKeySourceAdapterId"]
                  : "";
              if (
                sourceAdapterId &&
                sourceAdapterId !== adapterId &&
                adapterIDs.has(sourceAdapterId)
              ) {
                resolvedSecret = yield* secretStore
                  .get(byokApiKeySecretName({ instanceId, adapterId: sourceAdapterId }))
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ServerSettingsError({
                          settingsPath,
                          operation: "read-secret",
                          providerInstanceId: instanceId,
                          environmentVariable: `byok:${adapterId}:apiKey`,
                          cause,
                        }),
                    ),
                  );
              }
            }
            materialized = {
              ...materialized,
              apiKey: Option.isSome(resolvedSecret) ? textDecoder.decode(resolvedSecret.value) : "",
            };
          }
          // Balance access tokens follow the same redaction contract as the API
          // key but live in their own secret slot.
          if (adapterId !== "" && adapter["balanceAccessTokenRedacted"] === true) {
            const balanceSecret = yield* secretStore
              .get(byokBalanceTokenSecretName({ instanceId, adapterId }))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "read-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: `byok:${adapterId}:balanceAccessToken`,
                      cause,
                    }),
                ),
              );
            materialized = {
              ...materialized,
              balanceAccessToken: Option.isSome(balanceSecret)
                ? textDecoder.decode(balanceSecret.value)
                : "",
            };
          }
          adapters.push(materialized);
        }
        providerInstances[instanceId] = {
          ...instance,
          config: { ...record, adapters },
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeProviderEnvironmentSecrets = (
    settings: ServerSettings,
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...settings.providerInstances,
      };
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (!instance.environment) continue;
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          if (!variable.sensitive || !variable.valueRedacted) {
            environment.push(variable);
            continue;
          }
          const secret = yield* secretStore
            .get(providerEnvironmentSecretName({ instanceId, name: variable.name }))
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "read-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          environment.push({
            ...variable,
            value: Option.isSome(secret) ? textDecoder.decode(secret.value) : "",
          });
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }
      return {
        ...settings,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const materializeChanges = (changes: Stream.Stream<ServerSettings>) =>
    changes.pipe(
      Stream.mapEffect((settings) =>
        materializeProviderEnvironmentSecrets(settings).pipe(
          Effect.flatMap(materializeMcpServerSecrets),
          Effect.flatMap(materializeByokSecrets),
          Effect.catch((error: ServerSettingsError) =>
            Effect.logWarning("failed to materialize provider environment secrets", {
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }).pipe(Effect.as(settings)),
          ),
        ),
      ),
      Stream.map(resolveTextGenerationProvider),
    );

  const persistByokSecrets = (
    current: ServerSettings,
    next: ServerSettings,
    writeSecretStore: ServerSecretStore.ServerSecretStore["Service"],
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };
      const nextSecretNames = new Set<string>();

      for (const [instanceId, instance] of Object.entries(next.providerInstances)) {
        if (instance.driver !== "byok") continue;
        const config = instance.config;
        if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
        const record = config as Record<string, unknown>;
        if (!Array.isArray(record["adapters"])) continue;
        const adapters: unknown[] = [];
        const adapterIDs = new Set(
          record["adapters"].flatMap((entry) => {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
            const adapterId = (entry as Record<string, unknown>)["id"];
            return typeof adapterId === "string" && adapterId.length > 0 ? [adapterId] : [];
          }),
        );
        for (const entry of record["adapters"]) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            adapters.push(entry);
            continue;
          }
          const adapter = entry as Record<string, unknown>;
          const adapterId = typeof adapter["id"] === "string" ? adapter["id"] : "";
          if (!adapterId) {
            adapters.push(entry);
            continue;
          }
          const secretName = byokApiKeySecretName({ instanceId, adapterId });
          nextSecretNames.add(secretName);
          const apiKey = typeof adapter["apiKey"] === "string" ? adapter["apiKey"] : "";
          if (adapter["apiKeyRedacted"] === true && apiKey.length === 0) {
            const sourceAdapterId =
              typeof adapter["apiKeySourceAdapterId"] === "string"
                ? adapter["apiKeySourceAdapterId"]
                : "";
            if (
              sourceAdapterId &&
              sourceAdapterId !== adapterId &&
              adapterIDs.has(sourceAdapterId)
            ) {
              const ownSecret = yield* writeSecretStore.get(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "read-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: `byok:${adapterId}:apiKey`,
                      cause,
                    }),
                ),
              );
              if (Option.isNone(ownSecret)) {
                const sourceSecret = yield* writeSecretStore
                  .get(byokApiKeySecretName({ instanceId, adapterId: sourceAdapterId }))
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ServerSettingsError({
                          settingsPath,
                          operation: "read-secret",
                          providerInstanceId: instanceId,
                          environmentVariable: `byok:${sourceAdapterId}:apiKey`,
                          cause,
                        }),
                    ),
                  );
                if (Option.isSome(sourceSecret)) {
                  yield* writeSecretStore.set(secretName, sourceSecret.value).pipe(
                    Effect.mapError(
                      (cause) =>
                        new ServerSettingsError({
                          settingsPath,
                          operation: "write-secret",
                          providerInstanceId: instanceId,
                          environmentVariable: `byok:${adapterId}:apiKey`,
                          cause,
                        }),
                    ),
                  );
                }
              }
            }
          }
          if (adapter["apiKeyRedacted"] !== true) {
            if (apiKey.length > 0) {
              yield* writeSecretStore.set(secretName, textEncoder.encode(apiKey)).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "write-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: `byok:${adapterId}:apiKey`,
                      cause,
                    }),
                ),
              );
              adapters.push({ ...adapter, apiKey: "", apiKeyRedacted: true });
            } else {
              yield* writeSecretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: `byok:${adapterId}:apiKey`,
                      cause,
                    }),
                ),
              );
              const { apiKeyRedacted: _omit, ...rest } = adapter;
              adapters.push(rest);
            }
          } else {
            const redacted = redactByokConfig({ adapters: [adapter] }) as { adapters: unknown[] };
            adapters.push(redacted.adapters[0]);
          }
          // Store a freshly entered balance access token, or drop the secret
          // when it was cleared; already-redacted tokens pass through.
          const balanceTokenName = byokBalanceTokenSecretName({ instanceId, adapterId });
          nextSecretNames.add(balanceTokenName);
          const balanceToken =
            typeof adapter["balanceAccessToken"] === "string" ? adapter["balanceAccessToken"] : "";
          if (adapter["balanceAccessTokenRedacted"] !== true && balanceToken.length > 0) {
            yield* writeSecretStore.set(balanceTokenName, textEncoder.encode(balanceToken)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: `byok:${adapterId}:balanceAccessToken`,
                    cause,
                  }),
              ),
            );
            const stored = adapters.pop() as Record<string, unknown>;
            adapters.push({ ...stored, balanceAccessToken: "", balanceAccessTokenRedacted: true });
          } else if (
            adapter["balanceAccessTokenRedacted"] !== true &&
            balanceToken.length === 0 &&
            Object.prototype.hasOwnProperty.call(adapter, "balanceAccessToken")
          ) {
            yield* writeSecretStore.remove(balanceTokenName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: `byok:${adapterId}:balanceAccessToken`,
                    cause,
                  }),
              ),
            );
            const stored = adapters.pop() as Record<string, unknown>;
            const { balanceAccessTokenRedacted: _omitBalance, ...restBalance } = stored;
            adapters.push(restBalance);
          }
        }
        providerInstances[instanceId] = {
          ...instance,
          config: { ...record, adapters },
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        if (instance.driver !== "byok") continue;
        const config = instance.config;
        if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
        const adapters = (config as Record<string, unknown>)["adapters"];
        if (!Array.isArray(adapters)) continue;
        for (const entry of adapters) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
          const adapterId = (entry as Record<string, unknown>)["id"];
          if (typeof adapterId !== "string" || adapterId.length === 0) continue;
          const balanceTokenName = byokBalanceTokenSecretName({ instanceId, adapterId });
          if (nextSecretNames.has(balanceTokenName)) continue;
          yield* writeSecretStore.remove(balanceTokenName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: `byok:${adapterId}:balanceAccessToken`,
                  cause,
                }),
            ),
          );
        }
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        if (instance.driver !== "byok") continue;
        const config = instance.config;
        if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
        const adapters = (config as Record<string, unknown>)["adapters"];
        if (!Array.isArray(adapters)) continue;
        for (const entry of adapters) {
          if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
          const adapterId = (entry as Record<string, unknown>)["id"];
          if (typeof adapterId !== "string" || adapterId.length === 0) continue;
          const secretName = byokApiKeySecretName({ instanceId, adapterId });
          if (nextSecretNames.has(secretName)) continue;
          yield* writeSecretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: `byok:${adapterId}:apiKey`,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const persistProviderEnvironmentSecrets = (
    current: ServerSettings,
    next: ServerSettings,
    writeSecretStore: ServerSecretStore.ServerSecretStore["Service"],
  ): Effect.Effect<ServerSettings, ServerSettingsError> =>
    Effect.gen(function* () {
      const providerInstances: Record<string, ProviderInstanceConfig> = {
        ...next.providerInstances,
      };

      const nextSecretKeys = new Set<string>();
      for (const [instanceId, instance] of Object.entries(next.providerInstances) as ReadonlyArray<
        readonly [string, ProviderInstanceConfig]
      >) {
        if (!instance.environment) continue;
        const legacyEnvironment = new Map(
          (current.providerInstances[ProviderInstanceId.make(instanceId)]?.environment ?? []).map(
            (variable) => [variable.name, variable],
          ),
        );
        const multicaSecretNames = multicaSecretEnvironmentNames(instance);
        const environment: ProviderInstanceEnvironmentVariable[] = [];
        for (const variable of instance.environment) {
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          const persistedVariable = multicaSecretNames.has(variable.name)
            ? { ...variable, sensitive: true }
            : variable;
          if (!persistedVariable.sensitive) {
            yield* writeSecretStore.remove(secretName).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "remove-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
            environment.push(redactProviderEnvironmentVariable(persistedVariable));
            continue;
          }

          nextSecretKeys.add(secretName);
          if (!persistedVariable.valueRedacted) {
            if (persistedVariable.value.length > 0) {
              yield* writeSecretStore
                .set(secretName, textEncoder.encode(persistedVariable.value))
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ServerSettingsError({
                        settingsPath,
                        operation: "write-secret",
                        providerInstanceId: instanceId,
                        environmentVariable: variable.name,
                        cause,
                      }),
                  ),
                );
              environment.push({ ...persistedVariable, value: "", valueRedacted: true });
            } else {
              yield* writeSecretStore.remove(secretName).pipe(
                Effect.mapError(
                  (cause) =>
                    new ServerSettingsError({
                      settingsPath,
                      operation: "remove-secret",
                      providerInstanceId: instanceId,
                      environmentVariable: variable.name,
                      cause,
                    }),
                ),
              );
              const { valueRedacted: _omit, ...rest } = persistedVariable;
              environment.push(rest);
            }
            continue;
          }

          const legacyVariable = legacyEnvironment.get(variable.name);
          if (
            multicaSecretNames.has(variable.name) &&
            legacyVariable?.sensitive === false &&
            legacyVariable.value.length > 0
          ) {
            yield* writeSecretStore.set(secretName, textEncoder.encode(legacyVariable.value)).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-secret",
                    providerInstanceId: instanceId,
                    environmentVariable: variable.name,
                    cause,
                  }),
              ),
            );
          }
          environment.push(redactProviderEnvironmentVariable(persistedVariable));
        }
        providerInstances[instanceId] = {
          ...instance,
          environment,
        } satisfies ProviderInstanceConfig;
      }

      for (const [instanceId, instance] of Object.entries(current.providerInstances)) {
        for (const variable of instance.environment ?? []) {
          if (!variable.sensitive) continue;
          const secretName = providerEnvironmentSecretName({ instanceId, name: variable.name });
          if (nextSecretKeys.has(secretName)) continue;
          yield* writeSecretStore.remove(secretName).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath,
                  operation: "remove-stale-secret",
                  providerInstanceId: instanceId,
                  environmentVariable: variable.name,
                  cause,
                }),
            ),
          );
        }
      }

      return {
        ...next,
        providerInstances: providerInstances as ServerSettings["providerInstances"],
      };
    });

  const serializeSettings = Effect.fnUntraced(
    function* (settings: ServerSettings) {
      const sparseSettingsJson = yield* encodeServerSettingsJson(
        stripDefaultServerSettings(settings, PERSISTED_SERVER_SETTINGS_DEFAULTS) ?? {},
      );
      return `${sparseSettingsJson}\n`;
    },
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          operation: "write-file",
          cause,
        }),
    ),
  );

  const prepareSettingsUpdate = Effect.fnUntraced(function* (
    current: ServerSettings,
    patch: ServerSettingsPatch,
  ) {
    const patched = yield* applyMulticaProviderInstanceMutation(current, patch);
    const normalizedPatched = yield* normalizeServerSettings(patched, settingsPath);
    const changedMulticaInstanceIds = yield* validateMulticaProviderInstancePreconditions(
      current,
      normalizedPatched,
      patch,
    );
    return assignMulticaProviderInstanceRevisions(
      current,
      normalizedPatched,
      changedMulticaInstanceIds,
    );
  });

  const buildOriginCommitPlan = Effect.fnUntraced(function* (
    current: ServerSettings,
    versioned: ServerSettings,
  ) {
    const secretTransaction = makeServerSettingsSecretTransaction(secretStore);
    const nextWithEnvironmentSecrets = yield* persistProviderEnvironmentSecrets(
      current,
      versioned,
      secretTransaction.store,
    );
    const nextWithMcpSecrets = yield* persistMcpServerSecrets(
      current,
      nextWithEnvironmentSecrets,
      secretTransaction.store,
    );
    const nextPersisted = yield* persistByokSecrets(
      current,
      nextWithMcpSecrets,
      secretTransaction.store,
    );
    const next = yield* normalizeServerSettings(nextPersisted, settingsPath);
    return {
      contents: yield* serializeSettings(next),
      value: next,
      compensate: secretTransaction.compensate.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              operation: "write-secret",
              cause,
            }),
        ),
      ),
    };
  });

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            operation: "prepare-directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(
      Effect.flatMap(materializeProviderEnvironmentSecrets),
      Effect.flatMap(materializeMcpServerSecrets),
      Effect.flatMap(materializeByokSecrets),
      Effect.map(resolveTextGenerationProvider),
    ),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          let currentSnapshot = yield* loadSettingsFromDisk;
          yield* Cache.set(settingsCache, cacheKey, currentSnapshot);
          let prepared = yield* prepareSettingsUpdate(currentSnapshot.settings, patch);
          yield* originCommitHook({ settingsPath, patch, token: currentSnapshot.token });

          while (true) {
            const committed = yield* commitServerSettingsOriginCas({
              settingsPath,
              expectedToken: currentSnapshot.token,
              prepare: buildOriginCommitPlan(currentSnapshot.settings, prepared),
            }).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, pathService),
              Effect.catchTag("ServerSettingsOriginError", (cause) =>
                Effect.fail(
                  new ServerSettingsError({
                    settingsPath,
                    operation: "write-file",
                    cause,
                  }),
                ),
              ),
            );
            if (committed._tag === "Conflict") {
              currentSnapshot = yield* hydrateSettingsOrigin(committed.snapshot);
              yield* Cache.set(settingsCache, cacheKey, currentSnapshot);
              prepared = yield* prepareSettingsUpdate(currentSnapshot.settings, patch);
              continue;
            }

            const next = committed.value;
            yield* Cache.set(settingsCache, cacheKey, {
              ...committed.snapshot,
              settings: next,
            });
            yield* emitChange(next);
            const materializedEnvironment = yield* materializeProviderEnvironmentSecrets(next);
            const materializedMcp = yield* materializeMcpServerSecrets(materializedEnvironment);
            const materialized = yield* materializeByokSecrets(materializedMcp);
            return resolveTextGenerationProvider(materialized);
          }
        }),
      ),
    get streamChanges() {
      return materializeChanges(Stream.fromPubSub(changesPubSub));
    },
    get subscribeChanges() {
      return PubSub.subscribe(changesPubSub).pipe(
        Effect.map((subscription) => materializeChanges(Stream.fromSubscription(subscription))),
      );
    },
  } satisfies ServerSettingsService["Service"];
});

export const layer = Layer.effect(ServerSettingsService, make);
