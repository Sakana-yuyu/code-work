import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CompositionCapabilityGrant,
  type CompositionTask,
  type CompositionTaskRun,
} from "@codework/contracts";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCompositionRuntimeAgentDriver } from "./CompositionRuntimeAgentDriver.ts";
import { makeMulticaDaemonRuntimeAdapter } from "./MulticaDaemonRuntimeAdapter.ts";
import type { MulticaDaemonProtocol } from "./MulticaDaemonProtocol.ts";
import {
  CompositionAgentDriverFailure,
  makeCompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("CompositionOrchestrator", (it) => {
  it.effect("Runtime 启动事件早于 Driver startTask 返回时保留状态并持久化 handshake", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let binding:
        | {
            readonly taskId: string;
            readonly runId: string;
            readonly runtimeTaskId: string;
          }
        | undefined;
      yield* driverRegistry.register({
        agentId: "agent-early-started",
        runtimeId: "runtime-early-started",
        startTask: (input) =>
          Effect.gen(function* () {
            binding = {
              taskId: input.task.taskId,
              runId: input.run.runId,
              runtimeTaskId: "runtime-task-early-started",
            };
            yield* projectCompositionRuntimeEvent(store, driverRegistry, {
              eventId: EventId.make("event-early-started"),
              provider: ProviderDriverKind.make("cursor"),
              providerInstanceId: ProviderInstanceId.make("cursor"),
              threadId: ThreadId.make("thread-early-started"),
              turnId: TurnId.make("turn-early-started"),
              createdAt: "2026-08-27T00:00:00.000Z",
              type: "turn.started",
              payload: {},
            });
            return {
              runtimeTaskId: binding.runtimeTaskId,
              capabilityHandshakeId: "handshake-early-started",
            };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => binding,
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-early-started",
        runId: "run-early-started",
        projectId: "project-early-started",
        assigneeKind: "agent",
        assigneeId: "agent-early-started",
        mode: "serial",
        promptDigest: "sha256:early-started",
        prompt: "运行时已经启动",
        workspaceRoot: "C:/workspace/early-started",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-early-started");
      assert.equal(result.run.capabilityHandshakeId, "handshake-early-started");
    }),
  );
  it.effect("Runtime 在 Driver startTask 返回前终态时不会被回写为 running", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let binding:
        | {
            readonly taskId: string;
            readonly runId: string;
            readonly runtimeTaskId: string;
          }
        | undefined;
      yield* driverRegistry.register({
        agentId: "agent-early-terminal",
        runtimeId: "runtime-early-terminal",
        startTask: (input) =>
          Effect.gen(function* () {
            binding = {
              taskId: input.task.taskId,
              runId: input.run.runId,
              runtimeTaskId: "runtime-task-early-terminal",
            };
            yield* projectCompositionRuntimeEvent(store, driverRegistry, {
              eventId: EventId.make("event-early-terminal"),
              provider: ProviderDriverKind.make("cursor"),
              providerInstanceId: ProviderInstanceId.make("cursor"),
              threadId: ThreadId.make("thread-early-terminal"),
              turnId: TurnId.make("turn-early-terminal"),
              createdAt: "2026-08-27T00:00:00.000Z",
              type: "turn.completed",
              payload: { state: "cancelled" },
            });
            return { runtimeTaskId: binding.runtimeTaskId };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => binding,
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-early-terminal",
        runId: "run-early-terminal",
        projectId: "project-early-terminal",
        assigneeKind: "agent",
        assigneeId: "agent-early-terminal",
        mode: "serial",
        promptDigest: "sha256:early-terminal",
        prompt: "运行时已经结束",
        workspaceRoot: "C:/workspace/early-terminal",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "cancelled");
      assert.equal(result.run.status, "cancelled");
      assert.equal(result.run.runtimeTaskId, "runtime-task-early-terminal");
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-early-terminal")).status,
        "cancelled",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-early-terminal")).status,
        "cancelled",
      );
    }),
  );
  it.effect("Runtime 终态早于 Driver startTask 失败时保留已投影的终态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let binding:
        | {
            readonly taskId: string;
            readonly runId: string;
            readonly runtimeTaskId: string;
          }
        | undefined;
      yield* driverRegistry.register({
        agentId: "agent-early-terminal-failure",
        runtimeId: "runtime-early-terminal-failure",
        startTask: (input) =>
          Effect.gen(function* () {
            binding = {
              taskId: input.task.taskId,
              runId: input.run.runId,
              runtimeTaskId: "runtime-task-early-terminal-failure",
            };
            yield* projectCompositionRuntimeEvent(store, driverRegistry, {
              eventId: EventId.make("event-early-terminal-failure"),
              provider: ProviderDriverKind.make("cursor"),
              providerInstanceId: ProviderInstanceId.make("cursor"),
              threadId: ThreadId.make("thread-early-terminal-failure"),
              turnId: TurnId.make("turn-early-terminal-failure"),
              createdAt: "2026-08-27T00:00:00.000Z",
              type: "turn.completed",
              payload: { state: "cancelled" },
            });
            return yield* new CompositionAgentDriverFailure({
              code: "provider_turn_start_failed",
              detail: "运行时终态后返回启动失败",
            });
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => binding,
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-early-terminal-failure",
        runId: "run-early-terminal-failure",
        projectId: "project-early-terminal-failure",
        assigneeKind: "agent",
        assigneeId: "agent-early-terminal-failure",
        mode: "serial",
        promptDigest: "sha256:early-terminal-failure",
        prompt: "运行时已经结束",
        workspaceRoot: "C:/workspace/early-terminal-failure",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "cancelled");
      assert.equal(result.run.status, "cancelled");
      assert.equal(
        Option.getOrThrow(yield* store.getTask("task-early-terminal-failure")).status,
        "cancelled",
      );
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-early-terminal-failure")).status,
        "cancelled",
      );
    }),
  );
  it.effect("重试失败 Task 时创建新 Run、递增 attempt、恢复输入并重新签发 grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{
        readonly runId: string;
        readonly attempt: number;
        readonly prompt?: string;
        readonly workspaceRoot?: string;
        readonly capabilityGrantIds: ReadonlyArray<string>;
      }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-retry",
        runtimeId: "runtime-retry",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              runId: input.run.runId,
              attempt: input.run.attempt,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
              capabilityGrantIds: [...(input.capabilityGrantIds ?? [])],
            });
            return { runtimeTaskId: "runtime-task-retry-2" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const issueCalls: Array<ReadonlyArray<string>> = [];
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: ({ capabilityIds }) =>
            Effect.sync(() => {
              issueCalls.push([...capabilityIds]);
              return [
                {
                  grantId: "grant-retry-2",
                  taskId: "task-retry",
                  agentId: "agent-retry",
                  capabilityId: "t3.workspace.read_file",
                  issuedAtUnixMs: 10,
                  expiresAtUnixMs: 1000,
                },
              ];
            }),
        },
        {
          save: () => Effect.void,
          get: () =>
            Effect.succeed(
              Option.some({
                taskId: "task-retry",
                prompt: "继续修复审核反馈",
                workspaceRoot: "C:/workspace/retry",
                workspaceRootDigest: "sha256:retry-workspace",
                model: "provider/model",
              }),
            ),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-retry",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry",
        mode: "review",
        status: "failed",
        promptDigest: "sha256:retry-prompt",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 5,
        finishedAtUnixMs: 5,
      });
      yield* store.upsertRun({
        taskId: "task-retry",
        runId: "run-old",
        agentId: "agent-retry",
        runtimeId: "runtime-old",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-old-revoked"],
        failureCode: "review_rejected",
      });

      const result = yield* orchestrator.retryTask({
        taskId: "task-retry",
        previousRunId: "run-old",
        runId: "run-retry-2",
        reason: "已修复审核反馈",
        capabilityIds: ["t3.workspace.read_file"],
      });

      assert.equal(result.task.status, "running");
      assert.equal(result.run.runId, "run-retry-2");
      assert.equal(result.run.attempt, 2);
      assert.equal(result.run.runtimeTaskId, "runtime-task-retry-2");
      assert.deepEqual(issueCalls, [["t3.workspace.read_file"]]);
      assert.deepEqual(started, [
        {
          runId: "run-retry-2",
          attempt: 2,
          prompt: "继续修复审核反馈",
          workspaceRoot: "C:/workspace/retry",
          capabilityGrantIds: ["grant-retry-2"],
        },
      ]);
      assert.equal((yield* store.getRun("run-old")).pipe(Option.getOrThrow).status, "failed");
    }),
  );
  it.effect("Code Work Squad Task 通过 Leader Driver 路由到 Multica 远端 Squad", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      let quickCreateInput: unknown;
      const protocol: MulticaDaemonProtocol = {
        register: () => Effect.die("测试未实现 register"),
        heartbeat: () =>
          Effect.succeed({
            runtimeId: "runtime-1",
            status: "online",
            serverCapabilities: ["rpc-v1", "squad", "leader", "task-graph"],
            runtimeGone: false,
          }),
        claimTask: () => Effect.succeed(null),
        startTask: () => Effect.void,
        reportProgress: () => Effect.void,
        completeTask: () => Effect.void,
        failTask: () => Effect.void,
        acknowledgeCancellation: () => Effect.void,
        getTaskStatus: () => Effect.succeed({ status: "running" }),
        quickCreateTask: (input) =>
          Effect.sync(() => {
            quickCreateInput = input;
            return { taskId: "multica-task-squad-1" };
          }),
      };
      const adapter = makeMulticaDaemonRuntimeAdapter({
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "https://multica.test",
        protocol,
        agents: [
          {
            agentId: "agent-leader",
            runtimeId: "multica:daemon-1:runtime-1",
            status: "online",
            capabilities: ["squad", "leader"],
          },
        ],
        capabilities: ["rpc-v1", "squad", "leader", "task-graph"],
        quickCreateIntentStore: store,
        taskAssigneeRoutes: [
          {
            codeworkAgentId: "agent-leader",
            workspaceId: "workspace-squad",
            multicaSquadId: "remote-squad-1",
          },
        ],
      });
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register(
        makeCompositionRuntimeAgentDriver({ adapter, agentId: "agent-leader" }),
      );
      yield* store.upsertSquad({
        squadId: "squad-1",
        name: "Code Work 协同组",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-leader", "agent-worker"],
      });

      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);
      const result = yield* orchestrator.dispatchTask({
        taskId: "task-squad-multica",
        runId: "run-squad-multica",
        projectId: "project-squad",
        assigneeKind: "squad",
        assigneeId: "squad-1",
        mode: "parallel",
        promptDigest: "sha256:squad-multica",
        prompt: "由 Squad Leader 协调执行",
        workspaceRoot: "C:/workspace/squad",
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.assigneeId, "squad-1");
      assert.equal(result.run.agentId, "agent-leader");
      assert.equal(result.run.runtimeTaskId, "multica-task-squad-1");
      assert.deepEqual(quickCreateInput, {
        workspaceId: "workspace-squad",
        squadId: "remote-squad-1",
        projectId: "project-squad",
        prompt: "由 Squad Leader 协调执行",
      });
    }),
  );
  it.effect("只允许最新失败 Run 重试，并拒绝非失败 Task", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const orchestrator = makeCompositionOrchestrator(store, makeCompositionAgentDriverRegistry());
      yield* store.upsertTask({
        taskId: "task-retry-invalid-status",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:retry-invalid-status",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-retry-invalid-status",
        runId: "run-retry-invalid-status",
        agentId: "agent-retry",
        runtimeId: "runtime-retry",
        status: "completed",
        attempt: 1,
        capabilityGrantIds: [],
      });

      const error = yield* Effect.flip(
        orchestrator.retryTask({
          taskId: "task-retry-invalid-status",
          previousRunId: "run-retry-invalid-status",
          runId: "run-retry-invalid-status-2",
          reason: "不应重试已完成任务",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );
      assert.equal(error._tag, "CompositionTaskRetryInvalidError");
    }),
  );
  it.effect("拒绝不是最新 Run 的 previousRunId 和重复 Run ID", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const orchestrator = makeCompositionOrchestrator(store, makeCompositionAgentDriverRegistry());
      yield* store.upsertTask({
        taskId: "task-retry-conflict",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:retry-conflict",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-retry-conflict",
        runId: "run-retry-conflict-existing",
        agentId: "agent-retry",
        runtimeId: "runtime-retry",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
      });
      yield* store.upsertRun({
        taskId: "task-retry-conflict",
        runId: "run-retry-conflict-latest",
        agentId: "agent-retry",
        runtimeId: "runtime-retry",
        status: "failed",
        attempt: 2,
        capabilityGrantIds: [],
      });

      const staleError = yield* Effect.flip(
        orchestrator.retryTask({
          taskId: "task-retry-conflict",
          previousRunId: "run-retry-conflict-existing",
          runId: "run-retry-conflict-new",
          reason: "旧 Run 不应重试",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );
      assert.equal(staleError._tag, "CompositionTaskRetryInvalidError");

      const duplicateError = yield* Effect.flip(
        orchestrator.retryTask({
          taskId: "task-retry-conflict",
          previousRunId: "run-retry-conflict-latest",
          runId: "run-retry-conflict-existing",
          reason: "新 Run ID 已存在",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );
      assert.equal(duplicateError._tag, "CompositionTaskRetryInvalidError");
    }),
  );
  it.effect("恢复输入缺失时不创建新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const orchestrator = makeCompositionOrchestrator(
        store,
        makeCompositionAgentDriverRegistry(),
        undefined,
        {
          save: () => Effect.void,
          get: () => Effect.succeed(Option.none()),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-retry-no-input",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:retry-no-input",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-retry-no-input",
        runId: "run-retry-no-input",
        agentId: "agent-retry",
        runtimeId: "runtime-retry",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: [],
      });

      const error = yield* Effect.flip(
        orchestrator.retryTask({
          taskId: "task-retry-no-input",
          previousRunId: "run-retry-no-input",
          runId: "run-retry-no-input-2",
          reason: "恢复输入不存在",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );
      assert.equal(error._tag, "CompositionTaskRetryInvalidError");
      assert.isTrue(Option.isNone(yield* store.getRun("run-retry-no-input-2")));
    }),
  );
  it.effect("重试 Driver 启动失败时回收新 grant，并保留旧 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const revoked: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-retry-start-failed",
        runtimeId: "runtime-retry-start-failed",
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "runtime_offline",
              detail: "Runtime 不在线",
            }),
          ),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () =>
            Effect.succeed([
              {
                grantId: "grant-retry-start-failed",
                taskId: "task-retry-start-failed",
                agentId: "agent-retry-start-failed",
                capabilityId: "t3.workspace.read_file",
                issuedAtUnixMs: 1,
                expiresAtUnixMs: 1000,
              },
            ]),
          revoke: ({ grantId }) => Effect.sync(() => revoked.push(grantId)),
        },
        {
          save: () => Effect.void,
          get: () =>
            Effect.succeed(
              Option.some({
                taskId: "task-retry-start-failed",
                prompt: "重试启动失败",
                workspaceRoot: "C:/workspace/retry-start-failed",
              }),
            ),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-retry-start-failed",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry-start-failed",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:retry-start-failed",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-retry-start-failed",
        runId: "run-retry-start-failed-old",
        agentId: "agent-retry-start-failed",
        runtimeId: "runtime-retry-start-failed",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-old-retry-start-failed"],
      });

      const result = yield* orchestrator.retryTask({
        taskId: "task-retry-start-failed",
        previousRunId: "run-retry-start-failed-old",
        runId: "run-retry-start-failed-new",
        reason: "验证启动失败回收",
        capabilityIds: ["t3.workspace.read_file"],
      });
      assert.equal(result.task.status, "failed");
      assert.equal(result.run.status, "failed");
      assert.equal(result.run.failureCode, "runtime_offline");
      assert.deepEqual(revoked, ["grant-old-retry-start-failed", "grant-retry-start-failed"]);
      assert.equal(
        (yield* store.getRun("run-retry-start-failed-old")).pipe(Option.getOrThrow).status,
        "failed",
      );
    }),
  );
  it.effect("review approve/reject 只处理 in_review Task，并分别终结状态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      const orchestrator = makeCompositionOrchestrator(store, registry);
      const reviewTask: CompositionTask = {
        taskId: "task-review-decision",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-review",
        mode: "review",
        status: "in_review",
        promptDigest: "sha256:review",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const reviewRun: CompositionTaskRun = {
        taskId: reviewTask.taskId,
        runId: "run-review-decision",
        agentId: reviewTask.assigneeId,
        runtimeId: "runtime-review",
        status: "in_review",
        attempt: 1,
        capabilityGrantIds: [],
      };
      yield* store.upsertTask(reviewTask);
      yield* store.upsertRun(reviewRun);

      const approved = yield* orchestrator.reviewTask({
        taskId: reviewTask.taskId,
        runId: reviewRun.runId,
        decision: "approve",
        reason: "Reviewer 已确认",
      });
      assert.equal(approved.status, "approved");
      assert.equal(approved.task.status, "completed");
      assert.equal(approved.run.status, "completed");

      const rejectedTask = { ...reviewTask, taskId: "task-review-rejected" };
      const rejectedRun = {
        ...reviewRun,
        taskId: rejectedTask.taskId,
        runId: "run-review-rejected",
      };
      yield* store.upsertTask(rejectedTask);
      yield* store.upsertRun(rejectedRun);
      const rejected = yield* orchestrator.reviewTask({
        taskId: rejectedTask.taskId,
        runId: rejectedRun.runId,
        decision: "reject",
        reason: "缺少测试",
      });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.task.status, "failed");
      assert.equal(rejected.run.status, "failed");
    }),
  );
  it.effect("dispatches a task through its AgentDriver and persists the run lifecycle", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-1",
        runtimeId: "runtime-1",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            return { runtimeTaskId: "runtime-task-1" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-1",
        runId: "run-1",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.deepEqual(started, ["task-1"]);
      assert.equal(result.task.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-1");
      const events = yield* store.listEvents("task-1", "run-1");
      assert.deepEqual(
        events.map((event) => event.status),
        ["queued", "running"],
      );
    }),
  );

  it.effect("按 Squad 的 Leader Agent Driver 执行，并保留 Squad 任务归属", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const startedBy: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* store.upsertSquad({
        squadId: "squad-1",
        name: "代码协同组",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-leader", "agent-worker"],
      });
      yield* driverRegistry.register({
        agentId: "agent-leader",
        runtimeId: "runtime-leader",
        startTask: (input) =>
          Effect.sync(() => {
            startedBy.push(input.run.agentId);
            return { runtimeTaskId: "runtime-task-squad" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-squad",
        runId: "run-squad",
        projectId: "project-1",
        assigneeKind: "squad",
        assigneeId: "squad-1",
        mode: "parallel",
        promptDigest: "sha256:squad",
        dependsOnTaskIds: [],
      });

      assert.deepEqual(startedBy, ["agent-leader"]);
      assert.equal(result.task.assigneeId, "squad-1");
      assert.equal(result.run.agentId, "agent-leader");
      assert.equal(result.run.runtimeId, "runtime-leader");
    }),
  );

  it.effect("为普通 Composition Task 签发 grant，并把 grant ID 持久化和传给 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const captured: string[][] = [];
      const revoked: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-grant",
        runtimeId: "runtime-grant",
        startTask: (input) =>
          Effect.sync(() => {
            captured.push([...(input.capabilityGrantIds ?? [])]);
            return {
              runtimeTaskId: "runtime-task-grant",
              capabilityHandshakeId: "handshake-grant",
            };
          }),
        revokeCapabilityHandshake: ({ run }) =>
          Effect.sync(() => revoked.push(`handshake:${run.capabilityHandshakeId}`)),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const grants: CompositionCapabilityGrant[] = [
        {
          grantId: "grant-1",
          taskId: "task-grant",
          agentId: "agent-grant",
          capabilityId: "workspace.read",
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 900_001,
        },
      ];
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, {
        issue: () => Effect.succeed(grants),
        revoke: ({ grantId }) => Effect.sync(() => revoked.push(grantId)),
      });

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-grant",
        runId: "run-grant",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-grant",
        mode: "serial",
        promptDigest: "sha256:grant",
        capabilityIds: ["workspace.read"],
        dependsOnTaskIds: [],
      });

      assert.deepEqual(result.run.capabilityGrantIds, ["grant-1"]);
      assert.equal(result.run.capabilityHandshakeId, "handshake-grant");
      assert.deepEqual(captured, [["grant-1"]]);
      const savedRun = yield* store.getRun("run-grant");
      assert.isTrue(Option.isSome(savedRun));
      if (Option.isSome(savedRun)) assert.deepEqual(savedRun.value.capabilityGrantIds, ["grant-1"]);
      const cancelled = yield* orchestrator.cancelTask({
        taskId: "task-grant",
        runId: "run-grant",
        reason: "用户取消",
      });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(revoked, ["handshake:handshake-grant", "grant-1"]);
    }),
  );

  it.effect("blocks a dependent task until the dependency reaches a valid terminal state", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      yield* store.upsertTask({
        taskId: "dependency-1",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:dependency",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      const started: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-1",
        runtimeId: "runtime-1",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            return {};
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-blocked",
        runId: "run-blocked",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-1",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: ["dependency-1"],
      });

      assert.equal(result.task.status, "blocked");
      assert.equal(result.run.status, "blocked");
      assert.deepEqual(started, []);
      assert.equal(
        (yield* store.listEvents("task-blocked", "run-blocked"))[0]?.eventType,
        "blocker",
      );
    }),
  );

  it.effect("persists a failed run when its AgentDriver is unavailable", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const orchestrator = makeCompositionOrchestrator(store, makeCompositionAgentDriverRegistry());

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-no-driver",
        runId: "run-no-driver",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "missing-agent",
        mode: "serial",
        promptDigest: "sha256:prompt",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "failed");
      assert.equal(result.run.failureCode, "agent_driver_unavailable");
      assert.equal(
        (yield* store.listEvents("task-no-driver", "run-no-driver")).at(-1)?.status,
        "failed",
      );
    }),
  );

  it.effect("外部只接受取消请求时保留运行状态并追加等待事件", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const revoked: string[] = [];
      const grants: CompositionCapabilityGrant[] = [
        {
          grantId: "grant-cancel-requested",
          taskId: "task-cancel-requested",
          agentId: "agent-cancel-requested",
          capabilityId: "workspace.read",
          issuedAtUnixMs: 1,
          expiresAtUnixMs: 900_001,
        },
      ];
      yield* driverRegistry.register({
        agentId: "agent-cancel-requested",
        runtimeId: "runtime-cancel-requested",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-cancel-requested" }),
        cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);
      const orchestratorWithGrants = makeCompositionOrchestrator(store, driverRegistry, {
        issue: () => Effect.succeed(grants),
        revoke: ({ grantId }) => Effect.sync(() => revoked.push(grantId)),
      });

      yield* orchestratorWithGrants.dispatchTask({
        taskId: "task-cancel-requested",
        runId: "run-cancel-requested",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-cancel-requested",
        mode: "serial",
        promptDigest: "sha256:cancel-requested",
        capabilityIds: ["workspace.read"],
        dependsOnTaskIds: [],
      });

      const result = yield* orchestratorWithGrants.cancelTask({
        taskId: "task-cancel-requested",
        runId: "run-cancel-requested",
        reason: "用户取消",
      });
      assert.equal(result.status, "cancel_requested");
      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.equal(result.run.cancelRequestedAtUnixMs !== undefined, true);
      assert.equal(
        Option.getOrThrow(yield* store.getRun("run-cancel-requested")).cancelRequestedAtUnixMs !==
          undefined,
        true,
      );
      assert.deepEqual(revoked, []);
      assert.equal(
        (yield* store.listEvents("task-cancel-requested", "run-cancel-requested")).at(-1)
          ?.eventType,
        "message",
      );
    }),
  );

  it.effect("外部取消能力失败时不提前修改 Code Work 任务终态", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-cancel-failed",
        runtimeId: "runtime-cancel-failed",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-cancel-failed" }),
        cancelTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "cancel_not_supported",
              detail: "外部 Runtime 未提供取消接口。",
            }),
          ),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      yield* orchestrator.dispatchTask({
        taskId: "task-cancel-failed",
        runId: "run-cancel-failed",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-cancel-failed",
        mode: "serial",
        promptDigest: "sha256:cancel-failed",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      yield* Effect.flip(
        orchestrator.cancelTask({
          taskId: "task-cancel-failed",
          runId: "run-cancel-failed",
          reason: "用户取消",
        }),
      );
      const savedTask = yield* store.getTask("task-cancel-failed");
      assert.isTrue(Option.isSome(savedTask));
      if (Option.isSome(savedTask)) assert.equal(savedTask.value.status, "running");
    }),
  );

  it.effect("持久化可恢复的派发输入而不改变任务摘要投影", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const persisted: Array<{
        readonly taskId: string;
        readonly prompt: string;
        readonly workspaceRoot: string;
        readonly workspaceRootDigest?: string;
        readonly model?: string;
      }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-recovery",
        runtimeId: "runtime-recovery",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-recovery" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, undefined, {
        save: (input) => Effect.sync(() => void persisted.push(input)),
        get: () => Effect.succeed(Option.none()),
        remove: () => Effect.void,
      });

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-recovery",
        runId: "run-recovery",
        projectId: "project-1",
        assigneeKind: "agent",
        assigneeId: "agent-recovery",
        mode: "serial",
        promptDigest: "sha256:recovery",
        dependsOnTaskIds: [],
        prompt: "恢复这次任务并继续执行",
        workspaceRoot: "C:/workspace/recovery",
        workspaceRootDigest: "sha256:workspace-recovery",
        model: "provider/model",
      });

      assert.equal(result.task.promptDigest, "sha256:recovery");
      assert.deepEqual(persisted, [
        {
          taskId: "task-recovery",
          prompt: "恢复这次任务并继续执行",
          workspaceRoot: "C:/workspace/recovery",
          workspaceRootDigest: "sha256:workspace-recovery",
          model: "provider/model",
        },
      ]);
    }),
  );

  it.effect("依赖完成后恢复有持久化输入的 blocked task", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{ readonly taskId: string; readonly prompt?: string }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-resume",
        runtimeId: "runtime-resume",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              taskId: input.task.taskId,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            });
            return { runtimeTaskId: "runtime-task-resumed" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      yield* store.upsertTask({
        taskId: "dependency-resume",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-resume",
        mode: "serial",
        status: "completed",
        promptDigest: "sha256:dependency-resume",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertTask({
        taskId: "task-resume",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-resume",
        mode: "serial",
        status: "blocked",
        promptDigest: "sha256:task-resume",
        dependsOnTaskIds: ["dependency-resume"],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      yield* store.upsertRun({
        taskId: "task-resume",
        runId: "run-resume",
        agentId: "agent-resume",
        runtimeId: "runtime-resume",
        status: "blocked",
        attempt: 1,
        capabilityGrantIds: [],
      });

      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, undefined, {
        save: () => Effect.void,
        get: (taskId) =>
          Effect.succeed(
            taskId === "task-resume"
              ? Option.some({
                  taskId,
                  prompt: "继续执行恢复任务",
                  workspaceRoot: "C:/workspace/resume",
                })
              : Option.none(),
          ),
        remove: () => Effect.void,
      });

      const resumed = yield* orchestrator.resumeReadyTasks();

      assert.deepEqual(started, [{ taskId: "task-resume", prompt: "继续执行恢复任务" }]);
      assert.deepEqual(
        resumed.map((item) => item.task.taskId),
        ["task-resume"],
      );
      assert.equal(resumed[0]?.task.status, "running");
      assert.equal((yield* store.getTask("task-resume")).pipe(Option.getOrThrow).status, "running");
    }),
  );

  it.effect("恢复同一非终态 Run 时保留运行身份和授权", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const resumed: Array<{
        readonly taskId: string;
        readonly runId: string;
        readonly reason: string;
      }> = [];
      yield* driverRegistry.register({
        agentId: "agent-runtime-resume",
        runtimeId: "runtime-resume",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-resume" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resumeTask: (input) =>
          Effect.sync(() => {
            resumed.push({
              taskId: input.task.taskId,
              runId: input.run.runId,
              reason: input.reason,
            });
            return { status: "accepted" as const };
          }),
      });
      yield* store.upsertTask({
        taskId: "task-runtime-resume",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-runtime-resume",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:runtime-resume",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      });
      yield* store.upsertRun({
        taskId: "task-runtime-resume",
        runId: "run-runtime-resume",
        agentId: "agent-runtime-resume",
        runtimeId: "runtime-resume",
        runtimeTaskId: "runtime-task-resume",
        capabilityHandshakeId: "handshake-runtime-resume",
        status: "running",
        attempt: 3,
        capabilityGrantIds: ["grant-runtime-resume"],
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.resumeTask({
        taskId: "task-runtime-resume",
        runId: "run-runtime-resume",
        reason: "连接恢复后继续执行",
      });

      assert.equal(result.status, "accepted");
      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.equal(result.run.runId, "run-runtime-resume");
      assert.equal(result.run.attempt, 3);
      assert.equal(result.run.runtimeTaskId, "runtime-task-resume");
      assert.equal(result.run.capabilityHandshakeId, "handshake-runtime-resume");
      assert.deepEqual(result.run.capabilityGrantIds, ["grant-runtime-resume"]);
      assert.deepEqual(resumed, [
        {
          taskId: "task-runtime-resume",
          runId: "run-runtime-resume",
          reason: "连接恢复后继续执行",
        },
      ]);
      assert.deepEqual(
        (yield* store.listEvents("task-runtime-resume", "run-runtime-resume")).map((event) => [
          event.status,
          event.summary,
        ]),
        [
          ["resuming", "Runtime 已请求恢复：连接恢复后继续执行"],
          ["running", "Runtime 已确认恢复运行"],
        ],
      );
    }),
  );

  it.effect("取消已请求的 Run 不允许恢复且不调用 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      let calls = 0;
      yield* driverRegistry.register({
        agentId: "agent-resume-cancelled",
        runtimeId: "runtime-resume-cancelled",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-resume-cancelled" }),
        cancelTask: () => Effect.succeed({ status: "cancel_requested" as const }),
        resumeTask: () =>
          Effect.sync(() => {
            calls += 1;
            return { status: "accepted" as const };
          }),
      });
      yield* store.upsertTask({
        taskId: "task-resume-cancelled",
        projectId: "project-resume",
        assigneeKind: "agent",
        assigneeId: "agent-resume-cancelled",
        mode: "serial",
        status: "running",
        promptDigest: "sha256:resume-cancelled",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-resume-cancelled",
        runId: "run-resume-cancelled",
        agentId: "agent-resume-cancelled",
        runtimeId: "runtime-resume-cancelled",
        runtimeTaskId: "runtime-task-resume-cancelled",
        status: "running",
        attempt: 1,
        capabilityGrantIds: [],
        cancelRequestedAtUnixMs: 2,
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const exit = yield* Effect.exit(
        orchestrator.resumeTask({
          taskId: "task-resume-cancelled",
          runId: "run-resume-cancelled",
          reason: "不应恢复",
        }),
      );

      assert.equal(exit._tag, "Failure");
      assert.equal(calls, 0);
      assert.equal(
        (yield* store.getTask("task-resume-cancelled")).pipe(Option.getOrThrow).status,
        "running",
      );
      assert.equal(
        (yield* store.getRun("run-resume-cancelled")).pipe(Option.getOrThrow).status,
        "running",
      );
    }),
  );
});
