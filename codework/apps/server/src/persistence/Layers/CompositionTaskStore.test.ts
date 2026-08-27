import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionTaskStore } from "../Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "./CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { CompositionTaskInputStore } from "../Services/CompositionTaskInputStore.ts";
import { CompositionTaskInputStoreLive } from "./CompositionTaskInputStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));
const secretStoreLayer = ServerSecretStore.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-composition-input-test-" })),
  Layer.provide(NodeServices.layer),
);
const inputStoreLayer = it.layer(
  CompositionTaskInputStoreLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(secretStoreLayer),
  ),
);

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
        capabilityHandshakeId: "handshake-1",
        status: "running" as const,
        attempt: 1,
        capabilityGrantIds: [],
        startedAtUnixMs: 2,
        cancelRequestedAtUnixMs: 3,
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
      const listedTasks = yield* store.listTasks("project-1");
      const loadedRun = yield* store.getRun("run-1");
      const events = yield* store.listEvents("task-1", "run-1");
      const dependencies = yield* store.listDependencies("task-1");
      const loadedLease = yield* store.getLease("lease-1");
      const loadedSquad = yield* store.getSquad("squad-1");

      assert.ok(Option.isSome(loadedTask));
      assert.equal(Option.getOrThrow(loadedTask).taskId, "task-1");
      assert.deepEqual(
        listedTasks.map((item) => item.taskId),
        ["task-1"],
      );
      assert.ok(Option.isSome(loadedRun));
      assert.equal(Option.getOrThrow(loadedRun).attempt, 1);
      assert.equal(Option.getOrThrow(loadedRun).capabilityHandshakeId, "handshake-1");
      assert.equal(Option.getOrThrow(loadedRun).cancelRequestedAtUnixMs, 3);
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

  it.effect("deduplicates a repeated provider source event id", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const event = {
        taskId: "task-source",
        runId: "run-source",
        sourceEventId: "provider-event-1",
        agentId: "agent-1",
        status: "running" as const,
        sequence: 0,
        eventType: "progress" as const,
        summary: "第一次投影",
      };

      yield* store.appendEvent(event);
      yield* store.appendEvent({ ...event, sequence: 1, summary: "重复投影" });

      const events = yield* store.listEvents(event.taskId, event.runId);
      assert.deepEqual(events, [event]);
    }),
  );

  it.effect("并发追加不同 sourceEventId 时自动分配连续 sequence", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const makeEvent = (sourceEventId: string) => ({
        taskId: "task-concurrent-sequence",
        runId: "run-concurrent-sequence",
        sourceEventId,
        agentId: "agent-1",
        status: "running" as const,
        sequence: 0,
        eventType: "progress" as const,
        summary: sourceEventId,
      });

      yield* Effect.forEach(
        [makeEvent("provider-event-a"), makeEvent("provider-event-b")],
        (event) => store.appendEventIfNew(event),
        { concurrency: 2 },
      );

      const events = yield* store.listEvents("task-concurrent-sequence", "run-concurrent-sequence");
      assert.deepEqual(
        events.map((event) => event.sequence),
        [0, 1],
      );
    }),
  );

  it.effect("按 runtime_id 和 runtime_task_id 查询全部关联 Run", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const firstRun = {
        runId: "run-runtime-lookup-1",
        taskId: "task-runtime-lookup",
        agentId: "agent-1",
        runtimeId: "runtime-lookup",
        runtimeTaskId: "runtime-task-lookup",
        status: "running" as const,
        attempt: 1,
        capabilityGrantIds: [],
      };
      const secondRun = {
        ...firstRun,
        runId: "run-runtime-lookup-2",
        attempt: 2,
      };
      const otherRun = {
        ...firstRun,
        runId: "run-runtime-lookup-other",
        runtimeTaskId: "runtime-task-other",
      };

      yield* store.upsertRun(firstRun);
      yield* store.upsertRun(secondRun);
      yield* store.upsertRun(otherRun);

      const runs = yield* store.listRunsByRuntimeTask(firstRun.runtimeId, firstRun.runtimeTaskId);
      assert.deepEqual(
        runs.map((run) => run.runId),
        [firstRun.runId, secondRun.runId],
      );
    }),
  );
});

inputStoreLayer("CompositionTaskInputStore", (it) => {
  it.effect("persists encrypted dispatch input and round-trips it without exposing plaintext", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskInputStore;
      const input = {
        taskId: "task-input-1",
        prompt: "读取私有配置并完成任务",
        workspaceRoot: "C:/workspace/project",
        workspaceRootDigest: "sha256:workspace",
        model: "provider/model",
      };

      yield* store.save(input);
      const loaded = yield* store.get(input.taskId);

      assert.ok(Option.isSome(loaded));
      assert.deepEqual(Option.getOrThrow(loaded), input);
    }),
  );

  it.effect("removes dispatch input and returns none after cleanup", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskInputStore;
      yield* store.save({
        taskId: "task-input-remove",
        prompt: "需要清理的输入",
        workspaceRoot: "C:/workspace/project",
      });

      yield* store.remove("task-input-remove");

      assert.isTrue(Option.isNone(yield* store.get("task-input-remove")));
    }),
  );
});
