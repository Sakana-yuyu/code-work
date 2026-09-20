import type { OrchestrationThreadActivity, ThreadTokenUsageSnapshot } from "@codework/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

type NullableContextWindowUsage = {
  readonly [Key in keyof ThreadTokenUsageSnapshot]: undefined extends ThreadTokenUsageSnapshot[Key]
    ? Exclude<ThreadTokenUsageSnapshot[Key], undefined> | null
    : ThreadTokenUsageSnapshot[Key];
};

export type ContextWindowSnapshot = NullableContextWindowUsage & {
  readonly remainingTokens: number | null;
  readonly usedPercentage: number | null;
  readonly remainingPercentage: number | null;
  readonly updatedAt: string;
};

export type AccountQuotaWindow = {
  readonly label: string;
  readonly usedPercentage: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
};

export type AccountQuotaSnapshot = {
  readonly windows: ReadonlyArray<AccountQuotaWindow>;
  readonly balance: number | null;
  readonly currency: string | null;
  readonly unlimited: boolean;
};

/** 根据当前对话累计输入 token 计算缓存命中率。 */
export function deriveCacheHitRate(usage: ContextWindowSnapshot | null): number | null {
  if (!usage) return null;

  const useCumulative = (usage.inputTokens ?? 0) > 0 && usage.cachedInputTokens != null;
  const inputTokens = useCumulative ? usage.inputTokens! : (usage.lastInputTokens ?? 0);
  const cachedInputTokens = useCumulative
    ? usage.cachedInputTokens!
    : (usage.lastCachedInputTokens ?? null);
  if (inputTokens <= 0 || cachedInputTokens === null) return null;

  return Math.min(100, Math.max(0, (cachedInputTokens / inputTokens) * 100));
}

/**
 * 模型响应步数：每条用量活动对应一次计费的模型调用（BYOK 每轮一条，
 * CLI 供应商按其上报节奏），与 deepseek-harness「N 步」同口径。没有
 * 用量上报的供应商计 0，界面按缺数处理而不是显示假数字。
 */
export function deriveModelResponseCount(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number {
  let count = 0;
  for (const activity of activities) {
    if (activity.kind === "context-window.updated") count += 1;
  }
  return count;
}

/** 累加已配对工具活动的真实执行耗时；缺少任一端时不猜测。 */
export function deriveToolDurationMs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): number | null {
  const startedAtByToolCall = new Map<string, number>();
  let totalDurationMs = 0;
  let completedToolCount = 0;

  for (const activity of activities) {
    if (activity.kind !== "tool.started" && activity.kind !== "tool.completed") continue;
    const payload = asRecord(activity.payload);
    const toolCallId = payload?.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) continue;
    const timestamp = Date.parse(activity.createdAt);
    if (!Number.isFinite(timestamp)) continue;

    if (activity.kind === "tool.started") {
      startedAtByToolCall.set(toolCallId, timestamp);
      continue;
    }

    const startedAt = startedAtByToolCall.get(toolCallId);
    if (startedAt === undefined || timestamp < startedAt) continue;
    totalDurationMs += timestamp - startedAt;
    completedToolCount += 1;
    startedAtByToolCall.delete(toolCallId);
  }

  return completedToolCount > 0 ? totalDurationMs : null;
}

/** Map a provider driver kind to a user-facing display name. */
export function formatProviderDisplayName(provider: string | null | undefined): string {
  if (!provider) return "This agent";
  switch (provider) {
    case "claudeAgent":
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default: {
      // Title-case unknown driver kinds so they read reasonably.
      const trimmed = provider.replace(/Agent$/i, "").trim();
      if (trimmed.length === 0) return provider;
      return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    }
  }
}

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") {
      continue;
    }

    const payload = asRecord(activity.payload);
    const usedTokens = asFiniteNumber(payload?.usedTokens);
    if (usedTokens === null || usedTokens < 0) {
      continue;
    }

    const maxTokens = asFiniteNumber(payload?.maxTokens);
    const usedPercentage =
      maxTokens !== null && maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : null;
    const remainingTokens =
      maxTokens !== null ? Math.max(0, Math.round(maxTokens - usedTokens)) : null;
    const remainingPercentage = usedPercentage !== null ? Math.max(0, 100 - usedPercentage) : null;

    return {
      usedTokens,
      totalProcessedTokens: asFiniteNumber(payload?.totalProcessedTokens),
      maxTokens,
      remainingTokens,
      usedPercentage,
      remainingPercentage,
      inputTokens: asFiniteNumber(payload?.inputTokens),
      cachedInputTokens: asFiniteNumber(payload?.cachedInputTokens),
      outputTokens: asFiniteNumber(payload?.outputTokens),
      reasoningOutputTokens: asFiniteNumber(payload?.reasoningOutputTokens),
      lastUsedTokens: asFiniteNumber(payload?.lastUsedTokens),
      lastInputTokens: asFiniteNumber(payload?.lastInputTokens),
      lastCachedInputTokens: asFiniteNumber(payload?.lastCachedInputTokens),
      lastOutputTokens: asFiniteNumber(payload?.lastOutputTokens),
      lastReasoningOutputTokens: asFiniteNumber(payload?.lastReasoningOutputTokens),
      toolUses: asFiniteNumber(payload?.toolUses),
      durationMs: asFiniteNumber(payload?.durationMs),
      compactsAutomatically: asBoolean(payload?.compactsAutomatically) ?? false,
      autoCompactThreshold: asFiniteNumber(payload?.autoCompactThreshold),
      updatedAt: activity.createdAt,
    };
  }

  return null;
}

function readNumber(record: Record<string, unknown>, keys: ReadonlyArray<string>): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function readString(record: Record<string, unknown>, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function readTimestamp(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      const date = new Date(value > 1_000_000_000_000 ? value : value * 1_000);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

/** 从官方 CLI 已上报的限额活动中提取可确认的额度，不猜测未上报的数据。 */
export function deriveLatestAccountQuotaSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AccountQuotaSnapshot | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account.rate-limits.updated") continue;
    const payload = asRecord(activity.payload);
    const limits = asRecord(payload?.rateLimits);
    if (!limits) continue;

    const windows: AccountQuotaWindow[] = [];
    let balance = readNumber(limits, ["balance", "remaining", "credits"]);
    const currency = readString(limits, ["currency", "unit"]);
    let unlimited = limits.unlimited === true;
    const directUsed = readNumber(limits, [
      "usedPercent",
      "used_percent",
      "utilization",
      "rate_limit_percentage",
    ]);
    if (directUsed !== null) {
      const usedPercentage = directUsed <= 1 ? directUsed * 100 : directUsed;
      windows.push({
        label: readString(limits, ["rate_limit_type", "type"]) ?? "current",
        usedPercentage: Math.max(0, Math.min(100, usedPercentage)),
        remaining: readNumber(limits, ["remaining", "remainingCredits"]),
        resetAt: readTimestamp(limits, ["resetAt", "resetsAt", "reset_at", "resets_at"]),
      });
    }
    for (const [key, value] of Object.entries(limits)) {
      const window = asRecord(value);
      if (!window) continue;
      const usedPercent = readNumber(window, ["usedPercent", "used_percent"]);
      const utilization = readNumber(window, ["utilization"]);
      const usedPercentage =
        usedPercent !== null
          ? Math.max(0, Math.min(100, usedPercent))
          : utilization === null
            ? null
            : Math.max(0, Math.min(100, utilization <= 1 ? utilization * 100 : utilization));
      const remaining = readNumber(window, ["remaining", "balance", "credits"]);
      const limit = readNumber(window, ["limit", "max"]);
      if (balance === null && (key === "credits" || key === "credit")) {
        balance = remaining ?? limit;
      }
      unlimited ||= window.unlimited === true;
      if (usedPercentage !== null || remaining !== null || limit !== null) {
        windows.push({
          label: key,
          usedPercentage,
          remaining:
            remaining ??
            (limit !== null && usedPercentage !== null ? limit * (1 - usedPercentage / 100) : null),
          resetAt: readTimestamp(window, ["resetAt", "resetsAt", "reset_at", "resets_at"]),
        });
      }
    }
    if (windows.length === 0 && balance === null && !unlimited) continue;
    return { windows, balance, currency, unlimited };
  }
  return null;
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  if (value < 1_000_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}
