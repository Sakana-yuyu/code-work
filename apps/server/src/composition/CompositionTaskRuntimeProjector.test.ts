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
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeCompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
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
      yield* projectCompositionRuntimeEvent(store, registry, event);
      yield* projectCompositionRuntimeEvent(store, registry, event);

      const loadedTask = yield* store.getTask(task.taskId);
      const loadedRun = yield* store.getRun(run.runId);
      const events = yield* store.listEvents(task.taskId, run.runId);
      assert.equal(Option.getOrThrow(loadedTask).status, "completed");
      assert.equal(Option.getOrThrow(loadedRun).status, "completed");
      assert.equal(events.length, 1);
      assert.equal(events[0]?.sourceEventId, "provider-event-1");
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
});
