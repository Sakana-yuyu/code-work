import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionGoalLoopRetryStore,
  type CompositionGoalLoopRetryStoreShape,
} from "../persistence/Services/CompositionGoalLoopRetryStore.ts";
import {
  CompositionTaskInputStore,
  type CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  settleAndRedispatchInterruptedGoalLoop,
  type CompositionGoalLoopRedispatchStorePort,
  type CompositionGoalLoopRetryStorePort,
} from "./CompositionGoalLoopRedispatch.ts";
import {
  CompositionOrchestratorService,
  type CompositionOrchestratorServiceShape,
} from "./CompositionOrchestratorService.ts";

export interface CompositionGoalLoopRetryStartupRecoveryReceipt {
  readonly type: "composition.goal_loop_retries.recovered";
  readonly recoveredAtUnixMs: number;
  readonly recoveredCount: number;
  readonly previousRunIds: ReadonlyArray<string>;
}

export class CompositionGoalLoopRetryStartupRecoveryError extends Schema.TaggedErrorClass<CompositionGoalLoopRetryStartupRecoveryError>()(
  "CompositionGoalLoopRetryStartupRecoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Goal Loop retry 启动恢复失败。";
  }
}

export type CompositionGoalLoopRetryStartupStorePort = CompositionGoalLoopRetryStorePort &
  Pick<CompositionGoalLoopRetryStoreShape, "listPendingIntents">;

export interface CompositionGoalLoopRetryStartupRecoveryOptions {
  readonly store: CompositionGoalLoopRedispatchStorePort;
  readonly retryStore: CompositionGoalLoopRetryStartupStorePort;
  readonly inputStore: Pick<CompositionTaskInputStoreShape, "get">;
  readonly orchestrator: Pick<CompositionOrchestratorServiceShape, "retryTask">;
  readonly recoveredAtUnixMs: number;
}

export interface CompositionGoalLoopRetryStartupRecoveryShape {
  readonly awaitRecovered: Effect.Effect<
    CompositionGoalLoopRetryStartupRecoveryReceipt,
    CompositionGoalLoopRetryStartupRecoveryError
  >;
}

const isStartupRecoveryError = Schema.is(CompositionGoalLoopRetryStartupRecoveryError);

const recoveryError = (cause: unknown): CompositionGoalLoopRetryStartupRecoveryError =>
  isStartupRecoveryError(cause)
    ? cause
    : new CompositionGoalLoopRetryStartupRecoveryError({ cause });

const missingRecoveryState = (detail: string) =>
  Effect.fail(new CompositionGoalLoopRetryStartupRecoveryError({ cause: new Error(detail) }));

export const recoverCompositionGoalLoopRetries = (
  options: CompositionGoalLoopRetryStartupRecoveryOptions,
): Effect.Effect<
  CompositionGoalLoopRetryStartupRecoveryReceipt,
  CompositionGoalLoopRetryStartupRecoveryError
> =>
  Effect.gen(function* () {
    const pending = yield* options.retryStore.listPendingIntents();
    yield* Effect.forEach(
      pending,
      (intent) =>
        Effect.gen(function* () {
          const taskOption = yield* options.store.getTask(intent.taskId);
          const previousRunOption = yield* options.store.getRun(intent.previousRunId);
          const recoveryInputOption = yield* options.inputStore.get(intent.taskId);
          if (Option.isNone(taskOption)) {
            return yield* missingRecoveryState(`待恢复 Task ${intent.taskId} 不存在。`);
          }
          if (Option.isNone(previousRunOption)) {
            return yield* missingRecoveryState(`待恢复旧 Run ${intent.previousRunId} 不存在。`);
          }
          if (previousRunOption.value.taskId !== intent.taskId) {
            return yield* missingRecoveryState(
              `待恢复旧 Run ${intent.previousRunId} 不属于 Task ${intent.taskId}。`,
            );
          }
          if (Option.isNone(recoveryInputOption)) {
            return yield* missingRecoveryState(`Task ${intent.taskId} 缺少加密恢复输入。`);
          }
          const task = taskOption.value;
          const previousRun = previousRunOption.value;
          const recoveryInput = recoveryInputOption.value;
          if (recoveryInput.taskId !== intent.taskId) {
            return yield* missingRecoveryState(`Task ${intent.taskId} 的恢复输入身份不匹配。`);
          }

          yield* settleAndRedispatchInterruptedGoalLoop({
            taskId: intent.taskId,
            runId: intent.previousRunId,
            newRunId: intent.newRunId,
            agentId: previousRun.agentId,
            ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
            runtimeId: previousRun.runtimeId,
            store: options.store,
            retryStore: options.retryStore,
            nowUnixMs: options.recoveredAtUnixMs,
            note: "服务启动恢复未完成的 Goal Loop retry",
            redispatch: ({ previousRunId, newRunId }) =>
              Effect.asVoid(
                options.orchestrator.retryTask({
                  taskId: intent.taskId,
                  previousRunId,
                  runId: newRunId,
                  reason: "服务启动恢复未完成的 Goal Loop retry",
                  capabilityIds: [...(recoveryInput.capabilityIds ?? [])],
                }),
              ),
          });
        }),
      { discard: true },
    );
    const receipt = {
      type: "composition.goal_loop_retries.recovered" as const,
      recoveredAtUnixMs: options.recoveredAtUnixMs,
      recoveredCount: pending.length,
      previousRunIds: pending.map((intent) => intent.previousRunId),
    };
    if (receipt.recoveredCount > 0) {
      yield* Effect.logWarning("已恢复重启前未完成的 Goal Loop retry", {
        recovered: receipt.recoveredCount,
      });
    }
    return receipt;
  }).pipe(Effect.mapError(recoveryError));

export class CompositionGoalLoopRetryStartupRecovery extends Context.Service<
  CompositionGoalLoopRetryStartupRecovery,
  CompositionGoalLoopRetryStartupRecoveryShape
>()("codework/composition/CompositionGoalLoopRetryStartupRecovery") {
  static readonly layer = Layer.effect(
    CompositionGoalLoopRetryStartupRecovery,
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retryStore = yield* CompositionGoalLoopRetryStore;
      const inputStore = yield* CompositionTaskInputStore;
      const orchestrator = yield* CompositionOrchestratorService;
      const recoveredAtUnixMs = yield* Clock.currentTimeMillis;
      const recoveryResult = yield* Effect.result(
        recoverCompositionGoalLoopRetries({
          store,
          retryStore,
          inputStore,
          orchestrator,
          recoveredAtUnixMs,
        }),
      );
      return CompositionGoalLoopRetryStartupRecovery.of({
        awaitRecovered: Effect.fromResult(recoveryResult),
      });
    }),
  );
}
