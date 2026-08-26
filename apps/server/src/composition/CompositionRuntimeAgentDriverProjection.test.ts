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

  it("Adapter 重建后替换旧 Driver，避免继续使用旧 Runtime 配置", async () => {
    const adapters = makeCompositionRuntimeAdapterRegistry();
    const first = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-rebuilt",
      capabilities: ["old-capability"],
    });
    const second = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-rebuilt",
      capabilities: ["new-capability"],
    });
    await Effect.runPromise(adapters.register(first));
    const projection = makeCompositionRuntimeAgentDriverProjection({
      adapterRegistry: adapters,
    });

    await Effect.runPromise(projection.refresh);
    await Effect.runPromise(adapters.unregister("runtime-rebuilt"));
    await Effect.runPromise(adapters.register(second));
    await Effect.runPromise(projection.refresh);

    const driver = await Effect.runPromise(projection.registry.get("runtime-rebuilt:agent"));
    expect(driver).toBeDefined();
    const profile = await Effect.runPromise(driver!.getProfile!());
    expect(profile).toMatchObject({
      capabilities: expect.arrayContaining(["new-capability"]),
    });
    expect(profile).not.toMatchObject({
      capabilities: expect.arrayContaining(["old-capability"]),
    });
  });

  it("只把 Runtime 明确声明且完成握手的 ToolBroker 能力标为可用", async () => {
    const adapters = makeCompositionRuntimeAdapterRegistry();
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-capabilities",
      driverKind: "acp",
      capabilities: [
        "t3.toolbroker",
        "t3.capability_handshake",
        "t3.workspace",
        "t3.terminal",
        "t3.git",
        "t3.browser",
        "t3.ide",
        "t3.provider_api",
        "squad",
        "leader",
        "task-graph",
      ],
      supportsResume: true,
      supportsMcp: true,
    });
    await Effect.runPromise(adapters.register(adapter));
    const projection = makeCompositionRuntimeAgentDriverProjection({
      adapterRegistry: adapters,
    });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(projection.registry.get("runtime-capabilities:agent"));
    const profile = await Effect.runPromise(driver!.getProfile!());

    expect(profile).toMatchObject({
      driverKind: "acp",
      status: "available",
      supportsToolBroker: true,
      supportsCapabilityHandshake: true,
      supportsWorkspace: true,
      supportsTerminal: true,
      supportsGit: true,
      supportsBrowser: true,
      supportsIde: true,
      supportsProviderApi: true,
      supportsResume: true,
      supportsSquad: true,
      supportsLeader: true,
      supportsTaskGraph: true,
    });
  });

  it("Multica 窄协议没有 ToolBroker 标记时保持降级状态", async () => {
    const adapters = makeCompositionRuntimeAdapterRegistry();
    const adapter = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "multica-degraded",
      driverKind: "multica",
      capabilities: ["squad", "leader", "task-graph"],
      supportsMcp: false,
    });
    await Effect.runPromise(adapters.register(adapter));
    const projection = makeCompositionRuntimeAgentDriverProjection({
      adapterRegistry: adapters,
    });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(projection.registry.get("multica-degraded:agent"));
    const profile = await Effect.runPromise(driver!.getProfile!());

    expect(profile).toMatchObject({
      driverKind: "multica",
      status: "degraded",
      supportsToolBroker: false,
      supportsCapabilityHandshake: false,
      supportsSquad: true,
      supportsLeader: true,
      supportsTaskGraph: true,
      reasonCode: "runtime_capability_handshake_unsupported",
    });
  });
});
