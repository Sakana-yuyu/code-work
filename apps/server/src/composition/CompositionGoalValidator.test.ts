import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import { runCompositionGoalLoop } from "./CompositionGoalLoop.ts";
import {
  GOAL_VALID_MARKER,
  composeGoalValidatorPrompt,
  makeByokSubAgentValidatorPort,
  makeSubAgentGoalValidator,
  parseGoalValidatorVerdict,
} from "./CompositionGoalValidator.ts";

class ValidatorPortFailure extends Data.TaggedError("ValidatorPortFailure")<{
  readonly detail: string;
}> {}

describe("parseGoalValidatorVerdict", () => {
  it("接受标记通过；拒绝标记带/不带理由分别给出 detail", () => {
    expect(parseGoalValidatorVerdict(`核对无误 ${GOAL_VALID_MARKER}`)).toEqual({ accepted: true });

    const withReason = parseGoalValidatorVerdict("[[GOAL_INVALID: 证据不足，还有失败用例]]");
    expect(withReason.accepted).toBe(false);
    expect(withReason.detail).toBe("证据不足，还有失败用例");

    const withoutReason = parseGoalValidatorVerdict("[[GOAL_INVALID]]");
    expect(withoutReason.accepted).toBe(false);
    expect(withoutReason.detail).toContain("未说明理由");
  });

  it("缺标记或同时给出两种标记一律按拒绝处理（fail-closed）", () => {
    const missing = parseGoalValidatorVerdict("我觉得应该差不多完成了");
    expect(missing.accepted).toBe(false);
    expect(missing.detail).toContain("缺少");

    const both = parseGoalValidatorVerdict(`${GOAL_VALID_MARKER} [[GOAL_INVALID: 前后矛盾]]`);
    expect(both.accepted).toBe(false);
    expect(both.detail).toBe("前后矛盾");

    expect(parseGoalValidatorVerdict(undefined).accepted).toBe(false);
  });
});

describe("composeGoalValidatorPrompt", () => {
  it("提示词包含目标、声明、原因与历史轮次摘要，并对长文本截断", () => {
    const longValue = "本轮产物文本".repeat(50);
    const prompt = composeGoalValidatorPrompt({
      goal: "修复登录页崩溃",
      claim: {
        round: 2,
        value: longValue,
        cleanText: "已修复崩溃并通过全部用例",
        reason: "回归测试全绿",
        history: [
          { round: 1, value: "第一轮定位到空指针" },
          { round: 2, value: longValue },
        ],
      },
    });
    expect(prompt).toContain("修复登录页崩溃");
    expect(prompt).toContain("已修复崩溃并通过全部用例");
    expect(prompt).toContain("回归测试全绿");
    expect(prompt).toContain("第 1 轮产物：第一轮定位到空指针");
    expect(prompt).toContain(GOAL_VALID_MARKER);
    expect(prompt).toContain("[[GOAL_INVALID");
    // 超长历史值被截断到 200 字符 + 省略号，完整原文不进入提示词。
    expect(prompt).toContain("…");
    expect(prompt).not.toContain(longValue);
  });
});

describe("makeSubAgentGoalValidator", () => {
  effectIt.effect("端口评审文本被解析为裁决，错误原样上抛", () =>
    Effect.gen(function* () {
      const seenPrompts: string[] = [];
      const validator = makeSubAgentGoalValidator<string, ValidatorPortFailure>({
        goal: "修复登录页崩溃",
        port: {
          review: ({ prompt }) => {
            seenPrompts.push(prompt);
            return Effect.succeed(`复检后确认 ${GOAL_VALID_MARKER}`);
          },
        },
      });
      const verdict = yield* validator({
        round: 1,
        value: "产物",
        cleanText: "已完成",
        reason: undefined,
        history: [{ round: 1, value: "产物" }],
      });
      expect(verdict.accepted).toBe(true);
      expect(seenPrompts).toHaveLength(1);
      expect(seenPrompts[0]).toContain("修复登录页崩溃");

      const failing = makeSubAgentGoalValidator<string, ValidatorPortFailure>({
        goal: "任意目标",
        port: {
          review: () => Effect.fail(new ValidatorPortFailure({ detail: "评审模型超时" })),
        },
      });
      const failure = yield* failing({
        round: 1,
        value: "产物",
        cleanText: "已完成",
        reason: undefined,
        history: [],
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("ValidatorPortFailure");
      expect(failure.detail).toBe("评审模型超时");
    }),
  );

  effectIt.effect("接入 Goal Loop：首轮拒绝后继续，次轮接受才收敛为 completed", () =>
    Effect.gen(function* () {
      const outputs = [
        `已完成 [[GOAL_COMPLETE: 自认为完成]]`,
        `补齐测试 [[GOAL_COMPLETE: 真完成]]`,
      ];
      const verdicts = ["[[GOAL_INVALID: 缺少回归证据]]", `核对通过 ${GOAL_VALID_MARKER}`];
      let reviewCalls = 0;
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (round) =>
          Effect.sync(() => ({
            value: outputs[round - 1]!,
            outputText: outputs[round - 1]!,
          })),
        validateCompletion: makeSubAgentGoalValidator<string, never>({
          goal: "修复登录页崩溃",
          port: {
            review: () => {
              const text = verdicts[reviewCalls];
              reviewCalls += 1;
              return Effect.succeed(text!);
            },
          },
        }),
      });
      expect(reviewCalls).toBe(2);
      expect(result.status).toBe("completed");
      expect(result.completion?.reason).toBe("真完成");
      expect(result.rejectedCompletions).toEqual([{ round: 1, detail: "缺少回归证据" }]);
    }),
  );
});

describe("makeByokSubAgentValidatorPort", () => {
  effectIt.effect("评审经由 CompositionAgentService 跑无工具单轮循环并返回最终文本", () =>
    Effect.gen(function* () {
      const seenInputs: Array<Record<string, unknown>> = [];
      const port = makeByokSubAgentValidatorPort({
        agentService: {
          run: (input) =>
            Effect.sync(() => {
              seenInputs.push({ ...input, tools: input.tools.length });
              return {
                text: `复核完成 ${GOAL_VALID_MARKER}`,
                messages: [],
                rounds: 1,
              };
            }),
        },
        providerInstanceId: "provider-byok-1",
        runtimeId: "runtime-byok-1",
        modelId: "model-reviewer",
        validatorAgentId: "agent-goal-validator",
        taskId: "task-v",
        runId: "run-v",
        workspaceRoot: "C:/workspace/v",
      });
      const text = yield* port.review({ prompt: "评审提示词" });
      expect(text).toContain(GOAL_VALID_MARKER);
      expect(seenInputs).toHaveLength(1);
      const captured = seenInputs[0] as Record<string, unknown>;
      expect(captured.providerInstanceId).toBe("provider-byok-1");
      expect(captured.agentId).toBe("agent-goal-validator");
      expect(captured.prompt).toBe("评审提示词");
      expect(captured.tools).toBe(0);
      expect(captured.capabilityGrantIds).toEqual([]);
      expect(captured.maxRounds).toBe(1);
    }),
  );
});
