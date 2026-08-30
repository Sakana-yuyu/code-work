import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionGoalLoopRetryIntent,
  CompositionGoalLoopRetryStoreError,
  CompositionGoalLoopRetryStoreShape,
} from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import type { CompositionTaskStoreError } from "../persistence/Services/CompositionTaskStore.ts";
import {
  CompositionGoalLoopRedispatchError,
  loadGoalLoopSettlementState,
  loadGoalLoopState,
  settleInterruptedGoalLoop,
  type CompositionGoalLoopRedispatchStorePort,
} from "./CompositionGoalLoopSettlement.ts";
import {
  CompositionGoalLoopSupervisorError,
  type CompositionGoalLoopScanResult,
} from "./CompositionGoalLoopSupervisor.ts";

export { CompositionGoalLoopRedispatchError } from "./CompositionGoalLoopSettlement.ts";
export type { CompositionGoalLoopRedispatchStorePort } from "./CompositionGoalLoopSettlement.ts";

export type CompositionGoalLoopRetryStorePort = Pick<
  CompositionGoalLoopRetryStoreShape,
  "prepareIntent" | "getIntent" | "markSettled" | "markDispatched"
>;

export type CompositionGoalLoopRedispatchOptions<E> = {
  readonly taskId: string;
  readonly runId: string;
  /** 首次请求提出的新 Run ID；若已有持久意图，则自动复用账本中的稳定值。 */
  readonly newRunId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionGoalLoopRedispatchStorePort;
  readonly retryStore: CompositionGoalLoopRetryStorePort;
  /** 中断落定时间戳，写入 run.finishedAtUnixMs 与 task.updatedAtUnixMs。 */
  readonly nowUnixMs: number;
  /** 结算说明透传给 supervisor 结算行。 */
  readonly note?: string;
  /**
   * 实际重派执行，通常包装 orchestrator.retryTask（创建新 Run 并重新派发）。
   * 回调必须使用参数中的稳定 newRunId，不能重新生成。
   */
  readonly redispatch: (args: {
    readonly previousRunId: string;
    readonly newRunId: string;
    readonly interruptedRounds: number;
  }) => Effect.Effect<void, E>;
};

const verifyNewRun = (
  store: CompositionGoalLoopRedispatchStorePort,
  intent: CompositionGoalLoopRetryIntent,
  previousRun: CompositionTaskRun,
): Effect.Effect<
  CompositionTaskRun,
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  Effect.flatMap(store.getRun(intent.newRunId), (newRunOption) => {
    if (Option.isNone(newRunOption)) {
      return Effect.fail(
        new CompositionGoalLoopRedispatchError({
          code: "goal_loop_redispatch_new_run_missing",
          detail: `重派回调结束后仍未找到新 Run ${intent.newRunId}。`,
        }),
      );
    }
    return newRunOption.value.taskId === intent.taskId &&
      newRunOption.value.attempt === previousRun.attempt + 1
      ? Effect.succeed(newRunOption.value)
      : Effect.fail(
          new CompositionGoalLoopRedispatchError({
            code: "goal_loop_redispatch_new_run_conflict",
            detail: `新 Run ${intent.newRunId} 与 Task 或 retry attempt 不匹配。`,
          }),
        );
  });

/**
 * 持久 retry intent → 旧状态结算 → 稳定 newRunId 重派。
 * 任一阶段中断后都可由下一次调用按持久阶段恢复，不依赖进程内标志或轮询。
 */
export const settleAndRedispatchInterruptedGoalLoop = <E>(
  options: CompositionGoalLoopRedispatchOptions<E>,
): Effect.Effect<
  {
    readonly scan: CompositionGoalLoopScanResult;
    readonly run: CompositionTaskRun;
    readonly task: CompositionTask;
    readonly newRunId: string;
  },
  | E
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionTaskStoreError
  | CompositionGoalLoopRetryStoreError
> =>
  Effect.gen(function* () {
    let intentOption = yield* options.retryStore.getIntent(options.runId);
    if (Option.isNone(intentOption)) {
      yield* loadGoalLoopSettlementState({
        taskId: options.taskId,
        runId: options.runId,
        store: options.store,
        allowExistingRedispatchSettlement: true,
      });
      intentOption = Option.some(
        yield* options.retryStore.prepareIntent({
          taskId: options.taskId,
          previousRunId: options.runId,
          newRunId: options.newRunId,
          createdAtUnixMs: options.nowUnixMs,
        }),
      );
    }
    let intent = Option.getOrThrow(intentOption);
    if (intent.taskId !== options.taskId) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_new_run_conflict",
        detail: `旧 Run ${options.runId} 的 retry intent 已属于其他 Task。`,
      });
    }

    const settled =
      intent.phase === "prepared"
        ? yield* settleInterruptedGoalLoop({
            taskId: options.taskId,
            runId: options.runId,
            agentId: options.agentId,
            parentTaskId: options.parentTaskId,
            runtimeId: options.runtimeId,
            store: options.store,
            nowUnixMs: options.nowUnixMs,
            note: options.note,
            decision: "redispatch",
            staleFailureCode: "goal_loop_interrupted",
            allowExistingRedispatchSettlement: true,
          })
        : yield* loadGoalLoopState({
            taskId: options.taskId,
            runId: options.runId,
            store: options.store,
          });
    if (intent.phase === "prepared") {
      intent = yield* options.retryStore.markSettled({
        previousRunId: options.runId,
        updatedAtUnixMs: options.nowUnixMs,
      });
    }

    const existingNewRun = yield* options.store.getRun(intent.newRunId);
    if (Option.isSome(existingNewRun)) {
      yield* verifyNewRun(options.store, intent, settled.run);
      intent = yield* options.retryStore.markDispatched({
        previousRunId: options.runId,
        updatedAtUnixMs: options.nowUnixMs,
      });
      return {
        scan: settled.scan,
        run: settled.run,
        task: settled.task,
        newRunId: intent.newRunId,
      };
    }
    if (intent.phase === "dispatched") {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_new_run_missing",
        detail: `retry intent 已标记 dispatched，但新 Run ${intent.newRunId} 不存在。`,
      });
    }

    yield* options.redispatch({
      previousRunId: options.runId,
      newRunId: intent.newRunId,
      interruptedRounds: settled.scan.completedRounds,
    });
    yield* verifyNewRun(options.store, intent, settled.run);
    intent = yield* options.retryStore.markDispatched({
      previousRunId: options.runId,
      updatedAtUnixMs: options.nowUnixMs,
    });
    return {
      scan: settled.scan,
      run: settled.run,
      task: settled.task,
      newRunId: intent.newRunId,
    };
  });

/** 放弃结算的入参：与自动重派一致，但无需 retry intent 与 redispatch 回调。 */
export type CompositionGoalLoopAbandonOptions = Omit<
  CompositionGoalLoopRedispatchOptions<never>,
  "redispatch" | "newRunId" | "retryStore"
>;

/** 落 supervisor:abandon 并把陈旧 run/task 收口为 failed，不创建新 Run。 */
export const settleAndAbandonInterruptedGoalLoop = (
  options: CompositionGoalLoopAbandonOptions,
): Effect.Effect<
  {
    readonly scan: CompositionGoalLoopScanResult;
    readonly run: CompositionTaskRun;
    readonly task: CompositionTask;
  },
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionTaskStoreError
> =>
  settleInterruptedGoalLoop({
    taskId: options.taskId,
    runId: options.runId,
    agentId: options.agentId,
    parentTaskId: options.parentTaskId,
    runtimeId: options.runtimeId,
    store: options.store,
    nowUnixMs: options.nowUnixMs,
    note: options.note,
    decision: "abandon",
    staleFailureCode: "goal_loop_abandoned",
  });
