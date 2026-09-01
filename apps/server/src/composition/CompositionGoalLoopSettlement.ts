import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
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
    | "goal_loop_redispatch_not_latest"
    | "goal_loop_redispatch_new_run_missing"
    | "goal_loop_redispatch_new_run_conflict"
    | "goal_loop_redispatch_new_run_not_started";
  readonly detail: string;
}> {}

export type CompositionGoalLoopRedispatchStorePort = CompositionGoalLoopStorePort &
  Pick<
    CompositionTaskStoreShape,
    "getTask" | "getRun" | "getLatestRun" | "upsertRun" | "upsertTask"
  >;

const RUN_TERMINAL_STATUSES: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export type CompositionGoalLoopSettleOptions = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string | undefined;
  readonly runtimeId?: string | undefined;
  readonly store: CompositionGoalLoopRedispatchStorePort;
  /** 中断落定时间戳，写入 run.finishedAtUnixMs 与 task.updatedAtUnixMs。 */
  readonly nowUnixMs: number;
  /** 结算说明透传给 supervisor 结算行。 */
  readonly note?: string | undefined;
  /** supervisor 结算行类别：redispatch=待改派（blocked）；abandon=放弃恢复（failed）。 */
  readonly decision: "redispatch" | "abandon";
  /** 陈旧 running 态 run 收口 failed 时写入的 failureCode。 */
  readonly staleFailureCode: "goal_loop_interrupted" | "goal_loop_abandoned";
  /** retry intent 已存在时，允许重入既有 supervisor:redispatch 结算行。 */
  readonly allowExistingRedispatchSettlement?: boolean;
};

export type GoalLoopSettlementState = {
  readonly scan: CompositionGoalLoopScanResult;
  readonly run: CompositionTaskRun;
  readonly task: CompositionTask;
};

export const loadGoalLoopSettlementState = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store"> & {
    readonly allowExistingRedispatchSettlement: boolean;
  },
): Effect.Effect<
  GoalLoopSettlementState,
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
    const redispatchSettlementId = `${goalLoopEventPrefix(
      options.taskId,
      options.runId,
    )}:supervisor:redispatch`;
    const hasRedispatchSettlement = events.some(
      (event) => event.sourceEventId === redispatchSettlementId,
    );
    if (
      !scan.interrupted &&
      !(options.allowExistingRedispatchSettlement && hasRedispatchSettlement)
    ) {
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
    return { scan, run: runOption.value, task: taskOption.value };
  });

export const loadGoalLoopState = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store">,
): Effect.Effect<
  GoalLoopSettlementState,
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const events = yield* options.store.listEvents(options.taskId, options.runId);
    const runOption = yield* options.store.getRun(options.runId);
    const taskOption = yield* options.store.getTask(options.taskId);
    if (Option.isNone(runOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_run_missing",
        detail: `Run ${options.runId} 不存在，无法恢复重派。`,
      });
    }
    if (Option.isNone(taskOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_task_missing",
        detail: `Task ${options.taskId} 不存在，无法恢复重派。`,
      });
    }
    return {
      scan: scanCompositionGoalLoopRun(events, {
        taskId: options.taskId,
        runId: options.runId,
      }),
      run: runOption.value,
      task: taskOption.value,
    };
  });

/**
 * 控制操作共用的结算流程：校验目标 Run 后落 supervisor 决定，并把陈旧 run/task 收口。
 * redispatch 重入只接受同一 Run 上已经存在的 supervisor:redispatch 行。
 */
export const settleInterruptedGoalLoop = (
  options: CompositionGoalLoopSettleOptions,
): Effect.Effect<
  GoalLoopSettlementState,
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const state = yield* loadGoalLoopSettlementState({
      taskId: options.taskId,
      runId: options.runId,
      store: options.store,
      allowExistingRedispatchSettlement:
        options.allowExistingRedispatchSettlement === true && options.decision === "redispatch",
    });

    if (state.scan.interrupted) {
      yield* superviseCompositionGoalLoopRun({
        taskId: options.taskId,
        runId: options.runId,
        agentId: options.agentId,
        ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
        ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
        store: options.store,
        decision: options.decision,
        ...(options.note === undefined ? {} : { note: options.note }),
      });
    }

    let run = state.run;
    if (!RUN_TERMINAL_STATUSES.has(run.status)) {
      run = {
        ...run,
        status: "failed",
        failureCode: options.staleFailureCode,
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertRun(run);
    }
    let task = state.task;
    if (task.status !== "failed" && task.status !== "timed_out") {
      task = {
        ...task,
        status: "failed",
        updatedAtUnixMs: options.nowUnixMs,
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertTask(task);
    }

    return { scan: state.scan, run, task };
  });
