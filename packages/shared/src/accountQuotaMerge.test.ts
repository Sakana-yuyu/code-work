import type {
  AccountQuotaResult,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUsageLimitsCommand,
  mergeAccountQuota,
  quotaWindowElapsedFraction,
  quotaWindowRemainingPercent,
  type EnvironmentAccountQuota,
} from "./accountQuotaMerge.ts";

const environmentId = (value: string) => value as EnvironmentId;
const driverKind = (value: string) => value as ProviderDriverKind;

function environment(
  id: string,
  label: string,
  providers: readonly {
    readonly provider: string;
    readonly providerInstanceId?: string;
    readonly planName?: string;
    readonly windows: readonly { readonly id: string; readonly usedFraction: number }[];
    readonly updatedAtUnixMs: number;
  }[],
): EnvironmentAccountQuota {
  return {
    environmentId: environmentId(id),
    label,
    result: {
      generatedAtUnixMs: 0,
      providers: providers.map((provider) => ({
        provider: driverKind(provider.provider),
        ...(provider.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: provider.providerInstanceId as ProviderInstanceId }),
        ...(provider.planName === undefined ? {} : { planName: provider.planName }),
        windows: provider.windows.map((window) => ({
          id: window.id,
          label: window.id,
          usedFraction: window.usedFraction,
          status: "ok" as const,
        })),
        updatedAtUnixMs: provider.updatedAtUnixMs,
      })),
    } satisfies AccountQuotaResult,
  };
}

describe("mergeAccountQuota", () => {
  it("keeps one card per provider with the freshest environment claiming it", () => {
    const merged = mergeAccountQuota([
      environment("env-b", "Worktree", [
        {
          provider: "codex",
          windows: [{ id: "primary", usedFraction: 0.1 }],
          updatedAtUnixMs: 100,
        },
      ]),
      environment("env-a", "Local", [
        {
          provider: "codex",
          windows: [{ id: "primary", usedFraction: 0.9 }],
          updatedAtUnixMs: 200,
        },
        {
          provider: "claudeAgent",
          windows: [{ id: "five_hour", usedFraction: 0.2 }],
          updatedAtUnixMs: 200,
        },
      ]),
    ]);

    expect(merged.map((provider) => provider.provider)).toEqual(["claudeAgent", "codex"]);
    const codex = merged.find((provider) => provider.provider === "codex");
    expect(codex?.environmentLabel).toBe("Local");
    expect(codex?.windows[0]?.usedFraction).toBe(0.9);
  });

  it("carries the plan name of the winning report", () => {
    const merged = mergeAccountQuota([
      environment("env-1", "Local", [
        {
          provider: "codex",
          planName: "pro",
          windows: [{ id: "primary", usedFraction: 0.5 }],
          updatedAtUnixMs: 10,
        },
      ]),
    ]);

    expect(merged[0]?.planName).toBe("pro");
  });

  it("keeps two configured instances of one driver as separate accounts", () => {
    const merged = mergeAccountQuota([
      environment("env-1", "Local", [
        {
          provider: "codex",
          providerInstanceId: "codex-personal",
          windows: [{ id: "primary", usedFraction: 0.1 }],
          updatedAtUnixMs: 100,
        },
        {
          provider: "codex",
          providerInstanceId: "codex-work",
          windows: [{ id: "primary", usedFraction: 0.9 }],
          updatedAtUnixMs: 100,
        },
      ]),
      // The same account pushed from another environment merges into the
      // instance slot rather than producing a duplicate card.
      environment("env-2", "Worktree", [
        {
          provider: "codex",
          providerInstanceId: "codex-work",
          windows: [{ id: "primary", usedFraction: 0.5 }],
          updatedAtUnixMs: 50,
        },
      ]),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((p) => p.providerInstanceId)).toEqual(["codex-personal", "codex-work"]);
    const work = merged.find((p) => p.providerInstanceId === "codex-work");
    expect(work?.environmentLabel).toBe("Local");
    expect(work?.windows[0]?.usedFraction).toBe(0.9);
  });

  it("keeps the driver default slot distinct from named instances", () => {
    const merged = mergeAccountQuota([
      environment("env-1", "Local", [
        {
          provider: "codex",
          windows: [{ id: "primary", usedFraction: 0.1 }],
          updatedAtUnixMs: 100,
        },
        {
          provider: "codex",
          providerInstanceId: "codex-work",
          windows: [{ id: "primary", usedFraction: 0.9 }],
          updatedAtUnixMs: 100,
        },
      ]),
    ]);

    expect(merged).toHaveLength(2);
  });

  it("returns an empty list when no environment reported anything", () => {
    expect(mergeAccountQuota([])).toEqual([]);
  });
});

describe("isUsageLimitsCommand", () => {
  it("matches the bare command and rejects prompts that merely start with it", () => {
    expect(isUsageLimitsCommand("/usage-limits")).toBe(true);
    expect(isUsageLimitsCommand("  /usage-limits  ")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits now")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
    expect(isUsageLimitsCommand("hey /usage-limits")).toBe(false);
  });
});

describe("quotaWindowRemainingPercent", () => {
  it("inverts usedFraction into a clamped 0–100 remainder", () => {
    expect(
      quotaWindowRemainingPercent({ id: "p", label: "", usedFraction: 0.42, status: "ok" }),
    ).toBe(58);
    expect(
      quotaWindowRemainingPercent({ id: "p", label: "", usedFraction: 1.4, status: "exhausted" }),
    ).toBe(0);
    expect(quotaWindowRemainingPercent({ id: "p", label: "", status: "unknown" })).toBeNull();
  });
});

describe("quotaWindowElapsedFraction", () => {
  const window = {
    id: "primary",
    label: "5 hours",
    usedFraction: 0.5,
    resetsAt: "2026-01-01T00:00:00.000Z",
    windowDurationMins: 300,
    status: "ok" as const,
  };

  it("derives elapsed share of the rolling window from resetsAt", () => {
    const halfway = Date.parse("2025-12-31T21:30:00.000Z"); // 2.5h before reset of a 5h window
    expect(quotaWindowElapsedFraction(window, halfway)).toBe(0.5);
  });

  it("clamps at both ends and stays null without duration", () => {
    expect(quotaWindowElapsedFraction(window, Date.parse(window.resetsAt))).toBe(1);
    const { windowDurationMins: _drop, ...noDuration } = window;
    expect(quotaWindowElapsedFraction(noDuration, 0)).toBeNull();
  });
});
