import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
  it.effect("按归档状态列出 Squad，并保持稳定的更新时间顺序", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const makeSquad = (squadId: string, updatedAtUnixMs: number, archivedAtUnixMs?: number) => ({
        squadId,
        name: `协同组 ${squadId}`,
        leaderAgentId: `leader-${squadId}`,
        memberAgentIds: [`leader-${squadId}`],
        revision: 1,
        collaborationMode: "serial" as const,
        members: [
          {
            agentId: `leader-${squadId}`,
            role: "leader" as const,
            order: 0,
            required: true,
            capabilityIds: [],
            maxConcurrentTasks: 1,
          },
        ],
        maxConcurrency: 1,
        maxRetries: 0,
        failurePolicy: "fail_fast" as const,
        partialSuccessPolicy: "reject" as const,
        approvalStages: [],
        createdAtUnixMs: 100,
        updatedAtUnixMs,
        ...(archivedAtUnixMs === undefined ? {} : { archivedAtUnixMs }),
      });

      yield* store.upsertSquad(makeSquad("active-older", 200));
      yield* store.upsertSquad(makeSquad("active-newer", 300));
      yield* store.upsertSquad(makeSquad("archived", 400, 400));

      assert.deepEqual(
        (yield* store.listSquads()).map((squad) => squad.squadId),
        ["active-newer", "active-older"],
      );
      assert.deepEqual(
        (yield* store.listSquads({ includeArchived: true })).map((squad) => squad.squadId),
        ["archived", "active-newer", "active-older"],
      );
    }),
  );

  it.effect("按 revision 顺序读取 Squad 不可变历史并标记旧版空配置", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const revision1 = {
        squadId: "squad-history",
        name: "历史协同组",
        leaderAgentId: "history-leader",
        memberAgentIds: ["history-leader"],
        revision: 1,
        collaborationMode: "serial" as const,
        members: [
          {
            agentId: "history-leader",
            role: "leader" as const,
            order: 0,
            required: true,
            capabilityIds: [],
            maxConcurrentTasks: 1,
          },
        ],
        maxConcurrency: 1,
        maxRetries: 0,
        failurePolicy: "fail_fast" as const,
        partialSuccessPolicy: "reject" as const,
        approvalStages: [],
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
      };
      const revision2 = {
        ...revision1,
        name: "历史协同组 v2",
        revision: 2,
        updatedAtUnixMs: 200,
      };

      yield* store.upsertSquad(revision1);
      yield* store.upsertSquad(revision2);
      yield* store.upsertSquad({
        squadId: "legacy-history",
        name: "旧版协同组",
        leaderAgentId: "legacy-leader",
        memberAgentIds: ["legacy-leader"],
      });

      assert.deepEqual(yield* store.listSquadRevisions(revision1.squadId), [
        {
          squadId: revision1.squadId,
          revision: 1,
          configuration: revision1,
          createdAtUnixMs: 100,
        },
        {
          squadId: revision1.squadId,
          revision: 2,
          configuration: revision2,
          createdAtUnixMs: 200,
        },
      ]);
      assert.deepEqual(yield* store.listSquadRevisions("legacy-history"), [
        {
          squadId: "legacy-history",
          revision: 1,
          configuration: null,
          createdAtUnixMs: 0,
        },
      ]);
    }),
  );

  it.effect("持久化丰富 Squad 配置、不可变 revision 历史和幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const sql = yield* SqlClient.SqlClient;
      const revision1 = {
        squadId: "squad-versioned",
        name: "版本化协同组",
        leaderAgentId: "agent-leader-versioned",
        memberAgentIds: ["agent-leader-versioned", "agent-worker-versioned"],
        instructions: "由 Leader 拆解并汇总结果",
        revision: 1,
        collaborationMode: "leader_workers" as const,
        members: [
          {
            agentId: "agent-leader-versioned",
            role: "leader" as const,
            order: 0,
            required: true,
            model: "provider/leader-model",
            workspaceRoot: "C:/workspace/leader",
            capabilityIds: ["t3.workspace.read_file"],
            maxConcurrentTasks: 1,
          },
          {
            agentId: "agent-worker-versioned",
            role: "worker" as const,
            order: 1,
            required: true,
            model: "provider/worker-model",
            workspaceRoot: "C:/workspace/worker",
            capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
            maxConcurrentTasks: 2,
          },
        ],
        maxConcurrency: 2,
        maxRetries: 1,
        failurePolicy: "fail_fast" as const,
        partialSuccessPolicy: "reject" as const,
        approvalStages: ["before_finalize" as const],
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
      };
      const revision2 = {
        ...revision1,
        name: "版本化协同组 v2",
        revision: 2,
        maxConcurrency: 3,
        updatedAtUnixMs: 200,
      };

      yield* store.upsertSquad(revision1);
      assert.deepEqual(Option.getOrThrow(yield* store.getSquad(revision1.squadId)), revision1);

      yield* store.upsertSquad(revision2);
      yield* store.upsertSquad(revision2);
      assert.deepEqual(Option.getOrThrow(yield* store.getSquad(revision1.squadId)), revision2);

      const driftedRevision = yield* Effect.result(
        store.upsertSquad({ ...revision2, name: "同 revision 漂移" }),
      );
      const staleRevision = yield* Effect.result(store.upsertSquad(revision1));
      assert.equal(driftedRevision._tag, "Failure");
      assert.equal(staleRevision._tag, "Failure");
      assert.deepEqual(Option.getOrThrow(yield* store.getSquad(revision1.squadId)), revision2);

      const revisions = yield* sql<{
        readonly revision: number;
        readonly configurationJson: string;
      }>`
        SELECT revision, configuration_json AS "configurationJson"
        FROM composition_squad_revisions
        WHERE squad_id = ${revision1.squadId}
        ORDER BY revision ASC
      `;
      assert.deepEqual(
        revisions.map((row) => row.revision),
        [1, 2],
      );
      assert.deepEqual(
        revisions.map((row) => JSON.parse(row.configurationJson).name),
        [revision1.name, revision2.name],
      );
    }),
  );

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
      yield* store.appendEvent({
        taskId: "task-1",
        runId: "run-1",
        sourceEventId: "byok-checkpoint-1",
        agentId: "agent-1",
        runtimeId: "runtime-1",
        status: "running",
        sequence: 2,
        eventType: "message",
        summary: "BYOK Agent 已保存部分输出",
        outputDelta: " 部分输出\n",
        outputOffsetBytes: 13,
        outputDigest: "sha256:checkpoint-1",
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
        [0, 1, 2],
      );
      assert.equal(events[2]?.outputDelta, " 部分输出\n");
      assert.equal(events[2]?.outputOffsetBytes, 13);
      assert.equal(events[2]?.outputDigest, "sha256:checkpoint-1");
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

  it.effect("同一工作区的并发领取只有一个赢家，且完全相同的请求可以幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const firstLease = {
        leaseId: "lease-claim-a",
        runtimeId: "runtime-a",
        taskId: "task-a",
        workspaceRootDigest: "sha256:shared-workspace",
        heartbeatAtUnixMs: 10,
        expiresAtUnixMs: 100,
        state: "active" as const,
      };
      const secondLease = {
        ...firstLease,
        leaseId: "lease-claim-b",
        runtimeId: "runtime-b",
        taskId: "task-b",
      };

      const claims = yield* Effect.all(
        [
          store.claimLease({ lease: firstLease, nowUnixMs: 10 }),
          store.claimLease({ lease: secondLease, nowUnixMs: 10 }),
        ],
        { concurrency: "unbounded" },
      );
      const winners = claims.filter(Option.isSome).map(Option.getOrThrow);
      assert.equal(winners.length, 1);

      const winner = winners[0]!;
      const replay = yield* store.claimLease({ lease: winner, nowUnixMs: 20 });
      const mutatedReplay = yield* store.claimLease({
        lease: { ...winner, expiresAtUnixMs: winner.expiresAtUnixMs + 1 },
        nowUnixMs: 20,
      });
      const staleClaim = yield* store.claimLease({
        lease: {
          ...winner,
          leaseId: "lease-stale-claim",
          workspaceRootDigest: "sha256:stale-workspace",
          heartbeatAtUnixMs: 19,
        },
        nowUnixMs: 20,
      });
      assert.deepEqual(Option.getOrThrow(replay), winner);
      assert.ok(Option.isNone(mutatedReplay));
      assert.ok(Option.isNone(staleClaim));
    }),
  );

  it.effect("只有当前 owner 能在租约有效期内续租，并且释放操作可以幂等重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const lease = {
        leaseId: "lease-renew",
        runtimeId: "runtime-owner",
        taskId: "task-renew",
        workspaceRootDigest: "sha256:renew-workspace",
        heartbeatAtUnixMs: 10,
        expiresAtUnixMs: 100,
        state: "active" as const,
      };
      assert.ok(Option.isSome(yield* store.claimLease({ lease, nowUnixMs: 10 })));

      const rejected = yield* store.renewLease({
        leaseId: lease.leaseId,
        runtimeId: "runtime-other",
        heartbeatAtUnixMs: 20,
        expiresAtUnixMs: 200,
        nowUnixMs: 20,
      });
      const renewed = yield* store.renewLease({
        leaseId: lease.leaseId,
        runtimeId: lease.runtimeId,
        heartbeatAtUnixMs: 20,
        expiresAtUnixMs: 200,
        nowUnixMs: 20,
      });
      const shortened = yield* store.renewLease({
        leaseId: lease.leaseId,
        runtimeId: lease.runtimeId,
        heartbeatAtUnixMs: 21,
        expiresAtUnixMs: 199,
        nowUnixMs: 21,
      });
      assert.ok(Option.isNone(rejected));
      assert.equal(Option.getOrThrow(renewed).expiresAtUnixMs, 200);
      assert.ok(Option.isNone(shortened));

      const rejectedRelease = yield* store.releaseLease({
        leaseId: lease.leaseId,
        runtimeId: "runtime-other",
        releasedAtUnixMs: 30,
      });
      assert.ok(Option.isNone(rejectedRelease));

      const released = yield* store.releaseLease({
        leaseId: lease.leaseId,
        runtimeId: lease.runtimeId,
        releasedAtUnixMs: 30,
      });
      const replayedRelease = yield* store.releaseLease({
        leaseId: lease.leaseId,
        runtimeId: lease.runtimeId,
        releasedAtUnixMs: 31,
      });
      const renewedAfterRelease = yield* store.renewLease({
        leaseId: lease.leaseId,
        runtimeId: lease.runtimeId,
        heartbeatAtUnixMs: 40,
        expiresAtUnixMs: 300,
        nowUnixMs: 40,
      });
      assert.equal(Option.getOrThrow(released).state, "released");
      assert.deepEqual(Option.getOrThrow(replayedRelease), Option.getOrThrow(released));
      assert.ok(Option.isNone(renewedAfterRelease));
    }),
  );

  it.effect("回收过期租约后允许新的 owner 领取同一工作区", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const expiredLease = {
        leaseId: "lease-expired",
        runtimeId: "runtime-old",
        taskId: "task-old",
        workspaceRootDigest: "sha256:reclaimed-workspace",
        heartbeatAtUnixMs: 10,
        expiresAtUnixMs: 20,
        state: "active" as const,
      };
      assert.ok(Option.isSome(yield* store.claimLease({ lease: expiredLease, nowUnixMs: 10 })));

      const notYetReclaimed = yield* store.reclaimExpiredLeases({ nowUnixMs: 19 });
      const renewAtExpiry = yield* store.renewLease({
        leaseId: expiredLease.leaseId,
        runtimeId: expiredLease.runtimeId,
        heartbeatAtUnixMs: 20,
        expiresAtUnixMs: 120,
        nowUnixMs: 20,
      });
      const reclaimed = yield* store.reclaimExpiredLeases({ nowUnixMs: 20 });
      const storedExpiredLease = yield* store.getLease(expiredLease.leaseId);
      const nextLease = {
        ...expiredLease,
        leaseId: "lease-reclaimed",
        runtimeId: "runtime-new",
        taskId: "task-new",
        heartbeatAtUnixMs: 20,
        expiresAtUnixMs: 120,
      };
      const nextClaim = yield* store.claimLease({ lease: nextLease, nowUnixMs: 20 });

      assert.deepEqual(notYetReclaimed, []);
      assert.ok(Option.isNone(renewAtExpiry));
      assert.deepEqual(
        reclaimed.map((lease) => lease.leaseId),
        [expiredLease.leaseId],
      );
      assert.equal(Option.getOrThrow(storedExpiredLease).state, "expired");
      assert.equal(Option.getOrThrow(nextClaim).runtimeId, "runtime-new");
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

  it.effect("持久化 Multica quick-create intent，并只允许 prepared 到 sending 再到 accepted", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const intent = {
        runId: "run-quick-create",
        taskId: "task-quick-create",
        runtimeId: "multica:daemon-1:runtime-1",
        idempotencyKey: "run-quick-create",
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
      };

      assert.isTrue(yield* store.createMulticaQuickCreateIntent(intent));
      assert.isFalse(yield* store.createMulticaQuickCreateIntent({ ...intent, taskId: "other" }));
      assert.deepEqual(
        Option.getOrThrow(
          yield* store.getMulticaQuickCreateIntentByIdempotencyKey(
            intent.runtimeId,
            intent.idempotencyKey,
          ),
        ),
        { ...intent, state: "prepared" },
      );

      const pendingBeforeSend = yield* store.listPendingMulticaQuickCreateIntents(intent.runtimeId);
      assert.deepEqual(pendingBeforeSend, [{ ...intent, state: "prepared" }]);

      const rejectedWrongRuntime = yield* store.claimMulticaQuickCreateIntentForSend({
        runId: intent.runId,
        runtimeId: "multica:other",
        updatedAtUnixMs: 1_001,
      });
      assert.isTrue(Option.isNone(rejectedWrongRuntime));

      const sending = yield* store.claimMulticaQuickCreateIntentForSend({
        runId: intent.runId,
        runtimeId: intent.runtimeId,
        updatedAtUnixMs: 1_001,
      });
      assert.deepEqual(Option.getOrThrow(sending), {
        ...intent,
        state: "sending",
        updatedAtUnixMs: 1_001,
      });
      assert.isTrue(
        Option.isNone(
          yield* store.claimMulticaQuickCreateIntentForSend({
            runId: intent.runId,
            runtimeId: intent.runtimeId,
            updatedAtUnixMs: 1_002,
          }),
        ),
      );

      const accepted = yield* store.acceptMulticaQuickCreateIntent({
        runId: intent.runId,
        runtimeId: intent.runtimeId,
        remoteTaskId: "multica-task-1",
        updatedAtUnixMs: 1_003,
      });
      assert.deepEqual(Option.getOrThrow(accepted), {
        ...intent,
        state: "accepted",
        remoteTaskId: "multica-task-1",
        updatedAtUnixMs: 1_003,
      });
      assert.deepEqual(yield* store.listPendingMulticaQuickCreateIntents(intent.runtimeId), []);
      assert.deepEqual(Option.getOrThrow(yield* store.getMulticaQuickCreateIntent(intent.runId)), {
        ...intent,
        state: "accepted",
        remoteTaskId: "multica-task-1",
        updatedAtUnixMs: 1_003,
      });
    }),
  );

  it.effect("并发创建同一 Run 的 Multica quick-create intent 时只允许一个发送者取得记录", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const intent = {
        runId: "run-quick-create-race",
        taskId: "task-quick-create-race",
        runtimeId: "multica:daemon-1:runtime-1",
        idempotencyKey: "run-quick-create-race",
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
      };

      const created = yield* Effect.forEach(
        [1, 2],
        () => store.createMulticaQuickCreateIntent(intent),
        { concurrency: 2 },
      );
      assert.deepEqual([...created].sort(), [false, true]);
      assert.deepEqual(Option.getOrThrow(yield* store.getMulticaQuickCreateIntent(intent.runId)), {
        ...intent,
        state: "prepared",
      });
    }),
  );

  it.effect("同一 Runtime 的不同 Run 不能复用 quick-create 幂等键", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const owner = {
        runId: "run-quick-create-key-owner",
        taskId: "task-quick-create-key-owner",
        runtimeId: "multica:daemon-1:runtime-key-scope",
        idempotencyKey: "shared-runtime-key",
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
      };

      assert.isTrue(yield* store.createMulticaQuickCreateIntent(owner));
      assert.isFalse(
        yield* store.createMulticaQuickCreateIntent({
          ...owner,
          runId: "run-quick-create-key-contender",
          taskId: "task-quick-create-key-contender",
        }),
      );
      assert.isTrue(
        yield* store.createMulticaQuickCreateIntent({
          ...owner,
          runId: "run-quick-create-other-runtime",
          taskId: "task-quick-create-other-runtime",
          runtimeId: "multica:daemon-2:runtime-key-scope",
        }),
      );
      assert.equal(
        Option.getOrThrow(
          yield* store.getMulticaQuickCreateIntentByIdempotencyKey(
            owner.runtimeId,
            owner.idempotencyKey,
          ),
        ).runId,
        owner.runId,
      );
    }),
  );

  it.effect("并发的不同 Run 争用同一 Runtime 幂等键时只创建一个 intent", () =>
    Effect.gen(function* () {
      const store = yield* CompositionTaskStore;
      const common = {
        runtimeId: "multica:daemon-1:runtime-key-race",
        idempotencyKey: "shared-race-key",
        createdAtUnixMs: 1_000,
        updatedAtUnixMs: 1_000,
      };
      const intents = [
        { ...common, runId: "run-key-race-a", taskId: "task-key-race-a" },
        { ...common, runId: "run-key-race-b", taskId: "task-key-race-b" },
      ];

      const created = yield* Effect.forEach(
        intents,
        (intent) => store.createMulticaQuickCreateIntent(intent),
        { concurrency: 2 },
      );
      assert.deepEqual([...created].sort(), [false, true]);
      const stored = yield* store.getMulticaQuickCreateIntentByIdempotencyKey(
        common.runtimeId,
        common.idempotencyKey,
      );
      assert.isTrue(Option.isSome(stored));
      assert.include(
        intents.map((intent) => intent.runId),
        Option.getOrThrow(stored).runId,
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
        capabilityIds: ["t3.workspace.read_file", "t3.workspace.write_file"],
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
