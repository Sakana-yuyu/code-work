// @effect-diagnostics nodeBuiltinImport:off - 本测试启动真实本地 IDE bridge fixture 子进程。
// @effect-diagnostics globalTimers:off - 本测试等待真实子进程和 WebSocket 生命周期。

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  compositionIdeAgentId,
  makeCompositionIdeAgentDriver,
} from "./CompositionIdeAgentDriver.ts";
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
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line) as { readonly port?: unknown };
          if (typeof message.port === "number") resolve(message.port);
        } catch {
          // 忽略 fixture 启动阶段的非 JSON 输出。
        }
      });
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

describe("CompositionIdeAgentDriver 本地跨进程 E2E", () => {
  it("通过真实 IDE bridge 子进程完成 task start 和 cancel", async () => {
    const fixture = await startFixture();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-fixture",
      profile: "vscode_ide",
      url: fixture.url,
      headers: { Authorization: "Bearer fixture-ide-token" },
      openTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const sessions = makeCompositionIdeSessionRegistry();
    try {
      await Effect.runPromise(sessions.register(adapter));
      const driver = makeCompositionIdeAgentDriver({
        registry: sessions,
        sessionId: "vscode-session-fixture",
        profile: "vscode_ide",
        agentId: compositionIdeAgentId("vscode-session-fixture"),
        eventStream: adapter.streamEvents,
      });
      const task = {
        taskId: "task-ide-e2e",
        projectId: "project-1",
        assigneeKind: "agent" as const,
        assigneeId: driver.agentId,
        mode: "serial" as const,
        status: "queued" as const,
        promptDigest: "sha256:ide-e2e",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run = {
        runId: "run-ide-e2e",
        taskId: task.taskId,
        agentId: driver.agentId,
        runtimeId: driver.runtimeId,
        status: "queued" as const,
        attempt: 1,
        capabilityGrantIds: [],
      };
      const started = await Effect.runPromise(
        driver.startTask({
          task,
          run,
          prompt: "执行 IDE bridge smoke",
          workspaceRoot: "C:/workspace",
        }),
      );
      expect(started.runtimeTaskId).toBe("fixture-runtime-task-1");

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
            reason: "E2E 取消",
          }),
        ),
      ).resolves.toEqual({ status: "cancelled" });
    } finally {
      adapter.close();
      await stopFixture(fixture);
    }
  });

  it("接收 IDE bridge 子进程发送的任务进度和终态事件", async () => {
    const fixture = await startFixture();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-fixture",
      profile: "vscode_ide",
      url: fixture.url,
      headers: { Authorization: "Bearer fixture-ide-token" },
      openTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const sessions = makeCompositionIdeSessionRegistry();
    try {
      await Effect.runPromise(sessions.register(adapter));
      const driver = makeCompositionIdeAgentDriver({
        registry: sessions,
        sessionId: "vscode-session-fixture",
        profile: "vscode_ide",
        eventStream: adapter.streamEvents,
      });
      const task = {
        taskId: "task-ide-events",
        projectId: "project-1",
        assigneeKind: "agent" as const,
        assigneeId: driver.agentId,
        mode: "serial" as const,
        status: "queued" as const,
        promptDigest: "sha256:ide-events",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run = {
        runId: "run-ide-events",
        taskId: task.taskId,
        agentId: driver.agentId,
        runtimeId: driver.runtimeId,
        status: "queued" as const,
        attempt: 1,
        capabilityGrantIds: [],
      };
      const eventsPromise = Effect.runPromise(
        driver.streamEvents!().pipe(Stream.take(2), Stream.runCollect),
      );
      const started = await Effect.runPromise(
        driver.startTask({
          task,
          run,
          prompt: "[fixture:complete] 执行 IDE bridge event smoke",
          workspaceRoot: "C:/workspace",
        }),
      );
      const events = Array.from(await eventsPromise);

      expect(events.map((event) => event.type)).toEqual(["task.progress", "task.completed"]);
      expect(driver.resolveRuntimeEvent!(events[0]!)).toEqual({
        taskId: task.taskId,
        runId: run.runId,
        runtimeTaskId: started.runtimeTaskId,
      });
      expect(driver.resolveRuntimeEvent!(events[1]!)).toEqual({
        taskId: task.taskId,
        runId: run.runId,
        runtimeTaskId: started.runtimeTaskId,
      });
    } finally {
      adapter.close();
      await stopFixture(fixture);
    }
  });
});
