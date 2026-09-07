/**
 * Thread Goal 数值展示的共享格式化。web 状态条与 mobile Goal 页必须产出
 * 完全一致的文本，因此收口在这里而不是各自实现。
 */

export function formatThreadGoalTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value < 10_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const k = value / 1_000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  const m = value / 1_000_000;
  return `${m >= 100 ? Math.round(m) : Math.round(m * 10) / 10}M`;
}

export function threadGoalProgressPercent(tokensUsed: number, tokenBudget: number): number {
  if (tokenBudget <= 0) return 100;
  return Math.min(100, Math.max(0, (tokensUsed / tokenBudget) * 100));
}
