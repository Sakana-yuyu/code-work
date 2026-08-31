import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  makeSqliteCapabilityGrantRegistry,
  type CapabilityGrantRegistryShape,
} from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { recoverCompositionRunStartCapabilities } from "./CompositionRunStartRecoveryCapabilities.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const makeFixture = (suffix: string, capabilityGrantIds: ReadonlyArray<string> = []) => {
  const task: CompositionTask = {
    taskId: `task-run-start-capabilities-${suffix}`,
    projectId: `project-run-start-capabilities-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-run-start-capabilities-${suffix}`,
    mode: "serial",
    status: "queued",
    promptDigest: `sha256:prompt-run-start-capabilities-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 1,
  };
  const run: CompositionTaskRun = {
    runId: `run-run-start-capabilities-${suffix}`,
    taskId: task.taskId,
    agentId: task.assigneeId,
    runtimeId: `runtime-run-start-capabilities-${suffix}`,
    status: "queued",
    attempt: 1,
    capabilityGrantIds: [...capabilityGrantIds],
  };
  return { task, run };
};

const seedFixture = Effect.fn("seedRunStartRecoveryCapabilitiesFixture")(function* (
  fixture: ReturnType<typeof makeFixture>,
) {
  const store = yield* CompositionTaskStore;
  yield* store.upsertTask(fixture.task);
  yield* store.upsertRun(fixture.run);
  return store;
});

const makeRegistry = (
  sql: SqlClient.SqlClient,
  suffix: string,
  now: () => number,
  capabilityRegistry = makeCompositionCapabilityRegistry(),
): CapabilityGrantRegistryShape => {
  let sequence = 0;
  return makeSqliteCapabilityGrantRegistry({
    sql,
    capabilityRegistry,
    now,
    randomUUID: () => `${suffix}-${++sequence}`,
  });
};

layer("Composition Run Start capability 恢复", (it) => {
  it.effect("复用剩余有效期充足且作用域匹配的 grant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let now = 1000;
      const registry = makeRegistry(sql, "reuse", () => now);
      const fixtureWithoutGrant = makeFixture("reuse");
      const [grant] = yield* registry.issue({
        taskId: fixtureWithoutGrant.task.taskId,
        agentId: fixtureWithoutGrant.run.agentId,
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 500_000,
      });
      assert.isDefined(grant);
      const fixture = {
        ...fixtureWithoutGrant,
        run: { ...fixtureWithoutGrant.run, capabilityGrantIds: [grant.grantId] },
      };
      const store = yield* seedFixture(fixture);

      const result = yield* recoverCompositionRunStartCapabilities(
        { taskStore: store, grantRegistry: registry },
        {
          task: fixture.task,
          run: fixture.run,
          capabilityIds: ["t3.workspace.read_file"],
          purpose: "start",
          nowUnixMs: now,
        },
      );

      assert.equal(result._tag, "Ready");
      if (result._tag !== "Ready") return;
      assert.deepEqual(result.run.capabilityGrantIds, [grant.grantId]);
      assert.isFalse(result.changed);
    }),
  );

  it.effect("首次 start 为过期 grant 签发替代授权并原子更新 Run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let now = 1000;
      const registry = makeRegistry(sql, "replace", () => now);
      const fixtureWithoutGrant = makeFixture("replace");
      const [expired] = yield* registry.issue({
        taskId: fixtureWithoutGrant.task.taskId,
        agentId: fixtureWithoutGrant.run.agentId,
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 1000,
      });
      assert.isDefined(expired);
      const fixture = {
        ...fixtureWithoutGrant,
        run: { ...fixtureWithoutGrant.run, capabilityGrantIds: [expired.grantId] },
      };
      const store = yield* seedFixture(fixture);
      now = 3000;

      const result = yield* recoverCompositionRunStartCapabilities(
        { taskStore: store, grantRegistry: registry },
        {
          task: fixture.task,
          run: fixture.run,
          capabilityIds: ["t3.workspace.read_file"],
          purpose: "start",
          nowUnixMs: now,
        },
      );

      assert.equal(result._tag, "Ready");
      if (result._tag !== "Ready") return;
      assert.isTrue(result.changed);
      assert.notEqual(result.run.capabilityGrantIds[0], expired.grantId);
      assert.deepEqual(
        Option.getOrThrow(yield* store.getRun(fixture.run.runId)).capabilityGrantIds,
        result.run.capabilityGrantIds,
      );
    }),
  );

  it.effect("accepted 的过期 grant 在没有 rebind 契约时进入人工态且不改 Run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let now = 1000;
      const registry = makeRegistry(sql, "accepted", () => now);
      const fixtureWithoutGrant = makeFixture("accepted");
      const [expired] = yield* registry.issue({
        taskId: fixtureWithoutGrant.task.taskId,
        agentId: fixtureWithoutGrant.run.agentId,
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 1000,
      });
      assert.isDefined(expired);
      const fixture = {
        ...fixtureWithoutGrant,
        run: { ...fixtureWithoutGrant.run, capabilityGrantIds: [expired.grantId] },
      };
      const store = yield* seedFixture(fixture);
      now = 3000;

      const result = yield* recoverCompositionRunStartCapabilities(
        { taskStore: store, grantRegistry: registry },
        {
          task: fixture.task,
          run: fixture.run,
          capabilityIds: ["t3.workspace.read_file"],
          purpose: "accepted",
          nowUnixMs: now,
        },
      );

      assert.equal(result._tag, "Manual");
      if (result._tag !== "Manual") return;
      assert.equal(result.code, "run_start_accepted_capability_rebind_required");
      assert.deepEqual(
        Option.getOrThrow(yield* store.getRun(fixture.run.runId)).capabilityGrantIds,
        [expired.grantId],
      );
    }),
  );

  it.effect("scope mismatch 与 capabilityId 伪装 grant 均进入隔离", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = 1000;
      const registry = makeRegistry(sql, "scope", () => now);
      const wrongFixture = makeFixture("scope-source");
      const [wrongGrant] = yield* registry.issue({
        taskId: wrongFixture.task.taskId,
        agentId: wrongFixture.run.agentId,
        capabilityIds: ["t3.workspace.read_file"],
      });
      assert.isDefined(wrongGrant);

      const target = makeFixture("scope-target", [wrongGrant.grantId]);
      const targetStore = yield* seedFixture(target);
      const mismatch = yield* recoverCompositionRunStartCapabilities(
        { taskStore: targetStore, grantRegistry: registry },
        {
          task: target.task,
          run: target.run,
          capabilityIds: ["t3.workspace.read_file"],
          purpose: "start",
          nowUnixMs: now,
        },
      );

      const legacy = makeFixture("legacy-grant", ["t3.workspace.read_file"]);
      const legacyStore = yield* seedFixture(legacy);
      const legacyResult = yield* recoverCompositionRunStartCapabilities(
        { taskStore: legacyStore, grantRegistry: registry },
        {
          task: legacy.task,
          run: legacy.run,
          capabilityIds: ["t3.workspace.read_file"],
          purpose: "start",
          nowUnixMs: now,
        },
      );

      assert.equal(mismatch._tag, "Quarantine");
      assert.equal(legacyResult._tag, "Quarantine");
      if (legacyResult._tag === "Quarantine") {
        assert.equal(legacyResult.code, "run_start_legacy_capability_grant_unsafe");
      }
    }),
  );
});
