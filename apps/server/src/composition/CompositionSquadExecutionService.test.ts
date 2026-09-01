import {
  ApprovalRequestId,
  COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
  ThreadId,
  type CompositionSquad,
  type CompositionSquadExecution,
  type CompositionSquadExecutionListRequest,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionListInput,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import {
  COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT,
  makeCompositionSquadExecutionService,
} from "./CompositionSquadExecutionService.ts";

const makeExecution = (
  executionId: string,
  createdAtUnixMs: number,
  overrides: Partial<CompositionSquadExecution> = {},
): CompositionSquadExecution => ({
  executionId,
  squadId: "squad-history",
  squadRevision: 1,
  projectId: "project-history",
  threadId: ThreadId.make("thread-history"),
  goalDigest: `sha256:goal-${executionId}`,
  goalTaskId: `${executionId}:task:goal`,
  workspaceRootDigest: "sha256:workspace-history",
  status: "queued",
  revision: 1,
  leaderTaskId: `${executionId}:task:leader`,
  leaderRunId: `${executionId}:run:leader:1`,
  pendingApprovals: [],
  createdAtUnixMs,
  updatedAtUnixMs: createdAtUnixMs,
  ...overrides,
});

const makeStore = (
  listExecutions: CompositionSquadExecutionStoreShape["listExecutions"],
): Pick<CompositionSquadExecutionStoreShape, "listExecutions"> => ({ listExecutions });

const makeSquadStore = (
  listSquads: CompositionTaskStoreShape["listSquads"],
): Pick<CompositionTaskStoreShape, "listSquads"> => ({ listSquads });

const emptySquadStore = makeSquadStore(() => Effect.succeed([]));

it.effect("默认限制为 50，并原样转发 execution 历史过滤条件", () =>
  Effect.gen(function* () {
    const requests: CompositionSquadExecutionListInput[] = [];
    const newer = makeExecution("execution-newer", 200);
    const older = makeExecution("execution-older", 100);
    const service = makeCompositionSquadExecutionService({
      store: makeStore((input) =>
        Effect.sync(() => {
          requests.push(input);
          return [newer, older];
        }),
      ),
      squadStore: emptySquadStore,
    });

    assert.deepEqual(yield* service.list(), [newer, older]);
    assert.deepEqual(requests[0], {
      limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT,
    });

    const filtered = yield* service.list({
      projectId: "project-history",
      threadId: ThreadId.make("thread-history"),
      squadId: "squad-history",
      statuses: ["queued", "failed"],
      limit: 200,
    });
    assert.deepEqual(filtered, [newer, older]);
    assert.deepEqual(requests[1], {
      projectId: "project-history",
      threadId: "thread-history",
      squadId: "squad-history",
      statuses: ["queued", "failed"],
      limit: 200,
    });
  }),
);

it.effect("保留 Store 的稳定倒序并允许空结果", () =>
  Effect.gen(function* () {
    const newer = makeExecution("execution-newer", 200);
    const older = makeExecution("execution-older", 100);
    let call = 0;
    const service = makeCompositionSquadExecutionService({
      store: makeStore(() => Effect.succeed(call++ === 0 ? [newer, older] : [])),
      squadStore: emptySquadStore,
    });

    assert.deepEqual(yield* service.list({ statuses: ["queued"] }), [newer, older]);
    assert.deepEqual(yield* service.list({ statuses: [] }), []);
  }),
);

it.effect("保留列表上限领域错误，但不泄漏持久层 detail", () =>
  Effect.gen(function* () {
    const sentinel = "SECRET_LIMIT_DETAIL";
    const service = makeCompositionSquadExecutionService({
      store: makeStore(() =>
        Effect.fail(
          new CompositionSquadExecutionStoreDomainError({
            code: "squad_execution_list_limit_invalid",
            detail: sentinel,
            executionId: "*",
          }),
        ),
      ),
      squadStore: emptySquadStore,
    });

    const error = yield* Effect.flip(service.list({ limit: 200 }));
    assert.equal(error.code, "squad_execution_list_limit_invalid");
    assert.notInclude(error.detail, sentinel);
    assert.notInclude(error.message, sentinel);
  }),
);

it.effect("SQL 与坏记录错误统一脱敏为稳定查询失败", () =>
  Effect.gen(function* () {
    const sentinel = "SECRET_PERSISTENCE_DETAIL";
    const causes = [
      new PersistenceSqlError({
        operation: "list secret executions",
        detail: `${sentinel}: SELECT * FROM private_table`,
      }),
      new PersistenceDecodeError({
        operation: "decode secret execution",
        issue: `${sentinel}: malformed private payload`,
      }),
    ];

    for (const cause of causes) {
      const service = makeCompositionSquadExecutionService({
        store: makeStore(() => Effect.fail(cause)),
        squadStore: emptySquadStore,
      });
      const error = yield* Effect.flip(service.list());

      assert.equal(error.code, "squad_execution_persistence_failed");
      assert.equal(error.detail, "列出 Squad execution 历史失败。");
      assert.notInclude(error.detail, sentinel);
      assert.notInclude(error.message, sentinel);
    }
  }),
);

it.effect("在服务端把 execution 映射为有上限的历史摘要，并只查询一次 Squad 名称", () =>
  Effect.gen(function* () {
    const listInputs: CompositionSquadExecutionListInput[] = [];
    const squadListInputs: Array<{ readonly includeArchived?: boolean } | undefined> = [];
    const awaitingApproval = makeExecution("execution-awaiting", 100, {
      squadId: "squad-known",
      squadRevision: 4,
      projectId: "project-history",
      goalDigest: "sha256:SECRET_GOAL",
      planDigest: "sha256:SECRET_PLAN",
      workspaceRootDigest: "sha256:SECRET_WORKSPACE",
      status: "awaiting_approval",
      nodes: [
        {
          nodeId: "node-1",
          agentId: "agent-worker",
          taskId: "task-node-1",
          runId: "run-node-1",
          promptDigest: "sha256:SECRET_PROMPT",
          dependsOnNodeIds: [],
        },
      ],
      pendingApprovals: [
        {
          approvalRequestId: ApprovalRequestId.make("approval-1"),
          stage: "before_dispatch",
          requestedAtUnixMs: 120,
        },
      ],
      startedAtUnixMs: 110,
      updatedAtUnixMs: 120,
    });
    const failed = makeExecution("execution-failed", 200, {
      squadId: "squad-missing",
      squadRevision: 2,
      projectId: "project-history",
      goalDigest: "sha256:SECRET_FAILED_GOAL",
      workspaceRootDigest: "sha256:SECRET_FAILED_WORKSPACE",
      status: "failed",
      failureCode: "provider_unavailable",
      failureDetail: "SECRET_FAILURE_DETAIL",
      startedAtUnixMs: 210,
      finishedAtUnixMs: 220,
      updatedAtUnixMs: 220,
    });
    const completed = makeExecution("execution-completed", 300, {
      squadId: "squad-known",
      squadRevision: 5,
      projectId: "project-history",
      status: "completed",
      nodes: [
        {
          nodeId: "node-2",
          agentId: "agent-reviewer",
          taskId: "task-node-2",
          runId: "run-node-2",
          promptDigest: "sha256:SECRET_COMPLETED_PROMPT",
          dependsOnNodeIds: [],
        },
      ],
      resultSummary: "全部节点完成。",
      startedAtUnixMs: 310,
      finishedAtUnixMs: 320,
      updatedAtUnixMs: 320,
    });
    const squads: ReadonlyArray<CompositionSquad> = [
      {
        squadId: "squad-known",
        name: "发布检查组",
        leaderAgentId: "agent-leader",
        memberAgentIds: ["agent-leader"],
        archivedAtUnixMs: 500,
      },
    ];
    const service = makeCompositionSquadExecutionService({
      store: makeStore((input) =>
        Effect.sync(() => {
          listInputs.push(input);
          return [awaitingApproval, failed, completed];
        }),
      ),
      squadStore: makeSquadStore((input) =>
        Effect.sync(() => {
          squadListInputs.push(input);
          return squads;
        }),
      ),
    });

    const request = {
      projectId: "project-history",
      statuses: ["awaiting_approval", "failed", "completed"],
      limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT + 99,
    } as CompositionSquadExecutionListRequest;
    const summaries = yield* service.listSummaries(request);

    assert.deepEqual(listInputs, [
      {
        projectId: "project-history",
        statuses: ["awaiting_approval", "failed", "completed"],
        limit: COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
      },
    ]);
    assert.deepEqual(squadListInputs, [{ includeArchived: true }]);
    assert.deepEqual(summaries, [
      {
        executionId: "execution-awaiting",
        squadId: "squad-known",
        squadDisplayName: "发布检查组",
        projectId: "project-history",
        status: "awaiting_approval",
        squadRevision: 4,
        nodeCount: 1,
        pendingApprovalCount: 1,
        createdAtUnixMs: 100,
      },
      {
        executionId: "execution-failed",
        squadId: "squad-missing",
        squadDisplayName: "squad-missing",
        projectId: "project-history",
        status: "failed",
        squadRevision: 2,
        nodeCount: 0,
        pendingApprovalCount: 0,
        createdAtUnixMs: 200,
        failureCode: "provider_unavailable",
      },
      {
        executionId: "execution-completed",
        squadId: "squad-known",
        squadDisplayName: "发布检查组",
        projectId: "project-history",
        status: "completed",
        squadRevision: 5,
        nodeCount: 1,
        pendingApprovalCount: 0,
        createdAtUnixMs: 300,
        resultSummary: "全部节点完成。",
      },
    ]);
    for (const summary of summaries) {
      for (const forbiddenField of [
        "goalDigest",
        "planDigest",
        "workspaceRootDigest",
        "failureDetail",
        "goalTaskId",
        "leaderTaskId",
        "leaderRunId",
        "nodes",
        "pendingApprovals",
      ]) {
        assert.equal(Object.hasOwn(summary, forbiddenField), false);
      }
    }
  }),
);

it.effect("空 execution 结果不查询 Squad 配置", () =>
  Effect.gen(function* () {
    let squadListCalls = 0;
    const service = makeCompositionSquadExecutionService({
      store: makeStore(() => Effect.succeed([])),
      squadStore: makeSquadStore(() =>
        Effect.sync(() => {
          squadListCalls += 1;
          return [];
        }),
      ),
    });

    assert.deepEqual(yield* service.listSummaries({ limit: 20 }), []);
    assert.equal(squadListCalls, 0);
  }),
);

it.effect("Squad 名称查询失败时返回稳定脱敏错误", () =>
  Effect.gen(function* () {
    const sentinel = "SECRET_SQUAD_LOOKUP_DETAIL";
    const service = makeCompositionSquadExecutionService({
      store: makeStore(() => Effect.succeed([makeExecution("execution-1", 100)])),
      squadStore: makeSquadStore(() =>
        Effect.fail(
          new PersistenceSqlError({
            operation: "list secret squads",
            detail: `${sentinel}: SELECT configuration_json FROM composition_squads`,
          }),
        ),
      ),
    });

    const error = yield* Effect.flip(service.listSummaries({ limit: 20 }));
    assert.equal(error.code, "squad_execution_persistence_failed");
    assert.equal(error.detail, "读取 Squad 显示名称失败。");
    assert.notInclude(error.message, sentinel);
  }),
);
