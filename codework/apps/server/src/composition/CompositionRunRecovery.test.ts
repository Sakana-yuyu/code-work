import { assert, it } from "@effect/vitest";
import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CompositionAgentDriverFailure } from "./CompositionOrchestrator.ts";
import { recoverOrphanedCompositionRuns } from "./CompositionRunRecovery.ts";

const task = (taskId: string, status: CompositionTask["status"]): CompositionTask => ({
  taskId,
  projectId: "project-orphan-recovery",
  assigneeKind: "agent",
  assigneeId: "agent-orphan-recovery",
  mode: "serial",
  status,
  promptDigest: `sha256:${taskId}`,
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
});

const run = (
  taskId: string,
  runId: string,
  status: CompositionTaskRun["status"],
): CompositionTaskRun => ({
  taskId,
  runId,
  agentId: "agent-orphan-recovery",
  runtimeId: "runtime-orphan-recovery",
  runtimeTaskId: `runtime-${runId}`,
  status,
  attempt: 1,
  capabilityGrantIds: [],
});

it.effect("服务重启只恢复最新活跃 Run，并跳过终态与已请求取消的 Run", () =>
  Effect.gen(function* () {
    const runningTask = task("task-orphan-running", "running");
    const completedTask = task("task-orphan-completed", "completed");
    const cancellingTask = task("task-orphan-cancelling", "running");
    const runs = new Map<string, CompositionTaskRun>([
      [runningTask.taskId, run(runningTask.taskId, "run-orphan-running", "running")],
      [completedTask.taskId, run(completedTask.taskId, "run-orphan-completed", "completed")],
      [
        cancellingTask.taskId,
        {
          ...run(cancellingTask.taskId, "run-orphan-cancelling", "running"),
          cancelRequestedAtUnixMs: 2,
        },
      ],
    ]);
    const resumed: string[] = [];

    const actions = yield* recoverOrphanedCompositionRuns({
      store: {
        listTasks: () => Effect.succeed([runningTask, completedTask, cancellingTask]),
        getLatestRun: (taskId) => Effect.succeed(Option.fromNullishOr(runs.get(taskId))),
      },
      orchestrator: {
        resumeTask: (input) =>
          Effect.sync(() => {
            resumed.push(input.runId);
            return {
              task: runningTask,
              run: runs.get(runningTask.taskId)!,
              status: "accepted" as const,
            };
          }),
      },
    });

    assert.deepEqual(resumed, ["run-orphan-running"]);
    assert.deepEqual(actions, [
      {
        taskId: "task-orphan-running",
        runId: "run-orphan-running",
        action: "accepted",
      },
    ]);
  }),
);

it.effect("单个 orphan Run 恢复失败会延后处理且不阻断后续 Run", () =>
  Effect.gen(function* () {
    const deferredTask = task("task-orphan-deferred", "running");
    const acceptedTask = task("task-orphan-accepted", "resuming");
    const runs = new Map<string, CompositionTaskRun>([
      [deferredTask.taskId, run(deferredTask.taskId, "run-orphan-deferred", "running")],
      [acceptedTask.taskId, run(acceptedTask.taskId, "run-orphan-accepted", "resuming")],
    ]);
    const attempted: string[] = [];

    const actions = yield* recoverOrphanedCompositionRuns({
      store: {
        listTasks: () => Effect.succeed([deferredTask, acceptedTask]),
        getLatestRun: (taskId) => Effect.succeed(Option.fromNullishOr(runs.get(taskId))),
      },
      orchestrator: {
        resumeTask: (input) => {
          attempted.push(input.runId);
          if (input.taskId === deferredTask.taskId) {
            return Effect.fail(
              new CompositionAgentDriverFailure({
                code: "agent_driver_unavailable",
                detail: "Runtime 尚未重新上线",
              }),
            );
          }
          return Effect.succeed({
            task: acceptedTask,
            run: runs.get(acceptedTask.taskId)!,
            status: "accepted" as const,
          });
        },
      },
    });

    assert.deepEqual(attempted, ["run-orphan-deferred", "run-orphan-accepted"]);
    assert.deepEqual(actions, [
      {
        taskId: "task-orphan-deferred",
        runId: "run-orphan-deferred",
        action: "deferred",
      },
      {
        taskId: "task-orphan-accepted",
        runId: "run-orphan-accepted",
        action: "accepted",
      },
    ]);
  }),
);
