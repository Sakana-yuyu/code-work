import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type CompositionTask,
  type CompositionTaskRun,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { projectCompositionRuntimeEvent } from "./CompositionTaskRuntimeProjector.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const task: CompositionTask = {
  taskId: "task-runtime-1",
  projectId: "project-1",
  threadId: "thread-runtime-1",
  assigneeKind: "agent",
  assigneeId: "agent-runtime-1",
  mode: "serial",
  status: "running",
  promptDigest: "sha256:prompt",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const reviewTask: CompositionTask = {
  ...task,
  taskId: "task-runtime-review",
  mode: "review",
};

const run: CompositionTaskRun = {
  runId: "run-runtime-1",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: "runtime-1",
  runtimeTaskId: "runtime-task-1",
  status: "running",
  attempt: 1,
  capabilityGrantIds: [],
  startedAtUnixMs: 2,
};

const reviewRun: CompositionTaskRun = {
  ...run,
  taskId: reviewTask.taskId,
  runId: "run-runtime-review",
};
const runtimeTaskId = "runtime-task-1";

const baseEvent = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-local"),
  threadId: ThreadId.make("thread-runtime-1"),
  turnId: TurnId.make("turn-runtime-1"),
  createdAt: "2026-08-25T00:00:00.000Z",
} as const;

const completionEvent = (eventId: string): ProviderRuntimeEvent => ({
  ...baseEvent,
  eventId: EventId.make(eventId),
  type: "turn.completed",
  payload: { state: "completed" },
});

const multicaCompletionEvent = (
  eventId: string,
  runtimeId: string,
  runtimeTaskId: string,
): ProviderRuntimeEvent => ({
  ...baseEvent,
  eventId: EventId.make(eventId),
  threadId: ThreadId.make(runtimeId),
  type: "task.completed",
  raw: {
    source: "multica.task-event",
    messageType: "task:completed",
    runtimeId,
    runtimeTaskId: RuntimeTaskId.make(runtimeTaskId),
    payload: { task_id: runtimeTaskId },
  },
  payload: {
    taskId: RuntimeTaskId.make(runtimeTaskId),
    status: "completed",
    summary: "Multica 任务已完成",
  },
});

layer("CompositionTaskRuntimeProjector", (it) => {
  it.effect("projects terminal runtime events and ignores duplicate source events", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: task.assigneeId,
        runtimeId: run.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({ taskId: task.taskId, runId: run.runId }),
      });
      yield* store.upsertTask(task);
      yield* store.upsertRun(run);

      const event = completionEvent("provider-event-1");
      let resumeCalls = 0;
      const resumeReadyTasks = () => Effect.sync(() => void (resumeCalls += 1));
      yield* projectCompositionRuntimeEvent(store, registry, event, undefined, resumeReadyTasks);
      yield* projectCompositionRuntimeEvent(store, registry, event, undefined, resumeReadyTasks);

      const loadedTask = yield* store.getTask(task.taskId);
      const loadedRun = yield* store.getRun(run.runId);
      const events = yield* store.listEvents(task.taskId, run.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "completed");
      assert.equal(Option.getOrThrow(loadedRun).status, "completed");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.sourceEventId, "provider-event-1");
      assert.equal(resumeCalls, 1);
    }),
  );

  it.effect("有效 Runtime 事件会持久化 Run 级活动水位", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const activityTask = { ...task, taskId: "task-runtime-activity" };
      const activityRun = {
        ...run,
        taskId: activityTask.taskId,
        runId: "run-runtime-activity",
        runtimeTaskId: "runtime-task-activity",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: activityRun.agentId,
        runtimeId: activityRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: activityRun.runtimeTaskId }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({ taskId: activityTask.taskId, runId: activityRun.runId }),
      });
      yield* store.upsertTask(activityTask);
      yield* store.upsertRun(activityRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-activity"),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(activityRun.runtimeTaskId),
          description: "Runtime 正在执行",
          summary: "Runtime 正在执行",
        },
      });

      const stored = Option.getOrThrow(yield* store.getRun(activityRun.runId));
      const storedTask = Option.getOrThrow(yield* store.getTask(activityTask.taskId));
      assert.equal(typeof stored.lastRuntimeEventAtUnixMs, "number");
      assert.equal(stored.lastRuntimeEventAtUnixMs, storedTask.updatedAtUnixMs);
    }),
  );

  it.effect("重复或终态后的迟到 Runtime 事件不会刷新 Run 活动水位", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const activityTask = { ...task, taskId: "task-runtime-activity-locked" };
      const activityRun = {
        ...run,
        taskId: activityTask.taskId,
        runId: "run-runtime-activity-locked",
        runtimeTaskId: "runtime-task-activity-locked",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: activityRun.agentId,
        runtimeId: activityRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: activityRun.runtimeTaskId }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({ taskId: activityTask.taskId, runId: activityRun.runId }),
      });
      yield* store.upsertTask(activityTask);
      yield* store.upsertRun(activityRun);
      yield* TestClock.setTime(100);
      const progressEvent: ProviderRuntimeEvent = {
        ...baseEvent,
        eventId: EventId.make("provider-event-activity-locked"),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(activityRun.runtimeTaskId),
          description: "Runtime 正在执行",
          summary: "Runtime 正在执行",
        },
      };
      yield* projectCompositionRuntimeEvent(store, registry, progressEvent);
      assert.equal(
        Option.getOrThrow(yield* store.getRun(activityRun.runId)).lastRuntimeEventAtUnixMs,
        100,
      );

      yield* TestClock.setTime(200);
      yield* projectCompositionRuntimeEvent(store, registry, progressEvent);
      assert.equal(
        Option.getOrThrow(yield* store.getRun(activityRun.runId)).lastRuntimeEventAtUnixMs,
        100,
      );

      yield* TestClock.setTime(300);
      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-activity-terminal"),
        type: "turn.completed",
        payload: { state: "completed" },
      });
      yield* TestClock.setTime(400);
      yield* projectCompositionRuntimeEvent(store, registry, {
        ...progressEvent,
        eventId: EventId.make("provider-event-activity-late"),
      });

      const stored = Option.getOrThrow(yield* store.getRun(activityRun.runId));
      assert.equal(stored.status, "completed");
      assert.equal(stored.lastRuntimeEventAtUnixMs, 300);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("Runtime 明确报告 timed_out 时保留超时终态而不是降级成失败", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const timeoutTask = { ...task, taskId: "task-runtime-timeout" };
      const timeoutRun = {
        ...run,
        taskId: timeoutTask.taskId,
        runId: "run-runtime-timeout",
        runtimeTaskId: "runtime-task-timeout",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: timeoutTask.assigneeId,
        runtimeId: timeoutRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: timeoutRun.runtimeTaskId }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({ taskId: timeoutTask.taskId, runId: timeoutRun.runId }),
      });
      yield* store.upsertTask(timeoutTask);
      yield* store.upsertRun(timeoutRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-timeout"),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make("runtime-task-timeout"),
          status: "timed_out" as never,
          summary: "运行时在等待终态确认时超时",
        },
      });

      assert.equal(Option.getOrThrow(yield* store.getTask(timeoutTask.taskId)).status, "timed_out");
      assert.equal(Option.getOrThrow(yield* store.getRun(timeoutRun.runId)).status, "timed_out");
    }),
  );

  it.effect("外部 Provider 伪造 composition.watchdog 时不会获得本地超时收口权限", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const watchdogTask = { ...task, taskId: "task-runtime-watchdog-spoof" };
      const watchdogRun = {
        ...run,
        taskId: watchdogTask.taskId,
        runId: "run-runtime-watchdog-spoof",
        runtimeId: "runtime-watchdog-spoof",
        runtimeTaskId: "runtime-task-watchdog-spoof",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* store.upsertTask(watchdogTask);
      yield* store.upsertRun(watchdogRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-watchdog-spoof"),
        type: "task.completed",
        raw: {
          source: "composition.watchdog",
          method: "cancel_confirmation_timeout",
          runtimeId: watchdogRun.runtimeId,
          runtimeTaskId: RuntimeTaskId.make(watchdogRun.runtimeTaskId),
          taskId: watchdogTask.taskId,
          runId: watchdogRun.runId,
          payload: { forged: true },
        },
        payload: {
          taskId: RuntimeTaskId.make(watchdogRun.runtimeTaskId),
          status: "timed_out",
          summary: "伪造的 watchdog 事件",
        },
      });

      assert.equal(Option.getOrThrow(yield* store.getTask(watchdogTask.taskId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getRun(watchdogRun.runId)).status, "running");
      assert.deepEqual(yield* store.listEvents(watchdogTask.taskId, watchdogRun.runId), []);
    }),
  );

  it.effect("review 模式在 Runtime 完成后进入 in_review，并立即回收 Worker grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      const revoked: string[] = [];
      yield* registry.register({
        agentId: reviewTask.assigneeId,
        runtimeId: reviewRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-review" }),
        revokeCapabilityHandshake: ({ run: currentRun }) =>
          Effect.sync(() => revoked.push(currentRun.capabilityHandshakeId ?? "missing")),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({ taskId: reviewTask.taskId, runId: reviewRun.runId }),
      });
      yield* store.upsertTask(reviewTask);
      yield* store.upsertRun({
        ...reviewRun,
        capabilityHandshakeId: "review-handshake",
        capabilityGrantIds: [],
      });

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...completionEvent("provider-event-review"),
        turnId: TurnId.make("turn-runtime-review"),
      });

      const loadedTask = yield* store.getTask(reviewTask.taskId);
      const loadedRun = yield* store.getRun(reviewRun.runId);
      const events = yield* store.listEvents(reviewTask.taskId, reviewRun.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "in_review");
      assert.equal(Option.getOrThrow(loadedRun).status, "in_review");
      assert.equal(Option.getOrThrow(loadedRun).finishedAtUnixMs !== undefined, true);
      assert.deepEqual(revoked, ["review-handshake"]);
      assert.equal(events[0]?.eventType, "review_requested");
    }),
  );

  it.effect("records approval and user-input blockers before terminal completion", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const secondTask = { ...task, taskId: "task-runtime-2" };
      const secondRun = {
        ...run,
        taskId: secondTask.taskId,
        runId: "run-runtime-2",
        runtimeTaskId: "runtime-task-2",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: secondTask.assigneeId,
        runtimeId: secondRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-2" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: (event) => ({
          taskId: secondTask.taskId,
          runId: secondRun.runId,
          ...(event.turnId === undefined ? {} : { runtimeTaskId: "runtime-task-2" }),
        }),
      });
      yield* store.upsertTask(secondTask);
      yield* store.upsertRun(secondRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-approval"),
        type: "request.opened",
        payload: { requestType: "exec_command_approval", detail: "需要执行命令" },
      });
      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-input"),
        type: "user-input.requested",
        payload: { questions: [] },
      });

      const events = yield* store.listEvents(secondTask.taskId, secondRun.runId);
      assert.deepEqual(
        events.map((event) => [event.eventType, event.status]),
        [
          ["blocker", "waiting_approval"],
          ["blocker", "waiting_input"],
        ],
      );
    }),
  );

  it.effect("首次进入 Runtime 终态时撤销 Run grant，重复事件不改变撤销语义", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      const revokedHandshakes: string[] = [];
      const taskWithGrant = { ...task, taskId: "task-runtime-grant" };
      const grantRegistry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => 1000,
      });
      const [grant] = yield* grantRegistry.issue({
        taskId: taskWithGrant.taskId,
        agentId: taskWithGrant.assigneeId,
        capabilityIds: ["t3.workspace.read_file"],
      });
      if (grant === undefined) throw new Error("测试预期已签发 grant。");
      const runWithGrant = {
        ...run,
        taskId: taskWithGrant.taskId,
        runId: "run-runtime-grant",
        capabilityGrantIds: [grant.grantId],
        capabilityHandshakeId: "handshake-runtime-grant",
      };
      yield* registry.register({
        agentId: taskWithGrant.assigneeId,
        runtimeId: runWithGrant.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId }),
        revokeCapabilityHandshake: ({ run }) =>
          Effect.sync(() => {
            if (run.capabilityHandshakeId !== undefined) {
              revokedHandshakes.push(run.capabilityHandshakeId);
            }
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({
          taskId: taskWithGrant.taskId,
          runId: runWithGrant.runId,
        }),
      });
      yield* store.upsertTask(taskWithGrant);
      yield* store.upsertRun(runWithGrant);

      const event = completionEvent("provider-event-grant");
      yield* projectCompositionRuntimeEvent(store, registry, event, grantRegistry);
      yield* projectCompositionRuntimeEvent(store, registry, event, grantRegistry);

      const revoked = yield* Effect.flip(
        grantRegistry.validate({
          grantId: grant.grantId,
          taskId: taskWithGrant.taskId,
          agentId: taskWithGrant.assigneeId,
          capabilityId: "t3.workspace.read_file",
        }),
      );
      assert.equal(revoked._tag, "CapabilityGrantRevokedError");
      assert.deepEqual(revokedHandshakes, ["handshake-runtime-grant"]);
      assert.equal((yield* store.listEvents(taskWithGrant.taskId, runWithGrant.runId)).length, 1);
    }),
  );

  it.effect("并发重复终态事件只撤销一次 Runtime capability handshake", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const concurrentTask = { ...task, taskId: "task-runtime-concurrent" };
      const concurrentRun = {
        ...run,
        taskId: concurrentTask.taskId,
        runId: "run-runtime-concurrent",
        capabilityHandshakeId: "handshake-runtime-concurrent",
      };
      const revokedHandshakes: string[] = [];
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: concurrentTask.assigneeId,
        runtimeId: concurrentRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-concurrent" }),
        revokeCapabilityHandshake: ({ run: currentRun }) =>
          Effect.sync(() => {
            if (currentRun.capabilityHandshakeId !== undefined) {
              revokedHandshakes.push(currentRun.capabilityHandshakeId);
            }
          }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({
          taskId: concurrentTask.taskId,
          runId: concurrentRun.runId,
        }),
      });
      yield* store.upsertTask(concurrentTask);
      yield* store.upsertRun(concurrentRun);

      const latestRunReadsReached = yield* Deferred.make<void>();
      const releaseLatestRunReads = yield* Deferred.make<void>();
      let latestRunReads = 0;
      const gatedStore = {
        ...store,
        getLatestRun: (taskId: string) =>
          Effect.gen(function* () {
            latestRunReads += 1;
            if (latestRunReads === 2) yield* Deferred.succeed(latestRunReadsReached, undefined);
            yield* Deferred.await(releaseLatestRunReads);
            return yield* store.getLatestRun(taskId);
          }),
      };
      const event = completionEvent("provider-event-concurrent");
      const first = yield* Effect.forkChild(
        projectCompositionRuntimeEvent(gatedStore, registry, event),
      );
      const second = yield* Effect.forkChild(
        projectCompositionRuntimeEvent(gatedStore, registry, event),
      );
      yield* Deferred.await(latestRunReadsReached);
      yield* Deferred.succeed(releaseLatestRunReads, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      assert.deepEqual(revokedHandshakes, ["handshake-runtime-concurrent"]);
      assert.equal((yield* store.listEvents(concurrentTask.taskId, concurrentRun.runId)).length, 1);
    }),
  );

  it.effect("旧 Run 的迟到终态事件只写入旧 Run 审计，不覆盖最新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retriedTask = { ...task, taskId: "task-runtime-retried" };
      const oldRun = {
        ...run,
        taskId: retriedTask.taskId,
        runId: "run-runtime-retried-old",
        runtimeTaskId: "runtime-task-retried-old",
        attempt: 1,
      };
      const latestRun = {
        ...oldRun,
        runId: "run-runtime-retried-latest",
        runtimeTaskId: "runtime-task-retried-latest",
        attempt: 2,
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: retriedTask.assigneeId,
        runtimeId: oldRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: oldRun.runtimeTaskId! }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({
          taskId: retriedTask.taskId,
          runId: oldRun.runId,
          runtimeTaskId: oldRun.runtimeTaskId,
        }),
      });
      yield* store.upsertTask(retriedTask);
      yield* store.upsertRun(oldRun);
      yield* store.upsertRun(latestRun);

      yield* projectCompositionRuntimeEvent(
        store,
        registry,
        completionEvent("provider-event-old-run-late"),
      );

      const loadedTask = yield* store.getTask(retriedTask.taskId);
      const loadedOldRun = yield* store.getRun(oldRun.runId);
      const loadedLatestRun = yield* store.getRun(latestRun.runId);
      const oldRunEvents = yield* store.listEvents(retriedTask.taskId, oldRun.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "running");
      assert.equal(Option.getOrThrow(loadedOldRun).status, "running");
      assert.equal(Option.getOrThrow(loadedLatestRun).status, "running");
      assert.equal(oldRunEvents.length, 1);
      assert.equal(oldRunEvents[0]?.sourceEventId, "provider-event-old-run-late");
    }),
  );

  it.effect("Driver 注销后按持久化 runtime 归属恢复迟到事件，且不触发 Driver 副作用", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const fallbackTask = { ...task, taskId: "task-runtime-fallback" };
      const fallbackRun = {
        ...run,
        taskId: fallbackTask.taskId,
        runId: "run-runtime-fallback",
        runtimeId: "runtime-fallback",
        runtimeTaskId: "runtime-task-fallback",
        capabilityHandshakeId: "handshake-fallback",
      };
      let revokeCalls = 0;
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: fallbackRun.agentId,
        runtimeId: fallbackRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: fallbackRun.runtimeTaskId! }),
        revokeCapabilityHandshake: () => Effect.sync(() => void (revokeCalls += 1)),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => undefined,
      });
      yield* store.upsertTask(fallbackTask);
      yield* store.upsertRun(fallbackRun);
      yield* registry.unregister(fallbackRun.agentId);

      yield* projectCompositionRuntimeEvent(
        store,
        registry,
        multicaCompletionEvent(
          "provider-event-fallback",
          fallbackRun.runtimeId,
          fallbackRun.runtimeTaskId!,
        ),
      );

      const loadedTask = yield* store.getTask(fallbackTask.taskId);
      const loadedRun = yield* store.getRun(fallbackRun.runId);
      const events = yield* store.listEvents(fallbackTask.taskId, fallbackRun.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "completed");
      assert.equal(Option.getOrThrow(loadedRun).status, "completed");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.sourceEventId, "provider-event-fallback");
      assert.equal(revokeCalls, 0);
    }),
  );

  it.effect("持久化 runtime 归属无命中时丢弃事件，不凭 task_id 猜测绑定", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const unknownTask = { ...task, taskId: "task-runtime-unknown-binding" };
      const registry = makeCompositionAgentDriverRegistry();
      yield* store.upsertTask(unknownTask);

      yield* projectCompositionRuntimeEvent(
        store,
        registry,
        multicaCompletionEvent(
          "provider-event-unknown-binding",
          "runtime-unknown-binding",
          unknownTask.taskId,
        ),
      );

      const loadedTask = yield* store.getTask(unknownTask.taskId);
      assert.equal(Option.getOrThrow(loadedTask).status, unknownTask.status);
      assert.deepEqual(yield* store.listEvents(unknownTask.taskId, "run-never-created"), []);
    }),
  );

  it.effect("持久化 runtime 归属多命中时拒绝投影，避免把事件写入不确定的 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const ambiguousTask = { ...task, taskId: "task-runtime-ambiguous-binding" };
      const firstRun = {
        ...run,
        taskId: ambiguousTask.taskId,
        runId: "run-runtime-ambiguous-1",
        runtimeId: "runtime-ambiguous",
        runtimeTaskId: "runtime-task-ambiguous",
        attempt: 1,
      };
      const secondRun = { ...firstRun, runId: "run-runtime-ambiguous-2", attempt: 2 };
      const registry = makeCompositionAgentDriverRegistry();
      yield* store.upsertTask(ambiguousTask);
      yield* store.upsertRun(firstRun);
      yield* store.upsertRun(secondRun);

      yield* projectCompositionRuntimeEvent(
        store,
        registry,
        multicaCompletionEvent(
          "provider-event-ambiguous-binding",
          firstRun.runtimeId,
          firstRun.runtimeTaskId!,
        ),
      );

      assert.equal(Option.getOrThrow(yield* store.getTask(ambiguousTask.taskId)).status, "running");
      assert.deepEqual(yield* store.listEvents(ambiguousTask.taskId, firstRun.runId), []);
      assert.deepEqual(yield* store.listEvents(ambiguousTask.taskId, secondRun.runId), []);
    }),
  );

  it.effect("按持久化归属恢复旧 Run 时仍只追加旧 Run 审计，不覆盖最新 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const retriedTask = { ...task, taskId: "task-runtime-fallback-old-run" };
      const oldRun = {
        ...run,
        taskId: retriedTask.taskId,
        runId: "run-runtime-fallback-old",
        runtimeId: "runtime-fallback-old",
        runtimeTaskId: "runtime-task-fallback-old",
        attempt: 1,
      };
      const latestRun = {
        ...oldRun,
        runId: "run-runtime-fallback-latest",
        runtimeTaskId: "runtime-task-fallback-latest",
        attempt: 2,
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* store.upsertTask(retriedTask);
      yield* store.upsertRun(oldRun);
      yield* store.upsertRun(latestRun);

      yield* projectCompositionRuntimeEvent(
        store,
        registry,
        multicaCompletionEvent(
          "provider-event-fallback-old-run",
          oldRun.runtimeId,
          oldRun.runtimeTaskId!,
        ),
      );

      assert.equal(Option.getOrThrow(yield* store.getTask(retriedTask.taskId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getRun(oldRun.runId)).status, "running");
      assert.equal(Option.getOrThrow(yield* store.getRun(latestRun.runId)).status, "running");
      const oldEvents = yield* store.listEvents(retriedTask.taskId, oldRun.runId);
      assert.equal(oldEvents.length, 1);
      assert.equal(oldEvents[0]?.sourceEventId, "provider-event-fallback-old-run");
    }),
  );

  it.effect("取消、超时和审核锁定后，迟到事件只保留审计而不复活任务", () =>
    Effect.gen(function* () {
      const cases = [
        { suffix: "cancelled", status: "cancelled" as const, eventType: "task.progress" as const },
        { suffix: "timed-out", status: "timed_out" as const, eventType: "task.completed" as const },
        { suffix: "in-review", status: "in_review" as const, eventType: "task.progress" as const },
      ];

      for (const current of cases) {
        const store = yield* CompositionTaskStore;
        const lockedTask = {
          ...task,
          taskId: `task-runtime-locked-${current.suffix}`,
          status: current.status,
        };
        const lockedRun = {
          ...run,
          taskId: lockedTask.taskId,
          runId: `run-runtime-locked-${current.suffix}`,
          runtimeTaskId: `runtime-task-locked-${current.suffix}`,
          status: current.status,
          finishedAtUnixMs: 100,
        };
        const registry = makeCompositionAgentDriverRegistry();
        yield* registry.register({
          agentId: lockedTask.assigneeId,
          runtimeId: lockedRun.runtimeId,
          startTask: () => Effect.succeed({ runtimeTaskId: lockedRun.runtimeTaskId! }),
          cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
          resolveRuntimeEvent: () => ({
            taskId: lockedTask.taskId,
            runId: lockedRun.runId,
            runtimeTaskId: lockedRun.runtimeTaskId,
          }),
        });
        yield* store.upsertTask(lockedTask);
        yield* store.upsertRun(lockedRun);

        const lateEvent: ProviderRuntimeEvent =
          current.eventType === "task.progress"
            ? ({
                ...baseEvent,
                eventId: EventId.make(`provider-event-late-${current.suffix}`),
                type: "task.progress",
                payload: {
                  taskId: RuntimeTaskId.make(lockedRun.runtimeTaskId),
                  description: "迟到进度",
                  summary: "迟到进度",
                },
              } as Extract<ProviderRuntimeEvent, { type: "task.progress" }>)
            : completionEvent(`provider-event-late-${current.suffix}`);
        yield* projectCompositionRuntimeEvent(store, registry, lateEvent);

        const loadedTask = yield* store.getTask(lockedTask.taskId);
        const loadedRun = yield* store.getRun(lockedRun.runId);
        const events = yield* store.listEvents(lockedTask.taskId, lockedRun.runId);
        assert.equal(Option.getOrThrow(loadedTask).status, current.status);
        assert.equal(Option.getOrThrow(loadedRun).status, current.status);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.sourceEventId, `provider-event-late-${current.suffix}`);
      }
    }),
  );

  it.effect("锁定状态收到同状态迟到事件时不刷新投影或覆盖终态结果", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const lockedTask = {
        ...task,
        taskId: "task-runtime-same-state-late",
        status: "completed" as const,
        updatedAtUnixMs: 100,
        finishedAtUnixMs: 100,
      };
      const lockedRun = {
        ...run,
        taskId: lockedTask.taskId,
        runId: "run-runtime-same-state-late",
        status: "completed" as const,
        finishedAtUnixMs: 100,
        resultSummary: "原始终态结果",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: lockedTask.assigneeId,
        runtimeId: lockedRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: lockedRun.runtimeTaskId! }),
        cancelTask: () => Effect.succeed({ status: "already_terminal" as const }),
        resolveRuntimeEvent: () => ({
          taskId: lockedTask.taskId,
          runId: lockedRun.runId,
          runtimeTaskId: lockedRun.runtimeTaskId!,
        }),
      });
      yield* store.upsertTask(lockedTask);
      yield* store.upsertRun(lockedRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...completionEvent("provider-event-same-state-late"),
      });

      const loadedTask = yield* store.getTask(lockedTask.taskId);
      const loadedRun = yield* store.getRun(lockedRun.runId);
      const events = yield* store.listEvents(lockedTask.taskId, lockedRun.runId);
      assert.deepEqual(Option.getOrThrow(loadedTask), lockedTask);
      assert.deepEqual(Option.getOrThrow(loadedRun), lockedRun);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.sourceEventId, "provider-event-same-state-late");
    }),
  );

  it.effect("迟到的启动和进度事件不能让运行中任务倒退或清除当前 blocker", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      const cases = [
        {
          suffix: "running-pending",
          taskStatus: "running" as const,
          runStatus: "running" as const,
          event: {
            ...baseEvent,
            eventId: EventId.make("provider-event-stale-pending"),
            type: "task.progress" as const,
            payload: {
              taskId: RuntimeTaskId.make("runtime-task-stale-pending"),
              status: "pending" as const,
              description: "旧的排队状态",
            },
          },
          expected: "running" as const,
        },
        {
          suffix: "approval-running",
          taskStatus: "waiting_approval" as const,
          runStatus: "waiting_approval" as const,
          event: {
            ...baseEvent,
            eventId: EventId.make("provider-event-stale-approval"),
            type: "task.started" as const,
            payload: {
              taskId: RuntimeTaskId.make("runtime-task-stale-approval"),
              description: "旧的启动事件",
            },
          },
          expected: "waiting_approval" as const,
        },
        {
          suffix: "input-running",
          taskStatus: "waiting_input" as const,
          runStatus: "waiting_input" as const,
          event: {
            ...baseEvent,
            eventId: EventId.make("provider-event-stale-input"),
            type: "task.progress" as const,
            payload: {
              taskId: RuntimeTaskId.make("runtime-task-stale-input"),
              status: "running" as const,
              description: "旧的运行状态",
            },
          },
          expected: "waiting_input" as const,
        },
      ];

      for (const current of cases) {
        const caseId = `stale-${current.suffix}`;
        const currentTask = {
          ...task,
          taskId: `task-runtime-${caseId}`,
          assigneeId: `agent-runtime-${caseId}`,
          status: current.taskStatus,
        };
        const currentRun = {
          ...run,
          taskId: currentTask.taskId,
          runId: `run-runtime-${caseId}`,
          runtimeId: `runtime-${caseId}`,
          runtimeTaskId: `runtime-task-${caseId}`,
          agentId: currentTask.assigneeId,
          status: current.runStatus,
        };
        yield* registry.register({
          agentId: currentTask.assigneeId,
          runtimeId: currentRun.runtimeId,
          startTask: () => Effect.succeed({ runtimeTaskId: currentRun.runtimeTaskId! }),
          cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
          resolveRuntimeEvent: () => ({
            taskId: currentTask.taskId,
            runId: currentRun.runId,
            runtimeTaskId: currentRun.runtimeTaskId,
          }),
        });
        yield* store.upsertTask(currentTask);
        yield* store.upsertRun(currentRun);

        yield* projectCompositionRuntimeEvent(store, registry, {
          ...current.event,
          threadId: ThreadId.make(`thread-${caseId}`),
        });

        assert.equal(
          Option.getOrThrow(yield* store.getTask(currentTask.taskId)).status,
          current.expected,
        );
        assert.equal(
          Option.getOrThrow(yield* store.getRun(currentRun.runId)).status,
          current.expected,
        );
      }
    }),
  );

  it.effect("Multica task:message 只写 message 审计，不推进或伪装成 progress", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const messageTask = { ...task, taskId: "task-runtime-message" };
      const messageRun = {
        ...run,
        taskId: messageTask.taskId,
        runId: "run-runtime-message",
        runtimeTaskId: "multica-task-message",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: messageTask.assigneeId,
        runtimeId: messageRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: messageRun.runtimeTaskId! }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({
          taskId: messageTask.taskId,
          runId: messageRun.runId,
          runtimeTaskId: messageRun.runtimeTaskId,
        }),
      });
      yield* store.upsertTask(messageTask);
      yield* store.upsertRun(messageRun);

      yield* projectCompositionRuntimeEvent(store, registry, {
        ...baseEvent,
        eventId: EventId.make("provider-event-message"),
        type: "task.progress",
        raw: {
          source: "multica.task-event",
          messageType: "task:message",
          payload: { task_id: messageRun.runtimeTaskId, type: "tool_result" },
        },
        payload: {
          taskId: RuntimeTaskId.make(messageRun.runtimeTaskId),
          description: "工具输出",
          summary: "工具输出",
          status: "running",
          messageType: "tool_result",
        },
      });

      const loadedTask = yield* store.getTask(messageTask.taskId);
      const loadedRun = yield* store.getRun(messageRun.runId);
      const events = yield* store.listEvents(messageTask.taskId, messageRun.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "running");
      assert.equal(Option.getOrThrow(loadedRun).status, "running");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.eventType, "message");
      assert.equal(events[0]?.summary, "工具输出");
    }),
  );

  it.effect("Task 投影写入失败时不会留下已抢占但未应用的事件", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const rollbackTask = { ...task, taskId: "task-runtime-rollback" };
      const rollbackRun = {
        ...run,
        taskId: rollbackTask.taskId,
        runId: "run-runtime-rollback",
      };
      const registry = makeCompositionAgentDriverRegistry();
      yield* registry.register({
        agentId: rollbackTask.assigneeId,
        runtimeId: rollbackRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-rollback" }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
        resolveRuntimeEvent: () => ({
          taskId: rollbackTask.taskId,
          runId: rollbackRun.runId,
        }),
      });
      yield* store.upsertTask(rollbackTask);
      yield* store.upsertRun(rollbackRun);

      const failingStore = {
        ...store,
        upsertTask: () => Effect.fail(undefined as never),
      };
      const result = yield* Effect.exit(
        projectCompositionRuntimeEvent(
          failingStore,
          registry,
          completionEvent("provider-event-rollback"),
        ),
      );

      assert.equal(result._tag, "Failure");
      assert.deepEqual(yield* store.listEvents(rollbackTask.taskId, rollbackRun.runId), []);
      assert.equal(
        (yield* store.getTask(rollbackTask.taskId)).pipe(Option.getOrUndefined)?.status,
        "running",
      );
    }),
  );
});
