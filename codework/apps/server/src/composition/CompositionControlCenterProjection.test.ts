import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { byokResumeRedispatchEventPrefix } from "./CompositionByokResumeRedispatch.ts";
import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import { projectCompositionControlCenter } from "./CompositionControlCenterProjection.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const seedTask = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly status: "queued" | "running" | "failed" | "completed";
    readonly dependsOnTaskIds?: ReadonlyArray<string>;
  },
) =>
  store.upsertTask({
    taskId: input.taskId,
    projectId: "project-control",
    assigneeKind: "agent",
    assigneeId: `agent-${input.taskId}`,
    mode: "serial",
    status: input.status,
    promptDigest: `sha256:${input.taskId}`,
    dependsOnTaskIds: [...(input.dependsOnTaskIds ?? [])],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  });

const seedRun = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly runId: string;
    readonly status: "running" | "failed";
  },
) =>
  store.upsertRun({
    taskId: input.taskId,
    runId: input.runId,
    agentId: `agent-${input.taskId}`,
    runtimeId: "runtime-control",
    status: input.status,
    attempt: 1,
    capabilityGrantIds: [],
  });

const seedGoalRow = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly runId: string;
    readonly suffix: string;
  },
) =>
  store.appendEventIfNew({
    taskId: input.taskId,
    runId: input.runId,
    agentId: `agent-${input.taskId}`,
    runtimeId: "runtime-control",
    sourceEventId: `${goalLoopEventPrefix(input.taskId, input.runId)}:${input.suffix}`,
    status: "running",
    sequence: 0,
    eventType: "status",
    summary: "控制中心种子行",
  });

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** 按生产形状落 BYOK checkpoint 行：`byok:` 前缀、message、累计偏移与正文摘要。 */
const seedByokCheckpoints = (
  store: CompositionTaskStoreShape,
  input: {
    readonly taskId: string;
    readonly runId: string;
    readonly deltas: ReadonlyArray<string>;
    readonly corruptDigest?: boolean;
  },
) =>
  Effect.gen(function* () {
    let offset = 0;
    let chunkIndex = 0;
    for (const delta of input.deltas) {
      offset += utf8ByteLength(delta);
      yield* store.appendEventIfNew({
        taskId: input.taskId,
        runId: input.runId,
        agentId: `agent-${input.taskId}`,
        runtimeId: "runtime-control",
        sourceEventId: `byok:checkpoint-${input.runId}-${chunkIndex}`,
        status: "running",
        sequence: 0,
        eventType: "message",
        summary: "BYOK Agent 已保存部分输出",
        outputDelta: delta,
        outputOffsetBytes: offset,
        outputDigest: input.corruptDigest === true ? sha256(`${delta}-tampered`) : sha256(delta),
      });
      chunkIndex += 1;
    }
  });

const makeGrantRegistryFakeRemoved = undefined;
void makeGrantRegistryFakeRemoved;

layer("CompositionControlCenterProjection", (it) => {
  describe("projectCompositionControlCenter", () => {
    it.effect("按任务聚合最新 Run、Goal Loop 状态、grant 审计摘要与 Squad 名册", () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        // task-running：Run 活跃 + 循环进行中（2 轮）。
        yield* seedTask(store, { taskId: "task-running", status: "running" });
        yield* seedRun(store, { taskId: "task-running", runId: "run-running", status: "running" });
        yield* seedGoalRow(store, {
          taskId: "task-running",
          runId: "run-running",
          suffix: "start",
        });
        yield* seedGoalRow(store, {
          taskId: "task-running",
          runId: "run-running",
          suffix: "round:2",
        });
        // task-converged：循环已收敛（预算耗尽终态）。
        yield* seedTask(store, {
          taskId: "task-converged",
          status: "failed",
          dependsOnTaskIds: ["task-z", "task-a"],
        });
        yield* seedRun(store, {
          taskId: "task-converged",
          runId: "run-converged",
          status: "failed",
        });
        yield* seedGoalRow(store, {
          taskId: "task-converged",
          runId: "run-converged",
          suffix: "start",
        });
        yield* seedGoalRow(store, {
          taskId: "task-converged",
          runId: "run-converged",
          suffix: "terminal:budget_exhausted",
        });
        // task-interrupted：Run 已 failed 但循环无终态行。
        yield* seedTask(store, { taskId: "task-interrupted", status: "failed" });
        yield* seedRun(store, {
          taskId: "task-interrupted",
          runId: "run-interrupted",
          status: "failed",
        });
        yield* seedGoalRow(store, {
          taskId: "task-interrupted",
          runId: "run-interrupted",
          suffix: "start",
        });
        yield* seedGoalRow(store, {
          taskId: "task-interrupted",
          runId: "run-interrupted",
          suffix: "round:1",
        });
        // task-settled：supervisor 已结算。
        yield* seedTask(store, { taskId: "task-settled", status: "failed" });
        yield* seedRun(store, { taskId: "task-settled", runId: "run-settled", status: "failed" });
        yield* seedGoalRow(store, {
          taskId: "task-settled",
          runId: "run-settled",
          suffix: "start",
        });
        yield* seedGoalRow(store, {
          taskId: "task-settled",
          runId: "run-settled",
          suffix: "supervisor:redispatch",
        });
        // task-queued：尚无 Run。
        yield* seedTask(store, { taskId: "task-queued", status: "queued" });
        yield* store.upsertSquad({
          squadId: "squad-control",
          name: "控制中心小队",
          leaderAgentId: "agent-task-running",
          memberAgentIds: ["agent-task-running", "agent-task-converged"],
        });

        const grantRegistry = {
          listAudit: ({ taskId }: { readonly taskId: string }) =>
            Effect.succeed(
              taskId === "task-running"
                ? [
                    {
                      auditId: "audit-1",
                      grantId: "grant-1",
                      taskId,
                      runId: "run-running",
                      agentId: "agent-task-running",
                      capabilityId: "t3.workspace.read_file",
                      operation: "read" as const,
                      outcome: "allowed" as const,
                      occurredAtUnixMs: 10,
                    },
                    {
                      auditId: "audit-2",
                      grantId: "grant-1",
                      taskId,
                      runId: "run-running",
                      agentId: "agent-task-running",
                      capabilityId: "t3.workspace.read_file",
                      operation: "read" as const,
                      outcome: "revoked" as const,
                      occurredAtUnixMs: 20,
                    },
                  ]
                : [],
            ),
        };
        const projection = yield* projectCompositionControlCenter({
          store,
          grantRegistry,
          squadIds: ["squad-control", "squad-missing"],
          now: () => 9_999,
        });

        assert.equal(projection.generatedAtUnixMs, 9_999);
        const byTask = new Map(projection.tasks.map((task) => [task.taskId, task]));
        assert.equal(byTask.size, 5);

        const running = byTask.get("task-running");
        assert.equal(running?.goalLoop?.state, "running");
        assert.equal(running?.goalLoop?.completedRounds, 2);
        assert.equal(running?.latestRun?.runId, "run-running");
        assert.equal(running?.grants?.totalEvents, 2);
        assert.equal(running?.grants?.revokedEvents, 1);
        assert.equal(running?.grants?.lastOutcome, "revoked");
        assert.equal(running?.grants?.lastOccurredAtUnixMs, 20);

        const converged = byTask.get("task-converged");
        assert.equal(converged?.goalLoop?.state, "converged");
        assert.deepEqual(converged?.goalLoop?.terminalStatuses, ["budget_exhausted"]);
        assert.deepEqual(converged?.dependsOnTaskIds, ["task-a", "task-z"]);
        assert.equal(converged?.grants?.totalEvents, 0);

        const interrupted = byTask.get("task-interrupted");
        assert.equal(interrupted?.goalLoop?.state, "interrupted");

        const settled = byTask.get("task-settled");
        assert.equal(settled?.goalLoop?.state, "supervisor_settled");
        assert.equal(settled?.goalLoop?.settledBySupervisor, true);

        const queued = byTask.get("task-queued");
        assert.isUndefined(queued?.goalLoop);
        assert.isUndefined(queued?.latestRun);
        assert.equal(queued?.status, "queued");

        assert.equal(projection.squads.length, 1);
        assert.equal(projection.squads[0]?.squadId, "squad-control");
        assert.equal(projection.squads[0]?.leaderAgentId, "agent-task-running");
        assert.deepEqual(projection.squads[0]?.memberAgentIds, [
          "agent-task-running",
          "agent-task-converged",
        ]);
        // 不存在的 Squad 不产出条目。
        assert.isFalse(projection.squads.some((squad) => squad.squadId === "squad-missing"));

        // Goal Loop 五态只扫 `goalloop:*` 前缀，不产出 BYOK 恢复态。
        assert.isUndefined(running?.byokResume);
        assert.isUndefined(interrupted?.byokResume);
      }),
    );

    it.effect("投影最新 Run 的 BYOK 恢复态：可恢复、摘要链损坏与已结算三种形态", () =>
      Effect.gen(function* () {
        const store = yield* CompositionTaskStore;
        // task-byok-ready：checkpoint 链完整，可恢复。
        yield* seedTask(store, { taskId: "task-byok-ready", status: "running" });
        yield* seedRun(store, {
          taskId: "task-byok-ready",
          runId: "run-byok-ready",
          status: "running",
        });
        yield* seedByokCheckpoints(store, {
          taskId: "task-byok-ready",
          runId: "run-byok-ready",
          deltas: ["前段输出，", "尾段输出"],
        });
        // task-byok-corrupt：摘要被篡改，投影降级为不可恢复并带稳定错误码。
        yield* seedTask(store, { taskId: "task-byok-corrupt", status: "running" });
        yield* seedRun(store, {
          taskId: "task-byok-corrupt",
          runId: "run-byok-corrupt",
          status: "running",
        });
        yield* seedByokCheckpoints(store, {
          taskId: "task-byok-corrupt",
          runId: "run-byok-corrupt",
          deltas: ["被篡改的输出"],
          corruptDigest: true,
        });
        // task-byok-settled：已有恢复重派结算行，重复触发会被服务端拒绝。
        yield* seedTask(store, { taskId: "task-byok-settled", status: "failed" });
        yield* seedRun(store, {
          taskId: "task-byok-settled",
          runId: "run-byok-settled",
          status: "failed",
        });
        yield* seedByokCheckpoints(store, {
          taskId: "task-byok-settled",
          runId: "run-byok-settled",
          deltas: ["已结算 Run 的输出"],
        });
        yield* store.appendEventIfNew({
          taskId: "task-byok-settled",
          runId: "run-byok-settled",
          agentId: "agent-task-byok-settled",
          runtimeId: "runtime-control",
          sourceEventId: `${byokResumeRedispatchEventPrefix("task-byok-settled", "run-byok-settled")}:settle`,
          status: "blocked",
          sequence: 0,
          eventType: "status",
          summary: "既有恢复重派结算行",
        });
        // task-byok-none：无 checkpoint 行，不挂空字段。
        yield* seedTask(store, { taskId: "task-byok-none", status: "running" });
        yield* seedRun(store, {
          taskId: "task-byok-none",
          runId: "run-byok-none",
          status: "running",
        });

        const projection = yield* projectCompositionControlCenter({ store, now: () => 1 });
        const byTask = new Map(projection.tasks.map((task) => [task.taskId, task]));

        const ready = byTask.get("task-byok-ready")?.byokResume;
        assert.equal(ready?.runId, "run-byok-ready");
        assert.equal(ready?.checkpointCount, 2);
        assert.equal(ready?.recoveredUtf8Bytes, utf8ByteLength("前段输出，尾段输出"));
        assert.equal(ready?.recoverable, true);
        assert.equal(ready?.redispatchSettled, false);
        assert.isUndefined(ready?.recoveryFailureCode);
        // 恢复正文不进投影，只回传统计。
        // @effect-diagnostics-next-line preferSchemaOverJson:off - 断言投影整体序列化不含恢复原文。
        assert.isFalse(JSON.stringify(projection).includes("尾段输出"));

        const corrupt = byTask.get("task-byok-corrupt")?.byokResume;
        assert.equal(corrupt?.checkpointCount, 1);
        assert.equal(corrupt?.recoverable, false);
        assert.equal(corrupt?.recoveredUtf8Bytes, 0);
        assert.equal(corrupt?.recoveryFailureCode, "byok_checkpoint_recovery_digest_mismatch");

        const settled = byTask.get("task-byok-settled")?.byokResume;
        assert.equal(settled?.recoverable, true);
        assert.equal(settled?.redispatchSettled, true);

        assert.isUndefined(byTask.get("task-byok-none")?.byokResume);
      }),
    );
  });
});
