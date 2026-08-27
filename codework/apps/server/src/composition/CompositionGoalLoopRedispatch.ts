import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  CompositionGoalLoopSupervisorError,
  scanCompositionGoalLoopRun,
  superviseCompositionGoalLoopRun,
  type CompositionGoalLoopScanResult,
  type CompositionGoalLoopStorePort,
} from "./CompositionGoalLoopSupervisor.ts";

export class CompositionGoalLoopRedispatchError extends Data.TaggedError(
  "CompositionGoalLoopRedispatchError",
)<{
  readonly code:
    | "goal_loop_redispatch_task_missing"
    | "goal_loop_redispatch_run_missing"
    | "goal_loop_redispatch_not_latest";
  readonly detail: string;
}> {}

export type CompositionGoalLoopRedispatchStorePort = CompositionGoalLoopStorePort &
  Pick<
    CompositionTaskStoreShape,
    "getTask" | "getRun" | "getLatestRun" | "upsertRun" | "upsertTask"
  >;

export type CompositionGoalLoopRedispatchOptions<E> = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionGoalLoopRedispatchStorePort;
  /** 中断落定时间戳，写入 run.finishedAtUnixMs 与 task.updatedAtUnixMs。 */
  readonly nowUnixMs: number;
  /** 结算说明透传给 supervisor 结算行。 */
  readonly note?: string;
  /**
   * 实际重派执行，通常包装 orchestrator.retryTask（创建新 Run 并重新派发）。
   * 仅在结算与状态落定全部成功后调用。
   */
  readonly redispatch: (args: {
    readonly previousRunId: string;
    readonly interruptedRounds: number;
  }) => Effect.Effect<void, E>;
};

const RUN_TERMINAL_STATUSES: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

/**
 * supervisor 结算 → 编排层自动重派的接线：
 * 1. 纯扫描判定未收敛（无副作用，校验失败不落任何行）；
 * 2. 校验 run 存在且是最新 Run；
 * 3. supervisor 落幂等 `supervisor:redispatch` 结算行（blocked）；
 * 4. 把陈旧的 running 态 run/task 落定为 failed（failureCode=goal_loop_interrupted），
 *    使其满足 retryTask 的"仅失败可重试"门槛；
 * 5. 调用 redispatch 回调执行真实重派。
 */
export const settleAndRedispatchInterruptedGoalLoop = <E>(
  options: CompositionGoalLoopRedispatchOptions<E>,
): Effect.Effect<
  {
    readonly scan: CompositionGoalLoopScanResult;
    readonly run: CompositionTaskRun;
    readonly task: CompositionTask;
  },
  | E
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const events = yield* options.store.listEvents(options.taskId, options.runId);
    const scan = scanCompositionGoalLoopRun(events, {
      taskId: options.taskId,
      runId: options.runId,
    });
    if (!scan.interrupted) {
      return yield* new CompositionGoalLoopSupervisorError({
        code: "goal_loop_supervisor_not_interrupted",
        detail: scan.settledBySupervisor
          ? "该 Run 的 Goal Loop 已由 supervisor 结算过。"
          : "该 Run 没有未收敛的 Goal Loop（无 start/round 行或已有终态行）。",
      });
    }

    const runOption = yield* options.store.getRun(options.runId);
    if (Option.isNone(runOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_run_missing",
        detail: `Run ${options.runId} 不存在，无法重派。`,
      });
    }
    const taskOption = yield* options.store.getTask(options.taskId);
    if (Option.isNone(taskOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_task_missing",
        detail: `Task ${options.taskId} 不存在，无法重派。`,
      });
    }
    const latestRunOption = yield* options.store.getLatestRun(options.taskId);
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== options.runId) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_not_latest",
        detail: `Run ${options.runId} 不是 Task ${options.taskId} 的最新 Run，拒绝自动重派。`,
      });
    }

    yield* superviseCompositionGoalLoopRun({
      taskId: options.taskId,
      runId: options.runId,
      agentId: options.agentId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
      ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
      store: options.store,
      decision: "redispatch",
      ...(options.note === undefined ? {} : { note: options.note }),
    });

    // 把陈旧 run/task 收口为 failed，满足 retryTask 的失败重试门槛。
    let run = runOption.value;
    if (!RUN_TERMINAL_STATUSES.has(run.status)) {
      run = {
        ...run,
        status: "failed",
        failureCode: "goal_loop_interrupted",
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertRun(run);
    }
    let task = taskOption.value;
    if (task.status !== "failed" && task.status !== "timed_out") {
      task = {
        ...task,
        status: "failed",
        updatedAtUnixMs: options.nowUnixMs,
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertTask(task);
    }

    yield* options.redispatch({
      previousRunId: options.runId,
      interruptedRounds: scan.completedRounds,
    });
    return { scan, run, task };
  });
