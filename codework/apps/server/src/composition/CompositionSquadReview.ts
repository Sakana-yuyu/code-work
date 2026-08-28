import { TrimmedNonEmptyString } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ReviewNodeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(160),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
);
const ReviewFeedback = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));

const CompositionSquadReviewDocument = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  decision: Schema.Literals(["approve", "reject"]),
  feedback: ReviewFeedback,
  reworkNodeIds: Schema.Array(ReviewNodeId).check(Schema.isMaxLength(64)),
});

type CompositionSquadReviewDocument = typeof CompositionSquadReviewDocument.Type;

export type CompositionSquadReviewDecision = Omit<CompositionSquadReviewDocument, "schemaVersion">;

export class CompositionSquadReviewError extends Schema.TaggedErrorClass<CompositionSquadReviewError>()(
  "CompositionSquadReviewError",
  {
    code: Schema.String,
    detail: Schema.String,
    reviewerNodeId: Schema.optional(Schema.String),
    targetNodeId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Squad 评审裁决无效：${this.code}: ${this.detail}`;
  }
}

const reviewError = (
  code: string,
  detail: string,
  options?: { readonly reviewerNodeId?: string; readonly targetNodeId?: string },
): CompositionSquadReviewError =>
  new CompositionSquadReviewError({
    code,
    detail,
    ...(options?.reviewerNodeId === undefined ? {} : { reviewerNodeId: options.reviewerNodeId }),
    ...(options?.targetNodeId === undefined ? {} : { targetNodeId: options.targetNodeId }),
  });

const documentKeys = new Set(["schemaVersion", "decision", "feedback", "reworkNodeIds"]);

const decodeDocument = Schema.decodeUnknownEffect(CompositionSquadReviewDocument);

const parseStrictJson = (
  output: string,
  reviewerNodeId: string,
): Effect.Effect<unknown, CompositionSquadReviewError> =>
  Effect.try({
    try: () => JSON.parse(output.trim()) as unknown,
    catch: () =>
      reviewError(
        "squad_review_output_invalid",
        "评审输出必须是 schemaVersion=1 的严格 JSON，不能包含 Markdown 代码围栏或额外说明。",
        { reviewerNodeId },
      ),
  }).pipe(
    Effect.flatMap((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return Effect.fail(
          reviewError("squad_review_output_invalid", "评审输出必须是 JSON 对象。", {
            reviewerNodeId,
          }),
        );
      }
      const keys = Object.keys(value);
      if (keys.length !== documentKeys.size || keys.some((key) => !documentKeys.has(key))) {
        return Effect.fail(
          reviewError(
            "squad_review_output_invalid",
            "评审 JSON 只能包含 schemaVersion、decision、feedback 和 reworkNodeIds。",
            { reviewerNodeId },
          ),
        );
      }
      return Effect.succeed(value);
    }),
  );

export const parseCompositionSquadReviewDecision = Effect.fn("parseCompositionSquadReviewDecision")(
  function* (input: {
    readonly output: string;
    readonly reviewerNodeId: string;
    readonly reworkableNodeIds: ReadonlyArray<string>;
  }) {
    const raw = yield* parseStrictJson(input.output, input.reviewerNodeId);
    const document = yield* decodeDocument(raw).pipe(
      Effect.mapError(() =>
        reviewError("squad_review_output_invalid", "评审 JSON 字段缺失、为空、超长或类型不正确。", {
          reviewerNodeId: input.reviewerNodeId,
        }),
      ),
    );

    if (document.decision === "approve" && document.reworkNodeIds.length > 0) {
      return yield* reviewError(
        "squad_review_approve_with_rework",
        "通过裁决不能同时请求重做节点。",
        { reviewerNodeId: input.reviewerNodeId },
      );
    }
    if (document.decision === "reject" && document.reworkNodeIds.length === 0) {
      return yield* reviewError(
        "squad_review_rework_required",
        "驳回裁决必须至少指定一个需要重做的节点。",
        { reviewerNodeId: input.reviewerNodeId },
      );
    }

    const reworkableNodeIds = new Set(input.reworkableNodeIds);
    const seen = new Set<string>();
    for (const targetNodeId of document.reworkNodeIds) {
      if (seen.has(targetNodeId)) {
        return yield* reviewError(
          "squad_review_target_duplicate",
          `重做节点重复：${targetNodeId}。`,
          { reviewerNodeId: input.reviewerNodeId, targetNodeId },
        );
      }
      seen.add(targetNodeId);
      if (targetNodeId === input.reviewerNodeId || !reworkableNodeIds.has(targetNodeId)) {
        return yield* reviewError(
          "squad_review_target_invalid",
          `评审节点不能要求重做未知或不可重做节点：${targetNodeId}。`,
          { reviewerNodeId: input.reviewerNodeId, targetNodeId },
        );
      }
    }

    return {
      decision: document.decision,
      feedback: document.feedback,
      reworkNodeIds: [...document.reworkNodeIds],
    } satisfies CompositionSquadReviewDecision;
  },
);

export const encodeCompositionSquadReviewDecision = (
  decision: CompositionSquadReviewDecision,
): string => JSON.stringify({ schemaVersion: 1, ...decision });

export const composeCompositionSquadReviewPrompt = (input: {
  readonly role: "reviewer" | "critic";
  readonly goal: string;
  readonly taskPrompt: string;
  readonly reworkableNodeIds: ReadonlyArray<string>;
}): string => {
  const role = input.role === "reviewer" ? "Reviewer" : "Critic";
  return [
    `你是本轮协同的 ${role}。独立核对依赖任务结果是否满足目标和验收要求。`,
    `目标：${input.goal}`,
    `评审重点：${input.taskPrompt}`,
    `允许请求重做的 nodeId：${input.reworkableNodeIds.join(", ") || "（无）"}`,
    "通过时只输出：",
    '{"schemaVersion":1,"decision":"approve","feedback":"通过理由","reworkNodeIds":[]}',
    "驳回时只输出：",
    '{"schemaVersion":1,"decision":"reject","feedback":"具体缺口与修复要求","reworkNodeIds":["node-id"]}',
    "只能使用上面列出的可重做 nodeId；不能要求重做 Reviewer/Critic 自身。",
    "输出必须是单个严格 JSON 对象，不能包含 Markdown 代码围栏或额外说明。",
  ].join("\n\n");
};
