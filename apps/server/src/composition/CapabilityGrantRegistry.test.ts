import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";

describe("CapabilityGrantRegistry", () => {
  it("为 task/agent 签发幂等短期 grant，并校验作用域", async () => {
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => 1000,
    });

    const first = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      }),
    );
    const second = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      }),
    );

    expect(first).toHaveLength(1);
    expect(second[0]?.grantId).toBe(first[0]?.grantId);
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: first[0]!.grantId,
          taskId: "task-1",
          agentId: "agent-2",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantScopeMismatchError" });
  });

  it("拒绝过期或已撤销 grant", async () => {
    let now = 1000;
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => now,
    });
    const [grant] = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 100,
      }),
    );

    now = 1100;
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantExpiredError" });

    now = 1000;
    await Effect.runPromise(registry.revoke({ grantId: grant!.grantId }));
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantRevokedError" });
  });

  it("记录不包含 arguments 的工具审计事件", async () => {
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => 1000,
    });
    const [grant] = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
      }),
    );

    await Effect.runPromise(
      registry.recordAudit({
        grantId: grant!.grantId,
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityId: "t3.workspace.read_file",
        operation: "read",
        outcome: "allowed",
      }),
    );
    const events = await Effect.runPromise(registry.listAudit({ taskId: "task-1" }));
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).arguments).toBeUndefined();
  });
});
