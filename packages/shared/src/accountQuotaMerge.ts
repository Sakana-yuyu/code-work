/**
 * Merges per-environment first-party account quota reports into the flat
 * provider list the usage page renders.
 *
 * Pure, so the de-duplication rules can be tested without a connected
 * environment.
 *
 * @module accountQuotaMerge
 */
import type {
  AccountQuotaProviderState,
  AccountQuotaResult,
  EnvironmentId,
} from "@codework/contracts";

export interface EnvironmentAccountQuota {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly result: AccountQuotaResult;
}

export interface MergedAccountQuotaProvider {
  /** The environment whose report won — where the quota was observed. */
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly provider: string;
  readonly planName?: string;
  readonly windows: AccountQuotaProviderState["windows"];
  readonly updatedAtUnixMs: number;
}

/**
 * One logical card per provider.
 *
 * Several environments on one machine (worktree servers, for instance) share
 * the same `~/.codex`/`~/.claude` accounts and would show the same
 * subscription twice. The freshest report claims the provider slot, so a
 * stale worktree server never masks a current answer; genuinely distinct
 * machines cannot be told apart at this layer and keep the freshest voice.
 */
export function mergeAccountQuota(
  environments: readonly EnvironmentAccountQuota[],
): readonly MergedAccountQuotaProvider[] {
  const claimed = new Map<string, MergedAccountQuotaProvider>();
  for (const environment of environments) {
    for (const state of environment.result.providers) {
      const current = claimed.get(state.provider);
      if (current !== undefined && current.updatedAtUnixMs >= state.updatedAtUnixMs) {
        continue;
      }
      claimed.set(state.provider, {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        provider: state.provider,
        ...(state.planName !== undefined ? { planName: state.planName } : {}),
        windows: state.windows,
        updatedAtUnixMs: state.updatedAtUnixMs,
      });
    }
  }
  return [...claimed.values()].sort((left, right) => left.provider.localeCompare(right.provider));
}
