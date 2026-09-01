// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ApprovalRequestId, ThreadId, type CompositionSquadExecution } from "@codework/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CompositionSquadExecutionStore,
  CompositionSquadExecutionStoreDomainError,
} from "../Services/CompositionSquadExecutionStore.ts";
import { CompositionSquadExecutionStoreLive } from "./CompositionSquadExecutionStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CompositionSquadExecutionStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makeQueuedExecution = (
  executionId: string,
  overrides: Partial<CompositionSquadExecution> = {},
): CompositionSquadExecution => ({
  executionId,
  squadId: "squad-execution",
  squadRevision: 1,
  projectId: "project-execution",
  threadId: ThreadId.make(`thread-${executionId}`),
  goalDigest: `sha256:goal-${executionId}`,
  planDigest: `sha256:plan-${executionId}`,
  goalTaskId: `goal-task-${executionId}`,
  workspaceRootDigest: "sha256:workspace-execution",
  status: "queued",
  revision: 1,
  leaderTaskId: `leader-task-${executionId}`,
  leaderRunId: `leader-run-${executionId}`,
  pendingApprovals: [],
  createdAtUnixMs: 100,
  updatedAtUnixMs: 100,
  ...overrides,
});

const makePlanningExecution = (
  current: CompositionSquadExecution,
  overrides: Partial<CompositionSquadExecution> = {},
): CompositionSquadExecution => ({
  ...current,
  status: "planning",
  revision: current.revision + 1,
  startedAtUnixMs: current.startedAtUnixMs ?? 110,
  updatedAtUnixMs: current.updatedAtUnixMs + 10,
  ...overrides,
});

const makeRunningExecution = (
  current: CompositionSquadExecution,
  overrides: Partial<CompositionSquadExecution> = {},
): CompositionSquadExecution => ({
  ...current,
  status: "running",
  revision: current.revision + 1,
  nodes: [
    {
      nodeId: "node-worker",
      agentId: "agent-worker",
      taskId: `worker-task-${current.executionId}`,
      runId: `worker-run-${current.executionId}`,
      promptDigest: "sha256:worker-prompt",
      dependsOnNodeIds: [],
    },
  ],
  startedAtUnixMs: current.startedAtUnixMs ?? 110,
  updatedAtUnixMs: current.updatedAtUnixMs + 10,
  ...overrides,
});

const withoutPlanDigest = (execution: CompositionSquadExecution): CompositionSquadExecution => {
  const { planDigest: _planDigest, ...legacyExecution } = execution;
  return legacyExecution;
};

const isSquadExecutionStoreDomainError = Schema.is(CompositionSquadExecutionStoreDomainError);

const failureCode = (
  result: { readonly _tag: "Success" } | { readonly _tag: "Failure"; readonly failure: unknown },
): string | undefined =>
  result._tag === "Failure" && isSquadExecutionStoreDomainError(result.failure)
    ? result.failure.code
    : undefined;

const makeSquadConfigurationJson = (squadId = "squad-execution", revision = 1): string =>
  JSON.stringify({
    squadId,
    name: "协同组",
    leaderAgentId: "agent-leader",
    memberAgentIds: ["agent-leader", "agent-worker"],
    revision,
    collaborationMode: "leader_workers",
    members: [
      {
        agentId: "agent-leader",
        role: "leader",
        order: 0,
        required: true,
        capabilityIds: [],
        maxConcurrentTasks: 1,
      },
      {
        agentId: "agent-worker",
        role: "worker",
        order: 1,
        required: true,
        capabilityIds: [],
        maxConcurrentTasks: 1,
      },
    ],
    maxConcurrency: 2,
    maxRetries: 1,
    failurePolicy: "fail_fast",
    partialSuccessPolicy: "reject",
    approvalStages: [],
    createdAtUnixMs: 100,
    updatedAtUnixMs: 100,
  });

const seedSquadRevision = (sql: SqlClient.SqlClient, squadId = "squad-execution") => sql`
  INSERT INTO composition_squad_revisions (
    squad_id, revision, configuration_json, created_at_unix_ms
  ) VALUES (${squadId}, 1, ${makeSquadConfigurationJson(squadId)}, 100)
  ON CONFLICT (squad_id, revision) DO NOTHING
`;

const makeFileStoreLayer = (dbPath: string) =>
  CompositionSquadExecutionStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

layer("CompositionSquadExecutionStore", (it) => {
  it.effect("原子 claim、稳定重领并拒绝身份漂移或不可恢复的 Squad revision", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const queued = makeQueuedExecution("execution-claim");

      assert.deepEqual(yield* store.claimExecution(queued), { execution: queued, claimed: true });
      assert.deepEqual(yield* store.claimExecution(queued), { execution: queued, claimed: false });
      const laterRetry = {
        ...queued,
        createdAtUnixMs: 200,
        updatedAtUnixMs: 200,
      };
      assert.deepEqual(yield* store.claimExecution(laterRetry), {
        execution: queued,
        claimed: false,
      });

      const planning = makePlanningExecution(queued);
      yield* store.saveTransition({ execution: planning, expectedRevision: queued.revision });
      assert.deepEqual(
        yield* store.claimExecution({
          ...queued,
          createdAtUnixMs: 300,
          updatedAtUnixMs: 300,
        }),
        { execution: planning, claimed: false },
      );
      assert.deepEqual(Option.getOrThrow(yield* store.getExecution(queued.executionId)), planning);

      const drift = yield* Effect.result(
        store.claimExecution({ ...queued, projectId: "project-drift" }),
      );
      const goalDrift = yield* Effect.result(
        store.claimExecution({ ...queued, goalDigest: "sha256:different-goal" }),
      );
      const planDrift = yield* Effect.result(
        store.claimExecution({ ...queued, planDigest: "sha256:different-plan" }),
      );
      const workspaceDrift = yield* Effect.result(
        store.claimExecution({ ...queued, workspaceRootDigest: "sha256:different-workspace" }),
      );
      const missingRevision = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-missing-revision", {
            squadRevision: 2,
          }),
        ),
      );
      yield* sql`
        INSERT INTO composition_squad_revisions (
          squad_id, revision, configuration_json, created_at_unix_ms
        ) VALUES ('legacy-squad', 1, NULL, 0)
      `;
      const legacyRevision = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-legacy-revision", {
            squadId: "legacy-squad",
          }),
        ),
      );
      yield* sql`
        INSERT INTO composition_squad_revisions (
          squad_id, revision, configuration_json, created_at_unix_ms
        ) VALUES ('malformed-squad', 1, 'not-json', 0)
      `;
      const malformedRevision = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-malformed-revision", {
            squadId: "malformed-squad",
          }),
        ),
      );
      yield* sql`
        INSERT INTO composition_squad_revisions (
          squad_id, revision, configuration_json, created_at_unix_ms
        ) VALUES ('invalid-squad', 1, '{}', 0)
      `;
      const invalidRevision = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-invalid-revision", {
            squadId: "invalid-squad",
          }),
        ),
      );
      yield* sql`
        INSERT INTO composition_squad_revisions (
          squad_id, revision, configuration_json, created_at_unix_ms
        ) VALUES (
          'mismatched-squad', 1,
          ${makeSquadConfigurationJson("different-squad")}, 0
        )
      `;
      const mismatchedRevision = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-mismatched-revision", {
            squadId: "mismatched-squad",
          }),
        ),
      );

      assert.equal(failureCode(drift), "squad_execution_conflict");
      assert.equal(failureCode(goalDrift), "squad_execution_conflict");
      assert.equal(failureCode(planDrift), "squad_execution_conflict");
      assert.equal(failureCode(workspaceDrift), "squad_execution_conflict");
      assert.equal(failureCode(missingRevision), "squad_execution_squad_revision_invalid");
      assert.equal(failureCode(legacyRevision), "squad_execution_squad_revision_invalid");
      assert.equal(malformedRevision._tag, "Failure");
      assert.equal(invalidRevision._tag, "Failure");
      if (malformedRevision._tag === "Failure") {
        assert.equal(malformedRevision.failure._tag, "PersistenceDecodeError");
      }
      if (invalidRevision._tag === "Failure") {
        assert.equal(invalidRevision.failure._tag, "PersistenceDecodeError");
      }
      assert.equal(failureCode(mismatchedRevision), "squad_execution_squad_revision_invalid");
    }),
  );

  it.effect("以 revision CAS 保存跨状态与同状态投影更新，并拒绝非法跳转", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const queued = makeQueuedExecution("execution-transition");
      const planning = makePlanningExecution(queued);
      const running = makeRunningExecution(planning);
      const awaitingToolApproval: CompositionSquadExecution = {
        ...running,
        revision: running.revision + 1,
        pendingApprovals: [
          {
            approvalRequestId: ApprovalRequestId.make("approval-tool"),
            stage: "before_mutating_tool",
            nodeId: "node-worker",
            taskId: `worker-task-${running.executionId}`,
            runId: `worker-run-${running.executionId}`,
            agentId: "agent-worker",
            capabilityId: "t3.workspace.write_file",
            toolCallId: "tool-call-1",
            requestedAtUnixMs: 140,
          },
        ],
        updatedAtUnixMs: 140,
      };

      yield* store.claimExecution(queued);
      assert.deepEqual(
        yield* store.saveTransition({ execution: planning, expectedRevision: 1 }),
        planning,
      );
      assert.deepEqual(
        yield* store.saveTransition({ execution: running, expectedRevision: 2 }),
        running,
      );
      assert.deepEqual(
        yield* store.saveTransition({ execution: awaitingToolApproval, expectedRevision: 3 }),
        awaitingToolApproval,
      );
      assert.deepEqual(
        yield* store.saveTransition({ execution: awaitingToolApproval, expectedRevision: 3 }),
        awaitingToolApproval,
      );

      const illegal = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...awaitingToolApproval,
            status: "planning",
            revision: 5,
            pendingApprovals: [],
            updatedAtUnixMs: 150,
          },
          expectedRevision: 4,
        }),
      );
      const stale = yield* Effect.result(
        store.saveTransition({
          execution: { ...awaitingToolApproval, revision: 5, updatedAtUnixMs: 150 },
          expectedRevision: 3,
        }),
      );

      assert.equal(failureCode(illegal), "squad_execution_status_conflict");
      assert.equal(failureCode(stale), "squad_execution_revision_conflict");
    }),
  );

  it.effect("将 plan 摘要作为不可变执行身份并拒绝新增、删除或改变", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);

      const queued = makeQueuedExecution("execution-plan-identity");
      yield* store.claimExecution(queued);
      const changed = yield* Effect.result(
        store.saveTransition({
          execution: makePlanningExecution(queued, {
            planDigest: "sha256:changed-plan",
          }),
          expectedRevision: 1,
        }),
      );
      const removed = yield* Effect.result(
        store.saveTransition({
          execution: withoutPlanDigest(makePlanningExecution(queued)),
          expectedRevision: 1,
        }),
      );

      const legacyQueued = withoutPlanDigest(makeQueuedExecution("execution-plan-identity-legacy"));
      yield* store.claimExecution(legacyQueued);
      const added = yield* Effect.result(
        store.saveTransition({
          execution: makePlanningExecution(legacyQueued, {
            planDigest: "sha256:added-plan",
          }),
          expectedRevision: 1,
        }),
      );

      assert.equal(failureCode(changed), "squad_execution_conflict");
      assert.equal(failureCode(removed), "squad_execution_conflict");
      assert.equal(failureCode(added), "squad_execution_conflict");
    }),
  );

  it.effect("完全一致重放会修复缺失的节点身份绑定", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);

      const queued = makeQueuedExecution("execution-binding-repair");
      const planning = makePlanningExecution(queued);
      const running = makeRunningExecution(planning);
      const node = running.nodes![0]!;
      const readNodeTaskBinding = () =>
        sql<{
          readonly executionId: string;
          readonly identityKind: string;
          readonly identityId: string;
          readonly role: string;
          readonly nodeId: string | null;
        }>`
          SELECT
            execution_id AS "executionId",
            identity_kind AS "identityKind",
            identity_id AS "identityId",
            role,
            node_id AS "nodeId"
          FROM composition_squad_execution_bindings
          WHERE execution_id = ${running.executionId}
            AND identity_kind = 'task'
            AND identity_id = ${node.taskId}
            AND role = 'node_task'
            AND node_id = ${node.nodeId}
        `;
      const expectedBinding = {
        executionId: running.executionId,
        identityKind: "task",
        identityId: node.taskId,
        role: "node_task",
        nodeId: node.nodeId,
      };
      yield* store.claimExecution(queued);
      yield* store.saveTransition({ execution: planning, expectedRevision: 1 });
      yield* store.saveTransition({ execution: running, expectedRevision: 2 });
      assert.deepEqual(yield* readNodeTaskBinding(), [expectedBinding]);

      yield* sql`
        DELETE FROM composition_squad_execution_bindings
        WHERE execution_id = ${running.executionId}
          AND identity_kind = 'task'
          AND identity_id = ${node.taskId}
          AND role = 'node_task'
          AND node_id = ${node.nodeId}
      `;
      assert.deepEqual(yield* readNodeTaskBinding(), []);

      assert.deepEqual(
        yield* store.saveTransition({ execution: running, expectedRevision: 2 }),
        running,
      );
      assert.deepEqual(yield* readNodeTaskBinding(), [expectedBinding]);
      assert.deepEqual(Option.getOrThrow(yield* store.getExecution(running.executionId)), running);
    }),
  );

  it.effect("全局预留顶层与节点 Task/Run 身份并拒绝跨 execution 抢占", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);

      const firstQueued = makeQueuedExecution("execution-binding-first");
      yield* store.claimExecution(firstQueued);
      const crossRole = yield* Effect.result(
        store.claimExecution(
          makeQueuedExecution("execution-binding-cross-role", {
            goalTaskId: firstQueued.leaderTaskId,
          }),
        ),
      );
      assert.equal(failureCode(crossRole), "squad_execution_conflict");
      assert.equal(Option.isNone(yield* store.getExecution("execution-binding-cross-role")), true);

      const firstPlanning = makePlanningExecution(firstQueued);
      const firstRunning = makeRunningExecution(firstPlanning);
      yield* store.saveTransition({ execution: firstPlanning, expectedRevision: 1 });
      yield* store.saveTransition({ execution: firstRunning, expectedRevision: 2 });

      const secondQueued = makeQueuedExecution("execution-binding-second");
      const secondPlanning = makePlanningExecution(secondQueued);
      yield* store.claimExecution(secondQueued);
      yield* store.saveTransition({ execution: secondPlanning, expectedRevision: 1 });
      const secondRunning = makeRunningExecution(secondPlanning);
      const duplicateNodeTask = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...secondRunning,
            nodes: [
              {
                ...secondRunning.nodes![0]!,
                taskId: firstRunning.nodes![0]!.taskId,
              },
            ],
          },
          expectedRevision: 2,
        }),
      );
      const duplicateNodeRun = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...secondRunning,
            nodes: [
              {
                ...secondRunning.nodes![0]!,
                runId: firstRunning.nodes![0]!.runId,
              },
            ],
          },
          expectedRevision: 2,
        }),
      );
      assert.equal(failureCode(duplicateNodeTask), "squad_execution_conflict");
      assert.equal(failureCode(duplicateNodeRun), "squad_execution_conflict");
      assert.deepEqual(
        Option.getOrThrow(yield* store.getExecution(secondQueued.executionId)),
        secondPlanning,
      );
    }),
  );

  it.effect("同状态更新不得改写节点、暂停来源或取消请求时间", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);

      const nodeQueued = makeQueuedExecution("execution-node-identity");
      const nodePlanning = makePlanningExecution(nodeQueued);
      const nodeRunning = makeRunningExecution(nodePlanning);
      yield* store.claimExecution(nodeQueued);
      yield* store.saveTransition({ execution: nodePlanning, expectedRevision: 1 });
      yield* store.saveTransition({ execution: nodeRunning, expectedRevision: 2 });
      const nodeDrift = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...nodeRunning,
            revision: 4,
            nodes: [
              {
                ...nodeRunning.nodes![0]!,
                taskId: "worker-task-drifted",
              },
            ],
            updatedAtUnixMs: 140,
          },
          expectedRevision: 3,
        }),
      );

      const pauseQueued = makeQueuedExecution("execution-pause-identity");
      const pausePlanning = makePlanningExecution(pauseQueued);
      const pauseRunning = makeRunningExecution(pausePlanning);
      const paused: CompositionSquadExecution = {
        ...pauseRunning,
        status: "paused",
        revision: 4,
        pausedFromStatus: "running",
        pausedAtUnixMs: 130,
        updatedAtUnixMs: 130,
      };
      yield* store.claimExecution(pauseQueued);
      yield* store.saveTransition({ execution: pausePlanning, expectedRevision: 1 });
      yield* store.saveTransition({ execution: pauseRunning, expectedRevision: 2 });
      yield* store.saveTransition({ execution: paused, expectedRevision: 3 });
      const pauseDrift = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...paused,
            revision: 5,
            pausedFromStatus: "in_review",
            pausedAtUnixMs: 140,
            updatedAtUnixMs: 140,
          },
          expectedRevision: 4,
        }),
      );

      const cancelQueued = makeQueuedExecution("execution-cancel-identity");
      const cancelPlanning = makePlanningExecution(cancelQueued);
      const cancelling: CompositionSquadExecution = {
        ...cancelPlanning,
        status: "cancelling",
        revision: 3,
        cancelRequestedAtUnixMs: 120,
        updatedAtUnixMs: 120,
      };
      yield* store.claimExecution(cancelQueued);
      yield* store.saveTransition({ execution: cancelPlanning, expectedRevision: 1 });
      yield* store.saveTransition({ execution: cancelling, expectedRevision: 2 });
      const cancelDrift = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...cancelling,
            revision: 4,
            cancelRequestedAtUnixMs: 130,
            updatedAtUnixMs: 130,
          },
          expectedRevision: 3,
        }),
      );

      assert.equal(failureCode(nodeDrift), "squad_execution_conflict");
      assert.equal(failureCode(pauseDrift), "squad_execution_conflict");
      assert.equal(failureCode(cancelDrift), "squad_execution_conflict");
    }),
  );

  it.effect("从 queued 暂停时拒绝补写启动时间并可恢复回 queued", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const queued = makeQueuedExecution("execution-paused-before-start");
      const paused: CompositionSquadExecution = {
        ...queued,
        status: "paused",
        revision: 2,
        pausedFromStatus: "queued",
        pausedAtUnixMs: 110,
        updatedAtUnixMs: 110,
      };
      yield* store.claimExecution(queued);
      assert.deepEqual(
        yield* store.saveTransition({ execution: paused, expectedRevision: 1 }),
        paused,
      );

      const injectedStart = yield* Effect.result(
        store.saveTransition({
          execution: {
            ...paused,
            revision: 3,
            startedAtUnixMs: 105,
            updatedAtUnixMs: 120,
          },
          expectedRevision: 2,
        }),
      );
      assert.equal(failureCode(injectedStart), "squad_execution_snapshot_invalid");

      const resumed: CompositionSquadExecution = {
        ...queued,
        revision: 3,
        updatedAtUnixMs: 120,
      };
      assert.deepEqual(
        yield* store.saveTransition({ execution: resumed, expectedRevision: 2 }),
        resumed,
      );
    }),
  );

  it.effect("并发 CAS 对不同目标只允许一个胜者，相同目标可安全重放", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const queued = makeQueuedExecution("execution-concurrent");
      const planningA = makePlanningExecution(queued, { updatedAtUnixMs: 120 });
      const planningB = makePlanningExecution(queued, { updatedAtUnixMs: 130 });
      yield* store.claimExecution(queued);

      const competing = yield* Effect.all(
        [
          Effect.result(store.saveTransition({ execution: planningA, expectedRevision: 1 })),
          Effect.result(store.saveTransition({ execution: planningB, expectedRevision: 1 })),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(competing.filter((result) => result._tag === "Success").length, 1);
      assert.equal(
        competing.filter(
          (result) =>
            result._tag === "Failure" &&
            failureCode(result) === "squad_execution_revision_conflict",
        ).length,
        1,
      );

      const current = Option.getOrThrow(yield* store.getExecution(queued.executionId));
      const running = makeRunningExecution(current);
      const sameTarget = yield* Effect.all(
        [
          store.saveTransition({ execution: running, expectedRevision: current.revision }),
          store.saveTransition({ execution: running, expectedRevision: current.revision }),
        ],
        { concurrency: "unbounded" },
      );
      assert.deepEqual(sameTarget, [running, running]);
    }),
  );

  it.effect("按项目、线程、Squad、状态查询并稳定列出未收敛执行", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const older = makeQueuedExecution("execution-older", {
        threadId: ThreadId.make("thread-filter"),
        createdAtUnixMs: 100,
        updatedAtUnixMs: 100,
      });
      const newer = makeQueuedExecution("execution-newer", {
        threadId: ThreadId.make("thread-filter"),
        createdAtUnixMs: 200,
        updatedAtUnixMs: 200,
      });
      const otherProject = makeQueuedExecution("execution-other-project", {
        projectId: "project-other",
        threadId: ThreadId.make("thread-other"),
        createdAtUnixMs: 300,
        updatedAtUnixMs: 300,
      });
      yield* store.claimExecution(older);
      yield* store.claimExecution(newer);
      yield* store.claimExecution(otherProject);

      assert.deepEqual(
        (yield* store.listExecutions({
          projectId: "project-execution",
          threadId: "thread-filter",
          squadId: "squad-execution",
          statuses: ["queued"],
          limit: 10,
        })).map((execution) => execution.executionId),
        ["execution-newer", "execution-older"],
      );
      const unsettled = yield* store.listUnsettledExecutions({ limit: 200 });
      assert.deepEqual(
        unsettled
          .map((execution) => execution.executionId)
          .filter(
            (executionId) => executionId === older.executionId || executionId === newer.executionId,
          ),
        ["execution-older", "execution-newer"],
      );
      const firstPage = yield* store.listUnsettledExecutions({ limit: 2 });
      const pageBoundary = firstPage.at(-1)!;
      const remaining = yield* store.listUnsettledExecutions({
        limit: 200,
        cursor: {
          updatedAtUnixMs: pageBoundary.updatedAtUnixMs,
          executionId: pageBoundary.executionId,
        },
      });
      assert.deepEqual([...firstPage, ...remaining], unsettled);

      const invalidCursor = yield* Effect.result(
        store.listUnsettledExecutions({
          limit: 10,
          cursor: { updatedAtUnixMs: -1, executionId: "" },
        }),
      );
      assert.equal(failureCode(invalidCursor), "squad_execution_list_cursor_invalid");
    }),
  );

  it.effect("坏记录会让单行读取与未收敛批次都 fail-closed", () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      const queued = makeQueuedExecution("execution-corrupt");
      const valid = makeQueuedExecution("execution-valid-alongside-corrupt", {
        createdAtUnixMs: 110,
        updatedAtUnixMs: 110,
      });
      yield* store.claimExecution(queued);
      yield* store.claimExecution(valid);
      yield* sql`
        UPDATE composition_squad_executions
        SET pending_approvals_json = '[{}]'
        WHERE execution_id = ${queued.executionId}
      `;

      const result = yield* Effect.result(store.getExecution(queued.executionId));
      const unsettledResult = yield* Effect.result(store.listUnsettledExecutions({ limit: 10 }));
      assert.equal(result._tag, "Failure");
      assert.equal(unsettledResult._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "PersistenceDecodeError");
      }
      if (unsettledResult._tag === "Failure") {
        assert.equal(unsettledResult.failure._tag, "PersistenceDecodeError");
      }
    }),
  );
});

it.effect("同一 SQLite 文件的两个独立连接保持 claim 与 CAS 竞争语义", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-squad-cas-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const queued = makeQueuedExecution("execution-file-concurrent");
  const claimFromConnection = () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      return yield* store.claimExecution(queued);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  const transitionFromConnection = (
    execution: CompositionSquadExecution,
    expectedRevision: number,
  ) =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      return yield* store.saveTransition({ execution, expectedRevision });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  const readFromConnection = () =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      return Option.getOrThrow(yield* store.getExecution(queued.executionId));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const claims = yield* Effect.all([claimFromConnection(), claimFromConnection()], {
      concurrency: "unbounded",
    });
    assert.deepEqual(claims.map((claim) => claim.claimed).sort(), [false, true]);

    const planningA = makePlanningExecution(queued, { updatedAtUnixMs: 120 });
    const planningB = makePlanningExecution(queued, { updatedAtUnixMs: 130 });
    const transitions = yield* Effect.all(
      [
        Effect.result(transitionFromConnection(planningA, 1)),
        Effect.result(transitionFromConnection(planningB, 1)),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(transitions.filter((result) => result._tag === "Success").length, 1);
    assert.equal(
      transitions.filter(
        (result) =>
          result._tag === "Failure" && failureCode(result) === "squad_execution_revision_conflict",
      ).length,
      1,
    );

    const current = yield* readFromConnection();
    const running = makeRunningExecution(current);
    assert.deepEqual(
      yield* Effect.all(
        [
          transitionFromConnection(running, current.revision),
          transitionFromConnection(running, current.revision),
        ],
        { concurrency: "unbounded" },
      ),
      [running, running],
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("两个 SQLite 连接竞争跨角色 Task 身份时只保留一个 execution", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-squad-binding-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const sharedTaskId = "task-shared-across-roles";
  const goalOwner = makeQueuedExecution("execution-binding-goal-owner", {
    goalTaskId: sharedTaskId,
  });
  const leaderOwner = makeQueuedExecution("execution-binding-leader-owner", {
    leaderTaskId: sharedTaskId,
  });
  const claimFromConnection = (execution: CompositionSquadExecution) =>
    Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      return yield* store.claimExecution(execution);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const claims = yield* Effect.all(
      [
        Effect.result(claimFromConnection(goalOwner)),
        Effect.result(claimFromConnection(leaderOwner)),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(claims.filter((result) => result._tag === "Success").length, 1);
    assert.equal(
      claims.filter(
        (result) => result._tag === "Failure" && failureCode(result) === "squad_execution_conflict",
      ).length,
      1,
    );

    const persisted = yield* Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      return {
        goalOwner: yield* store.getExecution(goalOwner.executionId),
        leaderOwner: yield* store.getExecution(leaderOwner.executionId),
        sharedBindings: yield* sql<{
          readonly executionId: string;
          readonly role: string;
        }>`
          SELECT execution_id AS "executionId", role
          FROM composition_squad_execution_bindings
          WHERE identity_kind = 'task' AND identity_id = ${sharedTaskId}
        `,
      };
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    assert.equal([persisted.goalOwner, persisted.leaderOwner].filter(Option.isSome).length, 1);
    assert.equal(persisted.sharedBindings.length, 1);
    assert.equal(["goal_task", "leader_task"].includes(persisted.sharedBindings[0]!.role), true);
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect(
  "两个 SQLite 连接并发 transition 争用同一节点 Task/Run 时只允许一个 execution 进入 running",
  () => {
    const tempDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-squad-node-binding-"),
    );
    const dbPath = NodePath.join(tempDir, "state.sqlite");
    const firstQueued = makeQueuedExecution("execution-node-binding-first");
    const secondQueued = makeQueuedExecution("execution-node-binding-second");
    const firstPlanning = makePlanningExecution(firstQueued);
    const secondPlanning = makePlanningExecution(secondQueued);
    const sharedTaskId = "shared-node-task";
    const sharedRunId = "shared-node-run";
    const makeSharedRunning = (planning: CompositionSquadExecution, nodeId: string) => {
      const running = makeRunningExecution(planning);
      return {
        ...running,
        nodes: [
          {
            ...running.nodes![0]!,
            nodeId,
            taskId: sharedTaskId,
            runId: sharedRunId,
          },
        ],
      } satisfies CompositionSquadExecution;
    };
    const transitionFromConnection = (execution: CompositionSquadExecution) =>
      Effect.gen(function* () {
        const store = yield* CompositionSquadExecutionStore;
        return yield* store.saveTransition({ execution, expectedRevision: 2 });
      }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* CompositionSquadExecutionStore;
        const sql = yield* SqlClient.SqlClient;
        yield* seedSquadRevision(sql);
        yield* store.claimExecution(firstQueued);
        yield* store.claimExecution(secondQueued);
        yield* store.saveTransition({ execution: firstPlanning, expectedRevision: 1 });
        yield* store.saveTransition({ execution: secondPlanning, expectedRevision: 1 });
      }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

      const firstRunning = makeSharedRunning(firstPlanning, "node-binding-first");
      const secondRunning = makeSharedRunning(secondPlanning, "node-binding-second");
      const transitions = yield* Effect.all(
        [
          Effect.result(transitionFromConnection(firstRunning)),
          Effect.result(transitionFromConnection(secondRunning)),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(transitions.filter((result) => result._tag === "Success").length, 1);
      assert.equal(
        transitions.filter(
          (result) =>
            result._tag === "Failure" && failureCode(result) === "squad_execution_conflict",
        ).length,
        1,
      );

      const persisted = yield* Effect.gen(function* () {
        const store = yield* CompositionSquadExecutionStore;
        const sql = yield* SqlClient.SqlClient;
        return {
          first: Option.getOrThrow(yield* store.getExecution(firstQueued.executionId)),
          second: Option.getOrThrow(yield* store.getExecution(secondQueued.executionId)),
          sharedBindings: yield* sql<{
            readonly executionId: string;
            readonly identityKind: string;
            readonly identityId: string;
            readonly role: string;
            readonly nodeId: string | null;
          }>`
          SELECT
            execution_id AS "executionId",
            identity_kind AS "identityKind",
            identity_id AS "identityId",
            role,
            node_id AS "nodeId"
          FROM composition_squad_execution_bindings
          WHERE (
            execution_id = ${firstQueued.executionId}
            OR execution_id = ${secondQueued.executionId}
          )
            AND role IN ('node_task', 'node_run')
          ORDER BY identity_kind ASC
        `,
        };
      }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
      const candidates = [
        { persisted: persisted.first, planning: firstPlanning, running: firstRunning },
        { persisted: persisted.second, planning: secondPlanning, running: secondRunning },
      ];
      assert.deepEqual(candidates.map(({ persisted: execution }) => execution.status).sort(), [
        "planning",
        "running",
      ]);
      const winner = candidates.find(({ persisted: execution }) => execution.status === "running")!;
      const loser = candidates.find(({ persisted: execution }) => execution.status === "planning")!;
      assert.deepEqual(winner.persisted, winner.running);
      assert.deepEqual(loser.persisted, loser.planning);
      const winnerNode = winner.running.nodes![0]!;
      assert.deepEqual(persisted.sharedBindings, [
        {
          executionId: winner.running.executionId,
          identityKind: "run",
          identityId: sharedRunId,
          role: "node_run",
          nodeId: winnerNode.nodeId,
        },
        {
          executionId: winner.running.executionId,
          identityKind: "task",
          identityId: sharedTaskId,
          role: "node_task",
          nodeId: winnerNode.nodeId,
        },
      ]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("使用同一 SQLite 文件重建 Layer 后仍可恢复未收敛 execution", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-squad-execution-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const queued = makeQueuedExecution("execution-restart");
  const planning = makePlanningExecution(queued);

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      yield* store.claimExecution(queued);
      yield* store.saveTransition({ execution: planning, expectedRevision: 1 });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      assert.deepEqual(Option.getOrThrow(yield* store.getExecution(queued.executionId)), planning);
      const running = makeRunningExecution(planning);
      assert.deepEqual(
        yield* store.saveTransition({ execution: running, expectedRevision: 2 }),
        running,
      );
      assert.deepEqual(yield* store.listUnsettledExecutions({ limit: 10 }), [running]);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("旧 execution 缺失 plan 摘要时可跨重启读取、列出并继续推进", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-squad-plan-legacy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const queued = withoutPlanDigest(makeQueuedExecution("execution-plan-legacy-store"));
  const planning = makePlanningExecution(queued);

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const sql = yield* SqlClient.SqlClient;
      yield* seedSquadRevision(sql);
      yield* store.claimExecution(queued);

      assert.deepEqual(Option.getOrThrow(yield* store.getExecution(queued.executionId)), queued);
      assert.deepEqual(
        yield* store.listExecutions({
          projectId: queued.projectId,
          squadId: queued.squadId,
          limit: 10,
        }),
        [queued],
      );
      assert.deepEqual(yield* store.listUnsettledExecutions({ limit: 10 }), [queued]);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    yield* Effect.gen(function* () {
      const store = yield* CompositionSquadExecutionStore;
      const restored = Option.getOrThrow(yield* store.getExecution(queued.executionId));
      assert.deepEqual(restored, queued);
      assert.isFalse("planDigest" in restored);
      assert.deepEqual(
        yield* store.saveTransition({ execution: planning, expectedRevision: 1 }),
        planning,
      );
      assert.deepEqual(yield* store.listUnsettledExecutions({ limit: 10 }), [planning]);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
