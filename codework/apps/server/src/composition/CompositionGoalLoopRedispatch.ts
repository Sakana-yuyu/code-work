import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionGoalLoopRetryIntent,
  CompositionGoalLoopRetryPhase,
  CompositionGoalLoopRetryStoreError,
  CompositionGoalLoopRetryStoreShape,
} from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import type { CompositionTaskStoreError } from "../persistence/Services/CompositionTaskStore.ts";
import {
  CompositionGoalLoopRedispatchError,
  inspectInterruptedGoalLoopSettlement,
  readGoalLoopSettlementSnapshot,
  settleInterruptedGoalLoop,
  type CompositionGoalLoopRedispatchStorePort,
  type CompositionGoalLoopSettlementInspection,
  type CompositionGoalLoopSettlementResult,
} from "./CompositionGoalLoopSettlement.ts";
import type {
  CompositionGoalLoopScanResult,
  CompositionGoalLoopSupervisorError,
} from "./CompositionGoalLoopSupervisor.ts";

export { CompositionGoalLoopRedispatchError } from "./CompositionGoalLoopSettlement.ts";
export type { CompositionGoalLoopRedispatchStorePort } from "./CompositionGoalLoopSettlement.ts";

export type CompositionGoalLoopRedispatchOptions<E> = {
  readonly taskId: string;
  readonly runId: string;
  /** 首次调用的候选 ID；若账本已存在则始终复用其中的稳定 newRunId。 */
  readonly newRunId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionGoalLoopRedispatchStorePort;
  readonly retryStore: Pick<
    CompositionGoalLoopRetryStoreShape,
    "getIntent" | "prepareIntent" | "markSettled" | "markDispatched"
  >;
  /** 中断落定时间戳，写入 run.finishedAtUnixMs、task.updatedAtUnixMs 与 retry 账本。 */
  readonly nowUnixMs: number;
  /** 结算说明透传给 supervisor 结算行。 */
  readonly note?: string;
  /** 实际重派执行；必须使用账本返回的稳定 newRunId。 */
  readonly redispatch: (args: {
    readonly previousRunId: string;
    readonly newRunId: string;
    readonly interruptedRounds: number;
  }) => Effect.Effect<void, E>;
};

const RETRY_PHASE_ORDER: Record<CompositionGoalLoopRetryPhase, number> = {
  prepared: 0,
  settled: 1,
  dispatched: 2,
};

const advanceIntentOrAdoptWinner = (
  retryStore: Pick<
    CompositionGoalLoopRetryStoreShape,
    "getIntent" | "markSettled" | "markDispatched"
  >,
  intent: CompositionGoalLoopRetryIntent,
  targetPhase: "settled" | "dispatched",
  updatedAtUnixMs: number,
): Effect.Effect<CompositionGoalLoopRetryIntent, CompositionGoalLoopRetryStoreError> =>
  Effect.gen(function* () {
    const advanced = yield* Effect.result(
      targetPhase === "settled"
        ? retryStore.markSettled({
            previousRunId: intent.previousRunId,
            expectedRevision: intent.revision,
            updatedAtUnixMs,
          })
        : retryStore.markDispatched({
            previousRunId: intent.previousRunId,
            expectedRevision: intent.revision,
            updatedAtUnixMs,
          }),
    );
    if (advanced._tag === "Success") return advanced.success;

    const current = yield* retryStore.getIntent(intent.previousRunId);
    if (
      Option.isSome(current) &&
      RETRY_PHASE_ORDER[current.value.phase] >= RETRY_PHASE_ORDER[targetPhase]
    ) {
      return current.value;
    }
    return yield* advanced.failure;
  });

const findStartedRetryRun = (
  options: Pick<CompositionGoalLoopRedispatchOptions<never>, "taskId" | "store"> & {
    readonly newRunId: string;
    readonly previousRun: CompositionTaskRun;
  },
): Effect.Effect<
  Option.Option<CompositionTaskRun>,
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const runOption = yield* options.store.getRun(options.newRunId);
    if (Option.isNone(runOption)) return Option.none();

    const run = runOption.value;
    if (
      run.runId !== options.newRunId ||
      run.taskId !== options.taskId ||
      run.attempt !== options.previousRun.attempt + 1
    ) {
      return yield* new CompositionGoalLoopRedispatchError({
        code: "goal_loop_redispatch_run_identity_mismatch",
        detail: `稳定新 Run ${options.newRunId} 的 taskId/attempt 与旧 Run 不匹配。`,
      });
    }
    return run.status === "queued" ? Option.none() : Option.some(run);
  });

const requireStartedRetryRun = (
  options: Pick<CompositionGoalLoopRedispatchOptions<never>, "taskId" | "store"> & {
    readonly newRunId: string;
    readonly previousRun: CompositionTaskRun;
  },
): Effect.Effect<
  CompositionTaskRun,
  CompositionGoalLoopRedispatchError | CompositionTaskStoreError
> =>
  findStartedRetryRun(options).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new CompositionGoalLoopRedispatchError({
              code: "goal_loop_redispatch_run_not_started",
              detail: `重派回调结束后，稳定新 Run ${options.newRunId} 仍不存在或停留在 queued。`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * Goal Loop retry 三阶段接线：先持久化稳定新 Run 身份，再结算旧 Run，最后才允许外部派发。
 * 任一阶段崩溃后都从账本恢复；跨实例 CAS 冲突会重读并采用已经推进的赢家状态。
 */
export const settleAndRedispatchInterruptedGoalLoop = <E>(
  options: CompositionGoalLoopRedispatchOptions<E>,
): Effect.Effect<
  CompositionGoalLoopSettlementResult & { readonly newRunId: string },
  | E
  | CompositionGoalLoopSupervisorError
  | CompositionGoalLoopRedispatchError
  | CompositionGoalLoopRetryStoreError
  | CompositionTaskStoreError
> =>
  Effect.gen(function* () {
    const existingIntent = yield* options.retryStore.getIntent(options.runId);
    const inspection: CompositionGoalLoopSettlementInspection | undefined = Option.isNone(
      existingIntent,
    )
      ? yield* inspectInterruptedGoalLoopSettlement({
          taskId: options.taskId,
          runId: options.runId,
          store: options.store,
        })
      : undefined;

    let intent = yield* options.retryStore.prepareIntent({
      taskId: options.taskId,
      previousRunId: options.runId,
      newRunId: options.newRunId,
      createdAtUnixMs: options.nowUnixMs,
    });

    let settled: CompositionGoalLoopSettlementResult;
    if (intent.phase === "prepared") {
      settled = yield* settleInterruptedGoalLoop(
        {
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
        },
        inspection,
      );
      intent = yield* advanceIntentOrAdoptWinner(
        options.retryStore,
        intent,
        "settled",
        options.nowUnixMs,
      );
    } else {
      settled = yield* readGoalLoopSettlementSnapshot({
        taskId: options.taskId,
        runId: options.runId,
        store: options.store,
      });
    }

    if (intent.phase === "dispatched") {
      yield* requireStartedRetryRun({
        taskId: options.taskId,
        newRunId: intent.newRunId,
        previousRun: settled.run,
        store: options.store,
      });
      return { ...settled, newRunId: intent.newRunId };
    }

    const startedBeforeRedispatch = yield* findStartedRetryRun({
      taskId: options.taskId,
      newRunId: intent.newRunId,
      previousRun: settled.run,
      store: options.store,
    });
    if (Option.isNone(startedBeforeRedispatch)) {
      yield* options.redispatch({
        previousRunId: options.runId,
        newRunId: intent.newRunId,
        interruptedRounds: settled.scan.completedRounds,
      });
      yield* requireStartedRetryRun({
        taskId: options.taskId,
        newRunId: intent.newRunId,
        previousRun: settled.run,
        store: options.store,
      });
    }

    intent = yield* advanceIntentOrAdoptWinner(
      options.retryStore,
      intent,
      "dispatched",
      options.nowUnixMs,
    );
    return { ...settled, newRunId: intent.newRunId };
  });

export type CompositionGoalLoopAbandonOptions = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: CompositionGoalLoopRedispatchStorePort;
  readonly nowUnixMs: number;
  readonly note?: string;
};

/** 放弃恢复仍使用无副作用预检，且不会创建 Goal Loop retry intent。 */
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
  Effect.gen(function* () {
    const inspection = yield* inspectInterruptedGoalLoopSettlement({
      taskId: options.taskId,
      runId: options.runId,
      store: options.store,
    });
    return yield* settleInterruptedGoalLoop(
      {
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
      },
      inspection,
    );
  });
