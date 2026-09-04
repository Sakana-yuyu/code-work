// @effect-diagnostics nodeBuiltinImport:off - 本测试启动真实本地 IDE fixture 子进程。
// @effect-diagnostics globalTimers:off - 本测试等待真实子进程和 WebSocket 生命周期。

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionIdeJsonRpcAdapter } from "./CompositionIdeJsonRpcTransport.ts";
import { makeCompositionIdeSessionRegistry } from "./CompositionIdeSessionRegistry.ts";

const fixturePath = NodeURL.fileURLToPath(
  new URL("./CompositionIdeJsonRpcFixture.mjs", import.meta.url),
);

type FixtureProcess = {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly url: string;
};

const startFixture = async (): Promise<FixtureProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath], {
    cwd: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = NodeReadline.createInterface({ input: child.stdout });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onLine = (line: string) => {
        try {
          const message = JSON.parse(line) as { readonly port?: unknown };
          if (typeof message.port === "number") resolve(message.port);
        } catch {
          // 忽略 fixture 启动阶段的非 JSON 输出，直到收到 ready 行。
        }
      };
      lines.on("line", onLine);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`IDE fixture 提前退出：${code ?? "unknown"}`)));
    });
    return { child, url: `ws://127.0.0.1:${port}/t3/ide` };
  } finally {
    lines.close();
  }
};

const stopFixture = async (fixture: FixtureProcess): Promise<void> => {
  if (fixture.child.exitCode !== null) return;
  fixture.child.stdin.write("close\n");
  await new Promise<void>((resolve) => fixture.child.once("exit", () => resolve()));
};

describe("CompositionIdeJsonRpcTransport 本地跨进程 E2E", () => {
  it("经过真实 IDE 子进程和 SessionRegistry 回流 probe、handshake、invoke", async () => {
    const fixture = await startFixture();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-fixture",
      profile: "vscode_ide",
      url: fixture.url,
      headers: { Authorization: "Bearer fixture-ide-token" },
      openTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const registry = makeCompositionIdeSessionRegistry();
    try {
      await Effect.runPromise(registry.register(adapter));
      await expect(
        Effect.runPromise(
          registry.resolve({ sessionId: "vscode-session-fixture", requestedProfile: "vscode_ide" }),
        ),
      ).resolves.toMatchObject({ status: "ready", profile: "vscode_ide" });

      await expect(
        Effect.runPromise(
          registry.handshake({
            sessionId: "vscode-session-fixture",
            requestedProfile: "vscode_ide",
            taskId: "task-1",
            runId: "run-1",
            agentId: "agent-1",
            capabilityGrantIds: ["grant-ide"],
            requestedOperations: ["editor.read"],
          }),
        ),
      ).resolves.toMatchObject({
        status: "accepted",
        handshakeId: "fixture-ide-handshake",
      });

      await expect(
        Effect.runPromise(
          registry.invoke({
            sessionId: "vscode-session-fixture",
            handshakeId: "fixture-ide-handshake",
            taskId: "task-1",
            runId: "run-1",
            agentId: "agent-1",
            operation: "editor.read",
            arguments: { uri: "file:///workspace/app.ts" },
          }),
        ),
      ).resolves.toMatchObject({
        contents: "fixture editor response",
        taskId: "task-1",
        runId: "run-1",
      });
    } finally {
      adapter.close();
      await stopFixture(fixture);
    }
  });
});
