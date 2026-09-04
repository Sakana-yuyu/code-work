/**
 * Delegation supervision core — ported from the original cursor-byok
 * supervisor coordinator, adapted to codework's black-box CLI executor.
 *
 * The original supervised streaming worker checkpoints; here the supervisor
 * model reviews the finished delegation (result or error) and returns a
 * bounded decision: accept / retry / reassign / escalate / fail. This module
 * is pure: prompt building, decision parsing, and the budget state machine
 * live here; the model call and scheduler resubmission stay in
 * `ByokDelegationService`.
 *
 * @module provider/byok/DelegationSupervision
 */
import type { ByokDelegationSupervisionConfig } from "@codework/contracts";

export type SupervisionDecision = "accept" | "retry" | "reassign" | "escalate" | "fail";

export interface SupervisionCounters {
  readonly round: number;
  readonly corrections: number;
  readonly retries: number;
  readonly reassigns: number;
  readonly escalates: number;
}

export const INITIAL_SUPERVISION_COUNTERS: SupervisionCounters = {
  round: 0,
  corrections: 0,
  retries: 0,
  reassigns: 0,
  escalates: 0,
};

export interface SupervisionReviewInput {
  readonly task: string;
  readonly result: string;
  readonly errorMessage: string | undefined;
  readonly counters: SupervisionCounters;
  readonly config: ByokDelegationSupervisionConfig;
}

const MAX_REVIEW_INPUT_CHARS = 6_000;

/** The supervisor sees bounded, redacted-free worker output only. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…[已截断]`;

export function buildSupervisorReviewPrompt(input: SupervisionReviewInput): string {
  const outcome =
    input.errorMessage !== undefined && input.errorMessage.trim().length > 0
      ? `执行失败：${bounded(input.errorMessage, 800)}`
      : `执行输出：\n${bounded(input.result, MAX_REVIEW_INPUT_CHARS)}`;
  return [
    "你是委派任务的监督模型。请审查下面这次委派执行的结果，判断是否达成了任务目标。",
    "",
    `【任务目标】\n${bounded(input.task, MAX_REVIEW_INPUT_CHARS)}`,
    "",
    `【执行结果】\n${outcome}`,
    "",
    "请只返回一个 JSON 对象，不要包含其他文字，格式为：",
    '{"decision":"accept|retry|reassign|escalate|fail","reason":"简要原因","correctedTask":"当 decision 为 retry/escalate 时，给出修正后的完整任务文本"}',
    "",
    "判定标准：",
    "- accept：结果达成任务目标，或存在的问题不影响目标。",
    `- retry：执行有可修复的失败或产出不完整，重新执行同一任务（本任务已重试 ${input.counters.retries} 次，上限 ${input.config.maxRetries} 次）。`,
    "- reassign：换一个模型重新执行更可能成功（需允许改派）。",
    "- escalate：由你改写任务、补充约束后再次委派（仅在确实需要更强指导时使用）。",
    "- fail：任务无法达成，继续重试没有意义。",
  ].join("\n");
}

export interface SupervisionDecisionResult {
  readonly decision: SupervisionDecision;
  readonly reason: string;
  readonly correctedTask: string | undefined;
}

const DECISIONS: ReadonlySet<string> = new Set(["accept", "retry", "reassign", "escalate", "fail"]);

/** Extract the first JSON object with a known decision from model output. */
export function parseSupervisionDecision(text: string): SupervisionDecisionResult | undefined {
  const candidates = text.match(/\{[\s\S]*?\}/gu) ?? [];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      const decision = typeof record["decision"] === "string" ? record["decision"] : "";
      if (!DECISIONS.has(decision)) continue;
      const reason = typeof record["reason"] === "string" ? record["reason"].trim() : "";
      const correctedTask =
        typeof record["correctedTask"] === "string" && record["correctedTask"].trim().length > 0
          ? record["correctedTask"].trim()
          : undefined;
      return {
        decision: decision as SupervisionDecision,
        reason,
        correctedTask,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

export type SupervisionAction =
  | { readonly kind: "done"; readonly counters: SupervisionCounters }
  | {
      readonly kind: "resubmit";
      readonly counters: SupervisionCounters;
      /** Next model override for reassign rounds; undefined keeps the routed model. */
      readonly modelOverride: string | undefined;
      readonly taskOverride: string | undefined;
    }
  | { readonly kind: "fail"; readonly counters: SupervisionCounters; readonly reason: string };

/**
 * Budget state machine (pure port of the original decision constraints).
 * `candidateModelIds` is the enabled group's model list used for reassign
 * rounds; `currentModelId` is the model the reviewed run executed on.
 */
export function nextSupervisionAction(input: {
  readonly decision: SupervisionDecisionResult;
  readonly counters: SupervisionCounters;
  readonly config: ByokDelegationSupervisionConfig;
  readonly candidateModelIds: ReadonlyArray<string>;
  readonly currentModelId: string | undefined;
  readonly lastTask: string;
}): SupervisionAction {
  const { decision, counters, config } = input;
  const limitsReached =
    counters.round + 1 >= Math.max(1, config.maxRounds) ||
    counters.retries >= Math.max(0, config.maxRetries) ||
    counters.corrections >= Math.max(0, config.maxCorrections);

  if (decision.decision === "accept") {
    return { kind: "done", counters };
  }
  if (decision.decision === "fail" || limitsReached) {
    return {
      kind: "fail",
      counters,
      reason:
        decision.decision === "fail"
          ? decision.reason || "监督模型判定任务无法达成。"
          : "监督预算已用尽，保留最后一次执行结果。",
    };
  }
  const nextCounters: SupervisionCounters = {
    round: counters.round + 1,
    corrections: counters.corrections + (decision.decision === "escalate" ? 1 : 0),
    retries: counters.retries + (decision.decision === "retry" ? 1 : 0),
    reassigns: counters.reassigns + (decision.decision === "reassign" ? 1 : 0),
    escalates: counters.escalates + (decision.decision === "escalate" ? 1 : 0),
  };
  if (decision.decision === "retry") {
    return {
      kind: "resubmit",
      counters: nextCounters,
      modelOverride: undefined,
      taskOverride: decision.correctedTask,
    };
  }
  if (decision.decision === "escalate") {
    return {
      kind: "resubmit",
      counters: nextCounters,
      modelOverride: undefined,
      taskOverride: decision.correctedTask ?? input.lastTask,
    };
  }
  // reassign: move to the next candidate model after the current one.
  if (!config.allowReassign) {
    return { kind: "fail", counters, reason: "监督模型请求改派，但改派未被允许。" };
  }
  const currentIndex = input.currentModelId
    ? input.candidateModelIds.indexOf(input.currentModelId)
    : -1;
  const nextModel = input.candidateModelIds[currentIndex + 1] ?? input.candidateModelIds[0];
  if (nextModel === undefined || nextModel === input.currentModelId) {
    return { kind: "fail", counters, reason: "模型组中没有可改派的其他模型。" };
  }
  return {
    kind: "resubmit",
    counters: nextCounters,
    modelOverride: nextModel,
    taskOverride: decision.correctedTask,
  };
}

/** Built-in role fragments (original builtins; config overrides win). */
export const BUILTIN_SUBAGENT_PROFILES: Readonly<Record<string, string>> = {
  explore: "以只读方式探索代码库：定位相关文件与实现，汇总入口、依赖与调用关系；不要修改任何文件。",
  generalPurpose: "完成给定的编码任务，遵循仓库现有约定，完成后给出变更摘要与验证方式。",
  browserUse: "使用浏览器自动化完成页面操作或验证，逐步记录观察结果，最后给出结论。",
};

/**
 * Resolve the role fragment for a subagent type: configured override first
 * (empty fragment disables injection), then the builtins.
 */
export function resolveSubagentPromptFragment(
  profiles: ReadonlyArray<{ readonly subagentType: string; readonly promptFragment: string }>,
  subagentType: string | undefined,
): string | undefined {
  const type = subagentType?.trim();
  if (type === undefined || type.length === 0) return undefined;
  const configured = profiles.find((profile) => profile.subagentType === type);
  if (configured !== undefined) {
    return configured.promptFragment.trim().length > 0 ? configured.promptFragment : undefined;
  }
  return BUILTIN_SUBAGENT_PROFILES[type];
}

/** Append the role fragment to the task text (original ApplySubagentPromptFragment). */
export function applySubagentPromptFragment(task: string, fragment: string | undefined): string {
  if (fragment === undefined) return task;
  return `${task}\n\n[子代理角色约束]\n${fragment}`;
}
