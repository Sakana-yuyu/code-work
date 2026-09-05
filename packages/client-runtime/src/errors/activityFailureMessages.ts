/**
 * 服务端把失败摘要以英文原句写入 activity.summary，但 activity.kind 是稳定
 * 的机器判别字段，比摘要文案更抗措辞调整。这里把已知失败 kind 映射为稳定
 * i18n key 与插值参数，客户端展示前翻译；未知 kind 返回 null，由调用方
 * 原样展示摘要（对未来新增的服务端失败活动保持透传）。
 * 服务端新增失败活动 kind 时在此登记。
 */
export interface ActivityFailureTranslation {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

const KEY_BY_ACTIVITY_KIND: Readonly<Record<string, string>> = {
  "provider.turn.start.failed": "activity.providerTurnStartFailed",
  "provider.turn.interrupt.failed": "activity.providerTurnInterruptFailed",
  "provider.approval.respond.failed": "activity.providerApprovalRespondFailed",
  "provider.user-input.respond.failed": "activity.providerUserInputRespondFailed",
  "checkpoint.revert.failed": "activity.checkpointRevertFailed",
  "checkpoint.capture.failed": "activity.checkpointCaptureFailed",
  "runtime.error": "activity.runtimeError",
  "tool.denied": "activity.toolDenied",
  "setup-script.failed": "activity.setupScriptFailedToStart",
};

export function activityFailureTranslation(activity: {
  readonly kind: string;
  readonly payload?: unknown;
}): ActivityFailureTranslation | null {
  const key = KEY_BY_ACTIVITY_KIND[activity.kind];
  if (key === undefined) return null;
  if (activity.kind === "tool.denied") {
    // 摘要本身携带工具名；payload 缺少 toolName 时回退原摘要，避免空洞插值。
    const payload =
      activity.payload !== null && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const toolName = payload?.toolName;
    if (typeof toolName !== "string" || toolName.length === 0) return null;
    return { key, params: { toolName } };
  }
  return { key, params: {} };
}
