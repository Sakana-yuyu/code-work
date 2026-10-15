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
  AccountQuotaWindow,
  EnvironmentId,
} from "@codework/contracts";

/** The client-answered composer command that opens the limits panel. */
export const USAGE_LIMITS_COMMAND = "/usage-limits";

/** `/usage-limits` typed out in full, optionally followed by whitespace. */
export function isUsageLimitsCommand(text: string): boolean {
  return /^\/usage-limits\s*$/.test(text.trim());
}

/**
 * Provider-owned web dashboard showing the same subscription quota, where one
 * exists (upstream Codex managed accounts link to the ChatGPT usage page).
 * The link is static — it never carries credentials or account identifiers.
 */
export function externalUsageLinkForProvider(
  provider: string,
): { readonly label: string; readonly url: string } | null {
  // 驱动 kind 与 provider 口径差一个 Agent 后缀（claudeAgent）。
  const key = provider.replace(/Agent$/i, "");
  if (key === "codex") {
    return { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" };
  }
  return null;
}

/** Quota still available in the window, as a 0–100 percent. */
export function quotaWindowRemainingPercent(window: AccountQuotaWindow): number | null {
  if (window.usedFraction === undefined) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - window.usedFraction) * 100)));
}

/**
 * Share of the rolling window already elapsed (0–1), derived from
 * `resetsAt - windowDurationMins`. Null when the provider reported neither —
 * the pace marker then stays hidden instead of guessing.
 */
export function quotaWindowElapsedFraction(
  window: AccountQuotaWindow,
  nowUnixMs: number,
): number | null {
  if (window.resetsAt === undefined || window.windowDurationMins === undefined) return null;
  const resetMs = Date.parse(window.resetsAt);
  const durationMs = window.windowDurationMins * 60_000;
  if (!Number.isFinite(resetMs) || durationMs <= 0) return null;
  const elapsed = 1 - (resetMs - nowUnixMs) / durationMs;
  return Math.min(1, Math.max(0, elapsed));
}

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
  /**
   * Configured instance the windows belong to. Two instances of one driver
   * are two accounts and merge independently; absent means the driver's
   * default account.
   */
  readonly providerInstanceId?: string;
  readonly planName?: string;
  readonly windows: AccountQuotaProviderState["windows"];
  readonly updatedAtUnixMs: number;
}

/**
 * One logical card per account.
 *
 * Several environments on one machine (worktree servers, for instance) share
 * the same `~/.codex`/`~/.claude` accounts and would show the same
 * subscription twice. The freshest report claims the `(provider, instance)`
 * slot, so a stale worktree server never masks a current answer; genuinely
 * distinct machines cannot be told apart at this layer and keep the freshest
 * voice. Two configured instances of one driver are separate accounts and
 * merge independently.
 */
export function mergeAccountQuota(
  environments: readonly EnvironmentAccountQuota[],
): readonly MergedAccountQuotaProvider[] {
  const claimed = new Map<string, MergedAccountQuotaProvider>();
  for (const environment of environments) {
    for (const state of environment.result.providers) {
      const accountKey =
        state.providerInstanceId === undefined
          ? state.provider
          : `${state.provider}:${state.providerInstanceId}`;
      const current = claimed.get(accountKey);
      if (current !== undefined && current.updatedAtUnixMs >= state.updatedAtUnixMs) {
        continue;
      }
      claimed.set(accountKey, {
        environmentId: environment.environmentId,
        environmentLabel: environment.label,
        provider: state.provider,
        ...(state.providerInstanceId !== undefined
          ? { providerInstanceId: state.providerInstanceId }
          : {}),
        ...(state.planName !== undefined ? { planName: state.planName } : {}),
        windows: state.windows,
        updatedAtUnixMs: state.updatedAtUnixMs,
      });
    }
  }
  return [...claimed.values()].sort((left, right) =>
    `${left.provider}:${left.providerInstanceId ?? ""}`.localeCompare(
      `${right.provider}:${right.providerInstanceId ?? ""}`,
    ),
  );
}
