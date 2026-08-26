// @effect-diagnostics globalTimers:off - 本测试等待真实子进程和 WebSocket 生命周期。

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { ProviderDriverKind } from "@codework/contracts";

import {
  makeMulticaDaemonWebSocketStream,
  type MulticaDaemonWebSocketTransport,
} from "./MulticaDaemonWebSocketTransport.ts";
import { makeMulticaDaemonRuntimeAdapter } from "./MulticaDaemonRuntimeAdapter.ts";
import { makeMulticaTaskEventWebSocketStream } from "./MulticaTaskEventWebSocketTransport.ts";
import type { MulticaDaemonProtocol } from "./MulticaDaemonProtocol.ts";

const fixturePath = fileURLToPath(new URL("./MulticaDualChannelFixture.mjs", import.meta.url));
const fixtureToken = "fixture-token";

type FixtureProcess = {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly baseUrl: string;
};

const startFixture = async (): Promise<FixtureProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
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
      child.once("exit", (code) => {
        reject(new Error(`Multica fixture 提前退出：${code ?? "unknown"}`));
      });
    });
    return { child, baseUrl: `http://127.0.0.1:${port}` };
  } finally {
    lines.close();
  }
};

const stopFixture = async (fixture: FixtureProcess): Promise<void> => {
  if (fixture.child.exitCode !== null) return;
  fixture.child.stdin.write("close\n");
  await new Promise<void>((resolve) => {
    fixture.child.once("exit", () => resolve());
  });
};

const makeProtocol = (): MulticaDaemonProtocol => ({
  register: () => Effect.die("测试未实现 register"),
  heartbeat: () =>
    Effect.succeed({
      runtimeId: "runtime-1",
      status: "online",
      serverCapabilities: ["rpc-v1"],
      runtimeGone: false,
    }),
  claimTask: () => Effect.succeed(null),
  startTask: () => Effect.void,
  reportProgress: () => Effect.void,
  completeTask: () => Effect.void,
  failTask: () => Effect.void,
  acknowledgeCancellation: () => Effect.void,
  getTaskStatus: () => Effect.succeed({ status: "running" }),
  quickCreateTask: () => Effect.succeed({ taskId: "created-task" }),
});

describe("Multica 双通道跨进程协议 E2E", () => {
  it("通过真实子进程验证 daemon control、task event 和 Adapter 事件回流", async () => {
    const fixture = await startFixture();
    let control: MulticaDaemonWebSocketTransport | undefined;
    try {
      control = makeMulticaDaemonWebSocketStream({
        baseUrl: fixture.baseUrl,
        headers: { Authorization: `Bearer ${fixtureToken}` },
        runtimeIds: ["runtime-1"],
        workspaceIds: ["workspace-1"],
        heartbeatIntervalMs: 60_000,
        readTimeoutMs: 5_000,
        openTimeoutMs: 5_000,
      });

      const controlResponse = await Effect.runPromise(
        control.request({ method: "fixture.echo", body: { ok: true } }),
      );
      expect(controlResponse).toMatchObject({
        status: 200,
        body: { fixture: true, method: "fixture.echo" },
      });

      const adapter = makeMulticaDaemonRuntimeAdapter({
        runtimeId: "multica:fixture:runtime-1",
        daemonId: "fixture",
        daemonRuntimeId: "runtime-1",
        baseUrl: fixture.baseUrl,
        protocol: makeProtocol(),
        agents: [
          {
            agentId: "agent-1",
            runtimeId: "multica:fixture:runtime-1",
            status: "online",
            capabilities: [],
          },
        ],
        streamFrames: ({ runtimeTaskId }) =>
          makeMulticaTaskEventWebSocketStream({
            baseUrl: fixture.baseUrl,
            headers: { Authorization: `Bearer ${fixtureToken}` },
            workspaceIds: ["workspace-1"],
            ...(runtimeTaskId === undefined ? {} : { taskId: runtimeTaskId }),
            openTimeoutMs: 5_000,
            reconnectDelaysMs: [0],
          }),
        controlFrames: () =>
          makeMulticaDaemonWebSocketStream({
            baseUrl: fixture.baseUrl,
            headers: { Authorization: `Bearer ${fixtureToken}` },
            runtimeIds: ["runtime-1"],
            workspaceIds: ["workspace-1"],
            heartbeatIntervalMs: 60_000,
            readTimeoutMs: 5_000,
            openTimeoutMs: 5_000,
          }).stream,
      });

      const events = await Effect.runPromise(
        adapter
          .streamEvents({ runtimeTaskId: "remote-task-1" })
          .pipe(Stream.take(2), Stream.runCollect),
      );
      expect(events).toHaveLength(2);
      expect(events.map((event) => event.type)).toEqual(["task.progress", "task.completed"]);
      expect(events.every((event) => event.provider === ProviderDriverKind.make("multica"))).toBe(
        true,
      );
      expect(events.map((event) => event.eventId)).toEqual([
        "fixture-task-progress",
        "fixture-task-completed",
      ]);
      expect(events.every((event) => event.raw?.runtimeId === "multica:fixture:runtime-1")).toBe(
        true,
      );
      expect(events.every((event) => event.raw?.runtimeTaskId === "remote-task-1")).toBe(true);
      expect(events[1]?.payload).toMatchObject({
        taskId: "remote-task-1",
        status: "completed",
        output: "fixture completed",
      });
    } finally {
      control?.close();
      await stopFixture(fixture);
    }
  });
});
