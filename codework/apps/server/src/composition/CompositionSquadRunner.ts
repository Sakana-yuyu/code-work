import * as NodeCrypto from "node:crypto";

import {
  ThreadId,
  type CompositionSquad,
  type CompositionSquadExecution,
  type CompositionSquadExecutionNode,
  type CompositionSquadMember,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import {
  CompositionSquadExecutionStore,
  CompositionSquadExecutionStoreDomainError,
  type CompositionSquadExecutionStoreError,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import {
  compositionSquadExecutionScope,
  encodeCompositionSquadPlanOutput,
  validateCompositionSquadPlan,
  type CompositionSquadPlanNode,
} from "./CompositionSquadPlan.ts";
import {
  CompositionSquadPlanner,
  type CompositionSquadPlanningCancellationReceipt,
  type CompositionSquadPlanningCancellationReport,
  type CompositionSquadPlannerShape,
} from "./CompositionSquadPlanner.ts";
import { composeCompositionSquadReviewPrompt } from "./CompositionSquadReview.ts";
import {
  CompositionSquadService,
  type CompositionSquadServiceError,
  type CompositionSquadServiceShape,
} from "./CompositionSquadService.ts";
import {
  CompositionTaskGraphExecutor,
  type CompositionTaskGraphCancellationReceipt,
  type CompositionTaskGraphCancellationReport,
  type CompositionTaskGraphExecutionInput,
  type CompositionTaskGraphExecutionResult,
  type CompositionTaskGraphExecutorShape,
  type CompositionTaskGraphNodeInput,
} from "./CompositionTaskGraphExecutor.ts";

export type { CompositionSquadPlanNode } from "./CompositionSquadPlan.ts";

export interface CompositionSquadExecutionInput {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
  readonly projectId: string;
  readonly threadId?: string;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly workspaceRootDigest?: string;
  readonly plan?: ReadonlyArray<CompositionSquadPlanNode>;
}

export interface CompositionSquadExecutionResult {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
  readonly graph: CompositionTaskGraphExecutionResult;
}

export class CompositionSquadRunnerError extends Schema.TaggedErrorClass<CompositionSquadRunnerError>()(
  "CompositionSquadRunnerError",
  {
    code: Schema.String,
    detail: Schema.String,
    squadId: Schema.String,
    nodeId: Schema.optional(Schema.String),
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Squad 运行失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionSquadRunnerShape {
  readonly run: (
    input: CompositionSquadExecutionInput,
  ) => Effect.Effect<CompositionSquadExecutionResult, CompositionSquadRunnerError>;
}

export class CompositionSquadRunner extends Context.Service<
  CompositionSquadRunner,
  CompositionSquadRunnerShape
>()("codework/composition/CompositionSquadRunner") {}

export interface CompositionSquadRunnerOptions {
  readonly squads: Pick<CompositionSquadServiceShape, "getRunnable" | "getRevision">;
  readonly planner: Pick<CompositionSquadPlannerShape, "plan">;
  readonly executor: Pick<
    CompositionTaskGraphExecutorShape,
    "execute" | "cancellationScopeProtocol"
  >;
  readonly executions: Pick<
    CompositionSquadExecutionStoreShape,
    "claimExecution" | "getExecution" | "saveTransition"
  >;
  readonly now?: () => number;
}

type CompileInput = {
  readonly squad: CompositionSquad;
  readonly input: CompositionSquadExecutionInput;
};

type ResolvedPlanNode = CompositionSquadPlanNode & {
  readonly member: CompositionSquadMember;
};

type BoundRequestedPlan =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "explicit";
      readonly plan: ReadonlyArray<CompositionSquadPlanNode>;
      readonly planDigest: string;
    };

type CompositionSquadExternalRunBoundary =
  | "none"
  | "planner_entered"
  | "planner_settled"
  | "graph_persisted"
  | "executor_v1_pre_ready"
  | "executor_ready"
  | "executor_legacy_entered"
  | "executor_settled";

type CompositionSquadCancellationEvidence = {
  readonly boundary: CompositionSquadExternalRunBoundary;
  readonly plannerReceipt: Option.Option<CompositionSquadPlanningCancellationReceipt>;
  readonly executorReceipt: Option.Option<CompositionTaskGraphCancellationReceipt>;
};

const canTakeOverRole = (
  source: CompositionSquadMember,
  candidate: CompositionSquadMember,
): boolean =>
  source.role === "worker"
    ? candidate.role === "worker"
    : (source.role === "reviewer" || source.role === "critic") &&
      (candidate.role === "reviewer" || candidate.role === "critic");

const hasCapabilities = (
  candidate: CompositionSquadMember,
  requiredCapabilityIds: ReadonlyArray<string>,
): boolean =>
  requiredCapabilityIds.every((capabilityId) => candidate.capabilityIds.includes(capabilityId));

const runnerError = (
  code: string,
  detail: string,
  squadId: string,
  options?: {
    readonly nodeId?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
  },
): CompositionSquadRunnerError =>
  new CompositionSquadRunnerError({
    code,
    detail,
    squadId,
    ...(options?.nodeId === undefined ? {} : { nodeId: options.nodeId }),
    ...(options?.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options?.actualRevision === undefined ? {} : { actualRevision: options.actualRevision }),
  });

const sha256 = (value: string): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex")}`;

const revisionOf = (squad: CompositionSquad): number => squad.revision ?? 1;

const isExecutionStoreDomainError = Schema.is(CompositionSquadExecutionStoreDomainError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const mapExecutionStoreError = (
  error: CompositionSquadExecutionStoreError,
  input: CompositionSquadExecutionInput,
): CompositionSquadRunnerError => {
  if (isExecutionStoreDomainError(error)) {
    return runnerError(error.code, error.detail, input.squadId, {
      ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
      ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
    });
  }
  if (isPersistenceSqlError(error) || isPersistenceDecodeError(error)) {
    return runnerError(
      "squad_execution_persistence_failed",
      "Squad execution 状态暂时无法安全持久化，请稍后重试。",
      input.squadId,
    );
  }
  return runnerError(
    "squad_execution_persistence_failed",
    "Squad execution 状态持久化失败。",
    input.squadId,
  );
};

const mapSquadServiceError = (
  error: CompositionSquadServiceError,
  squadId: string,
): CompositionSquadRunnerError =>
  runnerError(error.code, error.detail, squadId, {
    ...(error.expectedRevision === undefined ? {} : { expectedRevision: error.expectedRevision }),
    ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
  });

const normalizedTime = (value: number, lowerBound = 0): number =>
  Math.max(lowerBound, Math.max(0, Math.trunc(value)));

const explicitPlanDigest = (plan: ReadonlyArray<CompositionSquadPlanNode>): string =>
  sha256(`composition-squad-explicit-plan:v1\n${encodeCompositionSquadPlanOutput(plan)}`);

const bindRequestedPlan = (
  squad: CompositionSquad,
  input: CompositionSquadExecutionInput,
): Effect.Effect<BoundRequestedPlan, CompositionSquadRunnerError> => {
  if (input.plan === undefined) return Effect.succeed({ kind: "automatic" });
  return validateCompositionSquadPlan({ squad, plan: input.plan }).pipe(
    Effect.map(
      (plan): BoundRequestedPlan => ({
        kind: "explicit",
        plan,
        planDigest: explicitPlanDigest(plan),
      }),
    ),
    Effect.mapError((error) =>
      runnerError(
        error.code,
        error.detail,
        input.squadId,
        error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
      ),
    ),
  );
};

const executionScope = (input: CompositionSquadExecutionInput): string =>
  compositionSquadExecutionScope({
    executionId: input.executionId,
    squadId: input.squadId,
    squadRevision: input.squadRevision,
  });

const makeQueuedExecution = (
  input: CompositionSquadExecutionInput,
  boundPlan: BoundRequestedPlan,
  now: number,
): CompositionSquadExecution => {
  const scope = executionScope(input);
  return {
    executionId: input.executionId,
    squadId: input.squadId,
    squadRevision: input.squadRevision,
    projectId: input.projectId,
    ...(input.threadId === undefined ? {} : { threadId: ThreadId.make(input.threadId) }),
    goalDigest: sha256(input.goal),
    ...(boundPlan.kind === "explicit" ? { planDigest: boundPlan.planDigest } : {}),
    goalTaskId: `${scope}:task:leader-plan`,
    workspaceRootDigest: input.workspaceRootDigest ?? sha256(input.workspaceRoot),
    status: "queued",
    revision: 1,
    leaderTaskId: `${scope}:task:leader-finalize`,
    leaderRunId: `${scope}:run:leader-finalize:1`,
    pendingApprovals: [],
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
  };
};

const makePlanningExecution = (
  current: CompositionSquadExecution,
  now: number,
): CompositionSquadExecution => {
  const updatedAtUnixMs = normalizedTime(now, current.updatedAtUnixMs);
  return {
    ...current,
    status: "planning",
    revision: current.revision + 1,
    startedAtUnixMs: normalizedTime(updatedAtUnixMs, current.createdAtUnixMs),
    updatedAtUnixMs,
  };
};

const toExecutionNodes = (
  graph: CompositionTaskGraphExecutionInput,
): ReadonlyArray<CompositionSquadExecutionNode> =>
  graph.children.map((node) => ({
    nodeId: node.nodeId,
    agentId: node.assigneeId,
    taskId: node.taskId,
    runId: node.runId,
    promptDigest: node.promptDigest,
    dependsOnNodeIds: [...(node.dependsOnNodeIds ?? [])],
  }));

const makeRunningExecution = (
  current: CompositionSquadExecution,
  graph: CompositionTaskGraphExecutionInput,
  now: number,
): CompositionSquadExecution => ({
  ...current,
  status: "running",
  revision: current.revision + 1,
  nodes: toExecutionNodes(graph),
  updatedAtUnixMs: normalizedTime(now, current.updatedAtUnixMs),
});

const makeFailedExecution = (
  current: CompositionSquadExecution,
  error: CompositionSquadRunnerError,
  now: number,
): CompositionSquadExecution => {
  const updatedAtUnixMs = normalizedTime(now, current.updatedAtUnixMs);
  return {
    ...current,
    status: "failed",
    revision: current.revision + 1,
    failureCode: error.code,
    failureDetail: error.detail,
    finishedAtUnixMs: normalizedTime(
      updatedAtUnixMs,
      current.startedAtUnixMs ?? current.createdAtUnixMs,
    ),
    updatedAtUnixMs,
  };
};

const makeInReviewExecution = (
  current: CompositionSquadExecution,
  now: number,
): CompositionSquadExecution => ({
  ...current,
  status: "in_review",
  revision: current.revision + 1,
  updatedAtUnixMs: normalizedTime(now, current.updatedAtUnixMs),
});

const makeCompletedExecution = (
  current: CompositionSquadExecution,
  resultSummary: string,
  now: number,
): CompositionSquadExecution => {
  const updatedAtUnixMs = normalizedTime(now, current.updatedAtUnixMs);
  return {
    ...current,
    status: "completed",
    revision: current.revision + 1,
    resultSummary,
    finishedAtUnixMs: normalizedTime(
      updatedAtUnixMs,
      current.startedAtUnixMs ?? current.createdAtUnixMs,
    ),
    updatedAtUnixMs,
  };
};

const makeCancellingExecution = (
  current: CompositionSquadExecution,
  now: number,
): CompositionSquadExecution => {
  const active = { ...current };
  delete active.pausedFromStatus;
  delete active.pausedAtUnixMs;
  const updatedAtUnixMs = normalizedTime(now, current.updatedAtUnixMs);
  return {
    ...active,
    status: "cancelling",
    revision: current.revision + 1,
    pendingApprovals: [],
    cancelRequestedAtUnixMs: normalizedTime(
      updatedAtUnixMs,
      current.startedAtUnixMs ?? current.createdAtUnixMs,
    ),
    updatedAtUnixMs,
  };
};

const makeCancelledExecution = (
  current: CompositionSquadExecution,
  now: number,
): CompositionSquadExecution => {
  const active = { ...current };
  delete active.pausedFromStatus;
  delete active.pausedAtUnixMs;
  const updatedAtUnixMs = normalizedTime(now, current.updatedAtUnixMs);
  const cancelRequestedAtUnixMs =
    current.cancelRequestedAtUnixMs ??
    normalizedTime(updatedAtUnixMs, current.startedAtUnixMs ?? current.createdAtUnixMs);
  return {
    ...active,
    status: "cancelled",
    revision: current.revision + 1,
    pendingApprovals: [],
    cancelRequestedAtUnixMs,
    finishedAtUnixMs: normalizedTime(updatedAtUnixMs, cancelRequestedAtUnixMs),
    updatedAtUnixMs,
  };
};

const defaultMemberPrompt = (
  squad: CompositionSquad,
  member: CompositionSquadMember,
  goal: string,
): string =>
  [
    `目标：${goal}`,
    `你是 Squad「${squad.name}」中的 ${member.role}，负责完成与该角色匹配的独立工作。`,
    squad.instructions === undefined ? undefined : `协同说明：${squad.instructions}`,
    "输出可验证的结果摘要，供 Leader 最终汇总。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");

const leaderPrompt = (squad: CompositionSquad, goal: string): string =>
  [
    `目标：${goal}`,
    `你是 Squad「${squad.name}」的 Leader。请核对所有子 Agent 结果，处理冲突并形成最终结论。`,
    squad.instructions === undefined ? undefined : `协同说明：${squad.instructions}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");

const applyModeDependencies = (
  mode: NonNullable<CompositionSquad["collaborationMode"]>,
  nodes: ReadonlyArray<ResolvedPlanNode>,
): ReadonlyArray<ResolvedPlanNode> => {
  if (mode === "serial") {
    return nodes.map((node, index) => ({
      ...node,
      dependsOnNodeIds: index === 0 ? [] : [nodes[index - 1]!.nodeId],
    }));
  }
  if (mode === "parallel" || mode === "leader_workers") {
    return nodes.map((node) => ({ ...node, dependsOnNodeIds: [] }));
  }
  if (mode === "review_critic") {
    const workerNodeIds = nodes
      .filter((node) => node.member.role === "worker")
      .map((node) => node.nodeId);
    return nodes.map((node) =>
      node.member.role === "reviewer" || node.member.role === "critic"
        ? { ...node, dependsOnNodeIds: workerNodeIds }
        : { ...node, dependsOnNodeIds: [] },
    );
  }
  return nodes;
};

export const compileCompositionSquadGraph = ({
  squad,
  input,
}: CompileInput): Effect.Effect<CompositionTaskGraphExecutionInput, CompositionSquadRunnerError> =>
  Effect.gen(function* () {
    const revision = revisionOf(squad);
    if (squad.squadId !== input.squadId) {
      return yield* runnerError(
        "squad_identity_mismatch",
        `请求 Squad ${input.squadId}，实际读取到 ${squad.squadId}。`,
        input.squadId,
      );
    }
    if (revision !== input.squadRevision) {
      return yield* runnerError(
        "squad_revision_conflict",
        `预期 revision ${input.squadRevision}，实际为 ${revision}。`,
        input.squadId,
        { expectedRevision: input.squadRevision, actualRevision: revision },
      );
    }
    if (
      squad.collaborationMode === undefined ||
      squad.members === undefined ||
      squad.maxConcurrency === undefined ||
      squad.failurePolicy === undefined ||
      squad.partialSuccessPolicy === undefined
    ) {
      return yield* runnerError(
        "squad_configuration_incomplete",
        "Squad 缺少可执行的协同策略或成员配置。",
        input.squadId,
      );
    }
    const members = [...squad.members].sort((left, right) => left.order - right.order);
    const leader = members.find((member) => member.agentId === squad.leaderAgentId);
    if (leader === undefined || leader.role !== "leader") {
      return yield* runnerError(
        "squad_leader_missing",
        "Squad 没有匹配 leaderAgentId 的 Leader 成员。",
        input.squadId,
      );
    }
    if (squad.collaborationMode === "dependency_graph" && input.plan === undefined) {
      return yield* runnerError(
        "squad_plan_required",
        "dependency_graph 模式必须提供 Leader 已确认的显式任务计划。",
        input.squadId,
      );
    }

    const membersById = new Map(members.map((member) => [member.agentId, member] as const));
    const defaultPlan: ReadonlyArray<CompositionSquadPlanNode> = members
      .filter((member) => member.role !== "leader")
      .map((member) => ({
        nodeId: `member:${member.order}:${member.agentId}`,
        agentId: member.agentId,
        prompt: defaultMemberPrompt(squad, member, input.goal),
        dependsOnNodeIds: [],
      }));
    const plan = yield* validateCompositionSquadPlan({
      squad,
      plan: input.plan ?? defaultPlan,
    }).pipe(
      Effect.mapError((error) =>
        runnerError(
          error.code,
          error.detail,
          input.squadId,
          error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
        ),
      ),
    );
    const resolvedNodes: ResolvedPlanNode[] = [];
    for (const node of plan) {
      const member = membersById.get(node.agentId);
      if (member === undefined || member.role === "leader") {
        return yield* runnerError(
          "squad_member_missing",
          `计划节点 ${node.nodeId} 指向非 Squad 子成员：${node.agentId}。`,
          input.squadId,
          { nodeId: node.nodeId },
        );
      }
      resolvedNodes.push({ ...node, member });
    }
    const reworkableNodeIds = resolvedNodes
      .filter((node) => node.member.role === "worker")
      .map((node) => node.nodeId);
    const promptedNodes =
      squad.collaborationMode === "review_critic"
        ? resolvedNodes.map((node) =>
            node.member.role === "reviewer" || node.member.role === "critic"
              ? {
                  ...node,
                  prompt: composeCompositionSquadReviewPrompt({
                    role: node.member.role,
                    goal: input.goal,
                    taskPrompt: node.prompt,
                    reworkableNodeIds,
                  }),
                }
              : node,
          )
        : resolvedNodes;
    const modeNodes = applyModeDependencies(squad.collaborationMode, promptedNodes);
    const scope = executionScope(input);
    const maxAttempts = (squad.maxRetries ?? 0) + 1;
    const assignedNodeCounts = new Map<string, number>();
    for (const node of modeNodes) {
      assignedNodeCounts.set(
        node.member.agentId,
        (assignedNodeCounts.get(node.member.agentId) ?? 0) + 1,
      );
    }
    const children: CompositionTaskGraphNodeInput[] = modeNodes.map((node) => {
      const workspaceRoot = node.member.workspaceRoot ?? input.workspaceRoot;
      const failoverCandidates = members
        .filter(
          (candidate) =>
            candidate.agentId !== node.member.agentId &&
            canTakeOverRole(node.member, candidate) &&
            hasCapabilities(candidate, node.member.capabilityIds) &&
            (assignedNodeCounts.get(candidate.agentId) ?? 0) < candidate.maxConcurrentTasks,
        )
        .map((candidate) => ({
          assigneeId: candidate.agentId,
          workspaceRoot: candidate.workspaceRoot ?? input.workspaceRoot,
          ...(candidate.model === undefined ? {} : { model: candidate.model }),
          capabilityIds: [...node.member.capabilityIds],
        }));
      return {
        nodeId: node.nodeId,
        taskId: `${scope}:task:${node.nodeId}`,
        runId: `${scope}:run:${node.nodeId}:1`,
        projectId: input.projectId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        assigneeKind: "agent",
        assigneeId: node.member.agentId,
        mode: squad.collaborationMode === "serial" ? "serial" : "parallel",
        promptDigest: sha256(node.prompt),
        prompt: node.prompt,
        workspaceRoot,
        ...(input.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: input.workspaceRootDigest }),
        ...(node.member.model === undefined ? {} : { model: node.member.model }),
        capabilityIds: [...node.member.capabilityIds],
        dependsOnNodeIds: [...node.dependsOnNodeIds],
        maxAttempts: node.member.capabilityIds.length === 0 ? 1 : maxAttempts,
        ...(failoverCandidates.length === 0 ? {} : { failoverCandidates }),
      };
    });
    const finalPrompt = leaderPrompt(squad, input.goal);
    return {
      leader: {
        taskId: `${scope}:task:leader-finalize`,
        runId: `${scope}:run:leader-finalize:1`,
        projectId: input.projectId,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        assigneeKind: "squad",
        assigneeId: squad.squadId,
        promptDigest: sha256(finalPrompt),
        prompt: finalPrompt,
        workspaceRoot: leader.workspaceRoot ?? input.workspaceRoot,
        ...(input.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: input.workspaceRootDigest }),
        ...(leader.model === undefined ? {} : { model: leader.model }),
        capabilityIds: [...leader.capabilityIds],
        mode: "review",
      },
      children,
      schedule: squad.collaborationMode === "serial" ? "serial" : "parallel",
      maxConcurrency: squad.maxConcurrency,
      failurePolicy: squad.failurePolicy,
      partialSuccessPolicy: squad.partialSuccessPolicy,
      ...(squad.collaborationMode === "review_critic"
        ? {
            review: {
              reviewerNodeIds: modeNodes
                .filter((node) => node.member.role === "reviewer" || node.member.role === "critic")
                .map((node) => node.nodeId),
              reworkableNodeIds,
              maxRevisions: squad.maxRetries ?? 0,
            },
          }
        : {}),
    } satisfies CompositionTaskGraphExecutionInput;
  });

export const makeCompositionSquadRunner = (
  options: CompositionSquadRunnerOptions,
): CompositionSquadRunnerShape => {
  const readNow = () =>
    (options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now)).pipe(
      Effect.map((value) => normalizedTime(value)),
    );
  const saveTransition = (
    execution: CompositionSquadExecution,
    expectedRevision: number,
    input: CompositionSquadExecutionInput,
  ) =>
    options.executions
      .saveTransition({ execution, expectedRevision })
      .pipe(Effect.mapError((error) => mapExecutionStoreError(error, input)));
  const readExecution = (input: CompositionSquadExecutionInput) =>
    options.executions.getExecution(input.executionId).pipe(
      Effect.mapError((error) => mapExecutionStoreError(error, input)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              runnerError(
                "squad_execution_not_found",
                `execution ${input.executionId} 在中断收口时不存在。`,
                input.squadId,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
  const persistInterruptedCancellation = (
    input: CompositionSquadExecutionInput,
    evidence: CompositionSquadCancellationEvidence,
  ): Effect.Effect<void, CompositionSquadRunnerError> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const relevantReceipt =
          evidence.boundary === "planner_entered"
            ? evidence.plannerReceipt
            : evidence.boundary === "executor_ready" ||
                evidence.boundary === "executor_legacy_entered"
              ? evidence.executorReceipt
              : Option.none();
        const cancellationReceipt = Option.getOrUndefined(relevantReceipt);
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const current = yield* readExecution(input);
          if (
            current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled"
          ) {
            return;
          }

          const canFinalizeWithoutReceipt =
            evidence.boundary === "none" ||
            evidence.boundary === "planner_settled" ||
            evidence.boundary === "graph_persisted" ||
            evidence.boundary === "executor_v1_pre_ready" ||
            evidence.boundary === "executor_settled";
          const queuedCancellation =
            current.status === "queued" ||
            (current.status === "paused" && current.pausedFromStatus === "queued");
          const canFinalize =
            queuedCancellation ||
            canFinalizeWithoutReceipt ||
            cancellationReceipt?.complete === true;
          const now = yield* readNow();
          const next = queuedCancellation
            ? makeCancelledExecution(current, now)
            : current.status === "cancelling"
              ? canFinalize
                ? makeCancelledExecution(current, now)
                : current
              : makeCancellingExecution(current, now);
          if (next === current) {
            if (Option.isNone(relevantReceipt)) {
              return yield* runnerError(
                "squad_execution_cancellation_receipt_missing",
                "Squad execution 中断后未收到子 Run 取消回执，已停留在 cancelling。",
                input.squadId,
              );
            }
            return;
          }
          const persisted = yield* Effect.result(saveTransition(next, current.revision, input));
          if (persisted._tag === "Success") {
            if (persisted.success.status === "cancelled") return;
            if (!canFinalize) {
              if (Option.isNone(relevantReceipt)) {
                return yield* runnerError(
                  "squad_execution_cancellation_receipt_missing",
                  "Squad execution 中断后未收到子 Run 取消回执，已停留在 cancelling。",
                  input.squadId,
                );
              }
              return;
            }
            continue;
          }
          if (
            persisted.failure.code === "squad_execution_revision_conflict" ||
            persisted.failure.code === "squad_execution_status_conflict"
          ) {
            continue;
          }
          return yield* persisted.failure;
        }
        return yield* runnerError(
          "squad_execution_cancellation_conflict",
          `execution ${input.executionId} 在多次竞争后仍无法安全收口。`,
          input.squadId,
        );
      }),
    );
  const persistBusinessFailure = (
    current: CompositionSquadExecution,
    error: CompositionSquadRunnerError,
    input: CompositionSquadExecutionInput,
  ): Effect.Effect<never, CompositionSquadRunnerError> =>
    Effect.gen(function* () {
      const now = yield* readNow();
      const persisted = yield* Effect.result(
        saveTransition(makeFailedExecution(current, error, now), current.revision, input),
      );
      if (persisted._tag === "Failure") {
        yield* Effect.logError("Composition Squad 失败状态持久化失败").pipe(
          Effect.annotateLogs({
            executionId: current.executionId,
            currentStatus: current.status,
            originalErrorCode: error.code,
          }),
        );
        return yield* persisted.failure;
      }
      return yield* error;
    });
  const persistBusinessFailureCause = (
    current: CompositionSquadExecution,
    cause: Cause.Cause<CompositionSquadRunnerError>,
    input: CompositionSquadExecutionInput,
  ): Effect.Effect<never, CompositionSquadRunnerError> =>
    Effect.gen(function* () {
      const error = Option.getOrUndefined(Cause.findErrorOption(cause));
      if (error === undefined) return yield* Effect.failCause(cause);
      const now = yield* readNow();
      const persisted = yield* Effect.result(
        saveTransition(makeFailedExecution(current, error, now), current.revision, input),
      );
      if (persisted._tag === "Failure") {
        yield* Effect.logError("Composition Squad 失败状态持久化失败").pipe(
          Effect.annotateLogs({
            executionId: current.executionId,
            currentStatus: current.status,
            originalErrorCode: error.code,
          }),
        );
        return yield* Effect.failCause(Cause.combine(cause, Cause.fail(persisted.failure)));
      }
      return yield* Effect.failCause(cause);
    });

  return {
    run: Effect.fn("CompositionSquadRunner.run")(function* (input) {
      const externalRunBoundaryRef = yield* Ref.make<CompositionSquadExternalRunBoundary>("none");
      const plannerCancellationReportRef = yield* Ref.make(
        Option.none<CompositionSquadPlanningCancellationReport>(),
      );
      const executorCancellationReportRef = yield* Ref.make(
        Option.none<CompositionTaskGraphCancellationReport>(),
      );
      const readCancellationEvidence = Effect.gen(function* () {
        const boundary = yield* Ref.get(externalRunBoundaryRef);
        const plannerReport = yield* Ref.get(plannerCancellationReportRef);
        const executorReport = yield* Ref.get(executorCancellationReportRef);
        return {
          boundary,
          plannerReceipt: Option.map(plannerReport, (report) => report.receipt),
          executorReceipt: Option.map(executorReport, (report) => report.receipt),
        } satisfies CompositionSquadCancellationEvidence;
      });
      const failAfterPersistingCancellation = (
        cause: Cause.Cause<CompositionSquadRunnerError>,
      ): Effect.Effect<never, CompositionSquadRunnerError> =>
        Effect.gen(function* () {
          const persistenceExit = yield* Effect.exit(
            readCancellationEvidence.pipe(
              Effect.flatMap((evidence) => persistInterruptedCancellation(input, evidence)),
            ),
          );
          return yield* Effect.failCause(
            persistenceExit._tag === "Success"
              ? cause
              : Cause.combine(cause, persistenceExit.cause),
          );
        });
      const runnableSquad = yield* options.squads
        .getRunnable(input.squadId)
        .pipe(Effect.mapError((error) => mapSquadServiceError(error, input.squadId)));
      const runnableRevision = revisionOf(runnableSquad);
      if (runnableRevision !== input.squadRevision) {
        return yield* runnerError(
          "squad_revision_conflict",
          `预期 revision ${input.squadRevision}，实际为 ${runnableRevision}。`,
          input.squadId,
          { expectedRevision: input.squadRevision, actualRevision: runnableRevision },
        );
      }

      const boundPlan = yield* bindRequestedPlan(runnableSquad, input);
      const claimedAtUnixMs = yield* readNow();
      const queued = makeQueuedExecution(input, boundPlan, claimedAtUnixMs);
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claim = yield* options.executions
            .claimExecution(queued)
            .pipe(Effect.mapError((error) => mapExecutionStoreError(error, input)));
          if (!claim.claimed) {
            return yield* runnerError(
              "squad_execution_replay_unavailable",
              `execution ${input.executionId} 已存在；当前节点拒绝重复规划或派发。`,
              input.squadId,
            );
          }

          let cancellationPersistenceCause: Cause.Cause<CompositionSquadRunnerError> | undefined;
          const program = Effect.gen(function* () {
            const planningAtUnixMs = yield* readNow();
            let current = yield* saveTransition(
              makePlanningExecution(claim.execution, planningAtUnixMs),
              claim.execution.revision,
              input,
            );

            const revisionResult = yield* Effect.result(
              options.squads
                .getRevision(input.squadId, input.squadRevision)
                .pipe(Effect.mapError((error) => mapSquadServiceError(error, input.squadId))),
            );
            if (revisionResult._tag === "Failure") {
              return yield* persistBusinessFailure(current, revisionResult.failure, input);
            }
            const squad = revisionResult.success;
            const fixedRevision = revisionOf(squad);
            if (squad.squadId !== input.squadId || fixedRevision !== input.squadRevision) {
              return yield* persistBusinessFailure(
                current,
                runnerError(
                  "squad_revision_unavailable",
                  `固定 Squad revision 无法恢复：${input.squadId}@${input.squadRevision}。`,
                  input.squadId,
                  {
                    expectedRevision: input.squadRevision,
                    actualRevision: fixedRevision,
                  },
                ),
                input,
              );
            }
            if ((squad.approvalStages?.length ?? 0) > 0) {
              return yield* persistBusinessFailure(
                current,
                runnerError(
                  "squad_approval_not_supported",
                  "Squad 配置了审批点，但 execution 审批协调器尚未接入，已停止派发。",
                  input.squadId,
                ),
                input,
              );
            }

            let plan: ReadonlyArray<CompositionSquadPlanNode>;
            if (boundPlan.kind === "explicit") {
              plan = boundPlan.plan;
            } else {
              const planExit = yield* Effect.uninterruptibleMask((restorePlanner) =>
                Effect.gen(function* () {
                  yield* Ref.set(externalRunBoundaryRef, "planner_entered");
                  const exit = yield* Effect.exit(
                    restorePlanner(
                      options.planner.plan(
                        {
                          executionId: input.executionId,
                          squad,
                          projectId: input.projectId,
                          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                          goal: input.goal,
                          workspaceRoot: input.workspaceRoot,
                          ...(input.workspaceRootDigest === undefined
                            ? {}
                            : { workspaceRootDigest: input.workspaceRootDigest }),
                        },
                        {
                          onCancellationReceipt: (report) =>
                            Ref.set(plannerCancellationReportRef, Option.some(report)),
                          onInterruptedCancellation: (receipt) =>
                            Ref.update(plannerCancellationReportRef, (currentReport) =>
                              Option.isSome(currentReport)
                                ? currentReport
                                : Option.some({ trigger: "interrupted", receipt }),
                            ),
                        },
                      ),
                    ),
                  );
                  if (exit._tag === "Success") {
                    yield* Ref.set(externalRunBoundaryRef, "planner_settled");
                  }
                  return exit;
                }),
              );
              if (planExit._tag === "Failure") {
                const mappedCause = Cause.map(planExit.cause, (error) =>
                  runnerError(
                    error.code,
                    error.detail,
                    input.squadId,
                    error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
                  ),
                );
                if (Cause.interruptors(mappedCause).size > 0 || Cause.hasDies(mappedCause)) {
                  return yield* Effect.failCause(mappedCause);
                }
                const cancellationReport = Option.getOrUndefined(
                  yield* Ref.get(plannerCancellationReportRef),
                );
                if (cancellationReport?.receipt.complete !== true) {
                  return yield* failAfterPersistingCancellation(mappedCause);
                }
                return yield* persistBusinessFailureCause(current, mappedCause, input);
              }
              plan = planExit.value;
            }

            const graphResult = yield* Effect.result(
              compileCompositionSquadGraph({
                squad,
                input: { ...input, plan },
              }),
            );
            if (graphResult._tag === "Failure") {
              return yield* persistBusinessFailure(current, graphResult.failure, input);
            }
            const graphInput = graphResult.success;
            const runningAtUnixMs = yield* readNow();
            current = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const running = yield* saveTransition(
                  makeRunningExecution(current, graphInput, runningAtUnixMs),
                  current.revision,
                  input,
                );
                yield* Ref.set(externalRunBoundaryRef, "graph_persisted");
                return running;
              }),
            );

            const graph = yield* Effect.uninterruptibleMask((restoreExecutor) =>
              Effect.gen(function* () {
                const executorProtocolV1 = options.executor.cancellationScopeProtocol === "v1";
                yield* Ref.set(
                  externalRunBoundaryRef,
                  executorProtocolV1 ? "executor_v1_pre_ready" : "executor_legacy_entered",
                );
                const executionExit = yield* Effect.exit(
                  restoreExecutor(
                    options.executor.execute(graphInput, {
                      onCancellationScopeReady: () =>
                        Ref.set(externalRunBoundaryRef, "executor_ready"),
                      onCancellationReceipt: (report) =>
                        Ref.set(executorCancellationReportRef, Option.some(report)),
                      onInterruptedCancellation: (receipt) =>
                        Ref.update(executorCancellationReportRef, (currentReport) =>
                          Option.isSome(currentReport)
                            ? currentReport
                            : Option.some({ trigger: "interrupted", receipt }),
                        ),
                    }),
                  ),
                );
                if (executionExit._tag === "Success") {
                  yield* Ref.set(externalRunBoundaryRef, "executor_settled");
                  return executionExit.value;
                }

                const mappedCause = Cause.map(executionExit.cause, (error) =>
                  runnerError(
                    error.code,
                    error.detail,
                    input.squadId,
                    error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
                  ),
                );
                if (Cause.interruptors(mappedCause).size > 0 || Cause.hasDies(mappedCause)) {
                  return yield* Effect.failCause(mappedCause);
                }
                const cancellationReport = Option.getOrUndefined(
                  yield* Ref.get(executorCancellationReportRef),
                );
                if (
                  cancellationReport?.trigger === "business_failure" &&
                  !cancellationReport.receipt.complete
                ) {
                  const persistenceExit = yield* Effect.exit(
                    readCancellationEvidence.pipe(
                      Effect.flatMap((evidence) => persistInterruptedCancellation(input, evidence)),
                    ),
                  );
                  return yield* Effect.failCause(
                    persistenceExit._tag === "Success"
                      ? mappedCause
                      : Cause.combine(mappedCause, persistenceExit.cause),
                  );
                }
                return yield* persistBusinessFailureCause(current, mappedCause, input);
              }),
            );
            const finalAtUnixMs = yield* readNow();
            if (graph.leader.run.status === "completed") {
              const resultSummary = graph.leader.run.resultSummary?.trim();
              if (resultSummary === undefined || resultSummary.length === 0) {
                return yield* persistBusinessFailure(
                  current,
                  runnerError(
                    "squad_execution_result_invalid",
                    "Leader 已完成但没有提供可持久化的结果摘要。",
                    input.squadId,
                  ),
                  input,
                );
              }
              yield* saveTransition(
                makeCompletedExecution(current, resultSummary, finalAtUnixMs),
                current.revision,
                input,
              );
            } else if (graph.leader.run.status === "in_review") {
              yield* saveTransition(
                makeInReviewExecution(current, finalAtUnixMs),
                current.revision,
                input,
              );
            } else {
              return yield* persistBusinessFailure(
                current,
                runnerError(
                  "squad_execution_result_invalid",
                  `Leader 返回了不支持的终态：${graph.leader.run.status}。`,
                  input.squadId,
                ),
                input,
              );
            }

            return {
              executionId: input.executionId,
              squadId: input.squadId,
              squadRevision: input.squadRevision,
              graph,
            } satisfies CompositionSquadExecutionResult;
          });

          const exit = yield* Effect.exit(
            restore(program).pipe(
              Effect.onExit((programExit) => {
                if (
                  programExit._tag === "Success" ||
                  Cause.interruptors(programExit.cause).size === 0
                ) {
                  return Effect.void;
                }
                return Effect.exit(
                  readCancellationEvidence.pipe(
                    Effect.flatMap((evidence) => persistInterruptedCancellation(input, evidence)),
                  ),
                ).pipe(
                  Effect.flatMap((persistenceExit) =>
                    persistenceExit._tag === "Success"
                      ? Effect.void
                      : Effect.sync(() => {
                          cancellationPersistenceCause = persistenceExit.cause;
                        }),
                  ),
                );
              }),
            ),
          );
          if (exit._tag === "Success") return exit.value;
          return yield* Effect.failCause(
            cancellationPersistenceCause === undefined
              ? exit.cause
              : Cause.combine(exit.cause, cancellationPersistenceCause),
          );
        }),
      );
    }),
  };
};

const live = Effect.gen(function* () {
  const squads = yield* CompositionSquadService;
  const planner = yield* CompositionSquadPlanner;
  const executor = yield* CompositionTaskGraphExecutor;
  const executions = yield* CompositionSquadExecutionStore;
  return makeCompositionSquadRunner({ squads, planner, executor, executions });
});

export const layer = Layer.effect(CompositionSquadRunner, live);
