import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";

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

  it("为没有能力投影的旧 Driver 返回明确的降级状态", async () => {
    const registry = makeCompositionAgentDriverRegistry();
    await Effect.runPromise(registry.register(driver));

    await expect(Effect.runPromise(registry.listProfiles)).resolves.toMatchObject([
      {
        agentId: "agent-codex",
        status: "degraded",
        supportsToolBroker: false,
        reasonCode: "driver_profile_missing",
      },
    ]);
  });

  it("在 Driver 增删时发出变更通知，供运行时事件投影器刷新订阅", async () => {
    const registry = makeCompositionAgentDriverRegistry();

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const subscription = yield* registry.subscribeChanges;
            const notification = yield* PubSub.take(subscription).pipe(Effect.forkChild);
            yield* registry.register(driver);
            yield* Fiber.join(notification);
            return yield* registry.unregister(driver.agentId);
          }),
        ),
      ),
    ).resolves.toBe(true);
  });
});
