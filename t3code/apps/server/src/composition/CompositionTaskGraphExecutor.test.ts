import * as NodeServices from "@effect/platform-node/NodeServices";
import type { CompositionCapabilityGrant } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
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
import { makeCompositionOrchestrator } from "./CompositionOrchestrator.ts";
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

describe("CompositionTaskGraphExecutor", () => {
  it("拒绝循环依赖，而不是进入不可结束的等待", async () => {
    const executor = makeCompositionTaskGraphExecutor({
      orchestrator: {
        dispatchTask: () => Effect.die("不会执行"),
        retryTask: () => Effect.die("不会执行"),
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

    await expect(Effect.runPromise(executor.execute(input))).rejects.toMatchObject({
      code: "dependency_cycle",
    });
  });

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
          const drivers = [
            makeCompositionByokAgentDriver({
              agentId: "agent-a",
              runtimeId: "runtime-a",
              providerInstanceId: "provider-a",
              defaultModel: "model-a",
              agentService,
              listTools: () => Effect.succeed([tool]),
            }),
            makeCompositionByokAgentDriver({
              agentId: "agent-b",
              runtimeId: "runtime-b",
              providerInstanceId: "provider-b",
              defaultModel: "model-b",
              agentService,
              listTools: () => Effect.succeed([tool]),
            }),
            makeCompositionByokAgentDriver({
              agentId: "leader-agent",
              runtimeId: "runtime-leader",
              providerInstanceId: "provider-leader",
              defaultModel: "model-leader",
              agentService,
              listTools: () => Effect.succeed([tool]),
            }),
          ];
          const driverRegistry = makeCompositionAgentDriverRegistry();
          yield* Effect.forEach(drivers, (driver) => driverRegistry.register(driver));
          const store = yield* CompositionTaskStore;
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
});
