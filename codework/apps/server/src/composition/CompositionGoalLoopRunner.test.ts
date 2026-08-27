import type { CompositionTaskEvent } from "@codework/contracts";
import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runCompositionGoalLoopWithLedger } from "./CompositionGoalLoopRunner.ts";
import type { CompositionGoalLoopDecision } from "./CompositionGoalLoop.ts";

type LedgerRow = CompositionTaskEvent & { readonly sourceEventId: string };

/** 带去重语义的内存台账，模拟 appendEventIfNew 的幂等行为。 */
const makeLedger = () => {
  const rows: LedgerRow[] = [];
  const seen = new Set<string>();
  return {
    rows,
    store: {
      appendEventIfNew: (event: LedgerRow) =>
        Effect.sync(() => {
          if (seen.has(event.sourceEventId)) return false;
          seen.add(event.sourceEventId);
          rows.push(event);
          return true;
        }),
    },
  };
};

const attemptOf = (
  outputText: string,
  costUnits?: number,
): CompositionGoalLoopDecision<string> => ({
  value: outputText,
  outputText,
  ...(costUnits === undefined ? {} : { costUnits }),
});

describe("runCompositionGoalLoopWithLedger", () => {
  effectIt.effect("完成收敛把每轮与终态投影进台账，且不落原始输出文本", () =>
    Effect.gen(function* () {
      const ledger = makeLedger();
      const outputs = ["中间推演 SECRET-PAYLOAD", `搞定 [[GOAL_COMPLETE: 全部通过]]`];
      const result = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        runtimeId: "runtime-byok",
        maxAttempts: 5,
        store: ledger.store,
        attempt: (round) => Effect.sync(() => attemptOf(outputs[round - 1]!, 2)),
      });
      expect(result.status).toBe("completed");
      expect(ledger.rows.map((row) => row.sourceEventId)).toEqual([
        "goalloop:task-1:run-1:start",
        "goalloop:task-1:run-1:round:1",
        "goalloop:task-1:run-1:round:2",
        "goalloop:task-1:run-1:terminal:completed",
      ]);
      expect(ledger.rows[0]?.summary).toContain("轮数上限 5");
      expect(ledger.rows[0]?.eventType).toBe("status");
      expect(ledger.rows[1]?.eventType).toBe("progress");
      expect(ledger.rows[1]?.summary).toContain("第 1 轮 attempt 完成（本轮成本 2）");
      expect(ledger.rows[1]?.status).toBe("running");
      const terminal = ledger.rows[3];
      expect(terminal?.status).toBe("completed");
      expect(terminal?.summary).toContain("2 轮");
      expect(terminal?.summary).toContain("原因：全部通过");
      // 敏感内容约定：原始输出不得进入任务台账摘要。
      // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言台账行整体序列化不含敏感原文。
      expect(JSON.stringify(ledger.rows)).not.toContain("SECRET-PAYLOAD");
    }),
  );

  effectIt.effect("验证拒绝写 blocker 行；预算耗尽终态映射 failed 并统计拒绝次数", () =>
    Effect.gen(function* () {
      const ledger = makeLedger();
      const result = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-2",
        runId: "run-2",
        agentId: "agent-2",
        maxAttempts: 2,
        store: ledger.store,
        attempt: () => Effect.sync(() => attemptOf(`想完成 [[GOAL_COMPLETE]]`, 1)),
        validateCompletion: () => Effect.succeed({ accepted: false, detail: "证据不足" }),
      });
      expect(result.status).toBe("budget_exhausted");
      const blockers = ledger.rows.filter((row) => row.eventType === "blocker");
      expect(blockers.map((row) => row.sourceEventId)).toEqual([
        "goalloop:task-2:run-2:reject:1",
        "goalloop:task-2:run-2:reject:2",
      ]);
      expect(blockers[0]?.summary).toBe("第 1 轮完成声明被验证方拒绝：证据不足");
      const terminal = ledger.rows.at(-1);
      expect(terminal?.sourceEventId).toBe("goalloop:task-2:run-2:terminal:budget_exhausted");
      expect(terminal?.status).toBe("failed");
      expect(terminal?.summary).toContain("预算耗尽");
      expect(terminal?.summary).toContain("被拒 2 次");
    }),
  );

  effectIt.effect("外部取消、停滞 pivot 与截止超时分别映射 cancelled/blocked/timed_out", () =>
    Effect.gen(function* () {
      const cancelLedger = makeLedger();
      let executed = 0;
      const cancelResult = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-3",
        runId: "run-3",
        agentId: "agent-3",
        maxAttempts: 10,
        isCancelled: () => executed >= 1,
        store: cancelLedger.store,
        attempt: () =>
          Effect.sync(() => {
            executed += 1;
            return attemptOf("推进");
          }),
      });
      expect(cancelResult.status).toBe("cancelled");
      const cancelTerminal = cancelLedger.rows.at(-1);
      expect(cancelTerminal?.sourceEventId).toBe("goalloop:task-3:run-3:terminal:cancelled");
      expect(cancelTerminal?.status).toBe("cancelled");

      const pivotLedger = makeLedger();
      const pivotResult = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-4",
        runId: "run-4",
        agentId: "agent-4",
        maxAttempts: 10,
        stalePivotRounds: 2,
        store: pivotLedger.store,
        attempt: () => Effect.sync(() => attemptOf("原地打转")),
      });
      expect(pivotResult.status).toBe("pivot_required");
      const pivotTerminal = pivotLedger.rows.at(-1);
      expect(pivotTerminal?.sourceEventId).toBe("goalloop:task-4:run-4:terminal:pivot_required");
      expect(pivotTerminal?.status).toBe("blocked");
      expect(pivotTerminal?.summary).toContain("连续 2 轮无进展");

      const deadlineLedger = makeLedger();
      let clock = 1_000;
      const deadlineResult = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-5",
        runId: "run-5",
        agentId: "agent-5",
        maxAttempts: 10,
        deadlineUnixMs: 1_100,
        now: () => clock,
        store: deadlineLedger.store,
        attempt: () =>
          Effect.sync(() => {
            clock += 600;
            return attemptOf("慢速推进");
          }),
      });
      expect(deadlineResult.status).toBe("deadline_exceeded");
      const deadlineTerminal = deadlineLedger.rows.at(-1);
      expect(deadlineTerminal?.sourceEventId).toBe(
        "goalloop:task-5:run-5:terminal:deadline_exceeded",
      );
      expect(deadlineTerminal?.status).toBe("timed_out");
    }),
  );

  effectIt.effect("台账幂等：重复执行同一循环不重复落行", () =>
    Effect.gen(function* () {
      const ledger = makeLedger();
      const runOnce = () =>
        runCompositionGoalLoopWithLedger({
          taskId: "task-6",
          runId: "run-6",
          agentId: "agent-6",
          maxAttempts: 5,
          store: ledger.store,
          attempt: () => Effect.sync(() => attemptOf(`完成 [[GOAL_COMPLETE]]`)),
        });
      const first = yield* runOnce();
      const rowCountAfterFirst = ledger.rows.length;
      const second = yield* runOnce();
      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(rowCountAfterFirst).toBe(3);
      expect(ledger.rows.length).toBe(rowCountAfterFirst);
    }),
  );

  effectIt.effect("非法配置不落任何台账行", () =>
    Effect.gen(function* () {
      const ledger = makeLedger();
      const failure = yield* runCompositionGoalLoopWithLedger({
        taskId: "task-7",
        runId: "run-7",
        agentId: "agent-7",
        maxAttempts: 0,
        store: ledger.store,
        attempt: () => Effect.sync(() => attemptOf("x")),
      }).pipe(Effect.flip);
      expect(failure._tag).toBe("CompositionGoalLoopInvalidError");
      expect(ledger.rows).toEqual([]);
    }),
  );
});
