import type {
  SpecWorkflowCapability,
  SpecWorkflowFlag,
  SpecWorkflowIntentName,
  SpecWorkflowState,
} from "@codework/contracts";
import { routeSpecWorkflowIntent } from "./SpecWorkflowRouter.ts";

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

/** 知识库读取纪律：对齐上游「索引先行、按需打开、已录事实直接信任」。 */
const knowledgeReadDiscipline =
  "知识库：spec/knowledge.md 是知识索引（每个子文档一行）；先读索引，只打开与本次相关的子文档；已记录的结论直接信任，不要重新推导；发现与现实矛盾时更新对应子文档和索引。";

const flagGuardrails = {
  strict:
    "严格模式：不得偷懒跳步或擅自缩小方案范围；每个结论都要有可引用的代码证据，无法证实的明确标注为未知，不得臆测。",
  design:
    "设计模式：这是视觉关键任务，按前端美学标准执行（排版、留白、层级、一致性），交付前自查视觉细节。",
} satisfies Record<SpecWorkflowFlag, string>;

/** 供回合输入和 Composition 派发 prompt 共用的执行取向开关说明。 */
export const formatSpecWorkflowFlagGuardrails = (
  flags: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> =>
  (flags ?? []).flatMap((flag) =>
    flag === "strict" || flag === "design" ? [flagGuardrails[flag]] : [],
  );

const nodeInstructions: Record<SpecWorkflowIntentName, string> = {
  workflow: "按完整流程推进，在方案批准和最终验收处等待用户。",
  research:
    "只调研代码现状、约束、候选方案和风险，整理 research.md；废弃方向的草稿快照存入 spec/changes/<name>/research/（去除内部标记，可复活）；把新确认的领域事实沉淀为 spec/knowledge/ 子文档并更新 spec/knowledge.md 索引；不实施代码。",
  ask: "逐项澄清未决需求，记录用户已回答的问题；不擅自替用户作偏好决定。",
  chat: "只讨论用户的想法和方案，不创建或修改任何文件，不启动任务或后续阶段。",
  design: "只完成架构、接口、数据流和技术取舍设计，整理 design.md；不实施代码。",
  propose:
    "只编写方案的目标、范围、实现路径、风险和验收标准，整理 proposal.md；编写前先复用知识库已记录的结论；不实施代码。",
  revise: "读取已有方案，仅修订用户指定部分，指出需要重新批准的变化；不实施代码。",
  apply:
    "请求服务端实施已批准的方案；实施前先读 spec/knowledge.md 索引；不要在当前决策回合重复实施，完成后停止，不自动启动验证。",
  verify:
    "请求服务端派发独立验证；当前执行者不得自证通过，也不得自行修复或归档；验证台账写入 verify.md：每条发现使用稳定编号并附可引用的代码证据（引用不出代码就撤销该发现），每个维度最多 3 条，跨轮次对比；未修复的发现升级为失败。",
  acceptance: "只核对验收清单和证据，列出未验证项；最终验收必须由用户点击确认。",
  archive:
    "归档前先写 retrospect.md（方案与实际结果的偏差、证据、遗留项），并把可复用经验沉淀为 spec/knowledge/ 子文档、更新 spec/knowledge.md 索引（新经验取代过时事实）；然后请求归档，Server 会把 spec/changes/<name>/ 移入 spec/archive/；不要绕过验收或删除其他文件。",
  status: "只报告已有工作流进度、产物和可执行操作；没有工作流时如实说明，不创建产物。",
  stash: "只请求暂停已有工作流，保留产物；暂停后不继续执行。",
  resume: "只请求恢复已暂停的工作流，说明恢复位置，不启动整个流程。",
  fix: "请求服务端执行本次小改动，结果追加到 fix.md；定位问题前先读 spec/knowledge.md 索引；完成后停止，等待用户选择验证修复批次。",
  ship: "只请求独立验证累计修复批次；失败时保留记录，不擅自继续修复；证实为误报的结论沉淀到知识库。",
  loop: "只请求受控迭代，最多 3 轮；保留验收门禁，预算耗尽或用户暂停时停止。",
};

/** 单节点只装载该节点的职责；不会把整个流程授予当前回合。 */
export const formatSpecWorkflowSelectedInput = (
  capability: SpecWorkflowCapability,
  state: SpecWorkflowState | null,
  userInput: string | undefined,
): string | undefined => {
  if (!capability.enabled) return userInput;
  const intent = capability.selectedIntent ?? "workflow";
  if (intent === "workflow")
    return state === null || state.status === "completed"
      ? userInput
      : formatSpecWorkflowAgentInput(state, userInput, capability.flags);
  const route = routeSpecWorkflowIntent({
    capability,
    ...(state === null ? {} : { state }),
    intent,
    ...(intent === "loop" ? { loopConfig: { maxAttempts: 3 } } : {}),
  });
  const blocked =
    state?.status === "paused" && intent !== "resume" && intent !== "status" && intent !== "chat";
  const canDispatch =
    !blocked &&
    state !== null &&
    intent !== "chat" &&
    intent !== "status" &&
    route.action !== "show-status";
  const allowedCorrection = intent === "ship" && route.reason === "fix-batch-verification-required";
  return [
    "[Spec Workflow Selected Node]",
    `用户选择的节点：${intent}`,
    "仅执行所选部分，完成后停止；不得自行启动完整流程或调用未选择的节点。",
    nodeInstructions[intent],
    knowledgeReadDiscipline,
    ...formatSpecWorkflowFlagGuardrails(capability.flags),
    ...(state === null
      ? ["当前没有已启动的工作流。"]
      : [
          `当前阶段：${state.stage}；状态：${state.status}；未决问题：${state.tbdCount}；方案：${state.proposalStatus}；验证：${state.verificationStatus}`,
          `产物目录：spec/changes/${state.changeName}/；先读取已有产物，保留无关内容。`,
        ]),
    ...(blocked ? ["工作流已暂停，只解释当前状态；不得执行此节点。"] : []),
    ...(route.corrected && !allowedCorrection && intent !== "chat"
      ? [
          `所选入口的服务端校验结果：${route.reason}。解释缺少的前置条件；不得自行执行纠正后的其他节点，等待用户重新选择。`,
        ]
      : []),
    "实施、独立验证和归档必须经过 Server Router/Decider 门禁，不得在当前回合自行绕过。",
    ...(canDispatch && (!route.corrected || allowedCorrection)
      ? [
          `文档节点仅在本次实际完成后请求记录；执行节点仅在用户需求明确时请求派发。在回复末尾只输出 [[SPEC_WORKFLOW_INTENT: ${intent}]]。`,
        ]
      : ["不要输出工作流 marker 或伪造完成状态。"]),
    "",
    "[User Request]",
    userInput ?? "",
  ].join("\n");
};

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
  flags?: ReadonlyArray<string>,
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
    knowledgeReadDiscipline,
    ...formatSpecWorkflowFlagGuardrails(flags),
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
