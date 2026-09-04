/**
 * Merges per-environment BYOK balance dashboards into the single view the
 * plan tab renders.
 *
 * Pure, so the de-duplication rules can be tested without a connected
 * environment.
 *
 * @module byokBalanceMerge
 */
import type {
  ByokBalanceAdapterHealth,
  ByokBalanceDashboardAdapter,
  ByokBalanceDashboardResult,
  EnvironmentId,
} from "@codework/contracts";

export interface EnvironmentByokDashboard {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly dashboard: ByokBalanceDashboardResult;
}

export interface MergedByokAdapter {
  /** The environment whose report claimed this adapter — the query target. */
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly instanceLabel: string;
  readonly adapterId: string;
  readonly adapterLabel: string;
  /** Relay endpoint the adapter points at; adapters sharing it share one balance. */
  readonly baseURL: string;
  readonly health: ByokBalanceAdapterHealth;
  readonly balance: ByokBalanceDashboardAdapter["balance"];
}

export interface MergedByokPlans {
  readonly adapters: readonly MergedByokAdapter[];
  readonly okCount: number;
  readonly emptyCount: number;
  readonly unsupportedCount: number;
  readonly errorCount: number;
}

/**
 * One logical plan per `(instanceId, adapterId)`.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same BYOK config and would double-count every supplier. The first
 * environment in a stable order claims a pair, preferring a report whose probe
 * did not fail over one that did, so a flaky remote never masks a healthy
 * local answer. Disabled instances are skipped: they are not consuming plan.
 */
export function mergeByokDashboards(
  environments: readonly EnvironmentByokDashboard[],
): MergedByokPlans {
  const byPair = new Map<string, MergedByokAdapter>();

  const ordered = [...environments].sort((a, b) => a.environmentId.localeCompare(b.environmentId));
  for (const environment of ordered) {
    const { dashboard, environmentId } = environment;
    for (const instance of dashboard.instances) {
      if (!instance.enabled) continue;
      for (const adapter of instance.adapters) {
        const key = `${instance.instanceId}:${adapter.adapterId}`;
        const existing = byPair.get(key);
        if (existing !== undefined && existing.health !== "error") continue;
        byPair.set(key, {
          environmentId,
          instanceId: instance.instanceId,
          instanceLabel: instance.displayName ?? instance.instanceId,
          adapterId: adapter.adapterId,
          adapterLabel: adapter.displayName ?? adapter.adapterId,
          baseURL: adapter.baseURL ?? "",
          health: adapter.health,
          balance: adapter.balance,
        });
      }
    }
  }

  const adapters = [...byPair.values()];
  const count = (health: ByokBalanceAdapterHealth) =>
    adapters.filter((adapter) => adapter.health === health).length;

  return {
    adapters,
    okCount: count("ok"),
    emptyCount: count("empty"),
    unsupportedCount: count("unsupported"),
    errorCount: count("error"),
  };
}
