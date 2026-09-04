import type { ByokBalanceDashboardResult, EnvironmentId } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeByokDashboards, type EnvironmentByokDashboard } from "./byokBalanceMerge.ts";

function dashboard(
  instances: readonly {
    readonly instanceId: string;
    readonly displayName?: string;
    readonly enabled?: boolean;
    readonly adapters: readonly {
      readonly adapterId: string;
      readonly displayName?: string;
      readonly health: "ok" | "empty" | "unsupported" | "error";
    }[];
  }[],
): ByokBalanceDashboardResult {
  return {
    generatedAtUnixMs: 0,
    totals: {
      instanceCount: instances.length,
      adapterCount: 0,
      okCount: 0,
      emptyCount: 0,
      unsupportedCount: 0,
      errorCount: 0,
    },
    instances: instances.map((instance) => ({
      instanceId: instance.instanceId,
      displayName: instance.displayName,
      enabled: instance.enabled ?? true,
      health: "ok" as const,
      adapters: instance.adapters.map((adapter) => ({
        adapterId: adapter.adapterId,
        displayName: adapter.displayName,
        health: adapter.health,
        balance: {
          instanceId: instance.instanceId,
          adapterId: adapter.adapterId,
          supported: adapter.health !== "unsupported",
          source: "test",
          currency: "USD",
          unlimited: false,
          windows: [],
          message: "",
          transient: false,
        },
      })),
    })),
  };
}

function environment(
  environmentId: string,
  dashboard: ByokBalanceDashboardResult,
): EnvironmentByokDashboard {
  return { environmentId: environmentId as EnvironmentId, label: environmentId, dashboard };
}

describe("mergeByokDashboards", () => {
  it("flattens enabled instances into stable adapter rows", () => {
    const merged = mergeByokDashboards([
      environment(
        "env-b",
        dashboard([
          {
            instanceId: "glm",
            displayName: "GLM Coding Plan",
            adapters: [{ adapterId: "coding", displayName: "GLM Coding", health: "ok" }],
          },
        ]),
      ),
      environment(
        "env-a",
        dashboard([
          {
            instanceId: "ark",
            adapters: [
              { adapterId: "seed", health: "ok" },
              { adapterId: "broken", health: "error" },
            ],
          },
          { instanceId: "off", enabled: false, adapters: [{ adapterId: "x", health: "ok" }] },
        ]),
      ),
    ]);

    expect(merged.adapters.map((adapter) => adapter.adapterId)).toEqual([
      "seed",
      "broken",
      "coding",
    ]);
    expect(merged.adapters[0]?.instanceLabel).toBe("ark");
    expect(merged.adapters[2]?.instanceLabel).toBe("GLM Coding Plan");
    expect(merged.okCount).toBe(2);
    expect(merged.errorCount).toBe(1);
  });

  it("claims a duplicate pair once, preferring the healthy report", () => {
    const merged = mergeByokDashboards([
      environment(
        "env-b",
        dashboard([{ instanceId: "glm", adapters: [{ adapterId: "coding", health: "ok" }] }]),
      ),
      // A worktree server on the same machine resolving the same BYOK config,
      // but with a failed probe this time.
      environment(
        "env-a",
        dashboard([{ instanceId: "glm", adapters: [{ adapterId: "coding", health: "error" }] }]),
      ),
    ]);

    expect(merged.adapters).toHaveLength(1);
    expect(merged.adapters[0]?.health).toBe("ok");
    expect(merged.errorCount).toBe(0);
  });

  it("keeps an error report when no environment answered healthily", () => {
    const merged = mergeByokDashboards([
      environment(
        "env-a",
        dashboard([{ instanceId: "glm", adapters: [{ adapterId: "coding", health: "error" }] }]),
      ),
    ]);

    expect(merged.adapters).toHaveLength(1);
    expect(merged.errorCount).toBe(1);
  });

  it("returns empty totals with no environments", () => {
    expect(mergeByokDashboards([])).toEqual({
      adapters: [],
      okCount: 0,
      emptyCount: 0,
      unsupportedCount: 0,
      errorCount: 0,
    });
  });
});
