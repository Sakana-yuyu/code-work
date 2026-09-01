/** Supplier 条目显示名：displayName 缺省时回退实例 ID。 */
export const supplierDisplayName = (entry: {
  readonly instanceId: string;
  readonly displayName?: string | undefined;
}): string => entry.displayName ?? entry.instanceId;

/** 启用态徽标 i18n 键。 */
export const supplierEnabledLabelKey = (enabled: boolean): string =>
  enabled ? "supplierRegistry.enabled" : "supplierRegistry.disabled";

/** 关联 Agent 档案摘要：agentId · status。 */
export const formatSupplierProfileSummary = (profile: {
  readonly agentId: string;
  readonly status: string;
}): string => `${profile.agentId} · ${profile.status}`;

/** 孤儿档案警示行：label: id1, id2；无孤儿时返回 null（不渲染警示行）。 */
export const formatOrphanProfilesWarning = (
  label: string,
  orphanProfileAgentIds: readonly string[],
): string | null =>
  orphanProfileAgentIds.length === 0 ? null : `${label}: ${orphanProfileAgentIds.join(", ")}`;
