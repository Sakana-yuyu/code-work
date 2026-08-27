import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import {
  GOAL_CANCEL_MARKER,
  GOAL_COMPLETE_MARKER,
  type CompositionGoalLoopDecision,
  parseGoalCompletion,
  runCompositionGoalLoop,
} from "./CompositionGoalLoop.ts";

class TestAttemptFailure extends Data.TaggedError("TestAttemptFailure")<{
  readonly detail: string;
}> {}

const attemptOf = (
  outputText?: string,
  costUnits?: number,
): CompositionGoalLoopDecision<string> => ({
  value: outputText ?? "",
  ...(outputText === undefined ? {} : { outputText }),
  ...(costUnits === undefined ? {} : { costUnits }),
});

const GOAL_COMPLETE_PREFIX_NOT_CONTAIN_HINT = "[[GOAL_COMPLETE";

describe("parseGoalCompletion", () => {
  it("识别无原因标记、带原因标记与无标记三种情况", () => {
    const plain = parseGoalCompletion(`结果 ok ${GOAL_COMPLETE_MARKER}`);
    expect(plain.complete).toBe(true);
    expect(plain.cleanText).toBe("结果 ok");
    expect(plain.reason).toBeUndefined();

    const withReason = parseGoalCompletion(`结论：已修复 [[GOAL_COMPLETE: 全部测试通过]] 尾部内容`);
    expect(withReason.complete).toBe(true);
    // cleanText 只剥离标记本体，前后的正常文本保留。
    expect(withReason.cleanText).toBe("结论：已修复 尾部内容");
    expect(withReason.cleanText).not.toContain(GOAL_COMPLETE_PREFIX_NOT_CONTAIN_HINT);
    expect(withReason.reason).toBe("全部测试通过");

    const none = parseGoalCompletion("尚未完成，还需要一轮");
    expect(none.complete).toBe(false);
    expect(none.cleanText).toBe("尚未完成，还需要一轮");

    const missing = parseGoalCompletion(undefined);
    expect(missing.complete).toBe(false);
  });
});

describe("runCompositionGoalLoop", () => {
  effectIt.effect("输出出现完成标记即收敛为 completed，并剥离标记后返回 cleanText/reason", () =>
    Effect.gen(function* () {
      const outputs = ["第一轮分析……", `第二轮完成 [[GOAL_COMPLETE: 目标达成]]`];
      const rounds: number[] = [];
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (round) =>
          Effect.sync(() => {
            rounds.push(round);
            return attemptOf(outputs[round - 1], 2);
          }),
      });
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(result.costUnitsUsed).toBe(4);
      expect(result.completion?.cleanText).toBe("第二轮完成");
      expect(result.completion?.reason).toBe("目标达成");
      expect(result.history.map((entry) => entry.round)).toEqual([1, 2]);
      expect(rounds).toEqual([1, 2]);
    }),
  );

  effectIt.effect("无标记且轮数耗尽时以 budget_exhausted 收敛", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 3,
        attempt: () =>
          Effect.sync(() => {
            calls += 1;
            return attemptOf(`第 ${calls} 轮仍在推进`, 1);
          }),
      });
      expect(result.status).toBe("budget_exhausted");
      expect(result.rounds).toBe(3);
      expect(calls).toBe(3);
      expect(result.completion).toBeUndefined();
    }),
  );

  effectIt.effect("成本预算先于轮数耗尽时同样以 budget_exhausted 收敛", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        maxCostUnits: 5,
        attempt: (round) => Effect.sync(() => attemptOf(`轮次 ${round}`, 2)),
      });
      expect(result.status).toBe("budget_exhausted");
      expect(result.rounds).toBe(3);
      expect(result.costUnitsUsed).toBe(6);
    }),
  );

  effectIt.effect("attempt 向上下文暴露剩余预算；成本恰好用尽也在下一轮前拦截", () =>
    Effect.gen(function* () {
      const seen: Array<{ remainingAttempts: number; remainingCostUnits: number | undefined }> = [];
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 4,
        maxCostUnits: 4,
        attempt: (round, context) => {
          seen.push(context);
          return Effect.sync(() => attemptOf(`第 ${round} 轮`, round));
        },
      });
      expect(seen).toEqual([
        { remainingAttempts: 4, remainingCostUnits: 4 },
        { remainingAttempts: 3, remainingCostUnits: 3 },
        { remainingAttempts: 2, remainingCostUnits: 1 },
      ]);
      expect(result.status).toBe("budget_exhausted");
      expect(result.costUnitsUsed).toBe(6);
    }),
  );

  effectIt.effect("外部取消在下一轮开始前生效，不再产生新的 attempt", () =>
    Effect.gen(function* () {
      let cancelledAfter = 0;
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        isCancelled: () => cancelledAfter >= 2,
        attempt: () =>
          Effect.sync(() => {
            cancelledAfter += 1;
            return attemptOf("继续");
          }),
      });
      expect(result.status).toBe("cancelled");
      expect(result.rounds).toBe(2);
    }),
  );

  effectIt.effect("输出包含显式取消标记时按 cancelled 收敛", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (round) =>
          Effect.succeed(
            round === 2
              ? { value: "", outputText: `用户要求停止 ${GOAL_CANCEL_MARKER}` }
              : attemptOf("继续"),
          ),
      });
      expect(result.status).toBe("cancelled");
      expect(result.rounds).toBe(2);
      expect(result.completion).toBeUndefined();
    }),
  );

  effectIt.effect("注入 now 的墙钟截止在下一轮开始前触发 deadline_exceeded", () =>
    Effect.gen(function* () {
      let clock = 1_000;
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        deadlineUnixMs: 1_100,
        now: () => clock,
        attempt: () =>
          Effect.sync(() => {
            clock += 60;
            return attemptOf("慢速推进");
          }),
      });
      expect(result.status).toBe("deadline_exceeded");
      // 第 1 轮后 clock=1060 <1100 继续；第 2 轮后 clock=1120 >=1100 停止。
      expect(result.rounds).toBe(2);
    }),
  );

  effectIt.effect("attempt 失败原样上抛（本切片不做失败重试策略）", () =>
    Effect.gen(function* () {
      const failure = yield* runCompositionGoalLoop<string, TestAttemptFailure>({
        maxAttempts: 3,
        attempt: (round) =>
          round === 1
            ? Effect.fail(new TestAttemptFailure({ detail: "模型调用超时" }))
            : Effect.sync(() => attemptOf("不该执行")),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("TestAttemptFailure");
      expect(failure.detail).toBe("模型调用超时");
    }),
  );

  effectIt.effect("非法配置显式拒绝", () =>
    Effect.gen(function* () {
      const zeroAttempts = yield* runCompositionGoalLoop({
        maxAttempts: 0,
        attempt: () => Effect.sync(() => attemptOf("x")),
      }).pipe(Effect.flip);
      expect(zeroAttempts._tag).toBe("CompositionGoalLoopInvalidError");

      const negativeBudget = yield* runCompositionGoalLoop({
        maxAttempts: 2,
        maxCostUnits: -1,
        attempt: () => Effect.sync(() => attemptOf("x")),
      }).pipe(Effect.flip);
      expect(negativeBudget._tag).toBe("CompositionGoalLoopInvalidError");
    }),
  );
});
