import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProviderCompatibilityAdvisory } from "@codework/contracts";
import * as Schema from "effect/Schema";

import {
  applyProviderCompatibility,
  ProviderCompatibilityPolicy,
  resolveProviderCompatibility,
} from "./providerCompatibility.ts";

const CODEX = ProviderDriverKind.make("codex");
const CURSOR = ProviderDriverKind.make("cursor");
const ANTIGRAVITY = ProviderDriverKind.make("antigravity");
const MUSE = ProviderDriverKind.make("muse");
const CLAUDE = ProviderDriverKind.make("claudeAgent");

const decodePolicy = Schema.decodeSync(ProviderCompatibilityPolicy);

const basePolicy = {
  driver: "codex",
  appVersionRange: ">=1.0.0",
  recommendedRange: ">=0.90.0",
  recommendedVersion: "0.91.0",
  ranges: [
    { range: ">=0.90.0", status: "supported" },
    { range: ">=0.80.0 <0.90.0", status: "graceful" },
    { range: ">=0.70.0 <0.80.0", status: "unsupported" },
    { range: "<0.70.0", status: "broken" },
  ],
} as const;

const policy = decodePolicy(basePolicy);

describe("ProviderCompatibilityPolicy schema", () => {
  it("accepts a well-formed policy", () => {
    assert.deepStrictEqual(decodePolicy(basePolicy).driver, "codex");
  });

  it("rejects a recommendedVersion outside its recommendedRange", () => {
    assert.throws(() => decodePolicy({ ...basePolicy, recommendedVersion: "0.60.0" }));
  });

  it("rejects a recommendedVersion not in a supported range", () => {
    assert.throws(() => decodePolicy({ ...basePolicy, recommendedRange: ">=0.80.0 <0.90.0" }));
  });

  it("rejects malformed semver ranges", () => {
    assert.throws(() =>
      decodePolicy({ ...basePolicy, ranges: [{ range: "banana", status: "supported" }] }),
    );
  });
});

describe("resolveProviderCompatibility", () => {
  it("resolves supported/graceful/unsupported/broken/unknown by range", () => {
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, "0.95.0", "1.0.28")?.status,
      "supported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, "0.85.0", "1.0.28")?.status,
      "graceful",
    );
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, "0.75.0", "1.0.28")?.status,
      "unsupported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, "0.60.0", "1.0.28")?.status,
      "broken",
    );
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, null, "1.0.28")?.status,
      "unknown",
    );
  });

  it("appends the recommendation to non-supported messages", () => {
    const advisory = resolveProviderCompatibility([policy], CODEX, "0.75.0", "1.0.28");
    assert.strictEqual(advisory?.recommendedVersion, "0.91.0");
    assert.match(advisory?.message ?? "", /Use 0\.91\.0\./);
    const supported = resolveProviderCompatibility([policy], CODEX, "0.95.0", "1.0.28");
    assert.strictEqual(supported?.message, null);
  });

  it("ignores policies whose appVersionRange excludes this app", () => {
    assert.strictEqual(resolveProviderCompatibility([policy], CODEX, "0.95.0", "0.5.0"), undefined);
  });

  it("ignores policies for other drivers", () => {
    assert.strictEqual(
      resolveProviderCompatibility([policy], CLAUDE, "0.95.0", "1.0.28"),
      undefined,
    );
  });

  it("normalizes cursor date-build versions", () => {
    const cursorPolicy = decodePolicy({ ...basePolicy, driver: "cursor" });
    assert.strictEqual(
      resolveProviderCompatibility([cursorPolicy], CURSOR, "2026.01.15-deadbeef", "1.0.28")?.status,
      // 2026.01.15 is >= 0.90.0
      "supported",
    );
  });

  it("normalizes antigravity agy_acp_server prefixes", () => {
    const agPolicy = decodePolicy({ ...basePolicy, driver: "antigravity" });
    assert.strictEqual(
      resolveProviderCompatibility([agPolicy], ANTIGRAVITY, "agy_acp_server_0.85.0", "1.0.28")
        ?.status,
      "graceful",
    );
  });

  it("normalizes muse release revision suffixes", () => {
    const musePolicy = decodePolicy({ ...basePolicy, driver: "muse" });
    assert.strictEqual(
      resolveProviderCompatibility([musePolicy], MUSE, "0.75.0-R12.3", "1.0.28")?.status,
      "unsupported",
    );
  });

  it("keeps prerelease versions unknown instead of guessing", () => {
    assert.strictEqual(
      resolveProviderCompatibility([policy], CODEX, "0.95.0-beta.1", "1.0.28")?.status,
      "unknown",
    );
  });
});

describe("applyProviderCompatibility", () => {
  const snapshot: {
    enabled: boolean;
    installed: boolean;
    version: string;
    versionAdvisory: { latestVersion: string };
    extra: string;
    compatibilityAdvisory?: ServerProviderCompatibilityAdvisory;
  } = {
    enabled: true,
    installed: true,
    version: "0.75.0",
    versionAdvisory: { latestVersion: "0.91.0" },
    extra: "kept",
  };

  it("attaches advisory plus latestVersionStatus", () => {
    const out = applyProviderCompatibility(snapshot, CODEX, undefined, [policy]);
    assert.strictEqual(out.compatibilityAdvisory?.status, "unsupported");
    assert.strictEqual(out.compatibilityAdvisory?.latestVersionStatus, "supported");
    assert.strictEqual(out.extra, "kept");
  });

  it("prefers the remote policy over the bundled fallback", () => {
    const remote = decodePolicy({
      ...basePolicy,
      ranges: [{ range: ">=0.0.0", status: "supported" }],
    });
    const out = applyProviderCompatibility(snapshot, CODEX, [remote], [policy]);
    assert.strictEqual(out.compatibilityAdvisory?.status, "supported");
  });

  it("omits compatibility data for disabled or uninstalled providers", () => {
    assert.strictEqual(
      applyProviderCompatibility({ ...snapshot, enabled: false }, CODEX, [policy], undefined)
        .compatibilityAdvisory,
      undefined,
    );
    assert.strictEqual(
      applyProviderCompatibility({ ...snapshot, installed: false }, CODEX, [policy], undefined)
        .compatibilityAdvisory,
      undefined,
    );
  });

  it("drops a stale advisory when no policy matches", () => {
    const stale = {
      ...snapshot,
      compatibilityAdvisory: {
        status: "broken" as const,
        message: "stale",
        recommendedVersion: null,
        recommendedRange: null,
      },
    };
    const out = applyProviderCompatibility(stale, CLAUDE, [policy], undefined);
    assert.strictEqual(out.compatibilityAdvisory, undefined);
  });
});
