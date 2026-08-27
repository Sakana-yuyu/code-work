import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  CompositionIdeSessionAlreadyRegisteredError,
  makeCompositionIdeSessionRegistry,
  type CompositionIdeAdapter,
} from "./CompositionIdeSessionRegistry.ts";

const makeAdapter = (overrides: Partial<CompositionIdeAdapter> = {}): CompositionIdeAdapter => ({
  sessionId: "vscode-session-1",
  profile: "vscode_ide",
  probe: () =>
    Effect.succeed({
      sessionId: "vscode-session-1",
      profile: "vscode_ide" as const,
      verifiedOperations: ["workspace.open", "editor.read"],
      status: "ready" as const,
    }),
  handshake: (input) =>
    Effect.succeed({
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      profile: "vscode_ide" as const,
      status: "accepted" as const,
      handshakeId: "ide-handshake-1",
      acceptedGrantIds: [...input.capabilityGrantIds],
      verifiedOperations: [...input.requestedOperations],
    }),
  invoke: (input) => Effect.succeed({ operation: input.operation, arguments: input.arguments }),
  ...overrides,
});

describe("CompositionIdeSessionRegistry", () => {
  it("按稳定 sessionId 注册并拒绝覆盖活动 Adapter", async () => {
    const registry = makeCompositionIdeSessionRegistry();
    const adapter = makeAdapter();

    await Effect.runPromise(registry.register(adapter));
    await expect(Effect.runPromise(registry.register(makeAdapter()))).rejects.toBeInstanceOf(
      CompositionIdeSessionAlreadyRegisteredError,
    );
    await expect(Effect.runPromise(registry.get("vscode-session-1"))).resolves.toBe(adapter);
  });

  it("注销 session 时关闭可关闭的 transport，避免热替换留下旧连接", async () => {
    let closeCount = 0;
    const registry = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(
      registry.register(
        makeAdapter({
          close: () => {
            closeCount += 1;
          },
        }),
      ),
    );

    await expect(Effect.runPromise(registry.unregister("vscode-session-1"))).resolves.toBe(true);
    expect(closeCount).toBe(1);
  });

  it("profile 探测不匹配时返回 unavailable，不猜测 IDE 类型", async () => {
    const registry = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(registry.register(makeAdapter()));

    await expect(
      Effect.runPromise(
        registry.resolve({ sessionId: "vscode-session-1", requestedProfile: "cursor_ide" }),
      ),
    ).resolves.toMatchObject({
      profile: "unknown",
      status: "unavailable",
      reasonCode: "ide_profile_mismatch",
    });
  });

  it("握手只保存请求范围内的 verified operation，并按 task/run/agent 绑定租约", async () => {
    const registry = makeCompositionIdeSessionRegistry({ now: () => 1000, handshakeTtlMs: 5000 });
    await Effect.runPromise(registry.register(makeAdapter()));

    const handshake = await Effect.runPromise(
      registry.handshake({
        sessionId: "vscode-session-1",
        requestedProfile: "vscode_ide",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityGrantIds: ["grant-ide"],
        requestedOperations: ["editor.read"],
      }),
    );

    expect(handshake).toMatchObject({
      status: "accepted",
      handshakeId: "ide-handshake-1",
      verifiedOperations: ["editor.read"],
      expiresAtUnixMs: 6000,
    });

    await expect(
      Effect.runPromise(
        registry.invoke({
          sessionId: "vscode-session-1",
          handshakeId: "ide-handshake-1",
          taskId: "task-other",
          runId: "run-1",
          agentId: "agent-1",
          operation: "editor.read",
          arguments: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "ide_handshake_scope_mismatch" });

    await expect(
      Effect.runPromise(
        registry.invoke({
          sessionId: "vscode-session-1",
          handshakeId: "ide-handshake-1",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          operation: "workspace.write",
          arguments: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "ide_operation_not_verified" });
  });

  it("握手租约过期或 Adapter 断开后拒绝旧 operation", async () => {
    let now = 1000;
    const registry = makeCompositionIdeSessionRegistry({ now: () => now, handshakeTtlMs: 10 });
    await Effect.runPromise(registry.register(makeAdapter()));
    await Effect.runPromise(
      registry.handshake({
        sessionId: "vscode-session-1",
        requestedProfile: "vscode_ide",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityGrantIds: [],
        requestedOperations: ["editor.read"],
      }),
    );

    now = 1010;
    await expect(
      Effect.runPromise(
        registry.invoke({
          sessionId: "vscode-session-1",
          handshakeId: "ide-handshake-1",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          operation: "editor.read",
          arguments: {},
        }),
      ),
    ).rejects.toMatchObject({ code: "ide_handshake_expired" });

    await Effect.runPromise(registry.unregister("vscode-session-1"));
    await expect(Effect.runPromise(registry.get("vscode-session-1"))).resolves.toBeUndefined();
  });

  it("拒绝 Adapter 在 probe allowlist 之外扩大的握手 operation", async () => {
    const registry = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(
      registry.register(
        makeAdapter({
          handshake: (input) =>
            Effect.succeed({
              sessionId: input.sessionId,
              taskId: input.taskId,
              runId: input.runId,
              agentId: input.agentId,
              profile: "vscode_ide" as const,
              status: "accepted" as const,
              handshakeId: "ide-handshake-escalated",
              acceptedGrantIds: [...input.capabilityGrantIds],
              verifiedOperations: ["workspace.delete"],
            }),
        }),
      ),
    );

    await expect(
      Effect.runPromise(
        registry.handshake({
          sessionId: "vscode-session-1",
          requestedProfile: "vscode_ide",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          capabilityGrantIds: [],
          requestedOperations: ["workspace.delete"],
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      reasonCode: "ide_operation_not_probe_verified",
    });
  });
});
