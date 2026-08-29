import {
  ProjectId,
  ThreadId,
  type CompositionAutomationExecutionContext,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const decodeProjectId = Schema.decodeUnknownEffect(ProjectId);
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId);

export interface CompositionAutomationExecutionContextInput {
  readonly projectId: string;
  readonly executionContext: CompositionAutomationExecutionContext;
}

export interface ResolvedCompositionAutomationExecutionContext {
  readonly workspaceRoot: string;
  readonly threadId?: string;
}

export class CompositionAutomationExecutionContextError extends Schema.TaggedErrorClass<CompositionAutomationExecutionContextError>()(
  "CompositionAutomationExecutionContextError",
  {
    code: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Automation 执行上下文解析失败：${this.code}: ${this.detail}`;
  }
}

export type CompositionAutomationExecutionContextLookup = Pick<
  ProjectionSnapshotQueryShape,
  "getThreadCheckpointContext"
>;

export interface CompositionAutomationExecutionContextResolverShape {
  readonly resolve: (
    input: CompositionAutomationExecutionContextInput,
  ) => Effect.Effect<
    ResolvedCompositionAutomationExecutionContext,
    CompositionAutomationExecutionContextError
  >;
}

export class CompositionAutomationExecutionContextResolver extends Context.Service<
  CompositionAutomationExecutionContextResolver,
  CompositionAutomationExecutionContextResolverShape
>()(
  "codework/composition/CompositionAutomationExecutionContext/CompositionAutomationExecutionContextResolver",
) {}

export interface CompositionAutomationExecutionContextResolverOptions {
  readonly lookup: CompositionAutomationExecutionContextLookup;
}

const contextError = (
  code: string,
  detail: string,
  retryable: boolean,
): CompositionAutomationExecutionContextError =>
  new CompositionAutomationExecutionContextError({ code, detail, retryable });

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makeCompositionAutomationExecutionContextResolver = (
  options: CompositionAutomationExecutionContextResolverOptions,
): CompositionAutomationExecutionContextResolverShape => ({
  resolve: Effect.fn("CompositionAutomationExecutionContextResolver.resolve")(function* (input) {
    if (input.executionContext.mode === "isolated") {
      return { workspaceRoot: input.executionContext.workspaceRoot };
    }

    const requestedThreadId = input.executionContext.threadId;
    const projectId = yield* decodeProjectId(input.projectId).pipe(
      Effect.mapError(() =>
        contextError(
          "automation_project_id_invalid",
          `Automation projectId 无效：${input.projectId}`,
          false,
        ),
      ),
    );
    const threadId = yield* decodeThreadId(requestedThreadId).pipe(
      Effect.mapError(() =>
        contextError(
          "automation_thread_id_invalid",
          `Automation threadId 无效：${requestedThreadId}`,
          false,
        ),
      ),
    );
    const context = yield* options.lookup
      .getThreadCheckpointContext(threadId)
      .pipe(
        Effect.mapError((cause) =>
          contextError(
            "automation_context_lookup_failed",
            `读取线程 ${threadId} 的执行上下文失败：${errorDetail(cause)}`,
            true,
          ),
        ),
      );
    if (Option.isNone(context)) {
      return yield* contextError(
        "automation_thread_not_found",
        `线程 ${threadId} 不存在或已删除。`,
        false,
      );
    }
    if (context.value.projectId !== projectId) {
      return yield* contextError(
        "automation_thread_project_mismatch",
        `线程 ${threadId} 属于项目 ${context.value.projectId}，与 Automation 项目 ${projectId} 不一致。`,
        false,
      );
    }
    return {
      workspaceRoot: context.value.worktreePath ?? context.value.workspaceRoot,
      threadId: requestedThreadId,
    };
  }),
});

const live = Effect.gen(function* () {
  const lookup = yield* ProjectionSnapshotQuery;
  return makeCompositionAutomationExecutionContextResolver({ lookup });
});

export const layer = Layer.effect(CompositionAutomationExecutionContextResolver, live);
