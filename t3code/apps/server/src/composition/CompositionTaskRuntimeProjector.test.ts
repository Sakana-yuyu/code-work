import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type CompositionTask,
  type CompositionTaskRun,
  type ProviderRuntimeEvent,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

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

  it.effect("review 模式在 Runtime 完成后进入 in_review，并立即回收 Worker grant", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const registry = makeCompositionAgentDriverRegistry();
      const revoked: string[] = [];
      yield* registry.register({
        agentId: reviewTask.assigneeId,
        runtimeId: reviewRun.runtimeId,
        startTask: () => Effect.succeed({ runtimeTaskId: reviewRun.runtimeTaskId }),
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
});
