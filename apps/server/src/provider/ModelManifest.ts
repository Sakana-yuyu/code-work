/**
 * ModelManifest — decides which provider models are current and which belong
 * in the model picker's legacy section.
 *
 * The classification data (current slugs per driver kind) lives in
 * `model-manifest.json` next to this file. The bundled copy ships with every
 * release. At runtime the service refreshes it from the same file on `main`
 * via raw.githubusercontent.com, so a new model can leave the legacy section
 * with a commit to `main` instead of a release. Preference order is remote,
 * then the on-disk copy of the last successful fetch, then the bundle. A
 * failed fetch never fails a provider check.
 *
 * Drivers apply the manifest to snapshot drafts with `applyModelManifest`
 * before publishing, so every path that produces models (pending, probe,
 * error fallbacks) is classified the same way.
 */
import {
  ModelCapabilities,
  ProviderDriverKind,
  TrimmedNonEmptyString,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/http";

import { compareSemverVersions, parseSemver } from "@codework/shared/semver";
import { ProviderCompatibilityPolicy } from "./providerCompatibility.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const MODEL_MANIFEST_URL =
  "https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json";

/** How long a fetched manifest stays fresh before the next probe re-fetches. */
const MANIFEST_TTL_MS = 60 * 60 * 1000;

/** Minimum gap between fetch attempts after a failure, so an offline server
 * does not pay a network timeout on every provider check. */
const MANIFEST_RETRY_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Model catalog metadata. `current` models stay in the picker's primary
 * section; `legacy` models move to the legacy section. Driver-specific
 * compatibility (`adapter.claudeCode.minVersion`, `adapter.codex.minVersion`)
 * marks a catalog model as usable only once the installed CLI is new enough —
 * such models surface through `updateRequiredModels` instead of the picker.
 * `maxVersionExclusive` retires an announcement once the CLI bundles the
 * model directly.
 */
const ManifestModelStatus = Schema.Literals(["current", "legacy"]);
export type ManifestModelStatus = typeof ManifestModelStatus.Type;

/** Runtime metadata a catalog model can inherit via `profile`. */
const ManifestModelProfile = Schema.Struct({
  capabilities: Schema.optional(ModelCapabilities),
});
export type ManifestModelProfile = typeof ManifestModelProfile.Type;

const ManifestClaudeCodeCompatibility = Schema.Struct({
  minVersion: Schema.optional(Schema.String),
  maxVersionExclusive: Schema.optional(Schema.String),
});
export type ManifestClaudeCodeCompatibility = typeof ManifestClaudeCodeCompatibility.Type;

const ManifestCodexCompatibility = Schema.Struct({
  minVersion: Schema.optional(Schema.String),
});
export type ManifestCodexCompatibility = typeof ManifestCodexCompatibility.Type;

const ManifestModelAdapters = Schema.Struct({
  claudeCode: Schema.optional(ManifestClaudeCodeCompatibility),
  codex: Schema.optional(ManifestCodexCompatibility),
});
export type ManifestModelAdapters = typeof ManifestModelAdapters.Type;

const ManifestProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  status: Schema.optional(ManifestModelStatus),
  badge: Schema.optional(Schema.Literal("new")),
  profile: Schema.optional(Schema.String),
  adapter: Schema.optional(ManifestModelAdapters),
});
export type ManifestProviderModel = typeof ManifestProviderModel.Type;

const ManifestProviderCatalog = Schema.Struct({
  models: Schema.optional(Schema.Array(ManifestProviderModel)),
  profiles: Schema.optional(Schema.Record(Schema.String, ManifestModelProfile)),
  defaults: Schema.optional(Schema.Struct({ chat: Schema.optional(Schema.String) })),
});
export type ManifestProviderCatalog = typeof ManifestProviderCatalog.Type;

/**
 * `version` gates breaking schema changes: a build only accepts remote
 * manifests whose version it understands, and keeps its bundled copy
 * otherwise. `currentModels` is keyed by driver kind; kinds absent from the
 * map have no legacy concept and their models are left unflagged. `providers`
 * carries the remote-refreshable model catalog per driver kind.
 */
const ModelManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.optional(Schema.String),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  providers: Schema.optional(Schema.Record(ProviderDriverKind, ManifestProviderCatalog)),
  compatibility: Schema.optional(Schema.Array(ProviderCompatibilityPolicy)),
});
export type ModelManifestData = typeof ModelManifestSchema.Type;

const decodeManifest = Schema.decodeUnknownEffect(ModelManifestSchema);

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

/** On-disk shape of the last successfully fetched manifest. */
const ManifestCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  manifest: ModelManifestSchema,
});
const decodeManifestCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ManifestCacheFile as unknown as Schema.Codec<typeof ManifestCacheFile.Type>,
  ),
);
const encodeManifestCache = Schema.encodeEffect(
  Schema.fromJsonString(
    ManifestCacheFile as unknown as Schema.Codec<typeof ManifestCacheFile.Type>,
  ),
);

/** True when the manifest classifies `slug` as legacy for `driverKind`. */
export function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  return !currentModels.includes(slug);
}

/**
 * Decoded catalog section for one driver kind; `null` when the manifest
 * carries no catalog for the kind. Profile resolution happens here so every
 * consumer sees capabilities already applied.
 */
export interface ResolvedManifestCatalogModel {
  readonly entry: ManifestProviderModel;
  readonly capabilities: ModelCapabilities | null;
}

export function providerCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ManifestProviderCatalog | null {
  return manifest.providers?.[driverKind] ?? null;
}

function resolveCatalogModels(
  catalog: ManifestProviderCatalog,
): ReadonlyArray<ResolvedManifestCatalogModel> {
  return (catalog.models ?? []).map((entry) => ({
    entry,
    capabilities:
      (entry.profile ? catalog.profiles?.[entry.profile]?.capabilities : undefined) ?? null,
  }));
}

/** True when `version` satisfies the compatibility window; a null version
 * satisfies a model without a `minVersion` gate so unknown-version providers
 * keep their full catalog rather than losing every gated model. */
function versionSatisfies(
  version: string | null | undefined,
  minVersion: string | undefined,
  maxVersionExclusive: string | undefined,
): boolean {
  if (minVersion !== undefined) {
    if (!version || parseSemver(version) === null) return false;
    if (compareSemverVersions(version, minVersion) < 0) return false;
  }
  if (
    maxVersionExclusive !== undefined &&
    version !== null &&
    version !== undefined &&
    parseSemver(version) !== null &&
    compareSemverVersions(version, maxVersionExclusive) >= 0
  ) {
    return false;
  }
  return true;
}

function catalogEntryToServerModel(
  { entry, capabilities }: ResolvedManifestCatalogModel,
  defaultChatSlug: string | undefined,
): ServerProviderModel {
  return {
    slug: entry.slug,
    name: entry.name,
    ...(entry.shortName !== undefined ? { shortName: entry.shortName } : {}),
    ...(entry.subProvider !== undefined ? { subProvider: entry.subProvider } : {}),
    ...(entry.aliases !== undefined && entry.aliases.length > 0 ? { aliases: entry.aliases } : {}),
    ...(entry.badge !== undefined ? { badge: entry.badge } : {}),
    isCustom: false,
    ...(defaultChatSlug === entry.slug ? { isDefault: true } : {}),
    ...(entry.status === "legacy" ? { isLegacy: true } : {}),
    capabilities,
  };
}

/**
 * Lowest minimum version across the gated models — the version a user must
 * reach before the whole blocked set unlocks, surfaced in the upgrade
 * message and the picker's update-required notice.
 */
function lowestRequiredVersion(gated: ReadonlyArray<{ minVersion: string }>): string {
  return gated.reduce(
    (lowest, { minVersion }) =>
      compareSemverVersions(minVersion, lowest) < 0 ? minVersion : lowest,
    gated[0]!.minVersion,
  );
}

/**
 * Normalizes a Codex model slug into its product family so a catalog
 * announcement does not double-list a model the CLI already reports under a
 * different label (e.g. `gpt-5.3-codex-spark` vs `gpt-5.3 Codex Spark`).
 */
export function codexModelFamily(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface CatalogApplyResult {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly updateRequiredModels: ReadonlyArray<ServerProviderUpdateRequiredModel>;
  readonly versionUpgradeMessage: string | null;
}

function applyClaudeCatalog(
  draft: ServerProviderDraft,
  catalog: ManifestProviderCatalog,
): CatalogApplyResult {
  const resolved = resolveCatalogModels(catalog);
  // A draft that never probed the CLI (disabled or still pending) has no
  // version to gate on; it keeps the full catalog so the settings preview
  // is not degraded. An installed CLI with an unparsable version keeps the
  // historical behavior: gated models drop out silently.
  const version = draft.installed ? draft.version : undefined;
  const gated: Array<{ entry: ManifestProviderModel; minVersion: string }> = [];
  const available: ResolvedManifestCatalogModel[] = [];
  for (const model of resolved) {
    const compat = model.entry.adapter?.claudeCode;
    if (
      version !== undefined &&
      !versionSatisfies(version, compat?.minVersion, compat?.maxVersionExclusive)
    ) {
      // Only current-generation models are announced as update targets;
      // legacy models gate out silently.
      if (model.entry.status !== "legacy" && compat?.minVersion !== undefined && version !== null) {
        gated.push({ entry: model.entry, minVersion: compat.minVersion });
      }
      continue;
    }
    available.push(model);
  }

  const customSlugs = new Set(
    draft.models.filter((model) => model.isCustom).map((model) => model.slug),
  );
  const defaultChatSlug = catalog.defaults?.chat;
  const catalogModels = available
    .filter((model) => !customSlugs.has(model.entry.slug))
    .map((model) => catalogEntryToServerModel(model, defaultChatSlug));
  const customModels = draft.models.filter((model) => model.isCustom);

  // `updateRequiredModels` only exists once a concrete version proves the
  // CLI is too old; a versionless draft cannot announce a required update.
  const updateRequiredModels: ServerProviderUpdateRequiredModel[] =
    version != null
      ? gated.map(({ entry, minVersion }) => ({
          slug: entry.slug,
          name: entry.name,
          ...(entry.badge !== undefined ? { badge: entry.badge } : {}),
          minVersion,
        }))
      : [];

  // The probe message names the model gated at the lowest required CLI
  // version — the first model a user unlocks by upgrading. The picker
  // notice lists every gated model.
  const versionUpgradeMessage = (() => {
    if (gated.length === 0 || draft.status !== "ready" || version == null) return null;
    const lowest = lowestRequiredVersion(gated);
    const model = gated.find(({ minVersion }) => minVersion === lowest);
    if (!model) return null;
    return `Update Claude Code to v${lowest} or newer to use ${model.entry.name}.`;
  })();

  return {
    models: [...catalogModels, ...customModels],
    updateRequiredModels,
    versionUpgradeMessage,
  };
}

function applyCodexCatalog(
  draft: ServerProviderDraft,
  catalog: ManifestProviderCatalog,
): Pick<CatalogApplyResult, "updateRequiredModels"> {
  // Codex models come from the CLI itself; the manifest only announces
  // newer ones. A draft without a probed version cannot claim an update
  // is required.
  if (!draft.installed || draft.version == null) {
    return { updateRequiredModels: [] };
  }
  const version = draft.version;
  const discovered = new Set(draft.models.map((model) => codexModelFamily(model.slug)));
  const updateRequiredModels: ServerProviderUpdateRequiredModel[] = [];
  for (const entry of catalog.models ?? []) {
    if (entry.status !== "current") continue;
    const minVersion = entry.adapter?.codex?.minVersion;
    if (minVersion === undefined) continue;
    if (discovered.has(codexModelFamily(entry.slug))) continue;
    if (versionSatisfies(version, minVersion, undefined)) continue;
    updateRequiredModels.push({
      slug: entry.slug,
      name: entry.name,
      ...(entry.badge !== undefined ? { badge: entry.badge } : {}),
      minVersion,
    });
  }
  return { updateRequiredModels };
}

/**
 * Applies the manifest to a provider snapshot draft. For drivers with a
 * manifest catalog (`claudeAgent`), the catalog replaces the built-in list:
 * entries gated by `adapter.<driver>.minVersion` above the installed CLI
 * version move to `updateRequiredModels` and set the probe upgrade message.
 * For drivers without a catalog (`codex`), the CLI-reported list stands and
 * current-status announcements the CLI cannot run yet become
 * `updateRequiredModels`. Custom models are never reclassified or dropped.
 */
export function applyModelManifest(
  draft: ServerProviderDraft,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return applyManifestModels(draft, manifest, driverKind);
}

function applyManifestModels(
  draft: ServerProviderDraft,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  const catalog = providerCatalog(manifest, driverKind);
  if (catalog === null || (catalog.models ?? []).length === 0) {
    return { ...draft, models: classifyModels(draft.models, manifest, driverKind) };
  }

  if (driverKind === "claudeAgent") {
    const applied = applyClaudeCatalog(draft, catalog);
    return {
      ...draft,
      ...(applied.versionUpgradeMessage !== null && draft.message === undefined
        ? { message: applied.versionUpgradeMessage }
        : {}),
      models: applied.models,
      ...(applied.updateRequiredModels.length > 0
        ? { updateRequiredModels: applied.updateRequiredModels }
        : {}),
    };
  }

  if (driverKind === "codex") {
    const { updateRequiredModels } = applyCodexCatalog(draft, catalog);
    return {
      ...draft,
      models: classifyModels(draft.models, manifest, driverKind),
      ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
    };
  }

  return { ...draft, models: classifyModels(draft.models, manifest, driverKind) };
}

/** Model-level half of `applyModelManifest`, exported for focused tests. */
export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    if (isLegacyModel(manifest, driverKind, model.slug)) {
      return model.isLegacy ? model : { ...model, isLegacy: true };
    }
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    /** Manifest already in memory (disk cache or bundle); never fetches.
     * Snapshot classification reads this, so it never waits on the network. */
    readonly current: Effect.Effect<ModelManifestData>;
    /** Manifest after a TTL-gated remote refresh; never fails. */
    readonly refresh: Effect.Effect<ModelManifestData>;
    /** Forks `refresh` into the service's own scope. Drivers call this from
     * provider checks: the fetch is process-shared state, so it must survive
     * the teardown of whichever instance happened to trigger it. */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("codework/provider/ModelManifest") {}

/** Constant service for tests and callers that only need the bundled data. */
export const BundledOnlyModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refresh: Effect.succeed(BUNDLED_MODEL_MANIFEST),
  refreshInBackground: Effect.void,
};

export const layerTest = Layer.succeed(ModelManifest, BundledOnlyModelManifest);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const serviceScope = yield* Effect.scope;

  const cachePath = path.join(config.stateDir, "model-manifest.json");
  let manifest = BUNDLED_MODEL_MANIFEST;
  let fetchedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  const refreshSemaphore = yield* Semaphore.make(1);

  // `Effect.cached` makes concurrent first readers await the same disk load
  // rather than racing a "loaded" flag. Only `refreshed` takes the fetch
  // semaphore; `current` must never wait behind an in-flight network refresh.
  const ensureDiskCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const fromDisk = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeManifestCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk === null) return;
      // The disk copy is the last-seen remote manifest, so it outranks the
      // bundle even when stale: it is refreshed on the next successful fetch.
      manifest = fromDisk.manifest;
      fetchedAtMs = fromDisk.fetchedAtMs;
    }),
  );

  const refresh = Effect.fn("ModelManifest.refresh")(function* () {
    yield* ensureDiskCacheLoaded;
    const now = yield* Clock.currentTimeMillis;
    // A timestamp in the future means the wall clock moved backwards (the
    // disk cache crosses restarts, so monotonic time cannot cover it). Treat
    // it as expired: the refetch rewrites both timestamps and self-heals.
    const isWithin = (sinceMs: number | null, windowMs: number) =>
      sinceMs !== null && now >= sinceMs && now - sinceMs < windowMs;
    if (isWithin(fetchedAtMs, MANIFEST_TTL_MS)) return manifest;
    if (isWithin(lastAttemptMs, MANIFEST_RETRY_MS)) return manifest;

    // The same switch that gates provider CLI update checks. It stops network
    // fetches only: a manifest already cached on disk from an earlier fetch
    // stays in effect, since the setting is about phoning home, not about
    // discarding data the server already holds.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings !== null && !settings.enableProviderUpdateChecks) return manifest;

    lastAttemptMs = now;
    const fetched = yield* httpClient.get(MODEL_MANIFEST_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((json) => decodeManifest(json)),
      Effect.timeout(FETCH_TIMEOUT_MS),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) return manifest;

    manifest = fetched;
    fetchedAtMs = now;
    yield* encodeManifestCache({ fetchedAtMs: now, manifest: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(cachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
    return manifest;
  });

  const guardedRefresh = refreshSemaphore.withPermits(1)(refresh());

  return ModelManifest.of({
    current: ensureDiskCacheLoaded.pipe(Effect.map(() => manifest)),
    refresh: guardedRefresh,
    refreshInBackground: Effect.forkIn(guardedRefresh, serviceScope).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ModelManifest, make);
