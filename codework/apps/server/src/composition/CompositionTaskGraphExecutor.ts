import * as NodeCrypto from "node:crypto";

import type {
  CompositionSquadFailurePolicy,
  CompositionSquadPartialSuccessPolicy,
  CompositionTask,
  CompositionTaskRun,
  CompositionTaskStatus,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { classifyCompositionFailure } from "./CompositionFailurePolicy.ts";
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

const isCompositionTaskGraphExecutionError = Schema.is(CompositionTaskGraphExecutionError);

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
  readonly maxConcurrency?: number;
  readonly failurePolicy?: CompositionSquadFailurePolicy;
  readonly partialSuccessPolicy?: CompositionSquadPartialSuccessPolicy;
};

export type CompositionTaskGraphNodeResult = {
  readonly nodeId: string;
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly attempts: number;
  readonly dispatches: ReadonlyArray<CompositionDispatchResult>;
};

export type CompositionTaskGraphNodeFailure = {
  readonly nodeId: string;
  readonly kind: "failed" | "skipped";
  readonly failureCode: string;
  readonly detail: string;
  readonly task?: CompositionTask;
  readonly run?: CompositionTaskRun;
};

export type CompositionTaskGraphExecutionResult = {
  readonly leader: CompositionDispatchResult;
  readonly children: ReadonlyArray<CompositionTaskGraphNodeResult>;
  readonly failures?: ReadonlyArray<CompositionTaskGraphNodeFailure>;
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
  readonly orchestrator: Pick<CompositionOrchestrator, "dispatchTask" | "retryTask" | "cancelTask">;
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
  currentDispatch: CompositionDispatchResult;
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
  isCompositionTaskGraphExecutionError(error)
    ? error
    : graphError(errorCode(error), errorDetail(error));

const retryRunId = (initialRunId: string, attempt: number): string =>
  `${initialRunId}:retry:${attempt}`;

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const appendDependencyResults = (
  prompt: string,
  dependencies: ReadonlyArray<CompositionTaskGraphNodeResult>,
): string => {
  if (dependencies.length === 0) return prompt;
  const summary = dependencies
    .map(
      (dependency) =>
        `- ${dependency.nodeId} (${dependency.run.agentId}): ${dependency.run.resultSummary ?? "已完成"}`,
    )
    .join("\n");
  return `${prompt}\n\n依赖任务结果：\n${summary}`;
};

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
  if (
    input.maxConcurrency !== undefined &&
    (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1)
  ) {
    return graphError("invalid_max_concurrency", "maxConcurrency 必须是大于 0 的整数。");
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
    dependencies: ReadonlyArray<CompositionTaskGraphNodeResult>,
    leaderTaskId: string,
  ): Effect.Effect<RunningNode, CompositionTaskGraphExecutionError> =>
    Effect.gen(function* () {
      const prompt = appendDependencyResults(node.prompt, dependencies);
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
          promptDigest: dependencies.length === 0 ? node.promptDigest : sha256(prompt),
          dependsOnTaskIds: dependencies.map((dependency) => dependency.task.taskId),
          workspaceRoot: node.workspaceRoot,
          ...(node.workspaceRootDigest === undefined
            ? {}
            : { workspaceRootDigest: node.workspaceRootDigest }),
          prompt,
          ...(node.model === undefined ? {} : { model: node.model }),
          ...(node.capabilityIds === undefined ? {} : { capabilityIds: [...node.capabilityIds] }),
        })
        .pipe(
          Effect.mapError((error) => graphError(errorCode(error), errorDetail(error), node.nodeId)),
        );
      return {
        node,
        dispatch,
        dispatches: [dispatch],
        currentDispatch: dispatch,
      } satisfies RunningNode;
    });

  const settleNode = (
    started: RunningNode,
    activeNodes: Set<RunningNode>,
    continueOnFailure: boolean,
  ): Effect.Effect<
    CompositionTaskGraphNodeResult | CompositionTaskGraphNodeFailure,
    CompositionTaskGraphExecutionError
  > =>
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
          activeNodes.delete(started);
          return {
            nodeId: node.nodeId,
            task: settled.task,
            run: settled.run,
            attempts: dispatches.length,
            dispatches,
          } satisfies CompositionTaskGraphNodeResult;
        }
        const failure = classifyCompositionFailure(settled.run);
        if (dispatches.length >= maxAttempts || !failure.retryable) {
          activeNodes.delete(started);
          const detail = `子任务未完成：失败码=${failure.code}；失败分类=${failure.category}；恢复动作=${failure.recovery}；${settled.run.resultSummary ?? "无结果摘要"}`;
          return continueOnFailure
            ? ({
                nodeId: node.nodeId,
                kind: "failed",
                failureCode: failure.code,
                detail,
                task: settled.task,
                run: settled.run,
              } satisfies CompositionTaskGraphNodeFailure)
            : yield* graphError("child_failed", detail, node.nodeId);
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
        started.currentDispatch = retry;
        dispatches.push(retry);
      }
    });

  const execute: CompositionTaskGraphExecutorShape["execute"] = (input) =>
    Effect.gen(function* () {
      const validationError = validateGraph(input);
      if (validationError !== undefined) return yield* validationError;

      const pending = new Set(input.children.map((node) => node.nodeId));
      const results = new Map<string, CompositionTaskGraphNodeResult>();
      const failures = new Map<string, CompositionTaskGraphNodeFailure>();
      const activeNodes = new Set<RunningNode>();
      const failurePolicy = input.failurePolicy ?? "fail_fast";
      const partialSuccessPolicy = input.partialSuccessPolicy ?? "reject";

      const cancelNodes = (nodes: ReadonlyArray<RunningNode>, failedNodeId?: string) =>
        Effect.gen(function* () {
          const candidates = nodes.filter(
            (started) => failedNodeId === undefined || started.node.nodeId !== failedNodeId,
          );
          const failures: string[] = [];
          yield* Effect.forEach(
            candidates,
            (started) =>
              Effect.exit(
                options.orchestrator.cancelTask({
                  taskId: started.currentDispatch.task.taskId,
                  runId: started.currentDispatch.run.runId,
                  reason:
                    failedNodeId === undefined
                      ? "Task Graph 启动失败，取消已启动的子任务"
                      : `Task Graph 子任务 ${failedNodeId} 失败，取消仍运行的并行子任务`,
                }),
              ).pipe(
                Effect.flatMap((exit) => {
                  if (exit._tag === "Failure") {
                    failures.push(
                      `${started.node.nodeId}: ${errorDetail(Cause.squash(exit.cause))}`,
                    );
                  }
                  return Effect.void;
                }),
              ),
            { concurrency: "unbounded", discard: true },
          );
          for (const started of candidates) activeNodes.delete(started);
          return failures;
        });

      const failAfterCleanup = (
        failure: CompositionTaskGraphExecutionError,
        nodes: ReadonlyArray<RunningNode>,
      ) =>
        Effect.gen(function* () {
          const cleanupFailures = yield* cancelNodes(nodes, failure.nodeId);
          if (cleanupFailures.length > 0) {
            return yield* graphError(
              "child_cancel_cleanup_failed",
              `${failure.detail}；取消其他子任务失败：${cleanupFailures.join("；")}`,
              failure.nodeId,
            );
          }
          return yield* failure;
        });

      while (pending.size > 0) {
        if (failurePolicy === "continue_independent") {
          const skipped = input.children.filter(
            (node) =>
              pending.has(node.nodeId) &&
              (node.dependsOnNodeIds ?? []).some((dependencyId) => failures.has(dependencyId)),
          );
          for (const node of skipped) {
            const failedDependencies = (node.dependsOnNodeIds ?? []).filter((dependencyId) =>
              failures.has(dependencyId),
            );
            failures.set(node.nodeId, {
              nodeId: node.nodeId,
              kind: "skipped",
              failureCode: "dependency_failed",
              detail: `依赖节点未成功：${failedDependencies.join(", ")}`,
            });
            pending.delete(node.nodeId);
          }
          if (pending.size === 0) break;
        }
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

        const schedule = input.schedule ?? "parallel";
        const batchLimit = schedule === "serial" ? 1 : (input.maxConcurrency ?? ready.length);
        const scheduled = ready.slice(0, batchLimit);
        const runReady = (node: CompositionTaskGraphNodeInput) =>
          startNode(
            node,
            (node.dependsOnNodeIds ?? []).map((dependencyId) => results.get(dependencyId)!),
            input.leader.taskId,
          );
        // 先顺序写入每个子任务的 Code Work 投影，再并行等待 Driver 运行结果。
        const startedBatch: RunningNode[] = [];
        for (const node of scheduled) {
          const started =
            failurePolicy === "fail_fast"
              ? yield* runReady(node).pipe(
                  Effect.catch((failure) => failAfterCleanup(failure, startedBatch)),
                )
              : yield* Effect.result(runReady(node)).pipe(
                  Effect.flatMap((result) => {
                    if (result._tag === "Success") return Effect.succeed(result.success);
                    failures.set(node.nodeId, {
                      nodeId: node.nodeId,
                      kind: "failed",
                      failureCode: result.failure.code,
                      detail: result.failure.detail,
                    });
                    pending.delete(node.nodeId);
                    return Effect.void;
                  }),
                );
          if (started === undefined) continue;
          startedBatch.push(started);
          if (!terminalStatuses.has(started.currentDispatch.run.status)) {
            activeNodes.add(started);
          }
        }
        const batch =
          failurePolicy === "fail_fast"
            ? yield* (
                schedule === "parallel"
                  ? Effect.forEach(
                      startedBatch,
                      (started) => settleNode(started, activeNodes, false),
                      { concurrency: "unbounded" },
                    )
                  : Effect.forEach(startedBatch, (started) =>
                      settleNode(started, activeNodes, false),
                    )
              ).pipe(Effect.catch((failure) => failAfterCleanup(failure, [...activeNodes])))
            : yield* Effect.forEach(
                startedBatch,
                (started) =>
                  settleNode(started, activeNodes, true).pipe(
                    Effect.catch((failure) => {
                      activeNodes.delete(started);
                      return Effect.succeed({
                        nodeId: started.node.nodeId,
                        kind: "failed" as const,
                        failureCode: failure.code,
                        detail: failure.detail,
                      });
                    }),
                  ),
                schedule === "parallel" ? { concurrency: "unbounded" } : undefined,
              );
        for (const outcome of batch) {
          yield* Effect.logDebug(`Task Graph 子任务结果已汇聚：${outcome.nodeId}`);
          if ("kind" in outcome) {
            failures.set(outcome.nodeId, outcome);
          } else {
            results.set(outcome.nodeId, outcome);
          }
          pending.delete(outcome.nodeId);
        }
      }

      const childResults = input.children.flatMap((node) => {
        const result = results.get(node.nodeId);
        return result === undefined ? [] : [result];
      });
      const childFailures = input.children.flatMap((node) => {
        const failure = failures.get(node.nodeId);
        return failure === undefined ? [] : [failure];
      });
      if (childFailures.length > 0 && partialSuccessPolicy === "reject") {
        return yield* graphError(
          "partial_success_rejected",
          `存在 ${childFailures.length} 个失败或跳过节点，当前策略拒绝部分成功。`,
        );
      }
      yield* Effect.logDebug("Task Graph 开始派发 Leader");
      const childSummary = childResults
        .map(
          (result) =>
            `- ${result.nodeId} (${result.run.agentId}): ${result.run.resultSummary ?? "已完成"}`,
        )
        .join("\n");
      const failureSummary = childFailures
        .map(
          (failure) =>
            `- ${failure.nodeId} [${failure.kind}/${failure.failureCode}]: ${failure.detail}`,
        )
        .join("\n");
      const leaderPrompt = `${input.leader.prompt}\n\n子 Agent 执行结果：\n${childSummary || "（没有成功子任务）"}${failureSummary.length === 0 ? "" : `\n\n失败与跳过节点：\n${failureSummary}`}`;
      const leader = yield* options.orchestrator
        .dispatchTask({
          taskId: input.leader.taskId,
          runId: input.leader.runId,
          projectId: input.leader.projectId,
          ...(input.leader.threadId === undefined ? {} : { threadId: input.leader.threadId }),
          assigneeKind: input.leader.assigneeKind,
          assigneeId: input.leader.assigneeId,
          mode: "review",
          promptDigest: sha256(leaderPrompt),
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
        ...(childFailures.length === 0 ? {} : { failures: childFailures }),
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
