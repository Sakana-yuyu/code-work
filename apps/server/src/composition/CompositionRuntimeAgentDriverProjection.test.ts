import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionRuntimeAgentDriverProjection } from "./CompositionRuntimeAgentDriverProjection.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";
import { makeCompositionRuntimeAdapterRegistry } from "./CompositionRuntimeAdapterRegistry.ts";

describe("CompositionRuntimeAgentDriverProjection", () => {
  it("按 runtime adapter 的 Agent 列表投影并清理过期 driver", async () => {
    const adapters = makeCompositionRuntimeAdapterRegistry();
    const first = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });
    const second = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-2",
      agents: [
        {
          agentId: "runtime-2:claude",
          runtimeId: "runtime-2",
          status: "online",
          capabilities: ["task.cancel"],
        },
      ],
    });
    await Effect.runPromise(adapters.register(first));
    const projection = makeCompositionRuntimeAgentDriverProjection({
      adapterRegistry: adapters,
    });

    await Effect.runPromise(projection.refresh);
    await expect(
      Effect.runPromise(projection.registry.get("runtime-1:agent")),
    ).resolves.toBeDefined();

    await Effect.runPromise(adapters.register(second));
    await Effect.runPromise(projection.refresh);
    await expect(
      Effect.runPromise(projection.registry.get("runtime-2:claude")),
    ).resolves.toBeDefined();

    await Effect.runPromise(adapters.unregister("runtime-1"));
    await Effect.runPromise(projection.refresh);
    await expect(
      Effect.runPromise(projection.registry.get("runtime-1:agent")),
    ).resolves.toBeUndefined();
  });
});
