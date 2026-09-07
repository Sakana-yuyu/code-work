import type { AccountQuotaResult, EnvironmentId, ProviderDriverKind } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeAccountQuota, type EnvironmentAccountQuota } from "./accountQuotaMerge.ts";

const environmentId = (value: string) => value as EnvironmentId;
const driverKind = (value: string) => value as ProviderDriverKind;

function environment(
  id: string,
  label: string,
  providers: readonly {
    readonly provider: string;
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

  it("returns an empty list when no environment reported anything", () => {
    expect(mergeAccountQuota([])).toEqual([]);
  });
});
