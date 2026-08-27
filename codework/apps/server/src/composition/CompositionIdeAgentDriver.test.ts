import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  makeCompositionIdeAgentDriver,
  compositionIdeAgentId,
} from "./CompositionIdeAgentDriver.ts";
import { makeCompositionIdeSessionRegistry } from "./CompositionIdeSessionRegistry.ts";
import type { CompositionIdeAdapter } from "./CompositionIdeSessionRegistry.ts";

const task = {
  taskId: "task-ide-driver",
  projectId: "project-1",
  assigneeKind: "agent" as const,
  assigneeId: compositionIdeAgentId("vscode-session-1"),
  mode: "serial" as const,
  status: "queued" as const,
  promptDigest: "sha256:ide-driver",
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
};

const run = {
  runId: "run-ide-driver",
  taskId: task.taskId,
  agentId: task.assigneeId,
  runtimeId: "ide:vscode-session-1",
  status: "queued" as const,
  attempt: 1,
  capabilityGrantIds: ["grant-ide"],
};

const makeAdapter = (calls: string[]): CompositionIdeAdapter => ({
  sessionId: "vscode-session-1",
  profile: "vscode_ide",
  probe: () =>
    Effect.succeed({
      sessionId: "vscode-session-1",
      profile: "vscode_ide" as const,
      status: "ready" as const,
      verifiedOperations: ["task.start", "task.cancel"],
    }),
  handshake: (input) => {
    calls.push("handshake");
    return Effect.succeed({
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      profile: "vscode_ide" as const,
      status: "accepted" as const,
      handshakeId: "ide-task-handshake",
      acceptedGrantIds: [...input.capabilityGrantIds],
      verifiedOperations: [...input.requestedOperations],
    });
  },
  invoke: (input) => {
    calls.push(input.operation);
    if (input.operation === "task.start") {
      return Effect.succeed({ runtimeTaskId: "ide-runtime-task-1", status: "accepted" });
    }
    return Effect.succeed({ status: "cancelled", runtimeTaskId: "ide-runtime-task-1" });
  },
});

describe("CompositionIdeAgentDriver", () => {
  it("把已验证的 IDE task bridge operation 投影为可派发 Driver", async () => {
    const calls: string[] = [];
    const registry = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(registry.register(makeAdapter(calls)));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      agentId: compositionIdeAgentId("vscode-session-1"),
    });

    await expect(Effect.runPromise(driver.getProfile!())).resolves.toMatchObject({
      agentId: "ide:vscode-session-1",
      runtimeId: "ide:vscode-session-1",
      driverKind: "ide",
      status: "available",
      supportsIde: true,
      supportsToolBroker: false,
    });
  });

  it("先完成 capability handshake，再通过 IDE bridge 派发和取消任务", async () => {
    const calls: string[] = [];
    const registry = makeCompositionIdeSessionRegistry();
    await Effect.runPromise(registry.register(makeAdapter(calls)));
    const driver = makeCompositionIdeAgentDriver({
      registry,
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      agentId: compositionIdeAgentId("vscode-session-1"),
    });

    const started = await Effect.runPromise(
      driver.startTask({
        task,
        run,
        prompt: "请检查当前编辑器任务",
        workspaceRoot: "C:/workspace",
      }),
    );
    expect(started).toEqual({
      runtimeTaskId: "ide-runtime-task-1",
      capabilityHandshakeId: "ide-task-handshake",
    });

    await expect(
      Effect.runPromise(
        driver.cancelTask({
          task,
          run: {
            ...run,
            status: "running",
            runtimeTaskId: started.runtimeTaskId,
            capabilityHandshakeId: started.capabilityHandshakeId,
          },
          reason: "用户取消",
        }),
      ),
    ).resolves.toEqual({ status: "cancelled" });
    expect(calls).toEqual(["handshake", "task.start", "task.cancel"]);
  });
});
