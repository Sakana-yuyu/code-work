import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const sameCompositionRunStartTaskIdentity = (
  left: CompositionTask,
  right: CompositionTask,
): boolean =>
  left.taskId === right.taskId &&
  left.projectId === right.projectId &&
  left.threadId === right.threadId &&
  left.parentTaskId === right.parentTaskId &&
  left.assigneeKind === right.assigneeKind &&
  left.assigneeId === right.assigneeId &&
  left.mode === right.mode &&
  left.promptDigest === right.promptDigest &&
  sameStrings(left.dependsOnTaskIds, right.dependsOnTaskIds);

const sameCompositionRunStartRunStaticIdentity = (
  left: CompositionTaskRun,
  right: CompositionTaskRun,
): boolean =>
  left.runId === right.runId &&
  left.taskId === right.taskId &&
  left.agentId === right.agentId &&
  left.runtimeId === right.runtimeId &&
  left.attempt === right.attempt &&
  sameStrings(left.capabilityGrantIds, right.capabilityGrantIds);

export const sameCompositionRunStartRunIdentity = (
  left: CompositionTaskRun,
  right: CompositionTaskRun,
): boolean =>
  sameCompositionRunStartRunStaticIdentity(left, right) &&
  left.runtimeTaskId === right.runtimeTaskId &&
  left.capabilityHandshakeId === right.capabilityHandshakeId;

export type CompositionRunStartAcceptedProjectionGuard =
  | {
      readonly _tag: "Ready";
      readonly task: CompositionTask;
      readonly run: CompositionTaskRun;
    }
  | {
      readonly _tag: "Rejected";
      readonly code: string;
      readonly detail: string;
    };

const rejected = (code: string, detail: string): CompositionRunStartAcceptedProjectionGuard => ({
  _tag: "Rejected",
  code,
  detail,
});

type CompositionRunStartAcceptedProjectionInput = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly runtimeId: string;
  readonly receipt: {
    readonly runtimeTaskId: string | null;
    readonly capabilityHandshakeId: string | null;
  };
};

const guardCompositionRunStartAcceptedIdentity = (
  store: Pick<CompositionTaskStoreShape, "getTask" | "getRun" | "getLatestRun">,
  input: CompositionRunStartAcceptedProjectionInput,
): Effect.Effect<CompositionRunStartAcceptedProjectionGuard, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const [taskOption, runOption, latestRunOption] = yield* Effect.all(
      [
        store.getTask(input.task.taskId),
        store.getRun(input.run.runId),
        store.getLatestRun(input.task.taskId),
      ],
      { concurrency: "unbounded" },
    );
    if (Option.isNone(taskOption) || Option.isNone(runOption)) {
      return rejected(
        "run_start_accepted_projection_missing",
        "accepted receipt 投影时 Task 或 Run 已不存在，已阻止旧快照写入。",
      );
    }
    if (Option.isNone(latestRunOption) || latestRunOption.value.runId !== input.run.runId) {
      return rejected(
        "run_start_accepted_projection_run_replaced",
        "accepted receipt 投影时已有更新 Run，已阻止旧 Run 被复活。",
      );
    }

    const task = taskOption.value;
    const run = runOption.value;
    if (
      !sameCompositionRunStartTaskIdentity(task, input.task) ||
      !sameCompositionRunStartRunStaticIdentity(run, input.run) ||
      run.runtimeId !== input.runtimeId
    ) {
      return rejected(
        "run_start_accepted_projection_identity_changed",
        "accepted receipt 投影时 Task、Run 或 Runtime 启动身份已变化。",
      );
    }
    if (task.status !== run.status) {
      return rejected(
        "run_start_accepted_projection_status_mismatch",
        `accepted receipt 投影时 Task/Run 状态不一致：${task.status}/${run.status}。`,
      );
    }
    if (
      (input.receipt.runtimeTaskId !== null &&
        run.runtimeTaskId !== undefined &&
        run.runtimeTaskId !== input.receipt.runtimeTaskId) ||
      (input.receipt.capabilityHandshakeId !== null &&
        run.capabilityHandshakeId !== undefined &&
        run.capabilityHandshakeId !== input.receipt.capabilityHandshakeId)
    ) {
      return rejected(
        "run_start_accepted_projection_receipt_conflict",
        "accepted receipt 与当前 Run 已持久化的 Runtime receipt 不一致。",
      );
    }
    return { _tag: "Ready", task, run };
  });

/**
 * accepted receipt 的业务投影必须重新读取事务内赢家，不能依据启动扫描时的旧快照复活 Run。
 */
export const guardCompositionRunStartAcceptedProjection = (
  store: Pick<CompositionTaskStoreShape, "getTask" | "getRun" | "getLatestRun">,
  input: CompositionRunStartAcceptedProjectionInput,
): Effect.Effect<CompositionRunStartAcceptedProjectionGuard, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const guarded = yield* guardCompositionRunStartAcceptedIdentity(store, input);
    if (guarded._tag === "Rejected") return guarded;
    const { task, run } = guarded;
    if (run.cancelRequestedAtUnixMs !== undefined) {
      return rejected(
        "run_start_accepted_projection_cancel_requested",
        "accepted receipt 投影前已存在取消请求，已阻止 Run 进入 running。",
      );
    }
    return { _tag: "Ready", task, run };
  });

/** manual blocker 只允许投影到同一最新 queued/waiting_input Run，其他赢家仅保留持久人工态。 */
export const guardCompositionRunStartAcceptedManualProjection = (
  store: Pick<CompositionTaskStoreShape, "getTask" | "getRun" | "getLatestRun">,
  input: CompositionRunStartAcceptedProjectionInput,
): Effect.Effect<CompositionRunStartAcceptedProjectionGuard, CompositionTaskStoreError> =>
  Effect.gen(function* () {
    const guarded = yield* guardCompositionRunStartAcceptedIdentity(store, input);
    if (guarded._tag === "Rejected") return guarded;
    if (guarded.run.cancelRequestedAtUnixMs !== undefined) {
      return rejected(
        "run_start_accepted_manual_projection_cancel_requested",
        "accepted receipt 转人工态前已存在取消请求，已阻止 Run 回写为 waiting_input。",
      );
    }
    if (guarded.task.status !== "queued" && guarded.task.status !== "waiting_input") {
      return rejected(
        "run_start_accepted_manual_projection_status_changed",
        `accepted receipt 转人工态时 Task/Run 已变为 ${guarded.task.status}/${guarded.run.status}，仅保留持久人工记录。`,
      );
    }
    return guarded;
  });
