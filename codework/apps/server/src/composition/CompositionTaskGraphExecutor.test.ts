import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  CompositionCapabilityGrant,
  CompositionTaskDispatchResult,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import type { ByokAgentModelDriver } from "./ByokAgentLoop.ts";
import { ByokAgentModelError } from "./ByokAgentLoop.ts";
import { makeCompositionAgentService } from "./CompositionAgentService.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import {
  makeCompositionTaskGraphExecutor,
  type CompositionTaskGraphExecutionInput,
} from "./CompositionTaskGraphExecutor.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import {
  CompositionTaskRuntimeWaitError,
  type CompositionTaskRuntimeUpdate,
} from "./CompositionTaskRuntimeProjectionService.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
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

const makeSchedulingExecutor = (events: string[]) => {
  const tasks = new Map<string, CompositionTask>();
  const runs = new Map<string, CompositionTaskRun>();
  const orchestrator: Pick<CompositionOrchestrator, "dispatchTask" | "retryTask" | "cancelTask"> = {
    dispatchTask: (input) =>
      Effect.sync(() => {
        events.push(`dispatch:${input.taskId}`);
        const terminal = input.taskId === baseLeader.taskId;
        const task: CompositionTask = {
          taskId: input.taskId,
          projectId: input.projectId,
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
    },
    runtime: {
      awaitTaskCompletion: ({ taskId, runId }) =>
        Effect.sync(() => {
          events.push(`settle:${taskId}`);
          const task = tasks.get(taskId)!;
          const run = runs.get(runId)!;
          tasks.set(taskId, { ...task, status: "completed" });
          const completedRun = { ...run, status: "completed" as const };
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

describe("CompositionTaskGraphExecutor", () => {
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

      const error = yield* Effect.flip(
        executor.execute({
          leader: baseLeader,
          children,
        }),
      );
      expect(error).toMatchObject({ code: "child_cancel_cleanup_failed" });
    }),
  );
});
