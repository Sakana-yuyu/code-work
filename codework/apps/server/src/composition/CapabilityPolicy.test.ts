import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { makeCapabilityGrantRegistry } from "./CapabilityGrantRegistry.ts";
import { CapabilityNotGrantedError, makeCompositionCapabilityPolicy } from "./CapabilityPolicy.ts";

describe("CapabilityPolicy", () => {
  it("只允许当前 task/agent 的有效 grant，并返回过期时间", async () => {
    let now = 1000;
    const capabilityRegistry = makeCompositionCapabilityRegistry();
    const grantRegistry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => now });
    const policy = makeCompositionCapabilityPolicy({ capabilityRegistry, grantRegistry });
    const [grant] = await Effect.runPromise(
      grantRegistry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 100,
      }),
    );

    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: [grant!.grantId],
          operation: "read",
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow", expiresAtUnixMs: 1100 });

    now = 1100;
    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: [grant!.grantId],
          operation: "read",
        }),
      ),
    ).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });

  it("在迁移期保留直接 capability ID，并标记 legacy 决策", async () => {
    const capabilityRegistry = makeCompositionCapabilityRegistry();
    const policy = makeCompositionCapabilityPolicy({
      capabilityRegistry,
    });

    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: ["t3.workspace.read_file"],
          operation: "read",
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow", reasonCode: "legacy_capability_grant" });
  });
});
