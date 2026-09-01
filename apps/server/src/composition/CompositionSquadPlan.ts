import { TrimmedNonEmptyString, type CompositionSquad } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const PlanNodeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
);
const PlanAgentId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const PlanPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(20_000));
const PlanDependencyIds = Schema.Array(PlanNodeId).check(Schema.isMaxLength(64));

export const CompositionSquadPlanNodeSchema = Schema.Struct({
  nodeId: PlanNodeId,
  agentId: PlanAgentId,
  prompt: PlanPrompt,
  dependsOnNodeIds: PlanDependencyIds,
});

export type CompositionSquadPlanNode = typeof CompositionSquadPlanNodeSchema.Type;

const CompositionSquadPlanDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  nodes: Schema.Array(CompositionSquadPlanNodeSchema)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(64)),
});

export class CompositionSquadPlanError extends Schema.TaggedErrorClass<CompositionSquadPlanError>()(
  "CompositionSquadPlanError",
  {
    code: Schema.String,
    detail: Schema.String,
    nodeId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Squad 计划无效：${this.code}: ${this.detail}`;
  }
}

const planError = (code: string, detail: string, nodeId?: string): CompositionSquadPlanError =>
  new CompositionSquadPlanError({
    code,
    detail,
    ...(nodeId === undefined ? {} : { nodeId }),
  });

const decodePlanDocument = Schema.decodeUnknownEffect(CompositionSquadPlanDocument);
const decodePlanJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CompositionSquadPlanDocument),
);
const encodePlanJson = Schema.encodeSync(Schema.fromJsonString(CompositionSquadPlanDocument));

const reservedNodeIds: ReadonlySet<string> = new Set(["leader-plan", "leader-finalize"]);

const validateDecodedPlan = (
  squad: CompositionSquad,
  nodes: ReadonlyArray<CompositionSquadPlanNode>,
): Effect.Effect<ReadonlyArray<CompositionSquadPlanNode>, CompositionSquadPlanError> =>
  Effect.gen(function* () {
    const members = squad.members ?? [];
    const membersById = new Map(members.map((member) => [member.agentId, member] as const));
    const nodeIds = new Set<string>();

    for (const node of nodes) {
      if (reservedNodeIds.has(node.nodeId)) {
        return yield* planError(
          "squad_plan_reserved_node",
          `计划节点使用了系统保留的 nodeId：${node.nodeId}。`,
          node.nodeId,
        );
      }
      if (nodeIds.has(node.nodeId)) {
        return yield* planError(
          "squad_plan_duplicate_node",
          `计划包含重复 nodeId：${node.nodeId}。`,
          node.nodeId,
        );
      }
      nodeIds.add(node.nodeId);
      const member = membersById.get(node.agentId);
      if (member === undefined || member.role === "leader") {
        return yield* planError(
          "squad_member_missing",
          `计划节点 ${node.nodeId} 指向非 Squad 子成员：${node.agentId}。`,
          node.nodeId,
        );
      }
      const dependencyIds = new Set<string>();
      for (const dependencyId of node.dependsOnNodeIds) {
        if (dependencyIds.has(dependencyId)) {
          return yield* planError(
            "squad_plan_duplicate_dependency",
            `计划节点 ${node.nodeId} 重复依赖 ${dependencyId}。`,
            node.nodeId,
          );
        }
        dependencyIds.add(dependencyId);
      }
    }

    const nodesById = new Map(nodes.map((node) => [node.nodeId, node] as const));
    for (const node of nodes) {
      for (const dependencyId of node.dependsOnNodeIds) {
        if (!nodesById.has(dependencyId)) {
          return yield* planError(
            "dependency_node_missing",
            `依赖的 nodeId 不存在：${dependencyId}。`,
            node.nodeId,
          );
        }
        if (dependencyId === node.nodeId) {
          return yield* planError("dependency_cycle", "计划节点不能依赖自身。", node.nodeId);
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return false;
      if (visited.has(nodeId)) return true;
      visiting.add(nodeId);
      for (const dependencyId of nodesById.get(nodeId)?.dependsOnNodeIds ?? []) {
        if (!visit(dependencyId)) return false;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return true;
    };
    for (const node of nodes) {
      if (!visit(node.nodeId)) {
        return yield* planError("dependency_cycle", "Squad 计划依赖图存在循环。", node.nodeId);
      }
    }

    return nodes;
  });

export const validateCompositionSquadPlan = Effect.fn("validateCompositionSquadPlan")(
  function* (input: {
    readonly squad: CompositionSquad;
    readonly plan: ReadonlyArray<CompositionSquadPlanNode>;
  }) {
    const document = yield* decodePlanDocument({ schemaVersion: 1, nodes: input.plan }).pipe(
      Effect.mapError(() =>
        planError(
          "squad_plan_output_invalid",
          "计划必须包含 1 至 64 个字段完整、非空且长度受限的节点。",
        ),
      ),
    );
    return yield* validateDecodedPlan(input.squad, document.nodes);
  },
);

export const parseCompositionSquadPlanOutput = Effect.fn("parseCompositionSquadPlanOutput")(
  function* (input: { readonly squad: CompositionSquad; readonly output: string }) {
    const document = yield* decodePlanJson(input.output.trim()).pipe(
      Effect.mapError(() =>
        planError(
          "squad_plan_output_invalid",
          "Leader 输出必须是 schemaVersion=1 的严格 JSON，不能包含 Markdown 代码围栏或额外说明。",
        ),
      ),
    );
    return yield* validateDecodedPlan(input.squad, document.nodes);
  },
);

export const encodeCompositionSquadPlanOutput = (
  nodes: ReadonlyArray<CompositionSquadPlanNode>,
): string => encodePlanJson({ schemaVersion: 1, nodes });

export const compositionSquadExecutionScope = (input: {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
}): string => `${input.executionId}:squad:${input.squadId}:r${input.squadRevision}`;

export const isCompositionSquadLeaderPlanTaskId = (taskId: string): boolean =>
  taskId.endsWith(":task:leader-plan");
