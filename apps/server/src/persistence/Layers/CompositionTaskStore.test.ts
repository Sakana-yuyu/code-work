import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionTaskStore } from "../Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "./CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

layer("CompositionTaskStore", (it) => {
  it.effect("persists task, run, ordered events, dependency, lease, and squad records", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const task = {
        taskId: "task-1",
        projectId: "project-1",
        assigneeKind: "squad" as const,
        assigneeId: "squad-1",
        mode: "serial" as const,
        status: "queued" as const,
        promptDigest: "sha256:prompt",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run = {
        runId: "run-1",
        taskId: "task-1",
        agentId: "agent-1",
        runtimeId: "runtime-1",
        status: "running" as const,
        attempt: 1,
        startedAtUnixMs: 2,
      };
      const dependency = {
        taskId: "task-1",
        dependsOnTaskId: "task-0",
        condition: "success" as const,
        createdAtUnixMs: 1,
      };
      const lease = {
        leaseId: "lease-1",
        runtimeId: "runtime-1",
        taskId: "task-1",
        workspaceRootDigest: "sha256:workspace",
        heartbeatAtUnixMs: 2,
        expiresAtUnixMs: 100,
        state: "active" as const,
      };
      const squad = {
        squadId: "squad-1",
        name: "主从协同",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-1"],
      };

      yield* store.upsertTask(task);
      yield* store.upsertRun(run);
      yield* store.appendEvent({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        status: "running",
        sequence: 0,
        eventType: "status",
        summary: "任务已启动",
      });
      yield* store.appendEvent({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        status: "completed",
        sequence: 1,
        eventType: "status",
        summary: "任务已完成",
      });
      yield* store.upsertDependency(dependency);
      yield* store.upsertLease(lease);
      yield* store.upsertSquad(squad);

      const loadedTask = yield* store.getTask("task-1");
      const loadedRun = yield* store.getRun("run-1");
      const events = yield* store.listEvents("task-1", "run-1");
      const dependencies = yield* store.listDependencies("task-1");
      const loadedLease = yield* store.getLease("lease-1");
      const loadedSquad = yield* store.getSquad("squad-1");

      assert.ok(Option.isSome(loadedTask));
      assert.equal(Option.getOrThrow(loadedTask).taskId, "task-1");
      assert.ok(Option.isSome(loadedRun));
      assert.equal(Option.getOrThrow(loadedRun).attempt, 1);
      assert.deepEqual(
        events.map((event) => event.sequence),
        [0, 1],
      );
      assert.equal(dependencies[0]?.condition, "success");
      assert.ok(Option.isSome(loadedLease));
      assert.equal(Option.getOrThrow(loadedLease).state, "active");
      assert.ok(Option.isSome(loadedSquad));
      assert.equal(Option.getOrThrow(loadedSquad).leaderAgentId, "agent-leader");
    }),
  );

  it.effect("rejects duplicate event sequence instead of rewriting history", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const event = {
        taskId: "task-duplicate",
        runId: "run-duplicate",
        agentId: "agent-1",
        status: "running" as const,
        sequence: 0,
        eventType: "message" as const,
        summary: "一次事件",
      };

      yield* store.appendEvent(event);
      const result = yield* Effect.result(store.appendEvent({ ...event, summary: "重复事件" }));
      assert.equal(result._tag, "Failure");
    }),
  );
});
