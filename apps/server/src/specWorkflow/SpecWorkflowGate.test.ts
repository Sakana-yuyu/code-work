import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@codework/contracts";

import { evaluateSpecWorkflowAccess } from "./SpecWorkflowGate.ts";

describe("Spec Workflow closed gate", () => {
  it("default disabled capability never enters the workflow", () => {
    expect(
      evaluateSpecWorkflowAccess({
        threadId: ThreadId.make("thread-1"),
        enabled: false,
        revision: 0,
        updatedAt: 0,
      }),
    ).toEqual({ kind: "disabled", reason: "not-enabled" });
  });

  it("only an explicit enabled capability opens the gate", () => {
    expect(
      evaluateSpecWorkflowAccess({
        threadId: ThreadId.make("thread-1"),
        enabled: true,
        revision: 1,
        updatedAt: 1,
      }),
    ).toEqual({ kind: "enabled" });
  });
});
