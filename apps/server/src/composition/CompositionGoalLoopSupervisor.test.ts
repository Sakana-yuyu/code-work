import type { CompositionTaskEvent } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import {
  scanCompositionGoalLoopRun,
  superviseCompositionGoalLoopRun,
} from "./CompositionGoalLoopSupervisor.ts";

type LedgerRow = CompositionTaskEvent & { readonly sourceEventId: string };

const goalRow = (
  taskId: string,
  runId: string,
  suffix: string,
  overrides: Partial<CompositionTaskEvent> = {},
): LedgerRow =>
  ({
    taskId,
    runId,
    agentId: "agent-1",
    sourceEventId: `${goalLoopEventPrefix(taskId, runId)}:${suffix}`,
    status: "running",
    sequence: 0,
    eventType: "progress",
    summary: "占位行",
    ...overrides,
  }) as LedgerRow;

/** 内存台账：listEvents 返回当前全部行，appendEventIfNew 按真实语义去重。 */
const makeStore = (initialRows: LedgerRow[] = []) => {
  const rows = [...initialRows];
  let failNextAppend = false;
  return {
    rows,
    failNextAppend: () => {
      failNextAppend = true;
    },
    store: {
      listEvents: (_taskId: string, _runId: string) => Effect.succeed(rows),
      appendEventIfNew: (event: LedgerRow) =>
        Effect.sync(() => {
          if (failNextAppend) {
            failNextAppend = false;
            return false;
          }
          if (rows.some((row) => row.sourceEventId === event.sourceEventId)) return false;
          rows.push(event);
          return true;
        }),
    },
  };
};

describe("scanCompositionGoalLoopRun", () => {
  it("已开始且无终态行视为未收敛，并统计轮次与拒绝次数", () => {
    const scan = scanCompositionGoalLoopRun(
      [
        goalRow("t", "r", "start"),
        goalRow("t", "r", "round:1"),
        goalRow("t", "r", "round:3"),
        goalRow("t", "r", "reject:2"),
      ],
      { taskId: "t", runId: "r" },
    );
    expect(scan.interrupted).toBe(true);
    expect(scan.completedRounds).toBe(3);
    expect(scan.rejectedCompletions).toBe(2);
    expect(scan.settledBySupervisor).toBe(false);
  });

  it("有终态行、被 supervisor 结算过或从未开始均不算未收敛", () => {
    expect(
      scanCompositionGoalLoopRun(
        [
          goalRow("t", "r", "start"),
          goalRow("t", "r", "terminal:completed", { eventType: "status" }),
        ],
        { taskId: "t", runId: "r" },
      ).interrupted,
    ).toBe(false);
    expect(
      scanCompositionGoalLoopRun(
        [
          goalRow("t", "r", "start"),
          goalRow("t", "r", "supervisor:redispatch", { eventType: "status" }),
        ],
        { taskId: "t", runId: "r" },
      ).settledBySupervisor,
    ).toBe(true);
    expect(
      scanCompositionGoalLoopRun([goalRow("t", "r", "round:1")], { taskId: "t", runId: "r" })
        .interrupted,
    ).toBe(true);
    expect(scanCompositionGoalLoopRun([], { taskId: "t", runId: "r" }).interrupted).toBe(false);
  });

  it("非 Goal Loop 行与无 sourceEventId 的行不参与判定", () => {
    const foreign = goalRow("t", "r", "terminal:cancelled", { eventType: "status" });
    const scan = scanCompositionGoalLoopRun(
      [
        { ...foreign, sourceEventId: undefined },
        goalRow("other", "r", "terminal:cancelled", { eventType: "status" }),
        goalRow("t", "other", "terminal:cancelled", { eventType: "status" }),
      ],
      { taskId: "t", runId: "r" },
    );
    expect(scan.interrupted).toBe(false);
    expect(scan.started).toBe(false);
  });
});

describe("superviseCompositionGoalLoopRun", () => {
  effectIt.effect("未收敛 Run 可结算为待改派，落幂等 blocked 结算行", () =>
    Effect.gen(function* () {
      const fake = makeStore([
        goalRow("task-1", "run-1", "start"),
        goalRow("task-1", "run-1", "round:2"),
        goalRow("task-1", "run-1", "reject:1"),
      ]);
      const scan = yield* superviseCompositionGoalLoopRun({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        runtimeId: "runtime-byok",
        store: fake.store,
        decision: "redispatch",
        note: "改派给备用 Agent",
      });
      expect(scan.interrupted).toBe(true);
      expect(fake.rows).toHaveLength(4);
      const settled = fake.rows[3];
      expect(settled?.sourceEventId).toBe("goalloop:task-1:run-1:supervisor:redispatch");
      expect(settled?.status).toBe("blocked");
      expect(settled?.summary).toContain("已完成 2 轮");
      expect(settled?.summary).toContain("被拒 1 次");
      expect(settled?.summary).toContain("已标记待改派");
      expect(settled?.summary).toContain("改派给备用 Agent");
    }),
  );

  effectIt.effect("abandon 结算映射 failed，已收敛或重复结算显式拒绝", () =>
    Effect.gen(function* () {
      const fake = makeStore([
        goalRow("task-2", "run-2", "start"),
        goalRow("task-2", "run-2", "round:1"),
      ]);
      const scan = yield* superviseCompositionGoalLoopRun({
        taskId: "task-2",
        runId: "run-2",
        agentId: "agent-2",
        store: fake.store,
        decision: "abandon",
      });
      expect(scan.interrupted).toBe(true);
      expect(fake.rows[2]?.status).toBe("failed");
      expect(fake.rows[2]?.summary).toContain("已放弃恢复");

      // 再次结算：扫描已能看到 supervisor 行 → not_interrupted（语义上已被结算）。
      const twice = yield* superviseCompositionGoalLoopRun({
        taskId: "task-2",
        runId: "run-2",
        agentId: "agent-2",
        store: fake.store,
        decision: "abandon",
      }).pipe(Effect.flip);
      if (twice._tag !== "CompositionGoalLoopSupervisorError") {
        throw new Error("Expected a CompositionGoalLoopSupervisorError");
      }
      expect(twice.code).toBe("goal_loop_supervisor_not_interrupted");

      // 循环已正常收敛的 Run 不允许结算。
      const converged = makeStore([
        goalRow("task-3", "run-3", "start"),
        goalRow("task-3", "run-3", "terminal:completed", { eventType: "status" }),
      ]);
      const notInterrupted = yield* superviseCompositionGoalLoopRun({
        taskId: "task-3",
        runId: "run-3",
        agentId: "agent-3",
        store: converged.store,
        decision: "redispatch",
      }).pipe(Effect.flip);
      if (notInterrupted._tag !== "CompositionGoalLoopSupervisorError") {
        throw new Error("Expected a CompositionGoalLoopSupervisorError");
      }
      expect(notInterrupted.code).toBe("goal_loop_supervisor_not_interrupted");
    }),
  );

  effectIt.effect("结算行写入被抢占时报 already_settled，不产生重复结算", () =>
    Effect.gen(function* () {
      const fake = makeStore([
        goalRow("task-4", "run-4", "start"),
        goalRow("task-4", "run-4", "round:1"),
      ]);
      fake.failNextAppend();
      const failure = yield* superviseCompositionGoalLoopRun({
        taskId: "task-4",
        runId: "run-4",
        agentId: "agent-4",
        store: fake.store,
        decision: "redispatch",
      }).pipe(Effect.flip);
      if (failure._tag !== "CompositionGoalLoopSupervisorError") {
        throw new Error("Expected a CompositionGoalLoopSupervisorError");
      }
      expect(failure.code).toBe("goal_loop_supervisor_already_settled");
      expect(fake.rows).toHaveLength(2);
    }),
  );
});
