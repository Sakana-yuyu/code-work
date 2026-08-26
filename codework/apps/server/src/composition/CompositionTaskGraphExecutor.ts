import type {
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import {
  type CompositionDispatchInput,
  type CompositionDispatchResult,
  type CompositionOrchestrator,
} from "./CompositionOrchestrator.ts";
import { CompositionOrchestratorService } from "./CompositionOrchestratorService.ts";
import {
  CompositionTaskRuntimeProjectionService,
  type CompositionTaskRuntimeProjectionServiceShape,
} from "./CompositionTaskRuntimeProjectionService.ts";

export class CompositionTaskGraphExecutionError extends Schema.TaggedErrorClass<CompositionTaskGraphExecutionError>()(
  "CompositionTaskGraphExecutionError",
  {
    code: Schema.String,
    detail: Schema.String,
    nodeId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Task Graph 执行失败：${this.code}: ${this.detail}`;
  }
}

type GraphDispatchInput = Omit<
  CompositionDispatchInput,
  "parentTaskId" | "dependsOnTaskIds" | "mode"
> & {
  readonly prompt: string;
  readonly workspaceRoot: string;
};

export type CompositionTaskGraphNodeInput = GraphDispatchInput & {
  readonly nodeId: string;
  readonly mode: "serial" | "parallel";
  readonly dependsOnNodeIds?: ReadonlyArray<string>;
  readonly maxAttempts?: number;
};

export type CompositionTaskGraphLeaderInput = GraphDispatchInput & {
  readonly mode?: "review";
};

export type CompositionTaskGraphExecutionInput = {
  readonly leader: CompositionTaskGraphLeaderInput;
  readonly children: ReadonlyArray<CompositionTaskGraphNodeInput>;
  readonly schedule?: "serial" | "parallel";
};

export type CompositionTaskGraphNodeResult = {
  readonly nodeId: string;
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly attempts: number;
  readonly dispatches: ReadonlyArray<CompositionDispatchResult>;
};

export type CompositionTaskGraphExecutionResult = {
  readonly leader: CompositionDispatchResult;
  readonly children: ReadonlyArray<CompositionTaskGraphNodeResult>;
};

export interface CompositionTaskGraphExecutorShape {
  readonly execute: (
    input: CompositionTaskGraphExecutionInput,
  ) => Effect.Effect<CompositionTaskGraphExecutionResult, CompositionTaskGraphExecutionError>;
}

export class CompositionTaskGraphExecutor extends Context.Service<
  CompositionTaskGraphExecutor,
  CompositionTaskGraphExecutorShape
>()("codework/composition/CompositionTaskGraphExecutor") {}

type GraphExecutorOptions = {
  readonly orchestrator: Pick<CompositionOrchestrator, "dispatchTask" | "retryTask">;
  readonly store: Pick<CompositionTaskStoreShape, "getTask">;
  readonly runtime: Pick<CompositionTaskRuntimeProjectionServiceShape, "awaitTaskCompletion">;
};

type SettledTask = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
};

type RunningNode = {
  readonly node: CompositionTaskGraphNodeInput;
  readonly dispatch: CompositionDispatchResult;
  readonly dispatches: ReadonlyArray<CompositionDispatchResult>;
};

const terminalStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

const nonEmpty = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0;

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return "task_graph_dependency_failed";
};

const graphError = (
  code: string,
  detail: string,
  nodeId?: string,
): CompositionTaskGraphExecutionError =>
  new CompositionTaskGraphExecutionError({
    code,
    detail,
    ...(nodeId === undefined ? {} : { nodeId }),
  });

const normalizeError = (error: unknown): CompositionTaskGraphExecutionError =>
  Schema.is(CompositionTaskGraphExecutionError)(error)
    ? error
    : graphError(errorCode(error), errorDetail(error));

const retryRunId = (initialRunId: string, attempt: number): string =>
  `${initialRunId}:retry:${attempt}`;

const validateGraph = (
  input: CompositionTaskGraphExecutionInput,
): CompositionTaskGraphExecutionError | undefined => {
  if (!nonEmpty(input.leader.taskId) || !nonEmpty(input.leader.runId)) {
    return graphError("leader_identity_missing", "Leader taskId 和 runId 不能为空。", "leader");
  }
  if (!nonEmpty(input.leader.prompt) || !nonEmpty(input.leader.workspaceRoot)) {
    return graphError(
      "leader_input_missing",
      "Leader prompt 和 workspaceRoot 不能为空。",
      "leader",
    );
  }

  const nodeIds = new Set<string>();
  const taskIds = new Set<string>([input.leader.taskId]);
  const runIds = new Set<string>([input.leader.runId]);
  const nodesById = new Map<string, CompositionTaskGraphNodeInput>();
  for (const node of input.children) {
    if (!nonEmpty(node.nodeId) || !nonEmpty(node.taskId) || !nonEmpty(node.runId)) {
      return graphError(
        "child_identity_missing",
        "子任务 nodeId、taskId 和 runId 不能为空。",
        node.nodeId,
      );
    }
    if (nodeIds.has(node.nodeId)) {
      return graphError("duplicate_node_id", `重复的 nodeId：${node.nodeId}`, node.nodeId);
    }
    if (taskIds.has(node.taskId)) {
      return graphError("duplicate_task_id", `重复的 taskId：${node.taskId}`, node.nodeId);
    }
    if (runIds.has(node.runId)) {
      return graphError("duplicate_run_id", `重复的 runId：${node.runId}`, node.nodeId);
    }
    if (!nonEmpty(node.prompt) || !nonEmpty(node.workspaceRoot)) {
      return graphError(
        "child_input_missing",
        "子任务 prompt 和 workspaceRoot 不能为空。",
        node.nodeId,
      );
    }
    if (
      node.maxAttempts !== undefined &&
      (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1)
    ) {
      return graphError("invalid_max_attempts", "maxAttempts 必须是大于 0 的整数。", node.nodeId);
    }
    if ((node.maxAttempts ?? 1) > 1 && (node.capabilityIds?.length ?? 0) === 0) {
      return graphError(
        "retry_capabilities_required",
        "当前 Orchestrator 的重试需要显式 capabilityIds，不能对无 capability 的子任务自动重试。",
        node.nodeId,
      );
    }
    nodeIds.add(node.nodeId);
    taskIds.add(node.taskId);
    runIds.add(node.runId);
    nodesById.set(node.nodeId, node);
  }

  for (const node of input.children) {
    for (const dependencyId of node.dependsOnNodeIds ?? []) {
      if (!nodesById.has(dependencyId)) {
        return graphError(
          "dependency_node_missing",
          `依赖的 nodeId 不存在：${dependencyId}`,
          node.nodeId,
        );
      }
      if (dependencyId === node.nodeId) {
        return graphError("dependency_cycle", "子任务不能依赖自身。", node.nodeId);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false;
    if (visited.has(nodeId)) return true;
    visiting.add(nodeId);
    const node = nodesById.get(nodeId);
    for (const dependencyId of node?.dependsOnNodeIds ?? []) {
      if (!visit(dependencyId)) return false;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return true;
  };
  for (const node of input.children) {
    if (!visit(node.nodeId)) {
      return graphError("dependency_cycle", "子任务依赖图存在循环。", node.nodeId);
    }
  }
  return undefined;
};

const make = (options: GraphExecutorOptions): CompositionTaskGraphExecutorShape => {
  const getSettledTask = (taskId: string, run: CompositionTaskRun, nodeId: string) =>
    options.store.getTask(taskId).pipe(
      Effect.mapError((error) => graphError(errorCode(error), errorDetail(error), nodeId)),
      Effect.flatMap((taskOption) =>
        Option.match(taskOption, {
          onNone: () =>
            Effect.fail(graphError("task_projection_missing", `任务投影不存在：${taskId}`, nodeId)),
          onSome: (task) => Effect.succeed({ task, run } satisfies SettledTask),
        }),
      ),
    );

  const awaitSettled = (input: {
    readonly taskId: string;
    readonly runId: string;
    readonly nodeId: string;
  }) =>
    options.runtime
      .awaitTaskCompletion(input)
      .pipe(
        Effect.mapError((error) => graphError(errorCode(error), errorDetail(error), input.nodeId)),
      );

  const startNode = (
    node: CompositionTaskGraphNodeInput,
    dependencyTaskIds: ReadonlyArray<string>,
    leaderTaskId: string,
  ): Effect.Effect<RunningNode, CompositionTaskGraphExecutionError> =>
    Effect.gen(function* () {
      const dispatch = yield* options.orchestrator
        .dispatchTask({
          taskId: node.taskId,
          runId: node.runId,
          projectId: node.projectId,
          ...(node.threadId === undefined ? {} : { threadId: node.threadId }),
          parentTaskId: leaderTaskId,
          assigneeKind: node.assigneeKind,
          assigneeId: node.assigneeId,
          mode: node.mode,
          promptDigest: node.promptDigest,
          dependsOnTaskIds: [...dependencyTaskIds],
          workspaceRoot: node.workspaceRoot,
          ...(node.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: node.workspaceRootDigest }),
          prompt: node.prompt,
          ...(node.model === undefined ? {} : { model: node.model }),
          ...(node.capabilityIds === undefined ? {} : { capabilityIds: [...node.capabilityIds] }),
        })
        .pipe(
          Effect.mapError((error) => graphError(errorCode(error), errorDetail(error), node.nodeId)),
        );
      return { node, dispatch, dispatches: [dispatch] } satisfies RunningNode;
    });

  const settleNode = (
    started: RunningNode,
  ): Effect.Effect<CompositionTaskGraphNodeResult, CompositionTaskGraphExecutionError> =>
    Effect.gen(function* () {
      const { node } = started;
      yield* Effect.logDebug(
        `Task Graph 开始等待子任务：${node.nodeId}/${started.dispatch.run.runId}`,
      );
      const maxAttempts = node.maxAttempts ?? 1;
      const dispatches = [...started.dispatches];
      let dispatch = started.dispatch;
      for (;;) {
        const run = terminalStatuses.has(dispatch.run.status)
          ? dispatch.run
          : yield* awaitSettled({
              taskId: node.taskId,
              runId: dispatch.run.runId,
              nodeId: node.nodeId,
            });
        const settled = yield* getSettledTask(node.taskId, run, node.nodeId);
        yield* Effect.logDebug(
          `Task Graph 收到子任务终态：${node.nodeId}/${settled.run.runId}/${settled.run.status}`,
        );
        if (settled.run.status === "completed") {
          return {
            nodeId: node.nodeId,
            task: settled.task,
            run: settled.run,
            attempts: dispatches.length,
            dispatches,
          } satisfies CompositionTaskGraphNodeResult;
        }
        if (dispatches.length >= maxAttempts) {
          return yield* graphError(
            "child_failed",
            `子任务未完成：${settled.run.failureCode ?? settled.run.status}；${settled.run.resultSummary ?? "无结果摘要"}`,
            node.nodeId,
          );
        }

        const nextRunId = retryRunId(node.runId, dispatches.length + 1);
        const retry = yield* options.orchestrator
          .retryTask({
            taskId: node.taskId,
            previousRunId: settled.run.runId,
            runId: nextRunId,
            reason: `Task Graph 自动重试第 ${dispatches.length + 1} 次`,
            capabilityIds: [...(node.capabilityIds ?? [])],
          })
          .pipe(
            Effect.mapError((error) =>
              graphError(errorCode(error), errorDetail(error), node.nodeId),
            ),
          );
        dispatch = retry;
        dispatches.push(retry);
      }
    });

  const execute: CompositionTaskGraphExecutorShape["execute"] = (input) =>
    Effect.gen(function* () {
      const validationError = validateGraph(input);
      if (validationError !== undefined) return yield* validationError;

      const nodesById = new Map(input.children.map((node) => [node.nodeId, node] as const));
      const pending = new Set(input.children.map((node) => node.nodeId));
      const results = new Map<string, CompositionTaskGraphNodeResult>();

      while (pending.size > 0) {
        const ready = input.children.filter(
          (node) =>
            pending.has(node.nodeId) &&
            (node.dependsOnNodeIds ?? []).every((dependencyId) => {
              const dependency = results.get(dependencyId);
              return dependency !== undefined && dependency.run.status === "completed";
            }),
        );
        if (ready.length === 0) {
          return yield* graphError(
            "graph_not_progressing",
            "没有可调度的就绪子任务，依赖图状态不一致。",
          );
        }

        const runReady = (node: CompositionTaskGraphNodeInput) =>
          startNode(
            node,
            (node.dependsOnNodeIds ?? []).map(
              (dependencyId) => nodesById.get(dependencyId)!.taskId,
            ),
            input.leader.taskId,
          );
        // 先顺序写入每个子任务的 Code Work 投影，再并行等待 Driver 运行结果。
        const startedBatch = yield* Effect.forEach(ready, runReady);
        const batch =
          (input.schedule ?? "parallel") === "parallel"
            ? yield* Effect.forEach(startedBatch, settleNode, { concurrency: "unbounded" })
            : yield* Effect.forEach(startedBatch, settleNode);
        for (const result of batch) {
          yield* Effect.logDebug(`Task Graph 子任务结果已汇聚：${result.nodeId}`);
          results.set(result.nodeId, result);
          pending.delete(result.nodeId);
        }
      }

      const childResults = input.children.map((node) => results.get(node.nodeId)!);
      yield* Effect.logDebug("Task Graph 开始派发 Leader");
      const childSummary = childResults
        .map(
          (result) =>
            `- ${result.nodeId} (${result.run.agentId}): ${result.run.resultSummary ?? "已完成"}`,
        )
        .join("\n");
      const leaderPrompt = `${input.leader.prompt}\n\n子 Agent 执行结果：\n${childSummary || "（没有子任务）"}`;
      const leader = yield* options.orchestrator
        .dispatchTask({
          taskId: input.leader.taskId,
          runId: input.leader.runId,
          projectId: input.leader.projectId,
          ...(input.leader.threadId === undefined ? {} : { threadId: input.leader.threadId }),
          assigneeKind: input.leader.assigneeKind,
          assigneeId: input.leader.assigneeId,
          mode: "review",
          promptDigest: input.leader.promptDigest,
          dependsOnTaskIds: childResults.map((result) => result.task.taskId),
          workspaceRoot: input.leader.workspaceRoot,
          ...(input.leader.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: input.leader.workspaceRootDigest }),
          prompt: leaderPrompt,
          ...(input.leader.model === undefined ? {} : { model: input.leader.model }),
          ...(input.leader.capabilityIds === undefined
            ? {}
            : { capabilityIds: [...input.leader.capabilityIds] }),
        })
        .pipe(
          Effect.mapError((error) => graphError(errorCode(error), errorDetail(error), "leader")),
        );

      const leaderRun = terminalStatuses.has(leader.run.status)
        ? leader.run
        : yield* awaitSettled({
            taskId: input.leader.taskId,
            runId: leader.run.runId,
            nodeId: "leader",
          });
      const leaderTask = yield* getSettledTask(input.leader.taskId, leaderRun, "leader");
      if (leaderTask.run.status !== "in_review" && leaderTask.run.status !== "completed") {
        return yield* graphError(
          "leader_failed",
          `Leader 未完成：${leaderTask.run.failureCode ?? leaderTask.run.status}；${leaderTask.run.resultSummary ?? "无结果摘要"}`,
          "leader",
        );
      }
      return {
        leader: { task: leaderTask.task, run: leaderTask.run },
        children: childResults,
      } satisfies CompositionTaskGraphExecutionResult;
    }).pipe(Effect.mapError(normalizeError));

  return { execute } satisfies CompositionTaskGraphExecutorShape;
};

export const makeCompositionTaskGraphExecutor = (
  options: GraphExecutorOptions,
): CompositionTaskGraphExecutorShape => make(options);

const live = Effect.gen(function* () {
  const orchestrator = yield* CompositionOrchestratorService;
  const store = yield* CompositionTaskStore;
  const runtime = yield* CompositionTaskRuntimeProjectionService;
  return makeCompositionTaskGraphExecutor({ orchestrator, store, runtime });
});

export const layer = Layer.effect(CompositionTaskGraphExecutor, live);
