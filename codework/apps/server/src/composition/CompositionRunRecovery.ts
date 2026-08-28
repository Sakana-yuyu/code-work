import type { CompositionTaskStatus } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionOrchestrator } from "./CompositionOrchestrator.ts";

const recoverableStatuses: ReadonlySet<CompositionTaskStatus> = new Set(["running", "resuming"]);

export type CompositionRunRecoveryAction = {
  readonly taskId: string;
  readonly runId: string;
  readonly action: "accepted" | "already_running" | "already_terminal" | "deferred";
};

export const recoverOrphanedCompositionRuns = Effect.fn("recoverOrphanedCompositionRuns")(
  function* (options: {
    readonly store: Pick<CompositionTaskStoreShape, "listTasks" | "getLatestRun">;
    readonly orchestrator: Pick<CompositionOrchestrator, "resumeTask">;
  }): Effect.fn.Return<ReadonlyArray<CompositionRunRecoveryAction>, CompositionTaskStoreError> {
    const tasks = yield* options.store.listTasks();
    const actions: CompositionRunRecoveryAction[] = [];

    for (const task of tasks) {
      if (!recoverableStatuses.has(task.status)) continue;
      const runOption = yield* options.store.getLatestRun(task.taskId);
      if (Option.isNone(runOption)) continue;
      const run = runOption.value;
      if (
        !recoverableStatuses.has(run.status) ||
        run.runtimeTaskId === undefined ||
        run.cancelRequestedAtUnixMs !== undefined
      ) {
        continue;
      }

      const result = yield* Effect.result(
        options.orchestrator.resumeTask({
          taskId: task.taskId,
          runId: run.runId,
          reason: "Code Work 服务重启后恢复孤立 Runtime Run",
        }),
      );
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Composition orphan Run 恢复延后", {
          taskId: task.taskId,
          runId: run.runId,
          cause: result.failure,
        });
        actions.push({ taskId: task.taskId, runId: run.runId, action: "deferred" });
        continue;
      }
      actions.push({
        taskId: task.taskId,
        runId: run.runId,
        action: result.success.status,
      });
    }

    return actions;
  },
);
