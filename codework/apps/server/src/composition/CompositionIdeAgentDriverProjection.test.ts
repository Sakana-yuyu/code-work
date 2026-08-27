import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { compositionIdeAgentId } from "./CompositionIdeAgentDriver.ts";
import { makeCompositionIdeAgentDriverProjection } from "./CompositionIdeAgentDriverProjection.ts";
import { makeCompositionIdeSessionRegistry } from "./CompositionIdeSessionRegistry.ts";
import type { CompositionIdeAdapter } from "./CompositionIdeSessionRegistry.ts";

const makeAdapter = (
  sessionId: string,
  operations: ReadonlyArray<string>,
): CompositionIdeAdapter => ({
  sessionId,
  profile: "vscode_ide",
  probe: () =>
    Effect.succeed({
      sessionId,
      profile: "vscode_ide" as const,
      status: "ready" as const,
      verifiedOperations: [...operations],
    }),
  handshake: (input) =>
    Effect.succeed({
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      profile: "vscode_ide" as const,
      status: "accepted" as const,
      handshakeId: `handshake:${sessionId}`,
      acceptedGrantIds: [...input.capabilityGrantIds],
      verifiedOperations: [...input.requestedOperations],
    }),
  invoke: () => Effect.succeed({}),
});

describe("CompositionIdeAgentDriverProjection", () => {
  it("按 session 投影 IDE Agent Driver，并在 session 注销后清理", async () => {
    const sessions = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(
      sessions.register(makeAdapter("vscode-session-1", ["task.start", "task.cancel"])),
    );
    const projection = makeCompositionIdeAgentDriverProjection({ sessionRegistry: sessions });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(
      projection.registry.get(compositionIdeAgentId("vscode-session-1")),
    );
    expect(driver).toBeDefined();
    await expect(Effect.runPromise(driver!.getProfile!())).resolves.toMatchObject({
      status: "available",
      driverKind: "ide",
    });

    await Effect.runPromise(sessions.unregister("vscode-session-1"));
    await Effect.runPromise(projection.refresh);
    await expect(
      Effect.runPromise(projection.registry.get(compositionIdeAgentId("vscode-session-1"))),
    ).resolves.toBeUndefined();
  });

  it("没有 task bridge operation 时保留降级 Driver，不伪造可派发能力", async () => {
    const sessions = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(sessions.register(makeAdapter("editor-only", ["editor.read"])));
    const projection = makeCompositionIdeAgentDriverProjection({ sessionRegistry: sessions });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(
      projection.registry.get(compositionIdeAgentId("editor-only")),
    );
    await expect(Effect.runPromise(driver!.getProfile!())).resolves.toMatchObject({
      status: "degraded",
      reasonCode: "ide_task_bridge_unsupported",
    });
  });
});
