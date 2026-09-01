import type { ProjectId, ThreadId } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  makeCompositionAutomationExecutionContextResolver,
  type CompositionAutomationExecutionContextLookup,
} from "./CompositionAutomationExecutionContext.ts";

const projectId = "project-automation-context" as ProjectId;
const threadId = "thread-automation-context" as ThreadId;

const makeLookup = (
  getThreadCheckpointContext: CompositionAutomationExecutionContextLookup["getThreadCheckpointContext"],
): CompositionAutomationExecutionContextLookup => ({ getThreadCheckpointContext });

describe("CompositionAutomationExecutionContext", () => {
  it.effect("isolated 上下文直接返回保存的 workspaceRoot", () =>
    Effect.gen(function* () {
      let lookups = 0;
      const resolver = makeCompositionAutomationExecutionContextResolver({
        lookup: makeLookup(() => {
          lookups += 1;
          return Effect.succeed(Option.none());
        }),
      });

      const resolved = yield* resolver.resolve({
        projectId,
        executionContext: {
          mode: "isolated",
          workspaceRoot: "E:/workspace/isolated",
          archiveOnFinish: true,
        },
      });

      assert.deepEqual(resolved, { workspaceRoot: "E:/workspace/isolated" });
      assert.equal(lookups, 0);
    }),
  );

  it.effect("existing thread 校验项目并优先使用 worktreePath", () =>
    Effect.gen(function* () {
      const resolver = makeCompositionAutomationExecutionContextResolver({
        lookup: makeLookup(() =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId,
              workspaceRoot: "E:/workspace/project",
              worktreePath: "E:/workspace/project/.t3/worktrees/feature-a",
              checkpoints: [],
            }),
          ),
        ),
      });

      const resolved = yield* resolver.resolve({
        projectId,
        executionContext: { mode: "existing_thread", threadId },
      });

      assert.deepEqual(resolved, {
        workspaceRoot: "E:/workspace/project/.t3/worktrees/feature-a",
        threadId,
      });
    }),
  );

  it.effect("existing thread 不属于 Automation 项目时拒绝启动", () =>
    Effect.gen(function* () {
      const resolver = makeCompositionAutomationExecutionContextResolver({
        lookup: makeLookup(() =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId: "project-other" as ProjectId,
              workspaceRoot: "E:/workspace/other",
              worktreePath: null,
              checkpoints: [],
            }),
          ),
        ),
      });

      const error = yield* resolver
        .resolve({
          projectId,
          executionContext: { mode: "existing_thread", threadId },
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "automation_thread_project_mismatch");
      assert.equal(error.retryable, false);
    }),
  );

  it.effect("existing thread 缺失时返回永久错误", () =>
    Effect.gen(function* () {
      const resolver = makeCompositionAutomationExecutionContextResolver({
        lookup: makeLookup(() => Effect.succeed(Option.none())),
      });

      const error = yield* resolver
        .resolve({
          projectId,
          executionContext: { mode: "existing_thread", threadId },
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "automation_thread_not_found");
      assert.equal(error.retryable, false);
    }),
  );

  it.effect("投影查询失败时返回可重试错误", () =>
    Effect.gen(function* () {
      const resolver = makeCompositionAutomationExecutionContextResolver({
        lookup: makeLookup(() => Effect.fail({} as ProjectionRepositoryError)),
      });

      const error = yield* resolver
        .resolve({
          projectId,
          executionContext: { mode: "existing_thread", threadId },
        })
        .pipe(Effect.flip);

      assert.equal(error.code, "automation_context_lookup_failed");
      assert.equal(error.retryable, true);
    }),
  );
});
