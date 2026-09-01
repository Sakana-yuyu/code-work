import { CompositionSquadRpcError } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";

import { toCompositionSquadRpcError } from "./CompositionSquadRpcError.ts";

describe("CompositionSquadRpcError", () => {
  it("保留生命周期和 Runner 的稳定错误字段", () => {
    const mapped = toCompositionSquadRpcError(
      {
        _tag: "CompositionSquadRunnerError",
        code: "squad_revision_conflict",
        detail: "预期 revision 2，实际为 3。",
        squadId: "squad-1",
        nodeId: "worker-a",
        expectedRevision: 2,
        actualRevision: 3,
      },
      "fallback-squad",
    );

    expect(mapped).toBeInstanceOf(CompositionSquadRpcError);
    expect(mapped).toMatchObject({
      code: "squad_revision_conflict",
      squadId: "squad-1",
      nodeId: "worker-a",
      expectedRevision: 2,
      actualRevision: 3,
    });
  });

  it("收敛未知异常并保留已经规范化的 RPC 错误", () => {
    const normalized = new CompositionSquadRpcError({
      code: "squad_archived",
      detail: "Squad 已归档。",
      squadId: "squad-2",
    });

    expect(toCompositionSquadRpcError(normalized, "fallback-squad")).toBe(normalized);
    expect(toCompositionSquadRpcError(new Error("boom"), "fallback-squad")).toMatchObject({
      code: "composition_squad_failed",
      detail: "boom",
      squadId: "fallback-squad",
    });
  });
});
