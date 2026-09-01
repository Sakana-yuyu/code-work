import { CompositionAutomationRpcError } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";

import { toCompositionAutomationRpcError } from "./CompositionAutomationRpcError.ts";

describe("CompositionAutomationRpcError", () => {
  it("保留运行身份与 revision 冲突字段", () => {
    const mapped = toCompositionAutomationRpcError(
      {
        code: "automation_revision_conflict",
        detail: "预期 revision 2，实际为 3。",
        automationId: "automation-1",
        automationRunId: "automation-run-1",
        expectedRevision: 2,
        actualRevision: 3,
      },
      "fallback-automation",
    );

    expect(mapped).toBeInstanceOf(CompositionAutomationRpcError);
    expect(mapped).toMatchObject({
      code: "automation_revision_conflict",
      automationId: "automation-1",
      automationRunId: "automation-run-1",
      expectedRevision: 2,
      actualRevision: 3,
    });
  });

  it("收敛未知异常并保留已经规范化的 RPC 错误", () => {
    const normalized = new CompositionAutomationRpcError({
      code: "automation_not_found",
      detail: "Automation 不存在。",
      automationId: "automation-2",
    });

    expect(toCompositionAutomationRpcError(normalized, "fallback-automation")).toBe(normalized);
    expect(toCompositionAutomationRpcError(new Error("boom"), "fallback-automation")).toMatchObject(
      {
        code: "composition_automation_failed",
        detail: "boom",
        automationId: "fallback-automation",
      },
    );
  });
});
