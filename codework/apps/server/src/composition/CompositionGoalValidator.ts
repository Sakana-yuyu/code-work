import * as Effect from "effect/Effect";

import type {
  CompositionAgentServiceError,
  CompositionAgentServiceShape,
} from "./CompositionAgentService.ts";
import type {
  CompositionGoalValidationInput,
  CompositionGoalValidationVerdict,
} from "./CompositionGoalLoop.ts";

/** 验证子代理的显式裁决标记；缺标记一律按拒绝处理（fail-closed）。 */
export const GOAL_VALID_MARKER = "[[GOAL_VALID]]";
const GOAL_INVALID_MARKER_PREFIX = "[[GOAL_INVALID";

/** 解析验证子代理输出中的裁决；同时出现接受与拒绝标记时按拒绝处理。 */
export const parseGoalValidatorVerdict = (
  outputText: string | undefined,
): CompositionGoalValidationVerdict => {
  const text = outputText ?? "";
  const invalidIndex = text.indexOf(GOAL_INVALID_MARKER_PREFIX);
  if (invalidIndex !== -1) {
    let cursor = invalidIndex + GOAL_INVALID_MARKER_PREFIX.length;
    let reason: string | undefined;
    if (text[cursor] === ":") {
      const close = text.indexOf("]", cursor);
      if (close !== -1) {
        reason = text.slice(cursor + 1, close).trim() || undefined;
      }
    }
    return {
      accepted: false,
      detail: reason ?? "验证方给出 [[GOAL_INVALID]] 但未说明理由。",
    };
  }
  if (text.includes(GOAL_VALID_MARKER)) return { accepted: true };
  return {
    accepted: false,
    detail: "验证方输出缺少 [[GOAL_VALID]]/[[GOAL_INVALID]] 裁决标记，按拒绝处理。",
  };
};

export type CompositionGoalValidatorClaim = {
  readonly goal: string;
  readonly claim: CompositionGoalValidationInput<unknown>;
};

/** 组装发给验证子代理的评审提示词；历史值逐条截断，避免提示词无界增长。 */
export const composeGoalValidatorPrompt = (input: CompositionGoalValidatorClaim): string => {
  const history = input.claim.history
    .map((entry) => `  - 第 ${entry.round} 轮产物：${truncate(String(entry.value), 200)}`)
    .join("\n");
  const reason =
    input.claim.reason === undefined
      ? ""
      : `\n- 完成原因声明：${truncate(input.claim.reason, 200)}`;
  return [
    `你是目标完成的验证子代理。请独立判断下述完成声明是否可信。`,
    `- 任务目标：${truncate(input.goal, 500)}`,
    `- 完成声明（第 ${input.claim.round} 轮）：${truncate(input.claim.cleanText, 500)}`,
    `${reason}- 历史轮次产物：`,
    history || "  （无）",
    `只允许输出 [[GOAL_VALID]]（接受）或 [[GOAL_INVALID: 拒绝理由]]（拒绝）之一。`,
  ].join("\n");
};

const truncate = (text: string, limit: number): string => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

/** 验证子代理的底层评审端口：输入提示词、输出原始文本。 */
export type SubAgentGoalValidatorPort<E> = {
  readonly review: (input: { readonly prompt: string }) => Effect.Effect<string, E>;
};

/**
 * 子代理 validator：把验证合同接到真实评审端口。
 * 组合提示词 → 端口评审 → 解析裁决标记（fail-closed），返回值可直接作为
 * runCompositionGoalLoop 的 validateCompletion 注入。
 */
export const makeSubAgentGoalValidator =
  <A, E>(options: { readonly goal: string; readonly port: SubAgentGoalValidatorPort<E> }) =>
  (input: CompositionGoalValidationInput<A>): Effect.Effect<CompositionGoalValidationVerdict, E> =>
    options.port
      .review({
        prompt: composeGoalValidatorPrompt({
          goal: options.goal,
          claim: input,
        }),
      })
      .pipe(Effect.map(parseGoalValidatorVerdict));

/** BYOK 生产模型循环后端：验证子代理经由 CompositionAgentService 跑一次无工具的单轮评审。 */
export const makeByokSubAgentValidatorPort = (options: {
  readonly agentService: Pick<CompositionAgentServiceShape, "run">;
  readonly providerInstanceId: string;
  readonly runtimeId: string;
  readonly modelId: string;
  readonly validatorAgentId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
}): SubAgentGoalValidatorPort<CompositionAgentServiceError> => ({
  review: ({ prompt }) =>
    options.agentService
      .run({
        providerInstanceId: options.providerInstanceId,
        runtimeId: options.runtimeId,
        modelId: options.modelId,
        taskId: options.taskId,
        runId: options.runId,
        agentId: options.validatorAgentId,
        workspaceRoot: options.workspaceRoot,
        prompt,
        capabilityGrantIds: [],
        tools: [],
        maxRounds: 1,
      })
      .pipe(Effect.map((result) => result.text)),
});
