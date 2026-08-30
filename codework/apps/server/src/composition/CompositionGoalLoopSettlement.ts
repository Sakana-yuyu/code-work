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
    | "goal_loop_redispatch_run_not_started"
    | "goal_loop_redispatch_run_identity_mismatch";
  readonly detail: string;
}> {}

export type CompositionGoalLoopRedispatchStorePort = CompositionGoalLoopStorePort &
  Pick<
    CompositionTaskStoreShape,
    "getTask" | "getRun" | "getLatestRun" | "upsertRun" | "upsertTask"
  >;

export type CompositionGoalLoopSettlementResult = {
  readonly scan: CompositionGoalLoopScanResult;
  readonly run: CompositionTaskRun;
  readonly task: CompositionTask;
};

export type CompositionGoalLoopSettlementInspection = CompositionGoalLoopSettlementResult;

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
};

const RUN_TERMINAL_STATUSES: ReadonlySet<CompositionTaskRun["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const readRequiredSnapshot = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store">,
): Effect.Effect<
  { readonly run: CompositionTaskRun; readonly task: CompositionTask },
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const runOption = yield* options.store.getRun(options.runId);
    if (Option.isNone(runOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_run_missing",
        detail: `Run ${options.runId} 不存在，无法重派。`,
      });
    }
    if (runOption.value.taskId !== options.taskId) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_run_identity_mismatch",
        detail: `Run ${options.runId} 不属于 Task ${options.taskId}，拒绝继续重派。`,
      });
    }
    const taskOption = yield* options.store.getTask(options.taskId);
    if (Option.isNone(taskOption)) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_task_missing",
        detail: `Task ${options.taskId} 不存在，无法重派。`,
      });
    }
    return { run: runOption.value, task: taskOption.value };
  });

const ensureLatestRun = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store">,
): Effect.Effect<void, CompositionGoalLoopRedispatchError | CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const latestRunOption = yield* options.store.getLatestRun(options.taskId);
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== options.runId) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_not_latest",
        detail: `Run ${options.runId} 不是 Task ${options.taskId} 的最新 Run，拒绝自动重派。`,
      });
    }
  });

const hasSupervisorDecision = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "decision">,
  events: ReadonlyArray<{ readonly sourceEventId?: string | undefined }>,
): boolean => {
  const expected = `${goalLoopEventPrefix(options.taskId, options.runId)}:supervisor:${options.decision}`;
  return events.some((event) => event.sourceEventId === expected);
};

/** 无副作用校验：首次创建 retry intent 前确认 Goal Loop 未收敛且旧 Run 仍为最新。 */
export const inspectInterruptedGoalLoopSettlement = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store">,
): Effect.Effect<
  CompositionGoalLoopSettlementInspection,
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
    const snapshot = yield* readRequiredSnapshot(options);
    yield* ensureLatestRun(options);
    return { scan, ...snapshot };
  });

/** 已有持久 retry intent 时只读当前投影，不再用旧 Run 是否最新来否定恢复。 */
export const readGoalLoopSettlementSnapshot = (
  options: Pick<CompositionGoalLoopSettleOptions, "taskId" | "runId" | "store">,
): Effect.Effect<
  CompositionGoalLoopSettlementResult,
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const events = yield* options.store.listEvents(options.taskId, options.runId);
    const scan = scanCompositionGoalLoopRun(events, {
      taskId: options.taskId,
      runId: options.runId,
    });
    const snapshot = yield* readRequiredSnapshot(options);
    return { scan, ...snapshot };
  });

/**
 * 可重入结算旧 Run。首次调用使用预检快照；若进程在 supervisor 行或状态投影后崩溃，
 * 重入接受同一 decision 的幂等行并补齐旧 Run 状态。若新 Run 已成为最新，不再覆盖其 Task 状态。
 */
export const settleInterruptedGoalLoop = (
  options: CompositionGoalLoopSettleOptions,
  inspection?: CompositionGoalLoopSettlementInspection,
): Effect.Effect<
  CompositionGoalLoopSettlementResult,
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    let scan: CompositionGoalLoopScanResult;
    if (inspection === undefined) {
      const events = yield* options.store.listEvents(options.taskId, options.runId);
      scan = scanCompositionGoalLoopRun(events, {
        taskId: options.taskId,
        runId: options.runId,
      });
      if (scan.interrupted) {
        yield* readRequiredSnapshot(options);
        yield* ensureLatestRun(options);
      } else if (!hasSupervisorDecision(options, events)) {
        return yield* new CompositionGoalLoopSupervisorError({
          code: "goal_loop_supervisor_not_interrupted",
          detail: scan.settledBySupervisor
            ? "该 Run 已由其他 supervisor 决策结算。"
            : "该 Run 没有未收敛的 Goal Loop（无 start/round 行或已有终态行）。",
        });
      }
    } else {
      scan = inspection.scan;
    }

    if (scan.interrupted) {
      const supervised = yield* Effect.result(
        superviseCompositionGoalLoopRun({
          taskId: options.taskId,
          runId: options.runId,
          agentId: options.agentId,
          ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
          ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
          store: options.store,
          decision: options.decision,
          ...(options.note === undefined ? {} : { note: options.note }),
        }),
      );
      if (supervised._tag === "Failure") {
        const events = yield* options.store.listEvents(options.taskId, options.runId);
        if (!hasSupervisorDecision(options, events)) {
          return yield* supervised.failure;
        }
      }
    }

    const snapshot = yield* readRequiredSnapshot(options);
    let run = snapshot.run;
    if (!RUN_TERMINAL_STATUSES.has(run.status)) {
      run = {
        ...run,
        status: "failed",
        failureCode: options.staleFailureCode,
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertRun(run);
    }

    let task = snapshot.task;
    const latestRunOption = yield* options.store.getLatestRun(options.taskId);
    const oldRunStillLatest =
      Option.isSome(latestRunOption) && latestRunOption.value.runId === options.runId;
    if (oldRunStillLatest && task.status !== "failed" && task.status !== "timed_out") {
      task = {
        ...task,
        status: "failed",
        updatedAtUnixMs: options.nowUnixMs,
        finishedAtUnixMs: options.nowUnixMs,
      };
      yield* options.store.upsertTask(task);
    }

    return { scan, run, task };
  });
