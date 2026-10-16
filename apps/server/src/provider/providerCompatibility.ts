import {
  TrimmedNonEmptyString,
  ServerProviderCompatibilityStatus,
  type ProviderDriverKind,
  type ServerProviderCompatibilityAdvisory,
} from "@codework/contracts";
import { satisfiesSemverRange } from "@codework/shared/semver";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };

// Deliberately uses the shared CLI gate syntax: comparator groups joined by ||.
// Prereleases and unrecognized release tags remain unknown.
const StableVersion = TrimmedNonEmptyString.pipe(
  Schema.check(Schema.makeFilter((value) => /^\d+\.\d+\.\d+$/.test(value))),
);
const VersionRange = TrimmedNonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter((value) =>
      value.split("||").every((group) => {
        const tokens = group.trim().split(/\s+/);
        return tokens.every((token) => /^(?:\^|>=|>|<=|<|=)?v?\d+(?:\.\d+){0,2}$/.test(token));
      }),
    ),
  ),
);
const Policy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  appVersionRange: VersionRange,
  recommendedRange: Schema.optionalKey(VersionRange),
  recommendedVersion: Schema.optionalKey(StableVersion),
  ranges: Schema.Array(
    Schema.Struct({
      range: VersionRange,
      status: ServerProviderCompatibilityStatus,
    }),
  ),
});

export const ProviderCompatibilityPolicy = Policy.pipe(
  Schema.check(
    Schema.makeFilter(
      (policy) => {
        const version = policy.recommendedVersion;
        if (version === undefined) return true;
        return (
          (policy.recommendedRange === undefined ||
            satisfiesSemverRange(version, policy.recommendedRange)) &&
          policy.ranges.find((entry) => satisfiesSemverRange(version, entry.range))?.status ===
            "supported"
        );
      },
      { expected: "a recommended version in a supported range" },
    ),
  ),
);
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

export function resolveProviderCompatibility(
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  driver: ProviderDriverKind,
  version: string | null,
  appVersion = packageJson.version,
): ServerProviderCompatibilityAdvisory | undefined {
  const policy = policies?.find(
    (entry) => entry.driver === driver && satisfiesSemverRange(appVersion, entry.appVersionRange),
  );
  if (!policy) return undefined;
  const unprefixed = version?.replace(/^v/, "");
  // Cursor appends a build hash to its date; Google's ACP runtime uses a release prefix;
  // Muse appends a release revision. Strip only these driver-specific forms, keeping
  // semver prereleases unknown.
  const stable =
    driver === "cursor"
      ? unprefixed?.replace(/^(\d{4}\.\d{2}\.\d{2})-[a-f0-9]+$/, "$1")
      : driver === "antigravity"
        ? unprefixed?.replace(/^agy_acp_server_(\d+\.\d+\.\d+)$/, "$1")
        : driver === "muse"
          ? unprefixed?.replace(/^(\d+\.\d+\.\d+)-R\d+(?:\.\d+)?$/, "$1")
          : unprefixed;
  const status =
    stable && /^\d+\.\d+\.\d+$/.test(stable)
      ? (policy.ranges.find((entry) => satisfiesSemverRange(stable, entry.range))?.status ??
        "unknown")
      : "unknown";
  const message =
    status === "broken"
      ? "This provider version is known to be incompatible with this Code Work release."
      : status === "unsupported"
        ? "This provider version is outside the supported range for this Code Work release."
        : status === "graceful"
          ? "This provider version has limited compatibility with this Code Work release."
          : null;
  const recommendedVersion = policy.recommendedVersion ?? null;
  const recommendedRange = policy.recommendedRange ?? null;
  const recommendation = recommendedVersion ?? recommendedRange;
  return {
    status,
    message: message && recommendation ? `${message} Use ${recommendation}.` : message,
    recommendedVersion,
    recommendedRange,
  };
}

/** A remote policy replaces its matching bundled policy; omission keeps the bundle. */
export function applyProviderCompatibility<
  T extends {
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly version: string | null;
    readonly versionAdvisory?: { readonly latestVersion: string | null } | undefined;
    readonly compatibilityAdvisory?: ServerProviderCompatibilityAdvisory | undefined;
  },
>(
  snapshot: T,
  driver: ProviderDriverKind,
  policies: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
  fallback: ReadonlyArray<ProviderCompatibilityPolicy> | undefined,
): T {
  const { compatibilityAdvisory: _previous, ...base } = snapshot;
  if (!snapshot.enabled || !snapshot.installed) return base as T;
  const advisory =
    resolveProviderCompatibility(policies, driver, snapshot.version) ??
    resolveProviderCompatibility(fallback, driver, snapshot.version);
  const latestVersion = snapshot.versionAdvisory?.latestVersion;
  const latestAdvisory = latestVersion
    ? (resolveProviderCompatibility(policies, driver, latestVersion) ??
      resolveProviderCompatibility(fallback, driver, latestVersion))
    : undefined;
  return advisory
    ? ({
        ...base,
        compatibilityAdvisory: {
          ...advisory,
          ...(latestAdvisory ? { latestVersionStatus: latestAdvisory.status } : {}),
        },
      } as T)
    : (base as T);
}
