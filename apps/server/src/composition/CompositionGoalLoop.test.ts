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
  scanGoalMarkers,
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

describe("scanGoalMarkers", () => {
  it("无标记时原样透传", () => {
    const text = "尚未完成，还需要一轮 [[ 未闭合也不算标记";
    expect(scanGoalMarkers(text)).toEqual({ text, complete: false, cancelled: false });
  });

  it("剥离尾部无原因与带原因的完成标记", () => {
    const plain = scanGoalMarkers("任务完成 [[GOAL_COMPLETE]]");
    expect(plain).toEqual({ text: "任务完成", complete: true, cancelled: false });

    const withReason = scanGoalMarkers("任务完成 [[GOAL_COMPLETE: 全部测试通过]]");
    expect(withReason).toEqual({ text: "任务完成", complete: true, cancelled: false });
  });

  it("剥离任意位置的标记并清理尾随空白", () => {
    const mid = scanGoalMarkers("结论：完成 [[GOAL_COMPLETE: 达成]] \n\n");
    expect(mid).toEqual({ text: "结论：完成", complete: true, cancelled: false });

    const multiple = scanGoalMarkers("A [[GOAL_COMPLETE]] 中段 [[GOAL_COMPLETE: 再次声明]]");
    expect(multiple.complete).toBe(true);
    expect(multiple.text).toBe("A  中段");
    expect(multiple.text).not.toContain("[[GOAL_COMPLETE");
  });

  it("剥离取消标记；与完成标记同时出现时两项均上报，优先级由调用方决定", () => {
    const cancelled = scanGoalMarkers("需求已失效 [[GOAL_CANCELLED: 用户叫停]]");
    expect(cancelled).toEqual({ text: "需求已失效", complete: false, cancelled: true });

    const both = scanGoalMarkers("完成 [[GOAL_COMPLETE]] 取消 [[GOAL_CANCELLED]]");
    expect(both.complete).toBe(true);
    expect(both.cancelled).toBe(true);
    expect(both.text).toBe("完成  取消");
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

  effectIt.effect("连续相同输出达到 stalePivotRounds 阈值时按 pivot_required 收敛", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        stalePivotRounds: 3,
        attempt: () => Effect.sync(() => attemptOf("仍在原地打转", 1)),
      });
      expect(result.status).toBe("pivot_required");
      expect(result.rounds).toBe(3);
      expect(result.costUnitsUsed).toBe(3);
      expect(result.completion).toBeUndefined();
      expect(result.pivot?.staleRounds).toBe(3);
      expect(result.pivot?.lastCleanText).toBe("仍在原地打转");
    }),
  );

  effectIt.effect("输出出现变化会重置停滞计数，避免误报 pivot", () =>
    Effect.gen(function* () {
      const outputs = ["卡住", "卡住", "有新进展", "卡住", "卡住"];
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        stalePivotRounds: 3,
        attempt: (round) => Effect.sync(() => attemptOf(outputs[round - 1], 1)),
      });
      expect(result.status).toBe("budget_exhausted");
      expect(result.rounds).toBe(5);
      expect(result.pivot).toBeUndefined();
    }),
  );

  effectIt.effect("空输出（idle）同样计入无进展并触发 pivot", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        stalePivotRounds: 2,
        attempt: () => Effect.sync(() => attemptOf("")),
      });
      expect(result.status).toBe("pivot_required");
      expect(result.rounds).toBe(2);
      expect(result.pivot?.staleRounds).toBe(2);
      expect(result.pivot?.lastCleanText).toBe("");
    }),
  );

  effectIt.effect("同轮出现完成标记时标记优先于停滞判定", () =>
    Effect.gen(function* () {
      const outputs = ["还在停", `还在停 [[GOAL_COMPLETE: 突破并完成]]`];
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        stalePivotRounds: 2,
        attempt: (round) => Effect.sync(() => attemptOf(outputs[round - 1])),
      });
      expect(result.status).toBe("completed");
      expect(result.completion?.reason).toBe("突破并完成");
      expect(result.pivot).toBeUndefined();
    }),
  );

  effectIt.effect("轮数预算先耗尽不误报 pivot；轮开始前的取消仍优先", () =>
    Effect.gen(function* () {
      const budgetResult = yield* runCompositionGoalLoop({
        maxAttempts: 2,
        stalePivotRounds: 3,
        attempt: () => Effect.sync(() => attemptOf("重复输出")),
      });
      expect(budgetResult.status).toBe("budget_exhausted");
      expect(budgetResult.pivot).toBeUndefined();

      let executed = 0;
      const cancelResult = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        stalePivotRounds: 3,
        isCancelled: () => executed >= 1,
        attempt: () =>
          Effect.sync(() => {
            executed += 1;
            return attemptOf("同一输出");
          }),
      });
      expect(cancelResult.status).toBe("cancelled");
      expect(cancelResult.rounds).toBe(1);
    }),
  );

  effectIt.effect("非法 stalePivotRounds 显式拒绝", () =>
    Effect.gen(function* () {
      const failure = yield* runCompositionGoalLoop({
        maxAttempts: 2,
        stalePivotRounds: 0,
        attempt: () => Effect.sync(() => attemptOf("x")),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("CompositionGoalLoopInvalidError");
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

  effectIt.effect("完成标记需验证子代理接受才收敛，拒绝后继续循环", () =>
    Effect.gen(function* () {
      const outputs = [`第一轮 [[GOAL_COMPLETE: 为时过早]]`, `第二轮 [[GOAL_COMPLETE: 真完成]]`];
      const seen: Array<{ round: number; cleanText: string; reason: string | undefined }> = [];
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 5,
        attempt: (round) => Effect.sync(() => attemptOf(outputs[round - 1], 1)),
        validateCompletion: (input) => {
          seen.push({ round: input.round, cleanText: input.cleanText, reason: input.reason });
          return Effect.succeed(
            input.round === 1 ? { accepted: false, detail: "证据不足" } : { accepted: true },
          );
        },
      });
      expect(result.status).toBe("completed");
      expect(result.rounds).toBe(2);
      expect(result.completion?.reason).toBe("真完成");
      expect(result.rejectedCompletions).toEqual([{ round: 1, detail: "证据不足" }]);
      expect(seen).toEqual([
        { round: 1, cleanText: "第一轮", reason: "为时过早" },
        { round: 2, cleanText: "第二轮", reason: "真完成" },
      ]);
    }),
  );

  effectIt.effect("验证始终拒绝时按既有预算规则收敛，并保留全部拒绝记录", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 2,
        attempt: () => Effect.sync(() => attemptOf(`进展 [[GOAL_COMPLETE: 想完成]]`, 1)),
        validateCompletion: () => Effect.succeed({ accepted: false, detail: "未通过校验" }),
      });
      expect(result.status).toBe("budget_exhausted");
      expect(result.rounds).toBe(2);
      expect(result.completion).toBeUndefined();
      expect(result.rejectedCompletions).toEqual([
        { round: 1, detail: "未通过校验" },
        { round: 2, detail: "未通过校验" },
      ]);
    }),
  );

  effectIt.effect("被拒绝的声明输出参与停滞判定，可在拒绝同时提前 pivot", () =>
    Effect.gen(function* () {
      const result = yield* runCompositionGoalLoop({
        maxAttempts: 10,
        stalePivotRounds: 2,
        attempt: () => Effect.sync(() => attemptOf("卡在同一句话 [[GOAL_COMPLETE: 完成了？]]", 1)),
        validateCompletion: () => Effect.succeed({ accepted: false, detail: "重复输出不可信" }),
      });
      expect(result.status).toBe("pivot_required");
      expect(result.rounds).toBe(2);
      expect(result.pivot?.staleRounds).toBe(2);
      expect(result.rejectedCompletions).toEqual([
        { round: 1, detail: "重复输出不可信" },
        { round: 2, detail: "重复输出不可信" },
      ]);
    }),
  );

  effectIt.effect("验证子代理失败原样上抛", () =>
    Effect.gen(function* () {
      const failure = yield* runCompositionGoalLoop<string, TestAttemptFailure>({
        maxAttempts: 3,
        attempt: () => Effect.sync(() => attemptOf(`输出 [[GOAL_COMPLETE]]`)),
        validateCompletion: () => Effect.fail(new TestAttemptFailure({ detail: "校验器超时" })),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("TestAttemptFailure");
      expect(failure.detail).toBe("校验器超时");
    }),
  );
});
