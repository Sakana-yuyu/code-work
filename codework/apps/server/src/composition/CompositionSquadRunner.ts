import * as NodeCrypto from "node:crypto";

import type { CompositionSquad, CompositionSquadMember } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  compositionSquadExecutionScope,
  validateCompositionSquadPlan,
  type CompositionSquadPlanNode,
} from "./CompositionSquadPlan.ts";
import {
  CompositionSquadPlanner,
  type CompositionSquadPlannerShape,
} from "./CompositionSquadPlanner.ts";
import { composeCompositionSquadReviewPrompt } from "./CompositionSquadReview.ts";
import {
  CompositionSquadService,
  type CompositionSquadServiceShape,
} from "./CompositionSquadService.ts";
import {
  CompositionTaskGraphExecutor,
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
  readonly squads: Pick<CompositionSquadServiceShape, "getRunnable">;
  readonly planner: Pick<CompositionSquadPlannerShape, "plan">;
  readonly executor: Pick<CompositionTaskGraphExecutorShape, "execute">;
}

type CompileInput = {
  readonly squad: CompositionSquad;
  readonly input: CompositionSquadExecutionInput;
};

type ResolvedPlanNode = CompositionSquadPlanNode & {
  readonly member: CompositionSquadMember;
};

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

const executionScope = (input: CompositionSquadExecutionInput): string =>
  compositionSquadExecutionScope({
    executionId: input.executionId,
    squadId: input.squadId,
    squadRevision: input.squadRevision,
  });

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
    const children: CompositionTaskGraphNodeInput[] = modeNodes.map((node) => {
      const workspaceRoot = node.member.workspaceRoot ?? input.workspaceRoot;
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
): CompositionSquadRunnerShape => ({
  run: Effect.fn("CompositionSquadRunner.run")(function* (input) {
    const squad = yield* options.squads.getRunnable(input.squadId).pipe(
      Effect.mapError((error) =>
        runnerError(error.code, error.detail, input.squadId, {
          ...(error.expectedRevision === undefined
            ? {}
            : { expectedRevision: error.expectedRevision }),
          ...(error.actualRevision === undefined ? {} : { actualRevision: error.actualRevision }),
        }),
      ),
    );
    const actualRevision = revisionOf(squad);
    if (actualRevision !== input.squadRevision) {
      return yield* runnerError(
        "squad_revision_conflict",
        `预期 revision ${input.squadRevision}，实际为 ${actualRevision}。`,
        input.squadId,
        { expectedRevision: input.squadRevision, actualRevision },
      );
    }
    const plan =
      input.plan === undefined
        ? yield* options.planner
            .plan({
              executionId: input.executionId,
              squad,
              projectId: input.projectId,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              goal: input.goal,
              workspaceRoot: input.workspaceRoot,
              ...(input.workspaceRootDigest === undefined
                ? {}
                : { workspaceRootDigest: input.workspaceRootDigest }),
            })
            .pipe(
              Effect.mapError((error) =>
                runnerError(
                  error.code,
                  error.detail,
                  input.squadId,
                  error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
                ),
              ),
            )
        : input.plan;
    const graphInput = yield* compileCompositionSquadGraph({
      squad,
      input: { ...input, plan },
    });
    const graph = yield* options.executor
      .execute(graphInput)
      .pipe(
        Effect.mapError((error) =>
          runnerError(
            error.code,
            error.detail,
            input.squadId,
            error.nodeId === undefined ? undefined : { nodeId: error.nodeId },
          ),
        ),
      );
    return {
      executionId: input.executionId,
      squadId: input.squadId,
      squadRevision: input.squadRevision,
      graph,
    } satisfies CompositionSquadExecutionResult;
  }),
});

const live = Effect.gen(function* () {
  const squads = yield* CompositionSquadService;
  const planner = yield* CompositionSquadPlanner;
  const executor = yield* CompositionTaskGraphExecutor;
  return makeCompositionSquadRunner({ squads, planner, executor });
});

export const layer = Layer.effect(CompositionSquadRunner, live);
