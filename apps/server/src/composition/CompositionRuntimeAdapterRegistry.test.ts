import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  CompositionRuntimeAdapterAlreadyRegisteredError,
  makeCompositionRuntimeAdapterRegistry,
} from "./CompositionRuntimeAdapterRegistry.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./CompositionRuntimeAdapter.ts";

describe("CompositionRuntimeAdapterRegistry", () => {
  it("按稳定 runtimeId 注册、查找、列出和注销 Adapter", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });

    await Effect.runPromise(registry.register(adapter));
    await expect(Effect.runPromise(registry.get("runtime-1"))).resolves.toBe(adapter);
    await expect(Effect.runPromise(registry.list)).resolves.toEqual([adapter]);
    await expect(Effect.runPromise(registry.unregister("runtime-1"))).resolves.toBe(true);
    await expect(Effect.runPromise(registry.get("runtime-1"))).resolves.toBeUndefined();
  });

  it("拒绝重复 runtimeId，避免热刷新覆盖活动连接", async () => {
    const registry = makeCompositionRuntimeAdapterRegistry();
    const adapter = makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" });

    await Effect.runPromise(registry.register(adapter));
    await expect(
      Effect.runPromise(
        registry.register(makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-1" })),
      ),
    ).rejects.toBeInstanceOf(CompositionRuntimeAdapterAlreadyRegisteredError);
    await expect(Effect.runPromise(registry.get("runtime-1"))).resolves.toBe(adapter);
  });
});
