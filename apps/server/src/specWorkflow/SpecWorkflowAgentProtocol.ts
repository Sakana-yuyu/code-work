import type { SpecWorkflowIntentName, SpecWorkflowState } from "@codework/contracts";

const intentNames = new Set<SpecWorkflowIntentName>([
  "workflow",
  "research",
  "ask",
  "chat",
  "design",
  "propose",
  "revise",
  "apply",
  "verify",
  "acceptance",
  "archive",
  "status",
  "stash",
  "resume",
  "fix",
  "ship",
  "loop",
]);

const intentMarker = /\[\[SPEC_WORKFLOW_INTENT:\s*([a-z-]+)\s*\]\]/giu;

export interface SpecWorkflowAgentDirective {
  readonly intent: SpecWorkflowIntentName | undefined;
  readonly cleanText: string;
}

/**
 * 解析 Provider 的内部工作流指令。
 *
 * 只有唯一且属于合同枚举的 marker 才能形成意图；所有 marker 都会从
 * 用户可见文本中移除，避免内部控制协议泄露到聊天记录。
 */
export const parseSpecWorkflowIntent = (text: string): SpecWorkflowAgentDirective => {
  const matches = Array.from(text.matchAll(intentMarker));
  const cleanText = text
    .replace(intentMarker, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  const candidate = matches.length === 1 ? matches[0]?.[1]?.toLowerCase() : undefined;
  return {
    intent:
      candidate !== undefined && intentNames.has(candidate as SpecWorkflowIntentName)
        ? (candidate as SpecWorkflowIntentName)
        : undefined,
    cleanText,
  };
};

/** 给已启用线程的 Provider 回合提供当前工作流上下文和严格回传协议。 */
export const formatSpecWorkflowAgentInput = (
  state: SpecWorkflowState,
  userInput: string | undefined,
): string => {
  const input = userInput?.trim() ?? "";
  return [
    "[Spec Workflow Native Protocol]",
    `工作流：${state.changeName}`,
    `当前阶段：${state.stage}`,
    `工作流状态：${state.status}`,
    `未决问题数：${state.tbdCount}`,
    `方案状态：${state.proposalStatus}`,
    `实现完成：${state.implementationCompleted ? "是" : "否"}`,
    `验证状态：${state.verificationStatus}`,
    `验收状态：${state.acceptanceStatus}`,
    "",
    "你只能在工作流已启用时使用这个协议；Server 的 Router/Decider 是最终门禁。",
    "根据用户请求和当前阶段自行选择下一步；用户意图不清或只是普通讨论时不要输出 marker。",
    "如果确实需要调用一个工作流入口，在最终回复末尾只输出一个严格 marker：",
    "[[SPEC_WORKFLOW_INTENT: research|ask|chat|design|propose|revise|apply|verify|acceptance|archive|status|stash|resume|fix|ship|loop]]",
    "不要伪造已完成、验证通过或人工验收；最终验收仍由用户/显式验收控制完成。",
    ...(state.mode === "fix"
      ? [
          "当前是轻量修复批次：每次 fix 都要把实际修复、验证方式和结果追加到当前 change 的 fix.md；没有完整记录时 Server 不允许 ship。",
          "ship 只对累计批次启动一次独立验证；验证失败时保留 fix.md 和工作流状态，回到 fix，不得伪造通过。",
        ]
      : []),
    ...(input.length > 0 ? ["", "[User Request]", input] : []),
  ].join("\n");
};
