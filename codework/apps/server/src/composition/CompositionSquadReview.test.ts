import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  composeCompositionSquadReviewPrompt,
  encodeCompositionSquadReviewDecision,
  parseCompositionSquadReviewDecision,
} from "./CompositionSquadReview.ts";

const parse = (output: string) =>
  parseCompositionSquadReviewDecision({
    output,
    reviewerNodeId: "reviewer",
    reworkableNodeIds: ["worker-a", "worker-b"],
  });

it.effect("解析严格的通过裁决", () =>
  Effect.gen(function* () {
    const decision = yield* parse(
      encodeCompositionSquadReviewDecision({
        decision: "approve",
        feedback: "实现和验证证据满足验收标准。",
        reworkNodeIds: [],
      }),
    );

    expect(decision).toEqual({
      decision: "approve",
      feedback: "实现和验证证据满足验收标准。",
      reworkNodeIds: [],
    });
  }),
);

it.effect("驳回必须给出反馈并只指向可重做节点", () =>
  Effect.gen(function* () {
    const decision = yield* parse(
      encodeCompositionSquadReviewDecision({
        decision: "reject",
        feedback: "worker-b 缺少失败场景测试。",
        reworkNodeIds: ["worker-b"],
      }),
    );

    expect(decision).toMatchObject({ decision: "reject", reworkNodeIds: ["worker-b"] });

    for (const [output, code] of [
      [
        '{"schemaVersion":1,"decision":"reject","feedback":"补测试","reworkNodeIds":[]}',
        "squad_review_rework_required",
      ],
      [
        '{"schemaVersion":1,"decision":"reject","feedback":"补测试","reworkNodeIds":["reviewer"]}',
        "squad_review_target_invalid",
      ],
      [
        '{"schemaVersion":1,"decision":"reject","feedback":"补测试","reworkNodeIds":["missing"]}',
        "squad_review_target_invalid",
      ],
      [
        '{"schemaVersion":1,"decision":"reject","feedback":"补测试","reworkNodeIds":["worker-a","worker-a"]}',
        "squad_review_target_duplicate",
      ],
    ] as const) {
      const error = yield* Effect.flip(parse(output));
      expect(error).toMatchObject({ code });
    }
  }),
);

it.effect("通过裁决不能夹带重做目标，输出也不能包含额外说明或字段", () =>
  Effect.gen(function* () {
    for (const output of [
      '{"schemaVersion":1,"decision":"approve","feedback":"通过","reworkNodeIds":["worker-a"]}',
      '```json\n{"schemaVersion":1,"decision":"approve","feedback":"通过","reworkNodeIds":[]}\n```',
      '{"schemaVersion":1,"decision":"approve","feedback":"通过","reworkNodeIds":[],"extra":true}',
    ]) {
      const error = yield* Effect.flip(parse(output));
      expect(error.code).toMatch(/^squad_review_/);
    }
  }),
);

it("为 reviewer/critic 生成包含目标、可重做节点和唯一 JSON 合同的提示词", () => {
  const prompt = composeCompositionSquadReviewPrompt({
    role: "critic",
    goal: "完成支付无关的协同调度功能",
    taskPrompt: "独立检查实现质量",
    reworkableNodeIds: ["worker-a", "worker-b"],
  });

  expect(prompt).toContain("Critic");
  expect(prompt).toContain("完成支付无关的协同调度功能");
  expect(prompt).toContain("worker-a, worker-b");
  expect(prompt).toContain('"decision":"approve"');
  expect(prompt).toContain('"decision":"reject"');
  expect(prompt).toContain("不能包含 Markdown 代码围栏或额外说明");
});
