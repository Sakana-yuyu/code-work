import type { CompositionTaskEvent, CompositionTaskStatus } from "@codework/contracts";
import * as Effect from "effect/Effect";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  runCompositionGoalLoop,
  type CompositionGoalLoopInvalidError,
  type CompositionGoalLoopOptions,
  type CompositionGoalLoopResult,
  type CompositionGoalValidationInput,
  type CompositionGoalValidationVerdict,
} from "./CompositionGoalLoop.ts";

type LedgerPort = Pick<CompositionTaskStoreShape, "appendEventIfNew">;

/** Goal Loop 台账行的统一 sourceEventId 前缀；supervisor 复用同一构造器避免漂移。 */
export const goalLoopEventPrefix = (taskId: string, runId: string): string =>
  `goalloop:${taskId}:${runId}`;

/**
 * Goal Loop 编排接线选项：在普通 Goal Loop 选项之上，补充任务台账投影所需的
 * 任务/Run 身份与存储端口。attempt 由调用方对接具体 Driver（BYOK 模型循环、
 * Multica 远端 dispatch 等），runner 只负责把循环事实以幂等事件行写进任务历史。
 */
export type CompositionGoalLoopRunnerOptions<A, E> = CompositionGoalLoopOptions<A, E> & {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly parentTaskId?: string;
  readonly runtimeId?: string;
  readonly store: LedgerPort;
  /** 轮次进度行携带的任务状态；缺省 running。终态行使用终态映射后的状态。 */
  readonly progressStatus?: CompositionTaskStatus;
  /** 摘要引用模型产文本（完成原因/拒绝原因）的最大字符数；缺省 120。 */
  readonly summaryTextLimit?: number;
};

/** Goal Loop 终态到 Composition 任务状态的映射。 */
export const describeGoalLoopTerminal = (
  result: CompositionGoalLoopResult<unknown>,
  truncate: (text: string) => string,
): { readonly status: CompositionTaskStatus; readonly summary: string } => {
  const rounds = `${result.rounds} 轮`;
  switch (result.status) {
    case "completed": {
      const reason = result.completion?.reason;
      return {
        status: "completed",
        summary: `目标循环完成（${rounds}${reason === undefined ? "" : `，原因：${truncate(reason)}`}）`,
      };
    }
    case "budget_exhausted":
      return { status: "failed", summary: `目标循环因预算耗尽收敛（${rounds}）` };
    case "deadline_exceeded":
      return { status: "timed_out", summary: `目标循环超过截止时间（${rounds}）` };
    case "cancelled":
      return { status: "cancelled", summary: `目标循环被取消（${rounds}）` };
    case "pivot_required":
      return {
        status: "blocked",
        summary: `目标循环停滞待改派（连续 ${result.pivot?.staleRounds ?? 0} 轮无进展）`,
      };
  }
};

/**
 * 把 runCompositionGoalLoop 接入任务台账：
 * - start 行在首个 attempt 前落账（非法配置时不产生任何行）；
 * - 每轮落 progress 行（只含轮次与成本，不含原始输出文本，避免敏感内容进台账）；
 * - 验证拒绝落 blocker 行；终态按映射落 status 行；
 * - 全部行使用 `goalloop:<taskId>:<runId>:*` 幂等 sourceEventId，重复执行/重放不刷屏。
 */
export const runCompositionGoalLoopWithLedger = <A, E>(
  options: CompositionGoalLoopRunnerOptions<A, E>,
): Effect.Effect<
  CompositionGoalLoopResult<A>,
  E | CompositionTaskStoreError | CompositionGoalLoopInvalidError
> =>
  Effect.gen(function* () {
    const limit = options.summaryTextLimit ?? 120;
    const truncate = (text: string): string => {
      const trimmed = text.trim();
      return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
    };
    const prefix = goalLoopEventPrefix(options.taskId, options.runId);
    const baseEvent = {
      taskId: options.taskId,
      runId: options.runId,
      agentId: options.agentId,
      ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
      ...(options.runtimeId === undefined ? {} : { runtimeId: options.runtimeId }),
      sequence: 0,
    };
    const persistEvent = (input: {
      readonly sourceEventId: string;
      readonly eventType: CompositionTaskEvent["eventType"];
      readonly status: CompositionTaskStatus;
      readonly summary: string;
    }) =>
      options.store.appendEventIfNew({
        ...baseEvent,
        sourceEventId: input.sourceEventId,
        status: input.status,
        eventType: input.eventType,
        summary: input.summary,
      });

    const progressStatus = options.progressStatus ?? "running";
    let started = false;
    const persistStart = (): Effect.Effect<boolean, CompositionTaskStoreError> => {
      if (started) return Effect.succeed(true);
      started = true;
      return persistEvent({
        sourceEventId: `${prefix}:start`,
        eventType: "status",
        status: progressStatus,
        summary: `目标循环开始（轮数上限 ${options.maxAttempts}${
          options.maxCostUnits === undefined ? "" : `，成本上限 ${options.maxCostUnits}`
        }${options.deadlineUnixMs === undefined ? "" : `，截止 ${options.deadlineUnixMs}`}）`,
      });
    };

    const innerValidate = options.validateCompletion;
    const loopOptions: CompositionGoalLoopOptions<A, E | CompositionTaskStoreError> = {
      ...options,
      attempt: (round, context) =>
        Effect.flatMap(persistStart(), () =>
          Effect.flatMap(options.attempt(round, context), (decision) =>
            Effect.map(
              persistEvent({
                sourceEventId: `${prefix}:round:${round}`,
                eventType: "progress",
                status: progressStatus,
                summary: `第 ${round} 轮 attempt 完成（本轮成本 ${decision.costUnits ?? 0}）`,
              }),
              () => decision,
            ),
          ),
        ),
      ...(innerValidate === undefined
        ? {}
        : {
            validateCompletion: (
              input: CompositionGoalValidationInput<A>,
            ): Effect.Effect<CompositionGoalValidationVerdict, E | CompositionTaskStoreError> =>
              Effect.flatMap(
                innerValidate(input),
                (
                  verdict,
                ): Effect.Effect<CompositionGoalValidationVerdict, E | CompositionTaskStoreError> =>
                  verdict.accepted
                    ? Effect.succeed(verdict)
                    : Effect.map(
                        persistEvent({
                          sourceEventId: `${prefix}:reject:${input.round}`,
                          eventType: "blocker",
                          status: progressStatus,
                          summary: `第 ${input.round} 轮完成声明被验证方拒绝${
                            verdict.detail === undefined ? "" : `：${truncate(verdict.detail)}`
                          }`,
                        }),
                        () => verdict,
                      ),
              ),
          }),
    };

    const result = yield* runCompositionGoalLoop(loopOptions);
    const terminal = describeGoalLoopTerminal(result, truncate);
    const rejectedCount = result.rejectedCompletions.length;
    yield* persistEvent({
      sourceEventId: `${prefix}:terminal:${result.status}`,
      eventType: "status",
      status: terminal.status,
      summary:
        rejectedCount > 0
          ? `${terminal.summary}；完成声明被拒 ${rejectedCount} 次`
          : terminal.summary,
    });
    return result;
  });
