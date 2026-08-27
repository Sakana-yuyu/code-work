import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { goalLoopEventPrefix } from "./CompositionGoalLoopRunner.ts";
import { projectCompositionControlCenter } from "./CompositionControlCenterProjection.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const layer = it.layer(CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const seedTask = (
  store: CompositionTaskStore,
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
  store: CompositionTaskStore,
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
  store: CompositionTaskStore,
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
      }),
    );
  });
});
