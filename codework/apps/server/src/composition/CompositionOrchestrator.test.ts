import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CompositionCapabilityGrant,
  type CompositionTask,
  type CompositionTaskRun,
  type CompositionTaskRunModelSnapshot,
} from "@codework/contracts";

import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
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

// Driver 合同要求 startTask 的错误通道收敛为 CompositionAgentDriverFailure。
const projectDriverEvent = (...args: Parameters<typeof projectCompositionRuntimeEvent>) =>
  projectCompositionRuntimeEvent(...args).pipe(
    Effect.mapError(
      (cause) =>
        new CompositionAgentDriverFailure({
          code: "runtime_event_persist_failed",
          detail: `${cause}`,
        }),
    ),
  );

layer("CompositionOrchestrator", (it) => {
  it.effect("工作区租约在 Driver 派发前原子领取，冲突时不调用 Driver，取消后允许新 Run 接管", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const started: string[] = [];
      yield* driverRegistry.register({
        agentId: "agent-runtime-lease",
        runtimeId: "runtime-lease-owner",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            return { runtimeTaskId: `runtime-${input.run.runId}` };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);
      const dispatch = (taskId: string, runId: string) =>
        orchestrator.dispatchTask({
          taskId,
          runId,
          projectId: "project-runtime-lease",
          assigneeKind: "agent",
          assigneeId: "agent-runtime-lease",
          mode: "serial",
          promptDigest: `sha256:${taskId}`,
          prompt: `执行 ${taskId}`,
          workspaceRoot: "C:/workspace/runtime-lease",
          workspaceRootDigest: "sha256:runtime-lease-workspace",
          capabilityIds: [],
          dependsOnTaskIds: [],
        });

      const first = yield* dispatch("task-runtime-lease-first", "run-runtime-lease-first");
      assert.equal(first.run.leaseId !== undefined, true);
      const firstLease = yield* store.getLease(first.run.leaseId!);
      const blocked = yield* dispatch("task-runtime-lease-blocked", "run-runtime-lease-blocked");

      assert.equal(first.task.status, "running");
      assert.equal(Option.getOrThrow(firstLease).state, "active");
      assert.equal(blocked.task.status, "failed");
      assert.equal(blocked.run.failureCode, "capacity_exceeded");
      assert.deepEqual(started, ["task-runtime-lease-first"]);

      yield* orchestrator.cancelTask({
        taskId: first.task.taskId,
        runId: first.run.runId,
        reason: "交给下一次运行",
      });
      assert.equal(Option.getOrThrow(yield* store.getLease(first.run.leaseId!)).state, "released");

      const successor = yield* dispatch(
        "task-runtime-lease-successor",
        "run-runtime-lease-successor",
      );
      assert.equal(successor.task.status, "running");
      assert.equal(successor.run.leaseId !== first.run.leaseId, true);
      assert.deepEqual(started, ["task-runtime-lease-first", "task-runtime-lease-successor"]);
    }),
  );

  it.effect("Driver 启动失败会释放已领取的工作区租约", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-runtime-lease-failure",
        runtimeId: "runtime-lease-failure",
        startTask: () =>
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "provider_network",
              detail: "Runtime 启动连接失败",
            }),
          ),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-runtime-lease-failure",
        runId: "run-runtime-lease-failure",
        projectId: "project-runtime-lease",
        assigneeKind: "agent",
        assigneeId: "agent-runtime-lease-failure",
        mode: "serial",
        promptDigest: "sha256:runtime-lease-failure",
        workspaceRootDigest: "sha256:runtime-lease-failure-workspace",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "failed");
      assert.equal(result.run.leaseId !== undefined, true);
      assert.equal(Option.getOrThrow(yield* store.getLease(result.run.leaseId!)).state, "released");
    }),
  );

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
            yield* projectDriverEvent(store, driverRegistry, {
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
            yield* projectDriverEvent(store, driverRegistry, {
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
        workspaceRootDigest: "sha256:early-terminal-workspace",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "cancelled");
      assert.equal(result.run.status, "cancelled");
      assert.equal(result.run.runtimeTaskId, "runtime-task-early-terminal");
      assert.equal(result.run.leaseId !== undefined, true);
      assert.equal(Option.getOrThrow(yield* store.getLease(result.run.leaseId!)).state, "released");
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
            yield* projectDriverEvent(store, driverRegistry, {
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
  it.effect("旧 Agent 离线时可把失败 Task 重派给新 Agent，并重新签发 grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{
        readonly agentId: string;
        readonly runId: string;
        readonly attempt: number;
        readonly prompt?: string;
        readonly workspaceRoot?: string;
        readonly capabilityGrantIds: ReadonlyArray<string>;
      }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-replacement",
        runtimeId: "runtime-replacement",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              agentId: input.run.agentId,
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
      const issueCalls: Array<{
        readonly agentId: string;
        readonly capabilityIds: ReadonlyArray<string>;
      }> = [];
      const revokedGrantIds: Array<string> = [];
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: ({ agentId, capabilityIds }) =>
            Effect.sync(() => {
              issueCalls.push({ agentId, capabilityIds: [...capabilityIds] });
              return [
                {
                  grantId: "grant-retry-2",
                  taskId: "task-retry",
                  agentId,
                  capabilityId: "t3.workspace.read_file",
                  issuedAtUnixMs: 10,
                  expiresAtUnixMs: 1000,
                },
              ];
            }),
          revoke: ({ grantId }) =>
            Effect.sync(() => {
              revokedGrantIds.push(grantId);
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
        agentId: "agent-replacement",
        reason: "已修复审核反馈",
        capabilityIds: ["t3.workspace.read_file"],
      });

      assert.equal(result.task.status, "running");
      assert.equal(result.task.assigneeId, "agent-replacement");
      assert.equal(result.run.runId, "run-retry-2");
      assert.equal(result.run.agentId, "agent-replacement");
      assert.equal(result.run.attempt, 2);
      assert.equal(result.run.runtimeTaskId, "runtime-task-retry-2");
      assert.deepEqual(issueCalls, [
        {
          agentId: "agent-replacement",
          capabilityIds: ["t3.workspace.read_file"],
        },
      ]);
      assert.deepEqual(revokedGrantIds, ["grant-old-revoked"]);
      assert.deepEqual(started, [
        {
          agentId: "agent-replacement",
          runId: "run-retry-2",
          attempt: 2,
          prompt: "继续修复审核反馈",
          workspaceRoot: "C:/workspace/retry",
          capabilityGrantIds: ["grant-retry-2"],
        },
      ]);
      assert.equal((yield* store.getRun("run-old")).pipe(Option.getOrThrow).status, "failed");
      const retryEvents = yield* store.listEvents("task-retry", "run-retry-2");
      assert.equal(
        retryEvents.some(
          (event) =>
            event.summary.includes("agent-retry") && event.summary.includes("agent-replacement"),
        ),
        true,
      );
    }),
  );
  it.effect("既有 queued retry Run 恢复时复用原 Run 与 grant 并启动 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{
        readonly runId: string;
        readonly capabilityGrantIds: ReadonlyArray<string>;
      }> = [];
      let issueCalls = 0;
      const revokedGrantIds: Array<string> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-retry-queued",
        runtimeId: "runtime-retry-queued",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              runId: input.run.runId,
              capabilityGrantIds: [...(input.capabilityGrantIds ?? [])],
            });
            return { runtimeTaskId: "runtime-task-retry-queued" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () => {
            issueCalls += 1;
            return Effect.succeed([]);
          },
          revoke: ({ grantId }) => Effect.sync(() => revokedGrantIds.push(grantId)),
        },
        {
          save: () => Effect.void,
          get: () =>
            Effect.succeed(
              Option.some({
                taskId: "task-retry-queued",
                prompt: "恢复已持久化但尚未启动的重试",
                workspaceRoot: "C:/workspace/retry-queued",
                workspaceRootDigest: "sha256:retry-queued-workspace",
              }),
            ),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-retry-queued",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry-queued",
        mode: "serial",
        status: "queued",
        promptDigest: "sha256:retry-queued",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 3,
      });
      yield* store.upsertRun({
        taskId: "task-retry-queued",
        runId: "run-retry-queued-old",
        agentId: "agent-retry-queued",
        runtimeId: "runtime-retry-queued",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-retry-queued-old"],
        failureCode: "goal_loop_interrupted",
      });
      yield* store.upsertRun({
        taskId: "task-retry-queued",
        runId: "run-retry-queued-new",
        agentId: "agent-retry-queued",
        runtimeId: "runtime-retry-queued",
        status: "queued",
        attempt: 2,
        capabilityGrantIds: ["grant-retry-queued-stable"],
      });

      const retryInput = {
        taskId: "task-retry-queued",
        previousRunId: "run-retry-queued-old",
        runId: "run-retry-queued-new",
        reason: "恢复 queued retry Run",
        capabilityIds: ["t3.workspace.read_file"],
      } as const;
      const unexecutedRetry = orchestrator.retryTask(retryInput);
      assert.isDefined(unexecutedRetry);
      const result = yield* orchestrator.retryTask(retryInput);

      assert.equal(result.task.status, "running");
      assert.equal(result.run.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-retry-queued");
      assert.isDefined(result.run.leaseId);
      assert.deepEqual(started, [
        {
          runId: "run-retry-queued-new",
          capabilityGrantIds: ["grant-retry-queued-stable"],
        },
      ]);
      assert.equal(issueCalls, 0);
      assert.deepEqual(revokedGrantIds, []);
    }),
  );
  it.effect("相同 retry 并发进入 queued 启动窗口时只调用一次 Driver", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      let startCalls = 0;
      let issueCalls = 0;
      const revokedGrantIds: Array<string> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-retry-concurrent",
        runtimeId: "runtime-retry-concurrent",
        startTask: () =>
          Effect.gen(function* () {
            startCalls += 1;
            if (startCalls === 1) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            return { runtimeTaskId: `runtime-task-retry-concurrent-${startCalls}` };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () => {
            issueCalls += 1;
            return Effect.succeed([
              {
                grantId: "grant-retry-concurrent-new",
                taskId: "task-retry-concurrent",
                agentId: "agent-retry-concurrent",
                capabilityId: "t3.workspace.read_file",
                issuedAtUnixMs: 1,
                expiresAtUnixMs: 10_000,
              },
            ]);
          },
          revoke: ({ grantId }) => Effect.sync(() => revokedGrantIds.push(grantId)),
        },
        {
          save: () => Effect.void,
          get: () =>
            Effect.succeed(
              Option.some({
                taskId: "task-retry-concurrent",
                prompt: "并发恢复重试",
                workspaceRoot: "C:/workspace/retry-concurrent",
              }),
            ),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-retry-concurrent",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-retry-concurrent",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:retry-concurrent",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-retry-concurrent",
        runId: "run-retry-concurrent-old",
        agentId: "agent-retry-concurrent",
        runtimeId: "runtime-retry-concurrent",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-retry-concurrent-old"],
      });
      const retry = () =>
        orchestrator.retryTask({
          taskId: "task-retry-concurrent",
          previousRunId: "run-retry-concurrent-old",
          runId: "run-retry-concurrent-new",
          reason: "验证并发启动门",
          capabilityIds: ["t3.workspace.read_file"],
        });

      const first = yield* Effect.forkChild(retry());
      yield* Deferred.await(firstStarted);
      const concurrent = yield* Effect.result(retry());
      yield* Deferred.succeed(releaseFirst, undefined);
      const completed = yield* Fiber.join(first);

      assert.equal(completed.run.status, "running");
      assert.equal(concurrent._tag, "Failure");
      if (concurrent._tag === "Failure") {
        assert.equal(concurrent.failure._tag, "CompositionTaskRetryInvalidError");
        if (concurrent.failure._tag === "CompositionTaskRetryInvalidError") {
          assert.equal(concurrent.failure.reason, "retry_dispatch_in_progress");
        }
      }
      assert.equal(startCalls, 1);
      assert.equal(issueCalls, 1);
      assert.deepEqual(revokedGrantIds, ["grant-retry-concurrent-old"]);
    }),
  );
  it.effect("目标 Agent 不可用时拒绝重派且不回退旧 Agent", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      let oldAgentStartCalls = 0;
      const revokedGrantIds: Array<string> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-old-online",
        runtimeId: "runtime-old-online",
        startTask: () =>
          Effect.sync(() => {
            oldAgentStartCalls += 1;
            return { runtimeTaskId: "must-not-start" };
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const orchestrator = makeCompositionOrchestrator(
        store,
        driverRegistry,
        {
          issue: () => Effect.die("目标 Agent 不可用时不应签发 grant"),
          revoke: ({ grantId }) => Effect.sync(() => revokedGrantIds.push(grantId)),
        },
        {
          save: () => Effect.void,
          get: () =>
            Effect.succeed(
              Option.some({
                taskId: "task-reassign-unavailable",
                prompt: "不得回退旧 Agent",
                workspaceRoot: "C:/workspace/reassign-unavailable",
              }),
            ),
          remove: () => Effect.void,
        },
      );
      yield* store.upsertTask({
        taskId: "task-reassign-unavailable",
        projectId: "project-retry",
        assigneeKind: "agent",
        assigneeId: "agent-old-online",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:reassign-unavailable",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
        finishedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        taskId: "task-reassign-unavailable",
        runId: "run-reassign-unavailable-old",
        agentId: "agent-old-online",
        runtimeId: "runtime-old-online",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-old-still-valid"],
      });

      const error = yield* Effect.flip(
        orchestrator.retryTask({
          taskId: "task-reassign-unavailable",
          previousRunId: "run-reassign-unavailable-old",
          runId: "run-reassign-unavailable-new",
          agentId: "agent-target-offline",
          reason: "显式验证目标不可用",
          capabilityIds: ["t3.workspace.read_file"],
        }),
      );

      if (error._tag !== "CompositionAgentDriverFailure") {
        assert.fail(`预期目标 Driver 不可用错误，实际为 ${error._tag}`);
      }
      assert.equal(error.code, "agent_driver_unavailable");
      assert.equal(oldAgentStartCalls, 0);
      assert.deepEqual(revokedGrantIds, []);
      assert.isTrue(Option.isNone(yield* store.getRun("run-reassign-unavailable-new")));
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
        idempotencyKey: "run-squad-multica",
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
        modelSnapshot: {
          kind: "byok",
          providerInstanceId: "byok-retry",
          adapterId: "adapter-retry",
          modelId: "model-retry",
          adapterConfigDigest: "sha256:adapter-retry",
        },
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
      assert.deepEqual(result.run.modelSnapshot, {
        kind: "byok",
        providerInstanceId: "byok-retry",
        adapterId: "adapter-retry",
        modelId: "model-retry",
        adapterConfigDigest: "sha256:adapter-retry",
      });
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
      const modelSnapshots: Array<CompositionTaskRunModelSnapshot | undefined> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-1",
        runtimeId: "runtime-1",
        startTask: (input) =>
          Effect.sync(() => {
            started.push(input.task.taskId);
            modelSnapshots.push(input.run.modelSnapshot);
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
        modelSnapshot: { kind: "runtime_native", modelId: "runtime-model-1" },
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.deepEqual(started, ["task-1"]);
      assert.deepEqual(modelSnapshots, [{ kind: "runtime_native", modelId: "runtime-model-1" }]);
      assert.equal(result.task.status, "running");
      assert.equal(result.run.runtimeTaskId, "runtime-task-1");
      assert.deepEqual(result.run.modelSnapshot, {
        kind: "runtime_native",
        modelId: "runtime-model-1",
      });
      assert.deepEqual(
        Option.getOrThrow(yield* store.getRun("run-1")).modelSnapshot,
        result.run.modelSnapshot,
      );
      const events = yield* store.listEvents("task-1", "run-1");
      assert.deepEqual(
        events.map((event) => event.status),
        ["queued", "running"],
      );
    }),
  );
  it.effect("初次派发空 capabilityIds 时不创建 Capability Grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-without-capabilities",
        runtimeId: "runtime-without-capabilities",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-without-capabilities" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      let issueCalls = 0;
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, {
        issue: () =>
          Effect.sync(() => {
            issueCalls += 1;
            return [];
          }),
      });

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-without-capabilities",
        runId: "run-without-capabilities",
        projectId: "project-without-capabilities",
        assigneeKind: "agent",
        assigneeId: "agent-without-capabilities",
        mode: "serial",
        promptDigest: "sha256:without-capabilities",
        capabilityIds: [],
        dependsOnTaskIds: [],
      });

      assert.equal(issueCalls, 0);
      assert.deepEqual(result.run.capabilityGrantIds, []);
    }),
  );

  it.effect("按 Squad 的 Leader Agent Driver 执行，并保留 Squad 任务归属", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const startedBy: string[] = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* store.upsertSquad({
        squadId: "squad-leader-driver",
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
        assigneeId: "squad-leader-driver",
        mode: "parallel",
        promptDigest: "sha256:squad",
        dependsOnTaskIds: [],
      });

      assert.deepEqual(startedBy, ["agent-leader"]);
      assert.equal(result.task.assigneeId, "squad-leader-driver");
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
        workspaceRootDigest: "sha256:cancel-requested-workspace",
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
      assert.equal(result.run.leaseId !== undefined, true);
      assert.equal(Option.getOrThrow(yield* store.getLease(result.run.leaseId!)).state, "active");
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
        readonly capabilityIds?: ReadonlyArray<string>;
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
        capabilityIds: ["t3.workspace.read_file"],
      });

      assert.equal(result.task.promptDigest, "sha256:recovery");
      assert.deepEqual(persisted, [
        {
          taskId: "task-recovery",
          prompt: "恢复这次任务并继续执行",
          workspaceRoot: "C:/workspace/recovery",
          workspaceRootDigest: "sha256:workspace-recovery",
          model: "provider/model",
          capabilityIds: [],
        },
      ]);
    }),
  );

  it.effect("依赖完成后恢复有持久化输入的 blocked task", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const started: Array<{
        readonly taskId: string;
        readonly prompt?: string;
        readonly modelSnapshot?: CompositionTaskRunModelSnapshot;
      }> = [];
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-resume",
        runtimeId: "runtime-resume",
        startTask: (input) =>
          Effect.sync(() => {
            started.push({
              taskId: input.task.taskId,
              ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
              ...(input.run.modelSnapshot === undefined
                ? {}
                : { modelSnapshot: input.run.modelSnapshot }),
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
        modelSnapshot: { kind: "legacy", modelId: "legacy-resume-model" },
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

      assert.deepEqual(started, [
        {
          taskId: "task-resume",
          prompt: "继续执行恢复任务",
          modelSnapshot: { kind: "legacy", modelId: "legacy-resume-model" },
        },
      ]);
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
        readonly leaseId?: string;
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
              ...(input.run.leaseId === undefined ? {} : { leaseId: input.run.leaseId }),
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
        leaseId: "lease-runtime-resume-expired",
        status: "running",
        attempt: 3,
        capabilityGrantIds: ["grant-runtime-resume"],
      });
      yield* store.claimLease({
        lease: {
          leaseId: "lease-runtime-resume-expired",
          runtimeId: "runtime-resume",
          taskId: "task-runtime-resume",
          workspaceRootDigest: "sha256:runtime-resume-workspace",
          heartbeatAtUnixMs: 1,
          expiresAtUnixMs: 100,
          state: "active",
        },
        nowUnixMs: 1,
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry);
      yield* TestClock.setTime(1_000);

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
      const recoveredLeaseId = result.run.leaseId;
      if (recoveredLeaseId === undefined) {
        throw new Error("恢复后的 Runtime Run 应关联新租约");
      }
      assert.equal(recoveredLeaseId !== "lease-runtime-resume-expired", true);
      assert.equal(
        Option.getOrThrow(yield* store.getLease("lease-runtime-resume-expired")).state,
        "expired",
      );
      assert.equal(Option.getOrThrow(yield* store.getLease(recoveredLeaseId)).state, "active");
      assert.deepEqual(result.run.capabilityGrantIds, ["grant-runtime-resume"]);
      assert.deepEqual(resumed, [
        {
          taskId: "task-runtime-resume",
          runId: "run-runtime-resume",
          reason: "连接恢复后继续执行",
          leaseId: recoveredLeaseId,
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

  it.effect("grant 下发以幂等事件投影到任务历史", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-grant-projection",
        runtimeId: "runtime-grant-projection",
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-grant-projection" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      const grantRegistry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, grantRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-grant-projection",
        runId: "run-grant-projection",
        projectId: "project-grant-projection",
        assigneeKind: "agent",
        assigneeId: "agent-grant-projection",
        mode: "serial",
        promptDigest: "sha256:grant-projection",
        prompt: "验证 grant 投影",
        workspaceRoot: "C:/workspace/grant-projection",
        capabilityIds: ["t3.workspace.read_file"],
        dependsOnTaskIds: [],
      });

      const events = yield* store.listEvents(result.task.taskId, result.run.runId);
      const issued = events.find((event) => event.sourceEventId?.endsWith(":issued"));
      assert.ok(issued !== undefined);
      assert.equal(
        issued.summary.startsWith(`能力授权已下发（1 项）：t3.workspace.read_file@`),
        true,
      );
    }),
  );
  it.effect("Driver 不可用时在 grant 投影之后继续递增事件序号", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      const grantRegistry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
      });
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, grantRegistry);

      const result = yield* orchestrator.dispatchTask({
        taskId: "task-grant-driver-unavailable",
        runId: "run-grant-driver-unavailable",
        projectId: "project-grant-driver-unavailable",
        assigneeKind: "agent",
        assigneeId: "agent-driver-unavailable",
        mode: "serial",
        promptDigest: "sha256:grant-driver-unavailable",
        prompt: "验证 grant 投影后的 Driver 不可用终态",
        workspaceRoot: "C:/workspace/grant-driver-unavailable",
        capabilityIds: ["t3.workspace.read_file"],
        dependsOnTaskIds: [],
      });

      assert.equal(result.task.status, "failed");
      assert.equal(result.run.failureCode, "agent_driver_unavailable");
      const events = yield* store.listEvents(result.task.taskId, result.run.runId);
      assert.deepEqual(
        events.map((event) => event.sequence),
        [0, 1, 2, 3],
      );
      assert.equal(events[1]?.sourceEventId?.endsWith(":issued"), true);
      assert.equal(events[2]?.sourceEventId?.endsWith(":revoked"), true);
      assert.equal(events[3]?.summary, "Agent Driver 不可用");
    }),
  );
  it.effect("旧 Run 的 grant 撤销在重试时投影为幂等事件", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      let issueCalls = 0;
      const driverRegistry = makeCompositionAgentDriverRegistry();
      yield* driverRegistry.register({
        agentId: "agent-revoke-projection",
        runtimeId: "runtime-revoke-projection",
        startTask: (input) =>
          Effect.succeed({ runtimeTaskId: `runtime-task-${input.run.attempt}` }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });
      // 伪造历史 failed run 及其 grant，重试时会先撤销再签发新 grant。
      yield* store.upsertTask({
        taskId: "task-revoke-projection",
        projectId: "project-revoke-projection",
        assigneeKind: "agent",
        assigneeId: "agent-revoke-projection",
        mode: "serial",
        status: "failed",
        promptDigest: "sha256:revoke-projection",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 2,
      });
      yield* store.upsertRun({
        runId: "run-revoke-old",
        taskId: "task-revoke-projection",
        agentId: "agent-revoke-projection",
        runtimeId: "runtime-revoke-projection",
        status: "failed",
        attempt: 1,
        capabilityGrantIds: ["grant-revoke-old-1"],
        failureCode: "review_rejected",
      });
      const grantRegistry = {
        issue: () => {
          issueCalls += 1;
          return Effect.succeed([
            {
              grantId: `grant-new-${issueCalls}`,
              taskId: "task-revoke-projection",
              agentId: "agent-revoke-projection",
              capabilityId: "t3.workspace.read_file",
              issuedAtUnixMs: 10,
              expiresAtUnixMs: 11_000,
            },
          ]);
        },
        revoke: () => Effect.void,
      };
      const orchestrator = makeCompositionOrchestrator(store, driverRegistry, grantRegistry, {
        save: () => Effect.void,
        get: () =>
          Effect.succeed(
            Option.some({
              taskId: "task-revoke-projection",
              prompt: "重试以验证撤销投影",
              workspaceRoot: "C:/workspace/revoke-projection",
            }),
          ),
        remove: () => Effect.void,
      });

      yield* orchestrator.retryTask({
        taskId: "task-revoke-projection",
        previousRunId: "run-revoke-old",
        runId: "run-revoke-new",
        reason: "回归验证撤销投影",
        capabilityIds: ["t3.workspace.read_file"],
      });

      const oldEvents = yield* store.listEvents("task-revoke-projection", "run-revoke-old");
      const revoked = oldEvents.find((event) => event.sourceEventId?.endsWith(":revoked"));
      assert.ok(revoked !== undefined);
      assert.equal(revoked.summary, "能力授权已撤销（1 项）");
      const newEvents = yield* store.listEvents("task-revoke-projection", "run-revoke-new");
      const issuedAgain = newEvents.find((event) => event.sourceEventId?.endsWith(":issued"));
      assert.ok(issuedAgain !== undefined);
    }),
  );
});
