import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  CompositionAgentDriverAlreadyRegisteredError,
  makeCompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";

const driver: CompositionAgentDriver = {
  agentId: "agent-codex",
  runtimeId: "codex-local",
  startTask: () => Effect.succeed({ runtimeTaskId: "runtime-task-1" }),
  cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
};

describe("CompositionAgentDriverRegistry", () => {
  it("registers, lists, resolves, and unregisters drivers by stable agent id", async () => {
    const registry = makeCompositionAgentDriverRegistry();

    await Effect.runPromise(registry.register(driver));
    await expect(Effect.runPromise(registry.list)).resolves.toEqual([driver]);
    await expect(Effect.runPromise(registry.get("agent-codex"))).resolves.toBe(driver);
    await expect(Effect.runPromise(registry.unregister("agent-codex"))).resolves.toBe(true);
    await expect(Effect.runPromise(registry.get("agent-codex"))).resolves.toBeUndefined();
  });

  it("rejects duplicate agent ids without replacing the existing driver", async () => {
    const registry = makeCompositionAgentDriverRegistry();
    const replacement: CompositionAgentDriver = {
      ...driver,
      runtimeId: "codex-replacement",
    };

    await Effect.runPromise(registry.register(driver));
    await expect(Effect.runPromise(registry.register(replacement))).rejects.toBeInstanceOf(
      CompositionAgentDriverAlreadyRegisteredError,
    );
    await expect(Effect.runPromise(registry.get("agent-codex"))).resolves.toBe(driver);
  });

  it("rejects an unnormalized agent id instead of changing the lookup key", async () => {
    const registry = makeCompositionAgentDriverRegistry();

    await expect(
      Effect.runPromise(registry.register({ ...driver, agentId: " agent-codex " })),
    ).rejects.toMatchObject({ detail: "agentId 必须已去除首尾空白。" });
  });
});
