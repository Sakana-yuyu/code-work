import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  type CompositionTask,
  type CompositionTaskRun,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import type {
  CompositionAgentDriverFailure,
  CompositionOrchestrator,
  CompositionTaskNotFoundError,
} from "./CompositionOrchestrator.ts";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "in_review"]);

export type CompositionRunLivenessAction = {
  readonly taskId: string;
  readonly runId: string;
  readonly action: "cancel_requested" | "cancelled" | "timed_out";
};

type CompositionRunLivenessProjectionError =
  | CompositionTaskStoreError
  | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  | CompositionAgentDriverFailure;

type CompositionRunLivenessError =
  | CompositionRunLivenessProjectionError
  | CompositionTaskNotFoundError;

export type CompositionRunLivenessOptions = {
  readonly store: Pick<CompositionTaskStoreShape, "listTasks" | "getLatestRun">;
  readonly orchestrator: Pick<CompositionOrchestrator, "cancelTask">;
  readonly nowUnixMs: number;
  readonly inactivityTimeoutMs: number;
  readonly cancelConfirmationTimeoutMs: number;
  readonly projectRuntimeEvent: (
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, CompositionRunLivenessProjectionError>;
};

export type CompositionRunLivenessSupervisorOptions = Omit<
  CompositionRunLivenessOptions,
  "nowUnixMs"
> & {
  readonly inactivityTimeoutMs: number;
  readonly cancelConfirmationTimeoutMs: number;
  readonly sweepIntervalMs: number;
};

export const defaultCompositionRunInactivityTimeoutMs = 5 * 60 * 1000;
export const defaultCompositionRunCancelConfirmationTimeoutMs = 30 * 1000;
export const defaultCompositionRunLivenessSweepIntervalMs = 15 * 1000;

const watchdogSourceEventId = (runId: string): string =>
  `composition-watchdog:${runId}:cancel-confirmation-timeout:1`;

const watchdogEvent = (
  task: CompositionTask,
  run: CompositionTaskRun,
  nowUnixMs: number,
): ProviderRuntimeEvent => {
  const sourceEventId = watchdogSourceEventId(run.runId);
  return {
    eventId: EventId.make(sourceEventId),
    provider: ProviderDriverKind.make("composition"),
    providerInstanceId: ProviderInstanceId.make("composition"),
    threadId: ThreadId.make(task.threadId ?? `composition-${task.taskId}-${run.runId}`),
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowUnixMs)),
    type: "task.completed",
    raw: {
      source: "composition.watchdog",
      method: "cancel_confirmation_timeout",
      runtimeId: run.runtimeId,
      ...(run.runtimeTaskId === undefined
        ? {}
        : { runtimeTaskId: RuntimeTaskId.make(run.runtimeTaskId) }),
      taskId: task.taskId,
      runId: run.runId,
      payload: { taskId: task.taskId, runId: run.runId },
    },
    payload: {
      taskId: RuntimeTaskId.make(run.runtimeTaskId ?? `composition-${run.runId}`),
      status: "timed_out",
      summary: "Runtime 在取消请求后未确认终态，已由 Composition Watchdog 收口",
      error: "runtime_cancel_confirmation_timeout",
    },
  };
};

const isStale = (
  task: CompositionTask,
  run: CompositionTaskRun,
  nowUnixMs: number,
  inactivityTimeoutMs: number,
): boolean => {
  const lastObservedAt =
    run.lastRuntimeEventAtUnixMs ?? Math.max(task.updatedAtUnixMs, run.startedAtUnixMs ?? 0);
  return nowUnixMs - lastObservedAt >= inactivityTimeoutMs;
};

/**
 * 扫描最新 Run 并执行一次有界的活性恢复；不直接修改 Task/Run 投影。
 */
export const recoverCompositionRunLiveness = (
  options: CompositionRunLivenessOptions,
): Effect.Effect<ReadonlyArray<CompositionRunLivenessAction>, CompositionRunLivenessError> =>
  Effect.gen(function* () {
    const tasks = yield* options.store.listTasks();
    const actions: CompositionRunLivenessAction[] = [];

    for (const task of tasks) {
      if (task.status !== "running" || terminalStatuses.has(task.status)) continue;
      const runOption = yield* options.store.getLatestRun(task.taskId);
      if (runOption._tag === "None") continue;
      const run = runOption.value;
      if (run.status !== "running" || terminalStatuses.has(run.status)) continue;
      if (run.cancelRequestedAtUnixMs !== undefined) {
        if (options.nowUnixMs - run.cancelRequestedAtUnixMs < options.cancelConfirmationTimeoutMs) {
          continue;
        }

        yield* options.projectRuntimeEvent(watchdogEvent(task, run, options.nowUnixMs));
        actions.push({ taskId: task.taskId, runId: run.runId, action: "timed_out" });
        continue;
      }

      if (isStale(task, run, options.nowUnixMs, options.inactivityTimeoutMs)) {
        const result = yield* options.orchestrator.cancelTask({
          taskId: task.taskId,
          runId: run.runId,
          reason: "Composition Watchdog 检测到 Runtime 长时间无进展",
        });
        if (result.status === "cancel_requested") {
          actions.push({ taskId: task.taskId, runId: run.runId, action: "cancel_requested" });
        } else if (result.status === "cancelled") {
          actions.push({ taskId: task.taskId, runId: run.runId, action: "cancelled" });
        }
        continue;
      }
    }

    return actions;
  });

/** 服务生命周期内定时扫描；单次失败不会中断后续 Runtime 事件流。 */
export const superviseCompositionRunLiveness = (
  options: CompositionRunLivenessSupervisorOptions,
): Effect.Effect<void, never, Scope.Scope> => {
  const sweep = Clock.currentTimeMillis.pipe(
    Effect.flatMap((nowUnixMs) => recoverCompositionRunLiveness({ ...options, nowUnixMs })),
    Effect.catchCause((cause) =>
      Effect.logError("Composition Run 活性扫描失败", { cause }).pipe(Effect.as([])),
    ),
    Effect.asVoid,
  );
  return Effect.gen(function* () {
    yield* sweep;
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(options.sweepIntervalMs).pipe(Effect.flatMap(() => sweep))),
    );
  });
};
