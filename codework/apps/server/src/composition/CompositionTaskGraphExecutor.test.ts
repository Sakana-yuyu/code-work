import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import type {
  CompositionCapabilityGrant,
  CompositionTaskDispatchResult,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import type { ByokAgentModelDriver } from "./ByokAgentLoop.ts";
import { ByokAgentModelError } from "./ByokAgentLoop.ts";
import { makeCompositionAgentService } from "./CompositionAgentService.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  makeCompositionTaskGraphExecutor,
  type CompositionTaskGraphCancellationReport,
  type CompositionTaskGraphCancellationReceipt,
  type CompositionTaskGraphExecutionInput,
} from "./CompositionTaskGraphExecutor.ts";
import {
  CompositionAgentDriverFailure,
  CompositionTaskRetryInvalidError,
  makeCompositionOrchestrator,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import {
  CompositionTaskRuntimeWaitError,
  type CompositionTaskRuntimeUpdate,
} from "./CompositionTaskRuntimeProjectionService.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { encodeCompositionSquadReviewDecision } from "./CompositionSquadReview.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type {
  CompositionTaskInputStoreShape,
  CompositionTaskRecoveryInput,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const testCapabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const CapabilityRegistryLayer = Layer.succeed(
  CapabilityRegistry.CapabilityRegistry,
  testCapabilityRegistry,
);
const CapabilityPolicyLayer = CapabilityPolicy.layer.pipe(Layer.provide(CapabilityRegistryLayer));

const TestLayer = Layer.mergeAll(
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer),
    Layer.provide(CapabilityRegistryLayer),
    Layer.provide(WorkspaceFileLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityRegistryLayer,
  WorkspaceFileLayer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  WorkspacePaths.layer,
  CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
).pipe(Layer.provideMerge(NodeServices.layer));

const baseLeader = {
  taskId: "leader-task",
  runId: "leader-run",
  projectId: "project-graph",
  assigneeKind: "agent" as const,
  assigneeId: "leader-agent",
  promptDigest: "sha256:leader",
  prompt: "汇总子 Agent 的结果",
  workspaceRoot: "C:/workspace",
};

const makeInputStore = (): CompositionTaskInputStoreShape => {
  const inputs = new Map<string, CompositionTaskRecoveryInput>();
  return {
    save: (input) => Effect.sync(() => void inputs.set(input.taskId, input)),
    get: (taskId) => Effect.succeed(Option.fromNullishOr(inputs.get(taskId))),
    remove: (taskId) => Effect.sync(() => void inputs.delete(taskId)),
  };
};

const makeGrantRegistry = (): Pick<
  CapabilityGrantRegistry.CapabilityGrantRegistryShape,
  "issue"
> => ({
  issue: ({ taskId, agentId, capabilityIds }) =>
    Effect.succeed(
      capabilityIds.map(
        (capabilityId): CompositionCapabilityGrant => ({
          grantId: capabilityId,
          taskId,
          agentId,
          capabilityId,
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 9_999_999_999,
        }),
      ),
    ),
});

const completionStatuses = new Set(["in_review", "completed", "failed", "cancelled", "timed_out"]);

const makeSchedulingExecutor = (
  events: string[],
  dispatchedInputs: Array<{
    readonly taskId: string;
    readonly prompt: string | undefined;
    readonly promptDigest: string;
  }> = [],
) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const orchestrator: Pick<CompositionOrchestrator, "dispatchTask" | "retryTask" | "cancelTask"> = {
    dispatchTask: (input) =>
      Effect.sync(() => {
        events.push(`dispatch:${input.taskId}`);
        dispatchedInputs.push({
          taskId: input.taskId,
          prompt: input.prompt,
          promptDigest: input.promptDigest,
        });
        const terminal = input.taskId === baseLeader.taskId;
        const task: CompositionTask = {
          taskId: input.taskId,
          projectId: input.projectId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
          assigneeKind: input.assigneeKind,
          assigneeId: input.assigneeId,
          mode: input.mode,
          status: terminal ? "completed" : "running",
          promptDigest: input.promptDigest,
          dependsOnTaskIds: [...input.dependsOnTaskIds],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        };
        const run: CompositionTaskRun = {
          runId: input.runId,
          taskId: input.taskId,
          agentId: input.assigneeId,
          runtimeId: `runtime-${input.assigneeId}`,
          status: terminal ? "completed" : "running",
          attempt: 1,
          capabilityGrantIds: [],
        };
        tasks.set(task.taskId, task);
        runs.set(run.runId, run);
        return { task, run };
      }),
    retryTask: () => Effect.die("本测试不应重试"),
    cancelTask: () => Effect.die("本测试不应取消"),
  };
  return makeCompositionTaskGraphExecutor({
    orchestrator,
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
      getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
    },
    runtime: {
      awaitTaskCompletion: ({ taskId, runId }) =>
        Effect.sync(() => {
          events.push(`settle:${taskId}`);
          const task = tasks.get(taskId)!;
          const run = runs.get(runId)!;
          tasks.set(taskId, { ...task, status: "completed" });
          const completedRun = {
            ...run,
            status: "completed" as const,
            resultSummary: `${taskId} 的可验证结果`,
          };
          runs.set(runId, completedRun);
          return completedRun;
        }),
    },
  });
};

const schedulingChildren = ["a", "b", "c"].map((suffix) => ({
  nodeId: `node-${suffix}`,
  taskId: `task-${suffix}`,
  runId: `run-${suffix}`,
  projectId: "project-graph",
  assigneeKind: "agent" as const,
  assigneeId: `agent-${suffix}`,
  mode: "parallel" as const,
  promptDigest: `sha256:${suffix}`,
  prompt: `任务 ${suffix.toUpperCase()}`,
  workspaceRoot: "C:/workspace",
}));

const makePartialSuccessExecutor = (events: string[], leaderPrompts: string[]) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const orchestrator: Pick<CompositionOrchestrator, "dispatchTask" | "retryTask" | "cancelTask"> = {
    dispatchTask: (input) =>
      Effect.sync(() => {
        events.push(`dispatch:${input.taskId}`);
        if (input.taskId === baseLeader.taskId && input.prompt !== undefined) {
          leaderPrompts.push(input.prompt);
        }
        const terminal = input.taskId === baseLeader.taskId;
        const task: CompositionTask = {
          taskId: input.taskId,
          projectId: input.projectId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
          assigneeKind: input.assigneeKind,
          assigneeId: input.assigneeId,
          mode: input.mode,
          status: terminal ? "completed" : "running",
          promptDigest: input.promptDigest,
          dependsOnTaskIds: [...input.dependsOnTaskIds],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        };
        const run: CompositionTaskRun = {
          runId: input.runId,
          taskId: input.taskId,
          agentId: input.assigneeId,
          runtimeId: `runtime-${input.assigneeId}`,
          status: terminal ? "completed" : "running",
          attempt: 1,
          capabilityGrantIds: [],
        };
        tasks.set(task.taskId, task);
        runs.set(run.runId, run);
        return { task, run };
      }),
    retryTask: () => Effect.die("本测试不应重试"),
    cancelTask: ({ taskId }) =>
      Effect.sync(() => {
        events.push(`cancel:${taskId}`);
        const task = tasks.get(taskId)!;
        const run = [...runs.values()].find((candidate) => candidate.taskId === taskId)!;
        return {
          task: { ...task, status: "cancelled" as const },
          run: { ...run, status: "cancelled" as const },
          status: "cancelled" as const,
        };
      }),
  };
  return makeCompositionTaskGraphExecutor({
    orchestrator,
    store: {
      getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
    },
    runtime: {
      awaitTaskCompletion: ({ taskId, runId }) =>
        Effect.sync(() => {
          const task = tasks.get(taskId)!;
          const run = runs.get(runId)!;
          const failed = taskId === "task-a";
          const status = failed ? ("failed" as const) : ("completed" as const);
          events.push(`${status}:${taskId}`);
          tasks.set(taskId, { ...task, status });
          const settledRun: CompositionTaskRun = {
            ...run,
            status,
            ...(failed
              ? { failureCode: "worker_failed", resultSummary: "A 节点执行失败" }
              : { resultSummary: `${taskId} 已完成` }),
          };
          runs.set(runId, settledRun);
          return settledRun;
        }),
    },
  });
};

const partialSuccessChildren = [
  { ...schedulingChildren[0]!, dependsOnNodeIds: [] },
  { ...schedulingChildren[1]!, dependsOnNodeIds: [] },
  { ...schedulingChildren[2]!, dependsOnNodeIds: ["node-a"] },
  {
    nodeId: "node-d",
    taskId: "task-d",
    runId: "run-d",
    projectId: "project-graph",
    assigneeKind: "agent" as const,
    assigneeId: "agent-d",
    mode: "parallel" as const,
    promptDigest: "sha256:d",
    prompt: "任务 D",
    workspaceRoot: "C:/workspace",
    dependsOnNodeIds: ["node-b"],
  },
];

describe("CompositionTaskGraphExecutor", () => {
  it.effect("重复执行相同任务图时复用稳定 Task/Run 且不重复派发", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = makeSchedulingExecutor(events);
      const input: CompositionTaskGraphExecutionInput = {
        leader: baseLeader,
        children: schedulingChildren.slice(0, 2),
        schedule: "parallel",
        maxConcurrency: 2,
      };

      const first = yield* executor.execute(input);
      const firstDispatchCount = events.filter((event) => event.startsWith("dispatch:")).length;
      const second = yield* executor.execute(input);
      const secondDispatchCount = events.filter((event) => event.startsWith("dispatch:")).length;

      expect(first.children.map((child) => child.run.runId)).toEqual(["run-a", "run-b"]);
      expect(second.children.map((child) => child.run.runId)).toEqual(["run-a", "run-b"]);
      expect(firstDispatchCount).toBe(3);
      expect(secondDispatchCount).toBe(firstDispatchCount);
    }),
  );

  it.effect("服务重启后复用已完成的稳定重试 Run，避免重复重试副作用", () =>
    Effect.gen(function* () {
      const child = {
        nodeId: "retry-recovery-child",
        taskId: "retry-recovery-task",
        runId: "retry-recovery-run",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "retry-recovery-agent",
        mode: "parallel" as const,
        promptDigest: "sha256:retry-recovery",
        prompt: "恢复重启前已经完成的重试任务",
        workspaceRoot: "C:/workspace",
        capabilityIds: ["t3.workspace.read_file"],
        maxAttempts: 2,
      };
      const retryRunId = `${child.runId}:retry:2`;
      const childTask: CompositionTask = {
        taskId: child.taskId,
        projectId: child.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: child.assigneeKind,
        assigneeId: child.assigneeId,
        mode: child.mode,
        status: "completed",
        promptDigest: child.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 3,
        finishedAtUnixMs: 3,
      };
      const baseRun: CompositionTaskRun = {
        runId: child.runId,
        taskId: child.taskId,
        agentId: child.assigneeId,
        runtimeId: "runtime-retry-recovery",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
        failureCode: "rate_limited",
        resultSummary: "首次执行触发瞬态限流",
      };
      const completedRetry: CompositionTaskRun = {
        ...baseRun,
        runId: retryRunId,
        status: "completed",
        attempt: 2,
        resultSummary: "重启前的第二次尝试已经完成",
        failureCode: undefined,
      };
      const tasks = new Map<string, CompositionTask>([[child.taskId, childTask]]);
      const runs = new Map<string, CompositionTaskRun>([
        [baseRun.runId, baseRun],
        [completedRetry.runId, completedRetry],
      ]);
      let retryCalls = 0;
      let leaderDispatches = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              if (input.taskId !== baseLeader.taskId) {
                throw new Error(`不应重复派发已持久化的子任务：${input.taskId}`);
              }
              leaderDispatches += 1;
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "completed",
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 4,
                updatedAtUnixMs: 4,
                finishedAtUnixMs: 4,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: "runtime-leader",
                status: "completed",
                attempt: 1,
                capabilityGrantIds: [],
                resultSummary: "Leader 已汇总恢复结果",
              };
              tasks.set(task.taskId, task);
              runs.set(run.runId, run);
              return { task, run } satisfies CompositionTaskDispatchResult;
            }),
          retryTask: (input) => {
            retryCalls += 1;
            return Effect.fail(
              new CompositionTaskRetryInvalidError({
                taskId: input.taskId,
                previousRunId: input.previousRunId,
                reason: "run_id_conflict",
              }),
            );
          },
          cancelTask: () => Effect.die("恢复已完成重试时不应取消任务"),
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("已持久化的 Run 均为终态"),
        },
      });

      const result = yield* executor.execute({ leader: baseLeader, children: [child] });

      expect(retryCalls).toBe(0);
      expect(leaderDispatches).toBe(1);
      expect(result.children[0]).toMatchObject({
        attempts: 2,
        run: { runId: retryRunId, status: "completed" },
      });
    }),
  );

  it.effect("continue_independent 继续无关分支并把部分成功交给 Leader review", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const leaderPrompts: string[] = [];
      const executor = makePartialSuccessExecutor(events, leaderPrompts);

      const result = yield* executor.execute({
        leader: baseLeader,
        children: partialSuccessChildren,
        schedule: "serial",
        failurePolicy: "continue_independent",
        partialSuccessPolicy: "require_review",
      } as CompositionTaskGraphExecutionInput);
      const failures = (
        result as typeof result & {
          readonly failures: ReadonlyArray<{
            readonly nodeId: string;
            readonly kind: "failed" | "skipped";
            readonly failureCode: string;
          }>;
        }
      ).failures;

      expect(events).toContain("dispatch:task-b");
      expect(events).toContain("dispatch:task-d");
      expect(events).not.toContain("dispatch:task-c");
      expect(events.some((event) => event.startsWith("cancel:"))).toBe(false);
      expect(failures).toMatchObject([
        { nodeId: "node-a", kind: "failed", failureCode: "worker_failed" },
        { nodeId: "node-c", kind: "skipped", failureCode: "dependency_failed" },
      ]);
      expect(leaderPrompts[0]).toContain("node-a");
      expect(leaderPrompts[0]).toContain("A 节点执行失败");
    }),
  );

  it.effect("partialSuccessPolicy=reject 在独立分支收口后拒绝派发 Leader", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = makePartialSuccessExecutor(events, []);

      const error = yield* Effect.flip(
        executor.execute({
          leader: baseLeader,
          children: partialSuccessChildren.slice(0, 2),
          schedule: "serial",
          failurePolicy: "continue_independent",
          partialSuccessPolicy: "reject",
        } as CompositionTaskGraphExecutionInput),
      );

      expect(events).toContain("completed:task-b");
      expect(events).not.toContain(`dispatch:${baseLeader.taskId}`);
      expect(error).toMatchObject({ code: "partial_success_rejected" });
    }),
  );

  it.effect("serial 调度必须等待前一节点完成后再启动下一节点", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = makeSchedulingExecutor(events);

      yield* executor.execute({
        leader: baseLeader,
        children: schedulingChildren.slice(0, 2),
        schedule: "serial",
      });

      expect(events.slice(0, 4)).toEqual([
        "dispatch:task-a",
        "settle:task-a",
        "dispatch:task-b",
        "settle:task-b",
      ]);
    }),
  );

  it.effect("依赖节点收到上游结果摘要且 promptDigest 覆盖实际提示词", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const dispatchedInputs: Array<{
        readonly taskId: string;
        readonly prompt: string | undefined;
        readonly promptDigest: string;
      }> = [];
      const executor = makeSchedulingExecutor(events, dispatchedInputs);

      yield* executor.execute({
        leader: baseLeader,
        children: [
          schedulingChildren[0]!,
          { ...schedulingChildren[1]!, dependsOnNodeIds: [schedulingChildren[0]!.nodeId] },
        ],
        schedule: "serial",
      });

      const dependent = dispatchedInputs.find((input) => input.taskId === "task-b")!;
      expect(dependent.prompt).toContain("依赖任务结果：");
      expect(dependent.prompt).toContain("node-a (agent-a): task-a 的可验证结果");
      expect(dependent.promptDigest).toBe(
        `sha256:${NodeCrypto.createHash("sha256").update(dependent.prompt!, "utf8").digest("hex")}`,
      );

      const leader = dispatchedInputs.find((input) => input.taskId === baseLeader.taskId)!;
      expect(leader.promptDigest).toBe(
        `sha256:${NodeCrypto.createHash("sha256").update(leader.prompt!, "utf8").digest("hex")}`,
      );
    }),
  );

  it.effect("Reviewer 驳回后只重做点名节点并使用修订结果再次评审", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const dispatches: Array<{ readonly taskId: string; readonly prompt: string | undefined }> =
        [];
      const worker = {
        nodeId: "worker",
        taskId: "task-worker",
        runId: "run-worker",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-worker",
        mode: "parallel" as const,
        promptDigest: "sha256:worker",
        prompt: "完成实现",
        workspaceRoot: "C:/workspace",
      };
      const reviewer = {
        nodeId: "reviewer",
        taskId: "task-reviewer",
        runId: "run-reviewer",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-reviewer",
        mode: "parallel" as const,
        promptDigest: "sha256:reviewer",
        prompt: "严格评审实现",
        workspaceRoot: "C:/workspace",
        dependsOnNodeIds: [worker.nodeId],
      };
      const orchestrator: Pick<
        CompositionOrchestrator,
        "dispatchTask" | "retryTask" | "cancelTask"
      > = {
        dispatchTask: (input) =>
          Effect.sync(() => {
            dispatches.push({ taskId: input.taskId, prompt: input.prompt });
            const leader = input.taskId === baseLeader.taskId;
            const task: CompositionTask = {
              taskId: input.taskId,
              projectId: input.projectId,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
              assigneeKind: input.assigneeKind,
              assigneeId: input.assigneeId,
              mode: input.mode,
              status: leader ? "completed" : "running",
              promptDigest: input.promptDigest,
              dependsOnTaskIds: [...input.dependsOnTaskIds],
              createdAtUnixMs: 1,
              updatedAtUnixMs: 1,
            };
            const run: CompositionTaskRun = {
              runId: input.runId,
              taskId: input.taskId,
              agentId: input.assigneeId,
              runtimeId: `runtime-${input.assigneeId}`,
              status: leader ? "completed" : "running",
              attempt: 1,
              capabilityGrantIds: [],
              ...(leader ? { resultSummary: "Leader 汇总完成" } : {}),
            };
            tasks.set(task.taskId, task);
            runs.set(run.runId, run);
            return { task, run };
          }),
        retryTask: () => Effect.die("本测试不应触发瞬态重试"),
        cancelTask: () => Effect.die("本测试不应触发取消"),
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator,
        store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
        runtime: {
          awaitTaskCompletion: ({ taskId, runId }) =>
            Effect.sync(() => {
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              const resultSummary =
                taskId === worker.taskId
                  ? "初稿缺少失败场景测试"
                  : taskId === `${worker.taskId}:review:1`
                    ? "修订稿已补齐失败场景测试"
                    : taskId === reviewer.taskId
                      ? encodeCompositionSquadReviewDecision({
                          decision: "reject",
                          feedback: "补齐失败场景测试。",
                          reworkNodeIds: [worker.nodeId],
                        })
                      : encodeCompositionSquadReviewDecision({
                          decision: "approve",
                          feedback: "修订结果满足要求。",
                          reworkNodeIds: [],
                        });
              const completedTask = { ...task, status: "completed" as const };
              const completedRun = { ...run, status: "completed" as const, resultSummary };
              tasks.set(taskId, completedTask);
              runs.set(runId, completedRun);
              return completedRun;
            }),
        },
      });
      const input: CompositionTaskGraphExecutionInput = {
        leader: baseLeader,
        children: [worker, reviewer],
        schedule: "parallel" as const,
        review: {
          reviewerNodeIds: [reviewer.nodeId],
          reworkableNodeIds: [worker.nodeId],
          maxRevisions: 1,
        },
      };

      const result = yield* executor.execute(input);

      expect(dispatches.map((dispatch) => dispatch.taskId)).toEqual([
        worker.taskId,
        reviewer.taskId,
        `${worker.taskId}:review:1`,
        `${reviewer.taskId}:review:1`,
        baseLeader.taskId,
      ]);
      expect(
        dispatches.find((dispatch) => dispatch.taskId === `${worker.taskId}:review:1`)?.prompt,
      ).toContain("补齐失败场景测试。");
      expect(
        dispatches.find((dispatch) => dispatch.taskId === `${worker.taskId}:review:1`)?.prompt,
      ).toContain("初稿缺少失败场景测试");
      expect(
        dispatches.find((dispatch) => dispatch.taskId === `${reviewer.taskId}:review:1`)?.prompt,
      ).toContain("修订稿已补齐失败场景测试");
      expect(result.children.find((child) => child.nodeId === worker.nodeId)).toMatchObject({
        attempts: 2,
        task: { taskId: `${worker.taskId}:review:1` },
      });
    }),
  );

  it.effect("评审输出非法或重做预算耗尽时阻止 Leader 汇总", () =>
    Effect.gen(function* () {
      const run = (reviewSummary: string, maxRevisions: number) => {
        const tasks = new Map<string, CompositionTask>();
        const dispatchedTaskIds: string[] = [];
        const worker = {
          nodeId: "worker",
          taskId: "task-worker-boundary",
          runId: "run-worker-boundary",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-worker",
          mode: "parallel" as const,
          promptDigest: "sha256:worker-boundary",
          prompt: "完成实现",
          workspaceRoot: "C:/workspace",
        };
        const reviewer = {
          nodeId: "reviewer",
          taskId: "task-reviewer-boundary",
          runId: "run-reviewer-boundary",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-reviewer",
          mode: "parallel" as const,
          promptDigest: "sha256:reviewer-boundary",
          prompt: "严格评审实现",
          workspaceRoot: "C:/workspace",
          dependsOnNodeIds: [worker.nodeId],
        };
        const executor = makeCompositionTaskGraphExecutor({
          orchestrator: {
            dispatchTask: (input) =>
              Effect.sync(() => {
                dispatchedTaskIds.push(input.taskId);
                const resultSummary =
                  input.taskId === reviewer.taskId
                    ? reviewSummary
                    : input.taskId === worker.taskId
                      ? "初稿"
                      : "不应派发 Leader";
                const task: CompositionTask = {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "completed",
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                };
                const run: CompositionTaskRun = {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "completed",
                  attempt: 1,
                  capabilityGrantIds: [],
                  resultSummary,
                };
                tasks.set(task.taskId, task);
                return { task, run };
              }),
            retryTask: () => Effect.die("本测试不应触发瞬态重试"),
            cancelTask: () => Effect.die("本测试不应触发取消"),
          },
          store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
          runtime: { awaitTaskCompletion: () => Effect.die("终态任务不应等待 Runtime") },
        });
        return Effect.flip(
          executor.execute({
            leader: baseLeader,
            children: [worker, reviewer],
            review: {
              reviewerNodeIds: [reviewer.nodeId],
              reworkableNodeIds: [worker.nodeId],
              maxRevisions,
            },
          }),
        ).pipe(Effect.map((error) => ({ error, dispatchedTaskIds })));
      };

      const invalid = yield* run("不是 JSON", 1);
      expect(invalid.error).toMatchObject({ code: "squad_review_output_invalid" });
      expect(invalid.dispatchedTaskIds).not.toContain(baseLeader.taskId);

      const exhausted = yield* run(
        encodeCompositionSquadReviewDecision({
          decision: "reject",
          feedback: "仍缺少边界测试。",
          reworkNodeIds: ["worker"],
        }),
        0,
      );
      expect(exhausted.error).toMatchObject({ code: "review_rework_exhausted" });
      expect(exhausted.dispatchedTaskIds).not.toContain(baseLeader.taskId);
    }),
  );

  it.effect("成员 Driver 离线时按候选顺序接管且保留原失败尝试", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const dispatches: Array<{
        readonly taskId: string;
        readonly assigneeId: string;
        readonly prompt: string | undefined;
        readonly modelSnapshot: CompositionTaskRun["modelSnapshot"];
        readonly capabilityIds: ReadonlyArray<string> | undefined;
      }> = [];
      const child = {
        nodeId: "offline-worker",
        taskId: "task-offline-worker",
        runId: "run-offline-worker",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-primary",
        mode: "parallel" as const,
        promptDigest: "sha256:offline-worker",
        prompt: "完成离线接管测试",
        workspaceRoot: "C:/workspace/primary",
        modelSnapshot: { kind: "runtime_native" as const, modelId: "primary-model" },
        capabilityIds: ["t3.workspace.read_file"],
        failoverCandidates: [
          {
            assigneeId: "agent-backup",
            model: "provider/backup-model",
            modelSnapshot: {
              kind: "byok" as const,
              providerInstanceId: "byok-backup",
              adapterId: "adapter-backup",
              modelId: "backup-model",
              adapterConfigDigest: "sha256:adapter-backup",
            },
            workspaceRoot: "C:/workspace/backup",
            capabilityIds: ["t3.workspace.read_file", "t3.git.status"],
          },
        ],
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              dispatches.push({
                taskId: input.taskId,
                assigneeId: input.assigneeId,
                prompt: input.prompt,
                modelSnapshot: input.modelSnapshot,
                capabilityIds: input.capabilityIds,
              });
              const primary = input.assigneeId === child.assigneeId;
              const leader = input.taskId === baseLeader.taskId;
              const status = primary
                ? ("failed" as const)
                : leader
                  ? ("completed" as const)
                  : ("running" as const);
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status,
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status,
                attempt: 1,
                ...(input.modelSnapshot === undefined
                  ? {}
                  : { modelSnapshot: input.modelSnapshot }),
                capabilityGrantIds: [],
                ...(primary
                  ? {
                      failureCode: "agent_driver_unavailable",
                      resultSummary: "主成员 Driver 未注册",
                    }
                  : leader
                    ? { resultSummary: "Leader 汇总完成" }
                    : {}),
              };
              tasks.set(task.taskId, task);
              runs.set(run.runId, run);
              return { task, run };
            }),
          retryTask: () => Effect.die("离线接管不应走原成员瞬态重试"),
          cancelTask: () => Effect.die("本测试不应取消"),
        },
        store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
        runtime: {
          awaitTaskCompletion: ({ taskId, runId }) =>
            Effect.sync(() => {
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              const completedTask = { ...task, status: "completed" as const };
              const completedRun = {
                ...run,
                status: "completed" as const,
                resultSummary: "备用成员完成接管任务",
              };
              tasks.set(taskId, completedTask);
              runs.set(runId, completedRun);
              return completedRun;
            }),
        },
      });

      const result = yield* executor.execute({ leader: baseLeader, children: [child] });

      expect(dispatches.map((dispatch) => [dispatch.taskId, dispatch.assigneeId])).toEqual([
        [child.taskId, "agent-primary"],
        [`${child.taskId}:failover:1`, "agent-backup"],
        [baseLeader.taskId, baseLeader.assigneeId],
      ]);
      const failover = dispatches[1]!;
      expect(failover.prompt).toContain("主成员 Driver 未注册");
      expect(dispatches[0]?.modelSnapshot).toEqual({
        kind: "runtime_native",
        modelId: "primary-model",
      });
      expect(failover.modelSnapshot).toEqual({
        kind: "byok",
        providerInstanceId: "byok-backup",
        adapterId: "adapter-backup",
        modelId: "backup-model",
        adapterConfigDigest: "sha256:adapter-backup",
      });
      expect(failover.capabilityIds).toEqual(["t3.workspace.read_file"]);
      expect(result.children[0]).toMatchObject({
        attempts: 2,
        task: { taskId: `${child.taskId}:failover:1`, assigneeId: "agent-backup" },
        run: { agentId: "agent-backup", resultSummary: "备用成员完成接管任务" },
      });
    }),
  );

  it.effect("用户取消确认超时不触发成员接管", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, CompositionTask>();
      const dispatches: string[] = [];
      const child = {
        nodeId: "cancel-timeout-worker",
        taskId: "task-cancel-timeout-worker",
        runId: "run-cancel-timeout-worker",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-primary",
        mode: "parallel" as const,
        promptDigest: "sha256:cancel-timeout-worker",
        prompt: "等待用户取消确认",
        workspaceRoot: "C:/workspace/primary",
        capabilityIds: ["t3.workspace.read_file"],
        failoverCandidates: [
          {
            assigneeId: "agent-backup",
            workspaceRoot: "C:/workspace/backup",
            capabilityIds: ["t3.workspace.read_file"],
          },
        ],
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              dispatches.push(input.taskId);
              const isPrimary = input.taskId === child.taskId;
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: isPrimary ? "timed_out" : "completed",
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status: isPrimary ? "timed_out" : "completed",
                attempt: 1,
                capabilityGrantIds: [],
                ...(isPrimary
                  ? {
                      failureCode: "runtime_cancel_confirmation_timeout",
                      resultSummary: "用户取消请求未在确认窗口内完成",
                    }
                  : { resultSummary: "不应执行" }),
              };
              tasks.set(task.taskId, task);
              return { task, run };
            }),
          retryTask: () => Effect.die("取消确认超时不应重试"),
          cancelTask: () => Effect.die("本测试不应再次取消"),
        },
        store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
        runtime: { awaitTaskCompletion: () => Effect.die("终态任务不应等待") },
      });

      const exit = yield* Effect.exit(executor.execute({ leader: baseLeader, children: [child] }));

      expect(exit._tag).toBe("Failure");
      expect(dispatches).toEqual([child.taskId]);
    }),
  );

  it.effect("所有接管候选耗尽时返回结构化失败且不派发 Leader", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, CompositionTask>();
      const dispatches: string[] = [];
      const child = {
        nodeId: "exhausted-worker",
        taskId: "task-exhausted-worker",
        runId: "run-exhausted-worker",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-primary",
        mode: "parallel" as const,
        promptDigest: "sha256:exhausted-worker",
        prompt: "完成候选耗尽测试",
        workspaceRoot: "C:/workspace/primary",
        capabilityIds: ["t3.workspace.read_file"],
        failoverCandidates: [
          {
            assigneeId: "agent-backup-a",
            workspaceRoot: "C:/workspace/backup-a",
            capabilityIds: ["t3.workspace.read_file"],
          },
          {
            assigneeId: "agent-backup-b",
            workspaceRoot: "C:/workspace/backup-b",
            capabilityIds: ["t3.workspace.read_file"],
          },
        ],
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            input.taskId === baseLeader.taskId
              ? Effect.die("候选耗尽后不应派发 Leader")
              : Effect.sync(() => {
                  dispatches.push(input.taskId);
                  const task: CompositionTask = {
                    taskId: input.taskId,
                    projectId: input.projectId,
                    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                    ...(input.parentTaskId === undefined
                      ? {}
                      : { parentTaskId: input.parentTaskId }),
                    assigneeKind: input.assigneeKind,
                    assigneeId: input.assigneeId,
                    mode: input.mode,
                    status: "failed",
                    promptDigest: input.promptDigest,
                    dependsOnTaskIds: [...input.dependsOnTaskIds],
                    createdAtUnixMs: 1,
                    updatedAtUnixMs: 1,
                  };
                  const run: CompositionTaskRun = {
                    runId: input.runId,
                    taskId: input.taskId,
                    agentId: input.assigneeId,
                    runtimeId: "unresolved",
                    status: "failed",
                    attempt: 1,
                    capabilityGrantIds: [],
                    failureCode: "agent_driver_unavailable",
                    resultSummary: `${input.assigneeId} 的 Driver 不可用`,
                  };
                  tasks.set(task.taskId, task);
                  return { task, run };
                }),
          retryTask: () => Effect.die("候选离线不应走原成员重试"),
          cancelTask: () => Effect.die("本测试不应取消"),
        },
        store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
        runtime: { awaitTaskCompletion: () => Effect.die("终态任务不应等待") },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [child] }));

      expect(error).toMatchObject({
        code: "failover_candidates_exhausted",
        nodeId: child.nodeId,
      });
      expect(dispatches).toEqual([
        child.taskId,
        `${child.taskId}:failover:1`,
        `${child.taskId}:failover:2`,
      ]);
    }),
  );

  it.effect("接管成员的瞬态失败在接管 Task 上重试", () =>
    Effect.gen(function* () {
      const tasks = new Map<string, CompositionTask>();
      const dispatches: Array<[string, string]> = [];
      const retries: Array<{ taskId: string; previousRunId: string; runId: string }> = [];
      const child = {
        nodeId: "retry-failover-worker",
        taskId: "task-retry-failover-worker",
        runId: "run-retry-failover-worker",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "agent-primary",
        mode: "parallel" as const,
        promptDigest: "sha256:retry-failover-worker",
        prompt: "完成接管重试测试",
        workspaceRoot: "C:/workspace/primary",
        capabilityIds: ["t3.workspace.read_file"],
        maxAttempts: 2,
        failoverCandidates: [
          {
            assigneeId: "agent-backup",
            workspaceRoot: "C:/workspace/backup",
            capabilityIds: ["t3.workspace.read_file"],
          },
        ],
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              dispatches.push([input.taskId, input.assigneeId]);
              const isLeader = input.taskId === baseLeader.taskId;
              const isPrimary = input.taskId === child.taskId;
              const status = isLeader ? "completed" : "failed";
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status,
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status,
                attempt: 1,
                capabilityGrantIds: [],
                ...(isLeader
                  ? { resultSummary: "Leader 汇总完成" }
                  : isPrimary
                    ? {
                        failureCode: "agent_driver_unavailable",
                        resultSummary: "主成员 Driver 未注册",
                      }
                    : {
                        failureCode: "provider_network",
                        resultSummary: "备用成员网络瞬时失败",
                      }),
              };
              tasks.set(task.taskId, task);
              return { task, run };
            }),
          retryTask: (input) =>
            Effect.sync(() => {
              retries.push({
                taskId: input.taskId,
                previousRunId: input.previousRunId,
                runId: input.runId,
              });
              const task = { ...tasks.get(input.taskId)!, status: "completed" as const };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: "agent-backup",
                runtimeId: "runtime-agent-backup",
                status: "completed",
                attempt: 2,
                capabilityGrantIds: [],
                resultSummary: "备用成员重试后完成",
              };
              tasks.set(task.taskId, task);
              return { task, run };
            }),
          cancelTask: () => Effect.die("本测试不应取消"),
        },
        store: { getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))) },
        runtime: { awaitTaskCompletion: () => Effect.die("终态任务不应等待") },
      });

      const result = yield* executor.execute({ leader: baseLeader, children: [child] });

      const failoverTaskId = `${child.taskId}:failover:1`;
      const failoverRunId = `${child.runId}:failover:1`;
      expect(retries).toEqual([
        {
          taskId: failoverTaskId,
          previousRunId: failoverRunId,
          runId: `${failoverRunId}:retry:2`,
        },
      ]);
      expect(dispatches).toEqual([
        [child.taskId, "agent-primary"],
        [failoverTaskId, "agent-backup"],
        [baseLeader.taskId, baseLeader.assigneeId],
      ]);
      expect(result.children[0]).toMatchObject({
        attempts: 3,
        task: { taskId: failoverTaskId, assigneeId: "agent-backup" },
        run: { runId: `${failoverRunId}:retry:2`, resultSummary: "备用成员重试后完成" },
      });
    }),
  );

  it.effect("parallel 调度不允许启动超过 maxConcurrency 的节点", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = makeSchedulingExecutor(events);

      yield* executor.execute({
        leader: baseLeader,
        children: schedulingChildren,
        schedule: "parallel",
        maxConcurrency: 2,
      } as CompositionTaskGraphExecutionInput);

      expect(events.indexOf("dispatch:task-c")).toBeGreaterThan(events.indexOf("settle:task-b"));
    }),
  );

  it.effect("拒绝循环依赖，而不是进入不可结束的等待", () =>
    Effect.gen(function* () {
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: () => Effect.die("不会执行"),
          retryTask: () => Effect.die("不会执行"),
          cancelTask: () => Effect.die("不会执行"),
        },
        store: { getTask: () => Effect.die("不会执行") },
        runtime: { awaitTaskCompletion: () => Effect.die("不会执行") },
      });
      const input: CompositionTaskGraphExecutionInput = {
        leader: baseLeader,
        children: [
          {
            nodeId: "a",
            taskId: "task-a",
            runId: "run-a",
            projectId: "project-graph",
            assigneeKind: "agent",
            assigneeId: "agent-a",
            mode: "parallel",
            promptDigest: "sha256:a",
            prompt: "任务 A",
            workspaceRoot: "C:/workspace",
            dependsOnNodeIds: ["b"],
          },
          {
            nodeId: "b",
            taskId: "task-b",
            runId: "run-b",
            projectId: "project-graph",
            assigneeKind: "agent",
            assigneeId: "agent-b",
            mode: "parallel",
            promptDigest: "sha256:b",
            prompt: "任务 B",
            workspaceRoot: "C:/workspace",
            dependsOnNodeIds: ["a"],
          },
        ],
      };

      const error = yield* Effect.flip(executor.execute(input));
      expect(error).toMatchObject({ code: "dependency_cycle" });
    }),
  );

  it.layer(TestLayer, { excludeTestServices: true })(
    "通过真实 ToolBroker 执行两个 BYOK 子 Agent，失败子任务重试后由 Leader 进入 review",
    (it) =>
      it.effect("执行 Task Graph", () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-task-graph-",
          });
          yield* fileSystem.writeFileString(path.join(workspaceRoot, "README.md"), "graph proof\n");

          const rawBroker = yield* ToolBroker.ToolBroker;
          const invocations: ToolBroker.ToolBrokerInput[] = [];
          const broker: ToolBroker.ToolBroker["Service"] = {
            invoke: (input) =>
              Effect.gen(function* () {
                invocations.push(input);
                return yield* rawBroker.invoke(input);
              }),
            cancel: rawBroker.cancel,
          };

          const tool = {
            canonicalToolName: "workspace.read_file",
            description: "读取工作区文本文件",
            parameters: {
              type: "object",
              properties: { cwd: { type: "string" }, relativePath: { type: "string" } },
              required: ["cwd", "relativePath"],
            },
          };
          const successfulModel = (text: string): ByokAgentModelDriver => ({
            complete: ({ turn }) =>
              turn === 1
                ? Stream.succeed({
                    type: "tool_call" as const,
                    toolCallId: `read-${text}`,
                    canonicalToolName: "workspace.read_file",
                    arguments: { cwd: workspaceRoot, relativePath: "README.md" },
                  }).pipe(Stream.concat(Stream.succeed({ type: "model_completed" as const })))
                : Stream.succeed({ type: "text_delta" as const, text }).pipe(
                    Stream.concat(Stream.succeed({ type: "model_completed" as const })),
                  ),
          });
          let flakyFirstCall = true;
          const flakyModel: ByokAgentModelDriver = {
            complete: ({ turn }) => {
              if (flakyFirstCall) {
                flakyFirstCall = false;
                return Stream.fail(
                  new ByokAgentModelError({ code: "temporary_model_failure", detail: "重试测试" }),
                );
              }
              return successfulModel("子 Agent B 已恢复").complete({
                messages: [],
                tools: [tool],
                turn,
              });
            },
          };
          const models = new Map<string, ByokAgentModelDriver>([
            ["provider-a", successfulModel("子 Agent A 已完成")],
            ["provider-b", flakyModel],
            ["provider-leader", successfulModel("Leader 已完成汇总")],
          ]);
          const agentService = makeCompositionAgentService({
            broker,
            resolveModelDriver: ({ providerInstanceId }) =>
              Effect.succeed(models.get(providerInstanceId)!),
          });
          const store = yield* CompositionTaskStore;
          const drivers = [
            makeCompositionByokAgentDriver({
              agentId: "agent-a",
              runtimeId: "runtime-a",
              providerInstanceId: "provider-a",
              defaultModel: "model-a",
              agentService,
              checkpointStore: store,
              listTools: () => Effect.succeed([tool]),
            }),
            makeCompositionByokAgentDriver({
              agentId: "agent-b",
              runtimeId: "runtime-b",
              providerInstanceId: "provider-b",
              defaultModel: "model-b",
              agentService,
              checkpointStore: store,
              listTools: () => Effect.succeed([tool]),
            }),
            makeCompositionByokAgentDriver({
              agentId: "leader-agent",
              runtimeId: "runtime-leader",
              providerInstanceId: "provider-leader",
              defaultModel: "model-leader",
              agentService,
              checkpointStore: store,
              listTools: () => Effect.succeed([tool]),
            }),
          ];
          const driverRegistry = makeCompositionAgentDriverRegistry();
          yield* Effect.forEach(drivers, (driver) => driverRegistry.register(driver));
          const updates = yield* PubSub.unbounded<CompositionTaskRuntimeUpdate>();
          const projectAndPublish = (event: Parameters<typeof projectCompositionRuntimeEvent>[2]) =>
            Effect.gen(function* () {
              yield* projectCompositionRuntimeEvent(store, driverRegistry, event);
              const binding = yield* driverRegistry.resolveRuntimeEvent(event);
              if (binding === undefined) return;
              const taskOption = yield* store.getTask(binding.taskId);
              const runOption = yield* store.getRun(binding.runId);
              if (Option.isNone(taskOption) || Option.isNone(runOption)) return;
              yield* PubSub.publish(updates, { task: taskOption.value, run: runOption.value });
            });
          yield* Effect.forEach(drivers, (driver) =>
            Stream.runForEach(driver.streamEvents!(), projectAndPublish).pipe(Effect.forkScoped),
          );
          yield* Effect.yieldNow;

          const runtime = {
            awaitTaskCompletion: ({
              taskId,
              runId,
            }: {
              readonly taskId: string;
              readonly runId: string;
            }) =>
              Effect.scoped(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(updates);
                  const current = yield* store.getRun(runId);
                  if (Option.isNone(current)) {
                    return yield* new CompositionTaskRuntimeWaitError({
                      taskId,
                      runId,
                      reason: "run_not_found",
                    });
                  }
                  if (completionStatuses.has(current.value.status)) return current.value;
                  const waitForUpdate = (): Effect.Effect<
                    typeof current.value,
                    CompositionTaskRuntimeWaitError
                  > =>
                    Effect.suspend(() =>
                      PubSub.take(subscription).pipe(
                        Effect.flatMap((update) =>
                          update.task.taskId === taskId &&
                          update.run.runId === runId &&
                          completionStatuses.has(update.run.status)
                            ? Effect.succeed(update.run)
                            : waitForUpdate(),
                        ),
                      ),
                    );
                  return yield* waitForUpdate();
                }),
              ),
          };
          const orchestrator = makeCompositionOrchestrator(
            store,
            driverRegistry,
            makeGrantRegistry(),
            makeInputStore(),
          );
          const executor = makeCompositionTaskGraphExecutor({ orchestrator, store, runtime });

          const result = yield* executor.execute({
            leader: {
              ...baseLeader,
              assigneeId: "leader-agent",
              workspaceRoot,
              model: "model-leader",
            },
            children: [
              {
                nodeId: "child-a",
                taskId: "task-a",
                runId: "run-a",
                projectId: "project-graph",
                assigneeKind: "agent",
                assigneeId: "agent-a",
                mode: "parallel",
                promptDigest: "sha256:a",
                prompt: "读取 README 并总结 A",
                workspaceRoot,
                model: "model-a",
                capabilityIds: ["t3.workspace.read_file"],
              },
              {
                nodeId: "child-b",
                taskId: "task-b",
                runId: "run-b",
                projectId: "project-graph",
                assigneeKind: "agent",
                assigneeId: "agent-b",
                mode: "parallel",
                promptDigest: "sha256:b",
                prompt: "读取 README 并总结 B",
                workspaceRoot,
                model: "model-b",
                capabilityIds: ["t3.workspace.read_file"],
                maxAttempts: 2,
              },
            ],
          });

          expect(result.children.map((child) => child.nodeId)).toEqual(["child-a", "child-b"]);
          expect(result.children.find((child) => child.nodeId === "child-b")?.attempts).toBe(2);
          expect(result.leader.task.status).toBe("in_review");
          expect(result.leader.run.status).toBe("in_review");
          expect(invocations).toHaveLength(3);
          expect(invocations.map((input) => input.agentId).sort()).toEqual([
            "agent-a",
            "agent-b",
            "leader-agent",
          ]);
          expect(invocations.map((input) => `${input.agentId}:${input.runId}`).sort()).toEqual([
            "agent-a:run-a",
            "agent-b:run-b:retry:2",
            "leader-agent:leader-run",
          ]);
          expect(
            invocations.every((input) => input.canonicalToolName === "workspace.read_file"),
          ).toBe(true);
          expect(
            invocations
              .filter((input) => input.agentId !== "leader-agent")
              .every((input) => input.capabilityGrantIds.includes("t3.workspace.read_file")),
          ).toBe(true);
        }),
      ),
  );

  it.effect("权限失败即使保留尝试次数也不会自动重试", () =>
    Effect.gen(function* () {
      const child = {
        nodeId: "permission-child",
        taskId: "permission-task",
        runId: "permission-run",
        projectId: "project-graph",
        assigneeKind: "agent" as const,
        assigneeId: "permission-agent",
        mode: "parallel" as const,
        promptDigest: "sha256:permission",
        prompt: "执行需要额外权限的任务",
        workspaceRoot: "C:/workspace",
        capabilityIds: ["test.permission"],
        maxAttempts: 3,
      };
      const task: CompositionTask = {
        taskId: child.taskId,
        projectId: child.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: child.assigneeKind,
        assigneeId: child.assigneeId,
        mode: child.mode,
        status: "failed",
        promptDigest: child.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const makeFailedRun = (runId: string, attempt: number): CompositionTaskRun => ({
        runId,
        taskId: child.taskId,
        agentId: child.assigneeId,
        runtimeId: "permission-runtime",
        status: "failed",
        attempt,
        capabilityGrantIds: [],
        failureCode: "permission_error",
        resultSummary: "缺少执行权限",
      });
      let retryCalls = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: () =>
            Effect.succeed({
              task,
              run: makeFailedRun(child.runId, 1),
            } satisfies CompositionTaskDispatchResult),
          retryTask: ({ runId }) =>
            Effect.sync(() => {
              retryCalls += 1;
              return {
                task,
                run: makeFailedRun(runId, retryCalls + 1),
              } satisfies CompositionTaskDispatchResult;
            }),
          cancelTask: () => Effect.die("本测试没有仍在运行的任务"),
        },
        store: { getTask: () => Effect.succeed(Option.some(task)) },
        runtime: { awaitTaskCompletion: () => Effect.die("初始 Run 已是终态") },
      });

      const error = yield* Effect.flip(
        executor.execute({
          leader: baseLeader,
          children: [child],
        }),
      );

      expect(retryCalls).toBe(0);
      expect(error).toMatchObject({ code: "child_failed", nodeId: child.nodeId });
      expect(error.detail).toContain("失败码=permission_error");
      expect(error.detail).toContain("失败分类=permission");
    }),
  );

  it.effect("并行子任务失败时取消仍在运行的兄弟任务，并且不派发 Leader", () =>
    Effect.gen(function* () {
      const childBStarted = yield* Deferred.make<void>();
      const cancelRelease = yield* Deferred.make<void>();
      const cancelled: string[] = [];
      const dispatches: string[] = [];
      const makeTask = (
        input: CompositionTaskGraphExecutionInput["children"][number],
        status: CompositionTask["status"],
      ): CompositionTask => ({
        taskId: input.taskId,
        projectId: input.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        mode: input.mode,
        status,
        promptDigest: input.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      const makeRun = (
        input: CompositionTaskGraphExecutionInput["children"][number],
        status: CompositionTaskRun["status"],
        overrides: Partial<CompositionTaskRun> = {},
      ): CompositionTaskRun => ({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.assigneeId,
        runtimeId: `runtime-${input.assigneeId}`,
        status,
        attempt: 1,
        capabilityGrantIds: [],
        ...overrides,
      });
      const children = [
        {
          nodeId: "child-a",
          taskId: "task-a",
          runId: "run-a",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-a",
          mode: "parallel" as const,
          promptDigest: "sha256:a",
          prompt: "任务 A",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "child-b",
          taskId: "task-b",
          runId: "run-b",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-b",
          mode: "parallel" as const,
          promptDigest: "sha256:b",
          prompt: "任务 B",
          workspaceRoot: "C:/workspace",
        },
      ];
      let leaderDispatched = false;
      const orchestrator: Pick<
        CompositionOrchestrator,
        "dispatchTask" | "retryTask" | "cancelTask"
      > = {
        dispatchTask: (input) => {
          dispatches.push(input.taskId);
          if (input.taskId === "leader-task") leaderDispatched = true;
          const child = children.find((candidate) => candidate.taskId === input.taskId);
          const task =
            child === undefined
              ? {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "running" as const,
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                }
              : makeTask(child, "running");
          const run: CompositionTaskRun =
            child === undefined
              ? {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "running",
                  attempt: 1,
                  capabilityGrantIds: [],
                }
              : makeRun(child, "running");
          return Effect.succeed({ task, run } satisfies CompositionTaskDispatchResult);
        },
        retryTask: () => Effect.die("本测试不应触发重试"),
        cancelTask: ({ taskId, runId }) =>
          Effect.sync(() => {
            cancelled.push(`${taskId}/${runId}`);
            const child = children.find((entry) => entry.taskId === taskId) ?? children[0]!;
            return {
              task: makeTask(child, "cancelled"),
              run: makeRun(child, "cancelled"),
              status: "cancelled" as const,
            };
          }),
      };
      const taskProjections = new Map(
        children.map((child) => [child.taskId, makeTask(child, "running")] as const),
      );
      const runtime = {
        awaitTaskCompletion: ({ runId }: { taskId: string; runId: string }) =>
          runId === "run-b"
            ? Deferred.succeed(childBStarted, undefined).pipe(
                Effect.flatMap(() => Deferred.await(cancelRelease)),
                Effect.map(() => makeRun(children[1]!, "cancelled")),
              )
            : Deferred.await(childBStarted).pipe(
                Effect.map(() =>
                  makeRun(children[0]!, "failed", {
                    failureCode: "child_failure",
                    resultSummary: "子任务 A 失败",
                  }),
                ),
              ),
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator,
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(taskProjections.get(taskId))),
        },
        runtime,
      });

      const execution = executor.execute({
        leader: baseLeader,
        children,
      });
      const exit = yield* Effect.exit(execution);
      yield* Deferred.succeed(cancelRelease, undefined);

      expect(exit._tag).toBe("Failure");
      expect(cancelled).toEqual(["task-b/run-b"]);
      expect(leaderDispatched).toBe(false);
      expect(dispatches).toEqual(["task-a", "task-b"]);
    }),
  );

  it.effect("并行失败时不取消已经完成的兄弟任务", () =>
    Effect.gen(function* () {
      const childBCompleted = yield* Deferred.make<void>();
      const cancelled: string[] = [];
      const children = [
        {
          nodeId: "child-a",
          taskId: "task-a-completed-sibling",
          runId: "run-a-completed-sibling",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-a",
          mode: "parallel" as const,
          promptDigest: "sha256:a-completed-sibling",
          prompt: "任务 A",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "child-b",
          taskId: "task-b-completed-sibling",
          runId: "run-b-completed-sibling",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-b",
          mode: "parallel" as const,
          promptDigest: "sha256:b-completed-sibling",
          prompt: "任务 B",
          workspaceRoot: "C:/workspace",
        },
      ];
      const makeTask = (
        input: (typeof children)[number],
        status: CompositionTask["status"],
      ): CompositionTask => ({
        taskId: input.taskId,
        projectId: input.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        mode: input.mode,
        status,
        promptDigest: input.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      const makeRun = (
        input: (typeof children)[number],
        status: CompositionTaskRun["status"],
        overrides: Partial<CompositionTaskRun> = {},
      ): CompositionTaskRun => ({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.assigneeId,
        runtimeId: `runtime-${input.assigneeId}`,
        status,
        attempt: 1,
        capabilityGrantIds: [],
        ...overrides,
      });
      const taskProjections = new Map(
        children.map((child) => [child.taskId, makeTask(child, "running")] as const),
      );
      const orchestrator: Pick<
        CompositionOrchestrator,
        "dispatchTask" | "retryTask" | "cancelTask"
      > = {
        dispatchTask: (input) => {
          const child = children.find((candidate) => candidate.taskId === input.taskId);
          if (child === undefined) {
            return Effect.succeed({
              task: {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "running" as const,
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              },
              run: {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status: "running" as const,
                attempt: 1,
                capabilityGrantIds: [],
              },
            } satisfies CompositionTaskDispatchResult);
          }
          return Effect.succeed({
            task: makeTask(child, "running"),
            run: makeRun(child, "running"),
          } satisfies CompositionTaskDispatchResult);
        },
        retryTask: () => Effect.die("本测试不应触发重试"),
        cancelTask: ({ taskId, runId }) =>
          Effect.sync(() => {
            cancelled.push(`${taskId}/${runId}`);
            const child = children.find((entry) => entry.taskId === taskId) ?? children[0]!;
            return {
              task: makeTask(child, "cancelled"),
              run: makeRun(child, "cancelled"),
              status: "cancelled" as const,
            };
          }),
      };
      const runtime = {
        awaitTaskCompletion: ({ runId }: { taskId: string; runId: string }) =>
          runId === children[1]!.runId
            ? Effect.succeed(makeRun(children[1]!, "completed")).pipe(
                Effect.tap(() => Deferred.succeed(childBCompleted, undefined)),
              )
            : Deferred.await(childBCompleted).pipe(
                Effect.map(() =>
                  makeRun(children[0]!, "failed", {
                    failureCode: "child_failure",
                    resultSummary: "子任务 A 失败",
                  }),
                ),
              ),
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator,
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(taskProjections.get(taskId))),
        },
        runtime,
      });

      const exit = yield* Effect.exit(
        executor.execute({
          leader: baseLeader,
          children,
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(cancelled).toEqual([]);
    }),
  );

  it.effect("并行失败时记录兄弟任务取消失败", () =>
    Effect.gen(function* () {
      const childBStarted = yield* Deferred.make<void>();
      const children = [
        {
          nodeId: "child-a",
          taskId: "task-a-cancel-failure",
          runId: "run-a-cancel-failure",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-a",
          mode: "parallel" as const,
          promptDigest: "sha256:a-cancel-failure",
          prompt: "任务 A",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "child-b",
          taskId: "task-b-cancel-failure",
          runId: "run-b-cancel-failure",
          projectId: "project-graph",
          assigneeKind: "agent" as const,
          assigneeId: "agent-b",
          mode: "parallel" as const,
          promptDigest: "sha256:b-cancel-failure",
          prompt: "任务 B",
          workspaceRoot: "C:/workspace",
        },
      ];
      const makeTask = (
        input: (typeof children)[number],
        status: CompositionTask["status"],
      ): CompositionTask => ({
        taskId: input.taskId,
        projectId: input.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: input.assigneeKind,
        assigneeId: input.assigneeId,
        mode: input.mode,
        status,
        promptDigest: input.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      const makeRun = (
        input: (typeof children)[number],
        status: CompositionTaskRun["status"],
        overrides: Partial<CompositionTaskRun> = {},
      ): CompositionTaskRun => ({
        runId: input.runId,
        taskId: input.taskId,
        agentId: input.assigneeId,
        runtimeId: `runtime-${input.assigneeId}`,
        status,
        attempt: 1,
        capabilityGrantIds: [],
        ...overrides,
      });
      const taskProjections = new Map(
        children.map((child) => [child.taskId, makeTask(child, "running")] as const),
      );
      const orchestrator: Pick<
        CompositionOrchestrator,
        "dispatchTask" | "retryTask" | "cancelTask"
      > = {
        dispatchTask: (input) => {
          const child = children.find((candidate) => candidate.taskId === input.taskId);
          if (child === undefined) {
            return Effect.succeed({
              task: {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "running" as const,
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              },
              run: {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status: "running" as const,
                attempt: 1,
                capabilityGrantIds: [],
              },
            } satisfies CompositionTaskDispatchResult);
          }
          return Effect.succeed({
            task: makeTask(child, "running"),
            run: makeRun(child, "running"),
          } satisfies CompositionTaskDispatchResult);
        },
        retryTask: () => Effect.die("本测试不应触发重试"),
        cancelTask: ({ taskId, runId }) =>
          taskId === children[1]!.taskId && runId === children[1]!.runId
            ? Effect.fail(
                new CompositionAgentDriverFailure({
                  code: "cancel_failed",
                  detail: "取消失败",
                }),
              )
            : Effect.sync(() => {
                const child = children.find((entry) => entry.taskId === taskId) ?? children[0]!;
                return {
                  task: makeTask(child, "cancelled"),
                  run: makeRun(child, "cancelled"),
                  status: "cancelled" as const,
                };
              }),
      };
      const runtime = {
        awaitTaskCompletion: ({ runId }: { taskId: string; runId: string }) =>
          runId === children[1]!.runId
            ? Deferred.succeed(childBStarted, undefined).pipe(Effect.flatMap(() => Effect.never))
            : Deferred.await(childBStarted).pipe(
                Effect.map(() =>
                  makeRun(children[0]!, "failed", {
                    failureCode: "child_failure",
                    resultSummary: "子任务 A 失败",
                  }),
                ),
              ),
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator,
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(taskProjections.get(taskId))),
        },
        runtime,
      });
      let report: CompositionTaskGraphCancellationReport | undefined;

      const exit = yield* Effect.exit(
        executor.execute(
          {
            leader: baseLeader,
            children,
          },
          {
            onCancellationReceipt: (value) =>
              Effect.sync(() => {
                report = value;
              }),
          },
        ),
      );
      expect(report).toMatchObject({
        trigger: "business_failure",
        receipt: {
          complete: false,
          runs: [
            {
              nodeId: "child-b",
              taskId: "task-b-cancel-failure",
              runId: "run-b-cancel-failure",
              outcome: "cancel_failed",
              failureCode: "cancel_failed",
            },
          ],
        },
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const rendered = Cause.prettyErrors(exit.cause)
          .map((error) => error.message)
          .join("\n");
        expect(rendered).toContain("子任务 A 失败");
        expect(rendered).toContain("取消其他子任务未全部确认终态");
      }
    }),
  );

  it.effect("内置 v1 Executor 在任何派发前发布 cancellation scope ready", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const executor = makeSchedulingExecutor(events);

      expect(executor.cancellationScopeProtocol).toBe("v1");
      yield* executor.execute(
        { leader: baseLeader, children: [] },
        {
          onCancellationScopeReady: () =>
            Effect.sync(() => {
              events.push("scope:ready");
            }),
        },
      );

      expect(events[0]).toBe("scope:ready");
      expect(events).toContain("dispatch:leader-task");
    }),
  );

  it.effect("continue_independent 节点清理不完整时发布 receipt 并组合原失败与清理失败", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "independent-cleanup",
        taskId: "independent-cleanup-task",
        runId: "independent-cleanup-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "independent-agent",
        mode: "parallel",
        promptDigest: "sha256:independent-cleanup",
        prompt: "执行独立节点",
        workspaceRoot: "C:/workspace",
      };
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      let report: CompositionTaskGraphCancellationReport | undefined;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (dispatch) =>
            Effect.sync(() => {
              if (dispatch.taskId === baseLeader.taskId) {
                throw new Error("清理不完整时不应派发 Leader");
              }
              const task: CompositionTask = {
                taskId: dispatch.taskId,
                projectId: dispatch.projectId,
                ...(dispatch.threadId === undefined ? {} : { threadId: dispatch.threadId }),
                ...(dispatch.parentTaskId === undefined
                  ? {}
                  : { parentTaskId: dispatch.parentTaskId }),
                assigneeKind: dispatch.assigneeKind,
                assigneeId: dispatch.assigneeId,
                mode: dispatch.mode,
                status: "running",
                promptDigest: dispatch.promptDigest,
                dependsOnTaskIds: [...dispatch.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: dispatch.runId,
                taskId: dispatch.taskId,
                agentId: dispatch.assigneeId,
                runtimeId: "runtime-independent",
                status: "running",
                attempt: 1,
                capabilityGrantIds: [],
              };
              tasks.set(task.taskId, task);
              runs.set(run.runId, run);
              return { task, run };
            }),
          retryTask: () => Effect.die("独立节点等待失败不应重试"),
          cancelTask: () =>
            Effect.fail(
              new CompositionAgentDriverFailure({
                code: "independent_cancel_failed",
                detail: "sensitive independent cancellation detail",
              }),
            ),
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: ({ taskId, runId }) =>
            Effect.fail(
              new CompositionTaskRuntimeWaitError({
                taskId,
                runId,
                reason: "independent runtime wait failed",
              }),
            ),
        },
      });

      const exit = yield* Effect.exit(
        executor.execute(
          {
            leader: baseLeader,
            children: [child],
            failurePolicy: "continue_independent",
          },
          {
            onCancellationReceipt: (value) =>
              Effect.sync(() => {
                report = value;
              }),
          },
        ),
      );

      expect(report).toMatchObject({
        trigger: "business_failure",
        receipt: {
          complete: false,
          runs: [
            {
              nodeId: child.nodeId,
              taskId: child.taskId,
              runId: child.runId,
              outcome: "cancel_failed",
            },
          ],
        },
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const rendered = Cause.prettyErrors(exit.cause)
          .map((error) => error.message)
          .join("\n");
        expect(rendered).toContain("independent runtime wait failed");
        expect(rendered).toContain("取消该节点任务未确认终态");
        expect(rendered).not.toContain("sensitive independent cancellation detail");
      }
    }),
  );

  it.effect("稳定 ID 身份冲突时不取消不属于当前任务图的 Run", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "identity-conflict-child",
        taskId: "identity-conflict-task",
        runId: "identity-conflict-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "expected-agent",
        mode: "parallel",
        promptDigest: "sha256:expected",
        prompt: "执行当前任务图的子任务",
        workspaceRoot: "C:/workspace",
      };
      const foreignTask: CompositionTask = {
        taskId: child.taskId,
        projectId: "foreign-project",
        assigneeKind: "agent",
        assigneeId: "foreign-agent",
        mode: "parallel",
        status: "running",
        promptDigest: "sha256:foreign",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const foreignRun: CompositionTaskRun = {
        runId: child.runId,
        taskId: child.taskId,
        agentId: "foreign-agent",
        runtimeId: "foreign-runtime",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      };
      let cancelCalls = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: () => Effect.die("身份冲突时不应重新派发"),
          retryTask: () => Effect.die("身份冲突测试不应重试"),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return {
                task: { ...foreignTask, status: "cancelled" as const },
                run: { ...foreignRun, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: (taskId) =>
            Effect.succeed(
              taskId === foreignTask.taskId ? Option.some(foreignTask) : Option.none(),
            ),
          getRun: (runId) =>
            Effect.succeed(runId === foreignRun.runId ? Option.some(foreignRun) : Option.none()),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("身份冲突时不应等待任务终态"),
        },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [child] }));

      expect(error).toMatchObject({
        code: "task_graph_identity_conflict",
        nodeId: child.nodeId,
      });
      expect(cancelCalls).toBe(0);
    }),
  );

  it.effect("稳定 ID 模型快照冲突时拒绝复用既有 Run", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "model-snapshot-conflict-child",
        taskId: "model-snapshot-conflict-task",
        runId: "model-snapshot-conflict-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "agent-model-snapshot",
        mode: "parallel",
        promptDigest: "sha256:model-snapshot",
        prompt: "验证模型快照重放身份",
        workspaceRoot: "C:/workspace",
        modelSnapshot: { kind: "runtime_native", modelId: "expected-model" },
      };
      const persistedTask: CompositionTask = {
        taskId: child.taskId,
        projectId: child.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: child.assigneeKind,
        assigneeId: child.assigneeId,
        mode: child.mode,
        status: "running",
        promptDigest: child.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const persistedRun: CompositionTaskRun = {
        runId: child.runId,
        taskId: child.taskId,
        agentId: child.assigneeId,
        runtimeId: "runtime-model-snapshot",
        status: "running",
        attempt: 1,
        modelSnapshot: { kind: "runtime_native", modelId: "other-model" },
        capabilityGrantIds: [],
      };
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: () => Effect.die("模型快照冲突时不应重新派发"),
          retryTask: () => Effect.die("模型快照冲突测试不应重试"),
          cancelTask: () => Effect.die("模型快照冲突时不应取消既有 Run"),
        },
        store: {
          getTask: (taskId) =>
            Effect.succeed(
              taskId === persistedTask.taskId ? Option.some(persistedTask) : Option.none(),
            ),
          getRun: (runId) =>
            Effect.succeed(
              runId === persistedRun.runId ? Option.some(persistedRun) : Option.none(),
            ),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("模型快照冲突时不应等待任务终态"),
        },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [child] }));

      expect(error).toMatchObject({
        code: "task_graph_identity_conflict",
        nodeId: child.nodeId,
      });
    }),
  );

  it.effect("派发成功返回串线身份时在 tracker 升级前拒绝 terminal 与 nonterminal", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "dispatch-response-identity-child",
        taskId: "dispatch-response-identity-task",
        runId: "dispatch-response-identity-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "dispatch-response-agent",
        mode: "parallel",
        promptDigest: "sha256:dispatch-response-identity",
        prompt: "验证派发成功响应的稳定身份",
        workspaceRoot: "C:/workspace",
      };

      for (const status of ["running", "completed"] as const) {
        const foreignTask: CompositionTask = {
          taskId: `${child.taskId}:foreign`,
          projectId: "foreign-project",
          parentTaskId: baseLeader.taskId,
          assigneeKind: "agent",
          assigneeId: "foreign-agent",
          mode: child.mode,
          status,
          promptDigest: "sha256:foreign-dispatch-response",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
          ...(status === "completed" ? { finishedAtUnixMs: 2 } : {}),
        };
        const foreignRun: CompositionTaskRun = {
          runId: `${child.runId}:foreign`,
          taskId: foreignTask.taskId,
          agentId: foreignTask.assigneeId,
          runtimeId: "foreign-dispatch-runtime",
          status,
          attempt: 1,
          capabilityGrantIds: [],
          ...(status === "completed" ? { finishedAtUnixMs: 2, resultSummary: "串线终态结果" } : {}),
        };
        let cancelCalls = 0;
        const executor = makeCompositionTaskGraphExecutor({
          orchestrator: {
            dispatchTask: () => Effect.succeed({ task: foreignTask, run: foreignRun }),
            retryTask: () => Effect.die("派发身份冲突不应进入重试"),
            cancelTask: () =>
              Effect.sync(() => {
                cancelCalls += 1;
                return {
                  task: { ...foreignTask, status: "cancelled" as const },
                  run: { ...foreignRun, status: "cancelled" as const },
                  status: "cancelled" as const,
                };
              }),
          },
          store: {
            getTask: () => Effect.succeed(Option.none<CompositionTask>()),
            getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
          },
          runtime: {
            awaitTaskCompletion: ({ taskId, runId }) =>
              Effect.fail(
                new CompositionTaskRuntimeWaitError({
                  taskId,
                  runId,
                  reason: "串线派发响应不应进入等待",
                }),
              ),
          },
        });

        const error = yield* Effect.flip(
          executor.execute({ leader: baseLeader, children: [child] }),
        );

        expect(error).toMatchObject({
          code: "task_graph_identity_conflict",
          nodeId: child.nodeId,
        });
        expect(cancelCalls).toBe(0);
      }
    }),
  );

  it.effect("重试成功返回串线身份时在 tracker 升级前拒绝 terminal 与 nonterminal", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "retry-response-identity-child",
        taskId: "retry-response-identity-task",
        runId: "retry-response-identity-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "retry-response-agent",
        mode: "parallel",
        promptDigest: "sha256:retry-response-identity",
        prompt: "验证重试成功响应的稳定身份",
        workspaceRoot: "C:/workspace",
        capabilityIds: ["t3.workspace.read_file"],
        maxAttempts: 2,
      };
      const initialTask: CompositionTask = {
        taskId: child.taskId,
        projectId: child.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: child.assigneeKind,
        assigneeId: child.assigneeId,
        mode: child.mode,
        status: "failed",
        promptDigest: child.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      };
      const initialRun: CompositionTaskRun = {
        runId: child.runId,
        taskId: child.taskId,
        agentId: child.assigneeId,
        runtimeId: "retry-response-runtime",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
        failureCode: "provider_network",
        resultSummary: "首次执行发生瞬态网络错误",
        finishedAtUnixMs: 2,
      };

      for (const status of ["running", "completed"] as const) {
        let initialDispatched = false;
        let retryReturned = false;
        let cancelCalls = 0;
        const foreignTask: CompositionTask = {
          ...initialTask,
          taskId: `${child.taskId}:foreign`,
          assigneeId: "foreign-retry-agent",
          status,
          ...(status === "completed" ? { finishedAtUnixMs: 3 } : {}),
        };
        const foreignRun: CompositionTaskRun = {
          runId: `${child.runId}:retry:2:foreign`,
          taskId: foreignTask.taskId,
          agentId: foreignTask.assigneeId,
          runtimeId: "foreign-retry-runtime",
          status,
          attempt: 99,
          capabilityGrantIds: [],
          ...(status === "completed"
            ? { finishedAtUnixMs: 3, resultSummary: "串线重试终态结果" }
            : {}),
        };
        const executor = makeCompositionTaskGraphExecutor({
          orchestrator: {
            dispatchTask: (input) =>
              Effect.sync(() => {
                if (input.taskId !== child.taskId) {
                  throw new Error(`身份冲突前不应派发 Leader：${input.taskId}`);
                }
                initialDispatched = true;
                return { task: initialTask, run: initialRun };
              }),
            retryTask: () =>
              Effect.sync(() => {
                retryReturned = true;
                return { task: foreignTask, run: foreignRun };
              }),
            cancelTask: () =>
              Effect.sync(() => {
                cancelCalls += 1;
                return {
                  task: { ...foreignTask, status: "cancelled" as const },
                  run: { ...foreignRun, status: "cancelled" as const },
                  status: "cancelled" as const,
                };
              }),
          },
          store: {
            getTask: (taskId) =>
              Effect.succeed(
                initialDispatched && !retryReturned && taskId === child.taskId
                  ? Option.some(initialTask)
                  : Option.none<CompositionTask>(),
              ),
            getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
          },
          runtime: {
            awaitTaskCompletion: ({ taskId, runId }) =>
              Effect.fail(
                new CompositionTaskRuntimeWaitError({
                  taskId,
                  runId,
                  reason: "串线重试响应不应进入等待",
                }),
              ),
          },
        });

        const error = yield* Effect.flip(
          executor.execute({ leader: baseLeader, children: [child] }),
        );

        expect(error).toMatchObject({
          code: "task_graph_retry_identity_conflict",
          nodeId: child.nodeId,
        });
        expect(cancelCalls).toBe(0);
      }
    }),
  );

  it.effect("等待子 Run 返回 foreign terminal 时拒绝伪造节点完成", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "await-identity-child",
        taskId: "await-identity-task",
        runId: "await-identity-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "await-identity-agent",
        mode: "parallel",
        promptDigest: "sha256:await-identity",
        prompt: "等待严格绑定当前 Run 的终态",
        workspaceRoot: "C:/workspace",
      };
      const task: CompositionTask = {
        taskId: child.taskId,
        projectId: child.projectId,
        parentTaskId: baseLeader.taskId,
        assigneeKind: child.assigneeKind,
        assigneeId: child.assigneeId,
        mode: child.mode,
        status: "running",
        promptDigest: child.promptDigest,
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run: CompositionTaskRun = {
        runId: child.runId,
        taskId: child.taskId,
        agentId: child.assigneeId,
        runtimeId: "await-identity-runtime",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
      };
      let childDispatched = false;
      let leaderDispatches = 0;
      let cancelCalls = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            input.taskId === child.taskId
              ? Effect.sync(() => {
                  childDispatched = true;
                  return { task, run };
                })
              : Effect.sync(() => {
                  leaderDispatches += 1;
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new CompositionAgentDriverFailure({
                        code: "leader_dispatched_after_foreign_terminal",
                        detail: "foreign terminal 被错误接受后派发了 Leader",
                      }),
                    ),
                  ),
                ),
          retryTask: () => Effect.die("foreign terminal 不应进入重试"),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: (taskId) =>
            Effect.succeed(
              childDispatched && taskId === child.taskId
                ? Option.some(task)
                : Option.none<CompositionTask>(),
            ),
          getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
        },
        runtime: {
          awaitTaskCompletion: () =>
            Effect.succeed({
              ...run,
              runId: `${run.runId}:foreign`,
              taskId: `${run.taskId}:foreign`,
              agentId: "foreign-agent",
              runtimeId: "foreign-runtime",
              status: "completed" as const,
              attempt: 99,
              resultSummary: "串线终态结果",
              finishedAtUnixMs: 2,
            }),
        },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [child] }));

      expect(error).toMatchObject({
        code: "task_graph_run_identity_conflict",
        nodeId: child.nodeId,
      });
      expect(leaderDispatches).toBe(0);
      expect(cancelCalls).toBe(1);
    }),
  );

  it.effect("等待 Leader Run 返回 foreign terminal 时拒绝伪造执行完成", () =>
    Effect.gen(function* () {
      let leaderTask: CompositionTask | undefined;
      let leaderRun: CompositionTaskRun | undefined;
      let leaderDispatched = false;
      let cancelCalls = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              leaderDispatched = true;
              leaderTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "running",
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              leaderRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: "leader-await-runtime",
                status: "running",
                attempt: 1,
                capabilityGrantIds: [],
              };
              return { task: leaderTask, run: leaderRun };
            }),
          retryTask: () => Effect.die("Leader foreign terminal 不应进入重试"),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              return {
                task: { ...leaderTask!, status: "cancelled" as const },
                run: { ...leaderRun!, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: () =>
            leaderDispatched
              ? Effect.fail(
                  new PersistenceSqlError({
                    operation: "load leader after foreign terminal",
                    detail: "foreign terminal 不应进入 Leader 投影读取",
                    cause: new Error("foreign leader terminal accepted"),
                  }),
                )
              : Effect.succeed(Option.none<CompositionTask>()),
          getRun: () => Effect.succeed(Option.none<CompositionTaskRun>()),
        },
        runtime: {
          awaitTaskCompletion: () =>
            Effect.succeed({
              ...leaderRun!,
              runId: `${leaderRun!.runId}:foreign`,
              taskId: `${leaderRun!.taskId}:foreign`,
              agentId: "foreign-leader-agent",
              runtimeId: "foreign-leader-runtime",
              status: "completed" as const,
              attempt: 99,
              resultSummary: "串线 Leader 终态结果",
              finishedAtUnixMs: 2,
            }),
        },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [] }));

      expect(error).toMatchObject({
        code: "task_graph_run_identity_conflict",
        nodeId: "leader",
      });
      expect(cancelCalls).toBe(1);
    }),
  );

  it.effect("派生重试 Run ID 碰撞时保留并取消原活动兄弟节点", () =>
    Effect.gen(function* () {
      const activeStarted = yield* Deferred.make<void>();
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const children: CompositionTaskGraphExecutionInput["children"] = [
        {
          nodeId: "run-id-collision-active",
          taskId: "run-id-collision-active-task",
          runId: "run-id-collision-base:retry:2",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "run-id-collision-active-agent",
          mode: "parallel",
          promptDigest: "sha256:run-id-collision-active",
          prompt: "保持运行直到兄弟节点触发重试",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "run-id-collision-retry",
          taskId: "run-id-collision-retry-task",
          runId: "run-id-collision-base",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "run-id-collision-retry-agent",
          mode: "parallel",
          promptDigest: "sha256:run-id-collision-retry",
          prompt: "失败后尝试生成碰撞的重试 Run ID",
          workspaceRoot: "C:/workspace",
          maxAttempts: 2,
          capabilityIds: ["t3.workspace.read_file"],
        },
      ];
      const cancelled: string[] = [];
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "running",
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status: "running",
                attempt: 1,
                capabilityGrantIds: [],
              };
              tasks.set(task.taskId, task);
              runs.set(run.runId, run);
              return { task, run } satisfies CompositionTaskDispatchResult;
            }),
          retryTask: () => Effect.die("Run ID 碰撞时不应进入重试派发"),
          cancelTask: ({ taskId, runId }) =>
            Effect.sync(() => {
              cancelled.push(`${taskId}/${runId}`);
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: ({ runId }) =>
            runId === children[0]!.runId
              ? Deferred.succeed(activeStarted, undefined).pipe(Effect.flatMap(() => Effect.never))
              : Deferred.await(activeStarted).pipe(
                  Effect.map(() => ({
                    ...runs.get(runId)!,
                    status: "failed" as const,
                    failureCode: "provider_network",
                    resultSummary: "瞬态网络失败，准备重试",
                  })),
                ),
        },
      });

      const error = yield* Effect.flip(
        executor.execute({ leader: baseLeader, children, maxConcurrency: 2 }),
      );

      expect(error).toMatchObject({
        code: "task_graph_run_id_collision",
        nodeId: children[1]!.nodeId,
      });
      expect(cancelled).toEqual([`${children[0]!.taskId}/${children[0]!.runId}`]);
    }),
  );

  it.effect("派发在落库前失败时保留原始错误且不发起取消", () =>
    Effect.gen(function* () {
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "dispatch-failure-child",
        taskId: "dispatch-failure-task",
        runId: "dispatch-failure-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "dispatch-failure-agent",
        mode: "parallel",
        promptDigest: "sha256:dispatch-failure",
        prompt: "验证派发失败错误分类",
        workspaceRoot: "C:/workspace",
      };
      let cancelCalls = 0;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: () =>
            Effect.fail(
              new CompositionAgentDriverFailure({
                code: "dispatch_failed_before_persist",
                detail: "派发在 Task/Run 落库前失败",
              }),
            ),
          retryTask: () => Effect.die("派发失败测试不应重试"),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              throw new Error("不存在的 Run 不应进入取消路径");
            }),
        },
        store: {
          getTask: () => Effect.succeed(Option.none()),
          getRun: () => Effect.succeed(Option.none()),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("派发失败时不应等待任务终态"),
        },
      });

      const error = yield* Effect.flip(executor.execute({ leader: baseLeader, children: [child] }));

      expect(error.code).not.toBe("child_cancel_cleanup_failed");
      expect(error.detail).toContain("派发在 Task/Run 落库前失败");
      expect(cancelCalls).toBe(0);
    }),
  );

  it.effect("普通失败清理中收到中断仍等待同一取消完成且不重复请求", () =>
    Effect.gen(function* () {
      const childBWaiting = yield* Deferred.make<void>();
      const cancelStarted = yield* Deferred.make<void>();
      const cancelRelease = yield* Deferred.make<void>();
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const children: CompositionTaskGraphExecutionInput["children"] = [
        {
          nodeId: "cleanup-interrupt-a",
          taskId: "cleanup-interrupt-task-a",
          runId: "cleanup-interrupt-run-a",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "cleanup-interrupt-agent-a",
          mode: "parallel",
          promptDigest: "sha256:cleanup-interrupt-a",
          prompt: "触发失败清理",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "cleanup-interrupt-b",
          taskId: "cleanup-interrupt-task-b",
          runId: "cleanup-interrupt-run-b",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "cleanup-interrupt-agent-b",
          mode: "parallel",
          promptDigest: "sha256:cleanup-interrupt-b",
          prompt: "等待取消确认",
          workspaceRoot: "C:/workspace",
        },
      ];
      let cancelCalls = 0;
      let cancelCompleted = false;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.sync(() => {
              const task: CompositionTask = {
                taskId: input.taskId,
                projectId: input.projectId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                assigneeKind: input.assigneeKind,
                assigneeId: input.assigneeId,
                mode: input.mode,
                status: "running",
                promptDigest: input.promptDigest,
                dependsOnTaskIds: [...input.dependsOnTaskIds],
                createdAtUnixMs: 1,
                updatedAtUnixMs: 1,
              };
              const run: CompositionTaskRun = {
                runId: input.runId,
                taskId: input.taskId,
                agentId: input.assigneeId,
                runtimeId: `runtime-${input.assigneeId}`,
                status: "running",
                attempt: 1,
                capabilityGrantIds: [],
              };
              tasks.set(task.taskId, task);
              runs.set(run.runId, run);
              return { task, run } satisfies CompositionTaskDispatchResult;
            }),
          retryTask: () => Effect.die("清理中断测试不应重试"),
          cancelTask: ({ taskId, runId }) =>
            Effect.gen(function* () {
              cancelCalls += 1;
              yield* Deferred.succeed(cancelStarted, undefined);
              yield* Deferred.await(cancelRelease);
              cancelCompleted = true;
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: ({ runId }) =>
            runId === children[1]!.runId
              ? Deferred.succeed(childBWaiting, undefined).pipe(Effect.flatMap(() => Effect.never))
              : Deferred.await(childBWaiting).pipe(
                  Effect.map(() => ({
                    ...runs.get(runId)!,
                    status: "failed" as const,
                    failureCode: "worker_failed",
                    resultSummary: "节点 A 失败并触发清理",
                  })),
                ),
        },
        cancelTimeoutMs: 1_000,
      });

      const executionFiber = yield* Effect.forkChild(
        executor.execute({ leader: baseLeader, children }),
      );
      yield* Deferred.await(cancelStarted);
      const interruptFiber = yield* Effect.forkChild(Fiber.interrupt(executionFiber));
      yield* Effect.sleep(20);
      yield* Deferred.succeed(cancelRelease, undefined);
      yield* Fiber.join(interruptFiber);

      expect(cancelCalls).toBe(1);
      expect(cancelCompleted).toBe(true);
    }).pipe(TestClock.withLive),
  );

  it.effect("候选 Run 归属查询与取消共享有界清理预算", () =>
    Effect.gen(function* () {
      const dispatched = yield* Deferred.make<void>();
      const ownershipLookupStarted = yield* Deferred.make<void>();
      const ownershipLookupRelease = yield* Deferred.make<void>();
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const child: CompositionTaskGraphExecutionInput["children"][number] = {
        nodeId: "ownership-timeout-child",
        taskId: "ownership-timeout-task",
        runId: "ownership-timeout-run",
        projectId: "project-graph",
        assigneeKind: "agent",
        assigneeId: "ownership-timeout-agent",
        mode: "parallel",
        promptDigest: "sha256:ownership-timeout",
        prompt: "验证候选 Run 归属查询超时",
        workspaceRoot: "C:/workspace",
      };
      let taskReads = 0;
      let cancelCalls = 0;
      let interruptCompleted = false;
      let receipt: CompositionTaskGraphCancellationReceipt | undefined;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                const task: CompositionTask = {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "running",
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                };
                const run: CompositionTaskRun = {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "running",
                  attempt: 1,
                  capabilityGrantIds: [],
                };
                tasks.set(task.taskId, task);
                runs.set(run.runId, run);
              });
              yield* Deferred.succeed(dispatched, undefined);
              return yield* Effect.never;
            }),
          retryTask: () => Effect.die("归属查询超时测试不应重试"),
          cancelTask: ({ taskId, runId }) =>
            Effect.sync(() => {
              cancelCalls += 1;
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }),
        },
        store: {
          getTask: (taskId) =>
            Effect.suspend(() => {
              taskReads += 1;
              if (taskReads === 1) return Effect.succeed(Option.none<CompositionTask>());
              return Deferred.succeed(ownershipLookupStarted, undefined).pipe(
                Effect.flatMap(() => Deferred.await(ownershipLookupRelease)),
                Effect.as(Option.fromNullishOr(tasks.get(taskId))),
              );
            }),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("派发响应丢失前不应等待任务终态"),
        },
        cancelTimeoutMs: 5,
      });

      const executionFiber = yield* Effect.forkChild(
        executor.execute(
          { leader: baseLeader, children: [child] },
          {
            onInterruptedCancellation: (value) =>
              Effect.sync(() => {
                receipt = value;
              }),
          },
        ),
      );
      yield* Deferred.await(dispatched);
      const interruptFiber = yield* Effect.forkChild(
        Fiber.interrupt(executionFiber).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              interruptCompleted = true;
            }),
          ),
        ),
      );
      yield* Deferred.await(ownershipLookupStarted);
      yield* Effect.sleep(30);
      const completedBeforeRelease = interruptCompleted;
      yield* Deferred.succeed(ownershipLookupRelease, undefined);
      yield* Fiber.join(interruptFiber);
      const exit = yield* Fiber.await(executionFiber);

      expect(completedBeforeRelease).toBe(true);
      expect(cancelCalls).toBe(0);
      expect(receipt).toEqual({
        complete: false,
        runs: [
          {
            nodeId: child.nodeId,
            taskId: child.taskId,
            runId: child.runId,
            outcome: "timeout",
            failureCode: "cancel_timeout",
          },
        ],
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
      }
    }).pipe(TestClock.withLive),
  );

  it.effect("候选 Run 归属查询失败时发布 ownership_unverified 而不是 not_owned", () =>
    Effect.gen(function* () {
      const dispatched = yield* Deferred.make<void>();
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      let taskReads = 0;
      let cancelCalls = 0;
      let receipt: CompositionTaskGraphCancellationReceipt | undefined;
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                tasks.set(input.taskId, {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "running",
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                });
                runs.set(input.runId, {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "running",
                  attempt: 1,
                  capabilityGrantIds: [],
                });
              });
              yield* Deferred.succeed(dispatched, undefined);
              return yield* Effect.never;
            }),
          retryTask: () => Effect.die("归属失败测试不应重试"),
          cancelTask: () =>
            Effect.sync(() => {
              cancelCalls += 1;
              throw new Error("归属未确认时不应取消");
            }),
        },
        store: {
          getTask: (_taskId) =>
            Effect.suspend(() => {
              taskReads += 1;
              return taskReads === 1
                ? Effect.succeed(Option.none<CompositionTask>())
                : Effect.die("sensitive ownership lookup detail");
            }),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: { awaitTaskCompletion: () => Effect.die("归属未确认时不应等待终态") },
      });
      const fiber = yield* Effect.forkChild(
        executor.execute(
          { leader: baseLeader, children: [] },
          {
            onInterruptedCancellation: (value) =>
              Effect.sync(() => {
                receipt = value;
              }),
          },
        ),
      );

      yield* Deferred.await(dispatched);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(cancelCalls).toBe(0);
      expect(receipt).toEqual({
        complete: false,
        runs: [
          {
            nodeId: "leader",
            taskId: baseLeader.taskId,
            runId: baseLeader.runId,
            outcome: "ownership_unverified",
            failureCode: "ownership_lookup_failed",
          },
        ],
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
        expect(Cause.pretty(exit.cause)).not.toContain("sensitive ownership lookup detail");
      }
    }),
  );

  it.effect("cancel_requested 在预算内确认终态，超时则发布 incomplete receipt", () => {
    const runCase = (confirm: boolean) =>
      Effect.gen(function* () {
        const dispatched = yield* Deferred.make<void>();
        const tasks = new Map<string, CompositionTask>();
        const runs = new Map<string, CompositionTaskRun>();
        let receipt: CompositionTaskGraphCancellationReceipt | undefined;
        const executor = makeCompositionTaskGraphExecutor({
          orchestrator: {
            dispatchTask: (input) =>
              Effect.gen(function* () {
                yield* Effect.sync(() => {
                  tasks.set(input.taskId, {
                    taskId: input.taskId,
                    projectId: input.projectId,
                    assigneeKind: input.assigneeKind,
                    assigneeId: input.assigneeId,
                    mode: input.mode,
                    status: "running",
                    promptDigest: input.promptDigest,
                    dependsOnTaskIds: [...input.dependsOnTaskIds],
                    createdAtUnixMs: 1,
                    updatedAtUnixMs: 1,
                  });
                  runs.set(input.runId, {
                    runId: input.runId,
                    taskId: input.taskId,
                    agentId: input.assigneeId,
                    runtimeId: `runtime-${input.assigneeId}`,
                    status: "running",
                    attempt: 1,
                    capabilityGrantIds: [],
                  });
                });
                yield* Deferred.succeed(dispatched, undefined);
                return yield* Effect.never;
              }),
            retryTask: () => Effect.die("取消确认测试不应重试"),
            cancelTask: ({ taskId, runId }) =>
              Effect.succeed({
                task: tasks.get(taskId)!,
                run: runs.get(runId)!,
                status: "cancel_requested" as const,
              }),
          },
          store: {
            getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
            getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
          },
          runtime: {
            awaitTaskCompletion: ({ runId }) =>
              confirm
                ? Effect.succeed({ ...runs.get(runId)!, status: "cancelled" as const })
                : Effect.never,
          },
          cancelTimeoutMs: 5,
        });
        const fiber = yield* Effect.forkChild(
          executor.execute(
            { leader: baseLeader, children: [] },
            {
              onInterruptedCancellation: (value) =>
                Effect.sync(() => {
                  receipt = value;
                }),
            },
          ),
        );
        yield* Deferred.await(dispatched);
        yield* Fiber.interrupt(fiber);
        return { exit: yield* Fiber.await(fiber), receipt };
      });

    return Effect.gen(function* () {
      const confirmed = yield* runCase(true);
      expect(confirmed.receipt).toEqual({
        complete: true,
        runs: [
          {
            nodeId: "leader",
            taskId: baseLeader.taskId,
            runId: baseLeader.runId,
            outcome: "terminal",
            terminalStatus: "cancelled",
          },
        ],
      });
      if (confirmed.exit._tag === "Failure") {
        expect(Cause.hasFails(confirmed.exit.cause)).toBe(false);
        expect(Cause.interruptors(confirmed.exit.cause).size).toBeGreaterThan(0);
      }

      const timedOut = yield* runCase(false);
      expect(timedOut.receipt).toEqual({
        complete: false,
        runs: [
          {
            nodeId: "leader",
            taskId: baseLeader.taskId,
            runId: baseLeader.runId,
            outcome: "timeout",
            failureCode: "cancel_timeout",
          },
        ],
      });
      if (timedOut.exit._tag === "Failure") {
        expect(Cause.hasFails(timedOut.exit.cause)).toBe(true);
        expect(Cause.interruptors(timedOut.exit.cause).size).toBeGreaterThan(0);
      }
    }).pipe(TestClock.withLive);
  });

  it.effect("子任务派发已持久化但响应未返回时中断仍会清理全部 Run", () =>
    Effect.gen(function* () {
      const childBDispatched = yield* Deferred.make<void>();
      const cancelled: string[] = [];
      let receipt: CompositionTaskGraphCancellationReceipt | undefined;
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const children: CompositionTaskGraphExecutionInput["children"] = [
        {
          nodeId: "interrupt-child-a",
          taskId: "interrupt-task-a",
          runId: "interrupt-run-a",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "interrupt-agent-a",
          mode: "parallel",
          promptDigest: "sha256:interrupt-a",
          prompt: "持续执行任务 A",
          workspaceRoot: "C:/workspace",
        },
        {
          nodeId: "interrupt-child-b",
          taskId: "interrupt-task-b",
          runId: "interrupt-run-b",
          projectId: "project-graph",
          assigneeKind: "agent",
          assigneeId: "interrupt-agent-b",
          mode: "parallel",
          promptDigest: "sha256:interrupt-b",
          prompt: "持续执行任务 B",
          workspaceRoot: "C:/workspace",
        },
      ];
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.gen(function* () {
              const result = yield* Effect.sync(() => {
                const task: CompositionTask = {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "running",
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                };
                const run: CompositionTaskRun = {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "running",
                  attempt: 1,
                  capabilityGrantIds: [],
                };
                tasks.set(task.taskId, task);
                runs.set(run.runId, run);
                return { task, run } satisfies CompositionTaskDispatchResult;
              });
              if (input.taskId === children[1]!.taskId) {
                yield* Deferred.succeed(childBDispatched, undefined);
                return yield* Effect.never;
              }
              return result;
            }),
          retryTask: () => Effect.die("中断清理测试不应重试"),
          cancelTask: ({ taskId, runId }) => {
            cancelled.push(`${taskId}/${runId}`);
            if (taskId === children[0]!.taskId) {
              return Effect.fail(
                new CompositionAgentDriverFailure({
                  code: "cancel_failed",
                  detail: "第一个子任务取消失败",
                }),
              );
            }
            return Effect.sync(() => {
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            });
          },
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("派发阶段中断前不应等待任务终态"),
        },
      });

      const fiber = yield* Effect.forkChild(
        executor.execute(
          {
            leader: baseLeader,
            children,
            maxConcurrency: 2,
          },
          {
            onInterruptedCancellation: (value) =>
              Effect.sync(() => {
                receipt = value;
              }),
          },
        ),
      );
      yield* Deferred.await(childBDispatched);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(cancelled.sort()).toEqual([
        "interrupt-task-a/interrupt-run-a",
        "interrupt-task-b/interrupt-run-b",
      ]);
      expect(receipt).toEqual({
        complete: false,
        runs: [
          {
            nodeId: "interrupt-child-a",
            taskId: "interrupt-task-a",
            runId: "interrupt-run-a",
            outcome: "cancel_failed",
            failureCode: "cancel_failed",
          },
          {
            nodeId: "interrupt-child-b",
            taskId: "interrupt-task-b",
            runId: "interrupt-run-b",
            outcome: "terminal",
            terminalStatus: "cancelled",
          },
        ],
      });
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasFails(exit.cause)).toBe(true);
        expect(Cause.hasDies(exit.cause)).toBe(false);
        expect(Cause.interruptors(exit.cause).size).toBeGreaterThan(0);
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          code: "child_cancel_cleanup_incomplete",
          detail: "Task Graph 中断清理未确认所有子 Run 已进入终态。",
        });
        expect(Cause.pretty(exit.cause)).not.toContain("第一个子任务取消失败");
      }
    }),
  );

  it.effect("Leader 派发响应丢失时中断会在有界时间内请求取消", () =>
    Effect.gen(function* () {
      const leaderDispatched = yield* Deferred.make<void>();
      const cancelled: string[] = [];
      let cancelCompleted = false;
      const tasks = new Map<string, CompositionTask>();
      const runs = new Map<string, CompositionTaskRun>();
      const executor = makeCompositionTaskGraphExecutor({
        orchestrator: {
          dispatchTask: (input) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                const task: CompositionTask = {
                  taskId: input.taskId,
                  projectId: input.projectId,
                  assigneeKind: input.assigneeKind,
                  assigneeId: input.assigneeId,
                  mode: input.mode,
                  status: "running",
                  promptDigest: input.promptDigest,
                  dependsOnTaskIds: [...input.dependsOnTaskIds],
                  createdAtUnixMs: 1,
                  updatedAtUnixMs: 1,
                };
                const run: CompositionTaskRun = {
                  runId: input.runId,
                  taskId: input.taskId,
                  agentId: input.assigneeId,
                  runtimeId: `runtime-${input.assigneeId}`,
                  status: "running",
                  attempt: 1,
                  capabilityGrantIds: [],
                };
                tasks.set(task.taskId, task);
                runs.set(run.runId, run);
              });
              yield* Deferred.succeed(leaderDispatched, undefined);
              return yield* Effect.never;
            }),
          retryTask: () => Effect.die("Leader 中断清理测试不应重试"),
          cancelTask: ({ taskId, runId }) =>
            Effect.sync(() => {
              cancelled.push(`${taskId}/${runId}`);
              const task = tasks.get(taskId)!;
              const run = runs.get(runId)!;
              return {
                task: { ...task, status: "cancelled" as const },
                run: { ...run, status: "cancelled" as const },
                status: "cancelled" as const,
              };
            }).pipe(
              Effect.flatMap((result) =>
                Effect.sleep(50).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      cancelCompleted = true;
                    }),
                  ),
                  Effect.as(result),
                ),
              ),
            ),
        },
        store: {
          getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
          getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
        },
        runtime: {
          awaitTaskCompletion: () => Effect.die("Leader 派发响应未返回前不应等待终态"),
        },
        cancelTimeoutMs: 5,
      });

      const fiber = yield* Effect.forkChild(executor.execute({ leader: baseLeader, children: [] }));
      yield* Deferred.await(leaderDispatched);
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toEqual(["leader-task/leader-run"]);
      expect(cancelCompleted).toBe(false);
    }).pipe(TestClock.withLive),
  );
});
