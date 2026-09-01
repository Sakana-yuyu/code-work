import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@codework/contracts";

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

  it("只在唯一 Driver 提供 Runtime 复合键时允许持久化恢复", async () => {
    const registry = makeCompositionAgentDriverRegistry();
    const event = {
      eventId: EventId.make("registry-persisted-correlation"),
      provider: ProviderDriverKind.make("cursor"),
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-27T00:00:00.000Z",
      type: "turn.completed",
      payload: { state: "completed" },
    } satisfies ProviderRuntimeEvent;
    const correlation = {
      runtimeId: "provider:cursor",
      runtimeTaskId: "provider:cursor:thread:turn",
    };
    await Effect.runPromise(
      registry.register({
        ...driver,
        resolvePersistedRuntimeEvent: () => correlation,
      }),
    );

    await expect(Effect.runPromise(registry.resolvePersistedRuntimeEvent(event))).resolves.toEqual(
      correlation,
    );

    await Effect.runPromise(
      registry.register({
        ...driver,
        agentId: "agent-claude",
        runtimeId: "claude-local",
        resolvePersistedRuntimeEvent: () => ({
          runtimeId: "provider:claude",
          runtimeTaskId: "provider:claude:thread:turn",
        }),
      }),
    );
    await expect(
      Effect.runPromise(registry.resolvePersistedRuntimeEvent(event)),
    ).resolves.toBeUndefined();
  });
});
