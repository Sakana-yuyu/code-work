import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionRunStartIntent,
  CompositionRunStartStoreError,
  CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  sameCompositionRunStartRunIdentity,
  sameCompositionRunStartTaskIdentity,
} from "./CompositionRunStartAcceptedProjection.ts";

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export type CompositionRunStartCancellationRequestResult =
  | {
      readonly _tag: "Requested";
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
      readonly intent: CompositionRunStartIntent;
    }
  | {
      readonly _tag: "Rejected";
      readonly code: string;
      readonly detail: string;
    };

const rejected = (code: string, detail: string): CompositionRunStartCancellationRequestResult => ({
  _tag: "Rejected",
  code,
  detail,
});

/**
 * 兼容旧 Run 取消字段时，必须在同一事务内确认最新非终态身份并写入持久取消屏障。
 */
export const requestCompositionRunStartCancellationBarrier = (
  taskStore: Pick<
    CompositionTaskStoreShape,
    "withTransaction" | "getTask" | "getRun" | "getLatestRun"
  >,
  runStartStore: Pick<CompositionRunStartStoreShape, "getStart" | "requestCancellation">,
  input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly reason: string;
  },
): Effect.Effect<
  CompositionRunStartCancellationRequestResult,
  CompositionTaskStoreError | CompositionRunStartStoreError
> =>
  taskStore.withTransaction(
    Effect.gen(function* () {
      const taskOption = yield* taskStore.getTask(input.task.taskId);
      const runOption = yield* taskStore.getRun(input.run.runId);
      const latestRunOption = yield* taskStore.getLatestRun(input.task.taskId);
      const intentOption = yield* runStartStore.getStart(input.run.runId);
      if (Option.isNone(taskOption) || Option.isNone(runOption) || Option.isNone(intentOption)) {
        return rejected(
          "run_start_cancellation_target_missing",
          "写入 Run Start 取消屏障前 Task、Run 或启动意图已不存在。",
        );
      }
      if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== input.run.runId) {
        return rejected(
          "run_start_cancellation_run_replaced",
          "写入 Run Start 取消屏障前已有更新 Run，已阻止取消旧启动身份。",
        );
      }

      const task = taskOption.value;
      const run = runOption.value;
      const intent = intentOption.value;
      if (
        !sameCompositionRunStartTaskIdentity(task, input.task) ||
        !sameCompositionRunStartRunIdentity(run, input.run) ||
        intent.taskId !== task.taskId ||
        intent.runId !== run.runId ||
        intent.agentId !== run.agentId ||
        intent.runtimeId !== run.runtimeId ||
        intent.attempt !== run.attempt
      ) {
        return rejected(
          "run_start_cancellation_identity_changed",
          "写入 Run Start 取消屏障前 Task、Run 或启动意图身份已变化。",
        );
      }
      if (
        task.status !== run.status ||
        terminalStatuses.has(task.status) ||
        terminalStatuses.has(run.status)
      ) {
        return rejected(
          "run_start_cancellation_status_changed",
          `写入 Run Start 取消屏障前 Task/Run 状态已变为 ${task.status}/${run.status}。`,
        );
      }
      if (run.cancelRequestedAtUnixMs === undefined) {
        return rejected(
          "run_start_cancellation_request_missing",
          "写入 Run Start 取消屏障前 Run 已不含取消请求。",
        );
      }

      const requested = yield* runStartStore.requestCancellation({
        runId: run.runId,
        expectedRevision: intent.revision,
        requestedAtUnixMs: run.cancelRequestedAtUnixMs,
        reason: input.reason,
      });
      return { _tag: "Requested", task, run, intent: requested };
    }),
  );
