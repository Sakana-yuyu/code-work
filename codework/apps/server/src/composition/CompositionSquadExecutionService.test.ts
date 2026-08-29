import { ThreadId, type CompositionSquadExecution } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionListInput,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import {
  COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT,
  makeCompositionSquadExecutionService,
} from "./CompositionSquadExecutionService.ts";

const makeExecution = (
  executionId: string,
  createdAtUnixMs: number,
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
});

const makeStore = (
  listExecutions: CompositionSquadExecutionStoreShape["listExecutions"],
): Pick<CompositionSquadExecutionStoreShape, "listExecutions"> => ({ listExecutions });

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
      });
      const error = yield* Effect.flip(service.list());

      assert.equal(error.code, "squad_execution_persistence_failed");
      assert.equal(error.detail, "列出 Squad execution 历史失败。");
      assert.notInclude(error.detail, sentinel);
      assert.notInclude(error.message, sentinel);
    }
  }),
);
