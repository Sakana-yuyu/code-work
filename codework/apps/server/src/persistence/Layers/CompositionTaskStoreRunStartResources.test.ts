// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CompositionTaskStore } from "../Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "./CompositionTaskStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const taskStoreLayer = it.layer(
  CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeFileTaskStoreLayer = (dbPath: string) =>
  CompositionTaskStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

const makeFixture = (suffix: string, attempt = 1) => {
  const task: CompositionTask = {
    taskId: `task-run-start-resources-${suffix}`,
    projectId: `project-run-start-resources-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-resources-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-resources-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 100,
    updatedAtUnixMs: 100,
  };
  const run: CompositionTaskRun = {
    runId: `run-run-start-resources-${suffix}-${attempt}`,
    taskId: task.taskId,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-resources-${suffix}`,
    status: "queued",
    attempt,
    capabilityGrantIds: ["grant-original"],
    leaseId: "lease-original",
  };
  return { task, run };
};

const seedFixture = Effect.fn("seedRunStartResourcesFixture")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const store = yield* CompositionTaskStore;
  yield* store.upsertTask(fixture.task);
  yield* store.upsertRun(fixture.run);
  return store;
});

const compareAndSet = (
  store: CompositionTaskStore["Service"],
  fixture: ReturnType<typeof makeFixture>,
  nextLeaseId: string,
  nextCapabilityGrantIds: ReadonlyArray<string>,
) =>
  store.compareAndSetRunStartResources({
    task: fixture.task,
    run: fixture.run,
    nextLeaseId,
    nextCapabilityGrantIds,
  });

taskStoreLayer("CompositionTaskStore Run Start 资源 CAS", (it) => {
  it.effect("原子更新 lease 与 grants，并拒绝陈旧 lease 或 grants 快照", () =>
    Effect.gen(function* () {
      const fixture = makeFixture("success");
      const store = yield* seedFixture(fixture);

      const updated = yield* compareAndSet(store, fixture, "lease-next", ["grant-next"]);
      assert.deepEqual(Option.getOrThrow(updated), {
        ...fixture.run,
        capabilityGrantIds: ["grant-next"],
        leaseId: "lease-next",
      });

      const staleLease = yield* compareAndSet(
        store,
        { ...fixture, run: { ...fixture.run, capabilityGrantIds: ["grant-next"] } },
        "lease-stale-winner",
        ["grant-stale-winner"],
      );
      const staleGrants = yield* compareAndSet(
        store,
        {
          ...fixture,
          run: { ...fixture.run, leaseId: "lease-next", capabilityGrantIds: ["grant-stale"] },
        },
        "lease-stale-grants",
        ["grant-stale-grants"],
      );

      assert.isTrue(Option.isNone(staleLease));
      assert.isTrue(Option.isNone(staleGrants));
      assert.deepEqual(Option.getOrThrow(yield* store.getRun(fixture.run.runId)), {
        ...fixture.run,
        capabilityGrantIds: ["grant-next"],
        leaseId: "lease-next",
      });
    }),
  );

  it.effect("拒绝非 queued Task、非最新 Run、取消、receipt 与已结束快照", () =>
    Effect.gen(function* () {
      const taskNotQueued = makeFixture("task-running");
      const notLatest = makeFixture("not-latest");
      const latest = {
        ...makeFixture("not-latest", 2),
        task: notLatest.task,
      };
      const cancelled = makeFixture("cancelled");
      const received = makeFixture("received");
      const finished = makeFixture("finished");
      const store = yield* CompositionTaskStore;

      yield* store.upsertTask({ ...taskNotQueued.task, status: "running" });
      yield* store.upsertRun(taskNotQueued.run);
      yield* store.upsertTask(notLatest.task);
      yield* store.upsertRun(notLatest.run);
      yield* store.upsertRun(latest.run);
      yield* store.upsertTask(cancelled.task);
      yield* store.upsertRun({ ...cancelled.run, cancelRequestedAtUnixMs: 120 });
      yield* store.upsertTask(received.task);
      yield* store.upsertRun({ ...received.run, runtimeTaskId: "runtime-task-received" });
      yield* store.upsertTask(finished.task);
      yield* store.upsertRun({ ...finished.run, finishedAtUnixMs: 130 });

      const results = yield* Effect.all([
        compareAndSet(store, taskNotQueued, "lease-task-running", ["grant-task-running"]),
        compareAndSet(store, notLatest, "lease-not-latest", ["grant-not-latest"]),
        compareAndSet(store, cancelled, "lease-cancelled", ["grant-cancelled"]),
        compareAndSet(store, received, "lease-received", ["grant-received"]),
        compareAndSet(store, finished, "lease-finished", ["grant-finished"]),
      ]);

      assert.isTrue(results.every(Option.isNone));
    }),
  );
});

it.effect("两个 SQLite 连接竞争同一 Run Start 资源快照时只有一个 CAS 赢家", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-run-start-cas-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const fixture = makeFixture("two-connections");

  return Effect.scoped(
    Effect.gen(function* () {
      const contextA = yield* Layer.build(makeFileTaskStoreLayer(dbPath));
      const storeA = Context.get(contextA, CompositionTaskStore);
      yield* storeA.upsertTask(fixture.task);
      yield* storeA.upsertRun(fixture.run);

      const contextB = yield* Layer.build(makeFileTaskStoreLayer(dbPath));
      const storeB = Context.get(contextB, CompositionTaskStore);
      const [winnerA, winnerB] = yield* Effect.all(
        [
          compareAndSet(storeA, fixture, "lease-a", ["grant-a"]),
          compareAndSet(storeB, fixture, "lease-b", ["grant-b"]),
        ],
        { concurrency: "unbounded" },
      );
      const winners = [winnerA, winnerB].filter(Option.isSome);
      const persisted = Option.getOrThrow(yield* storeA.getRun(fixture.run.runId));

      assert.equal(winners.length, 1);
      assert.isTrue(
        (persisted.leaseId === "lease-a" && persisted.capabilityGrantIds?.[0] === "grant-a") ||
          (persisted.leaseId === "lease-b" && persisted.capabilityGrantIds?.[0] === "grant-b"),
      );
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
