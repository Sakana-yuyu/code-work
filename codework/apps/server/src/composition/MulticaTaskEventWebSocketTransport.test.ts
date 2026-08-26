// @effect-diagnostics globalTimers:off - 测试需要驱动原生 fake WebSocket 的事件循环。

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  makeMulticaTaskEventWebSocketStream,
  makeMulticaTaskEventWebSocketUrl,
  type MulticaTaskEventWebSocket,
  type MulticaTaskEventWebSocketFactory,
} from "./MulticaTaskEventWebSocketTransport.ts";

type FakeSocketEvent = "open" | "message" | "error" | "close";

class FakeSocketImpl implements MulticaTaskEventWebSocket {
  readonly url: string;
  readonly sent: Array<string> = [];
  closeCount = 0;
  terminateCount = 0;
  private closed = false;
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(data: unknown) => void>(),
    error: new Set<(error: unknown) => void>(),
    close: new Set<() => void>(),
  };

  constructor(url: string) {
    this.url = url;
  }

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: FakeSocketEvent, listener: (() => void) | ((value: unknown) => void)): void {
    if (event === "open") this.listeners.open.add(listener as () => void);
    if (event === "message") this.listeners.message.add(listener as (data: unknown) => void);
    if (event === "error") this.listeners.error.add(listener as (error: unknown) => void);
    if (event === "close") this.listeners.close.add(listener as () => void);
  }

  off(event: "open", listener: () => void): void;
  off(event: "message", listener: (data: unknown) => void): void;
  off(event: "error", listener: (error: unknown) => void): void;
  off(event: "close", listener: () => void): void;
  off(event: FakeSocketEvent, listener: (() => void) | ((value: unknown) => void)): void {
    if (event === "open") this.listeners.open.delete(listener as () => void);
    if (event === "message") this.listeners.message.delete(listener as (data: unknown) => void);
    if (event === "error") this.listeners.error.delete(listener as (error: unknown) => void);
    if (event === "close") this.listeners.close.delete(listener as () => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.close) listener();
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  emit(event: FakeSocketEvent, value?: unknown): void {
    if (event === "open") for (const listener of this.listeners.open) listener();
    if (event === "message") for (const listener of this.listeners.message) listener(value);
    if (event === "error") for (const listener of this.listeners.error) listener(value);
    if (event === "close") for (const listener of this.listeners.close) listener();
  }
}

type MutableFakeSocket = FakeSocketImpl;

const makeFakeSocket = (url: string): MutableFakeSocket => new FakeSocketImpl(url);

const decodeSent = (
  socket: Pick<MulticaTaskEventWebSocket, "send"> & { readonly sent: ReadonlyArray<string> },
): ReadonlyArray<{ readonly type: string; readonly payload: unknown }> =>
  socket.sent.map(
    (value) => JSON.parse(value) as { readonly type: string; readonly payload: unknown },
  );

const flushEffects = async (): Promise<void> => {
  await Effect.runPromise(Effect.yieldNow);
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const makeFactory =
  (sockets: Array<MutableFakeSocket>): MulticaTaskEventWebSocketFactory =>
  (url) => {
    const socket = makeFakeSocket(url);
    sockets.push(socket);
    return socket;
  };

const startStream = async (options: {
  readonly workspaceIds: ReadonlyArray<string>;
  readonly taskId?: string;
  readonly sockets: Array<MutableFakeSocket>;
  readonly take: number;
  readonly reconnectDelaysMs?: ReadonlyArray<number>;
  readonly openTimeoutMs?: number;
}) => {
  const stream = makeMulticaTaskEventWebSocketStream({
    baseUrl: "https://multica.test/api",
    headers: { Authorization: "Bearer test-token" },
    workspaceIds: options.workspaceIds,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
    ...(options.reconnectDelaysMs === undefined
      ? {}
      : { reconnectDelaysMs: options.reconnectDelaysMs }),
    ...(options.openTimeoutMs === undefined ? {} : { openTimeoutMs: options.openTimeoutMs }),
    webSocketFactory: makeFactory(options.sockets),
  });
  const fiber = Effect.runFork(Stream.runCollect(Stream.take(stream, options.take)));
  await flushEffects();
  return fiber;
};

const emitFrame = (socket: FakeSocketImpl, type: string, payload: unknown = undefined): void => {
  socket.emit("message", JSON.stringify({ type, payload }));
};

const authenticateWorkspace = (
  socket: FakeSocketImpl,
  workspaceId: string,
  taskId?: string,
): void => {
  socket.emit("open");
  emitFrame(socket, "auth_ack");
  emitFrame(socket, "subscribe_ack", { scope: "workspace", id: workspaceId });
  if (taskId !== undefined) emitFrame(socket, "subscribe_ack", { scope: "task", id: taskId });
};

describe("MulticaTaskEventWebSocketTransport", () => {
  it("把 Multica HTTP 地址转换为 /ws，并且不把 token 放进 URL", () => {
    const url = makeMulticaTaskEventWebSocketUrl("https://multica.test/api/", "workspace one");
    const parsed = new URL(url);

    expect(parsed.protocol).toBe("wss:");
    expect(parsed.pathname).toBe("/api/ws");
    expect(parsed.searchParams.get("workspace_id")).toBe("workspace one");
    expect(parsed.search).not.toContain("token");
  });

  it("等待认证和订阅确认后才放行任务事件，并按官方顺序发送控制帧", async () => {
    const sockets: Array<MutableFakeSocket> = [];
    const fiber = await startStream({
      workspaceIds: ["workspace-1"],
      taskId: "task-1",
      sockets,
      take: 1,
    });
    const socket = sockets[0];
    expect(socket).toBeDefined();
    socket!.emit("open");
    expect(decodeSent(socket!)).toEqual([{ type: "auth", payload: { token: "test-token" } }]);

    emitFrame(socket!, "task:progress", { task_id: "task-1", summary: "过早事件" });
    emitFrame(socket!, "auth_ack");
    expect(decodeSent(socket!)).toEqual([
      { type: "auth", payload: { token: "test-token" } },
      { type: "subscribe", payload: { scope: "workspace", id: "workspace-1" } },
    ]);
    emitFrame(socket!, "subscribe_ack", { scope: "workspace", id: "workspace-1" });
    expect(decodeSent(socket!)).toEqual([
      { type: "auth", payload: { token: "test-token" } },
      { type: "subscribe", payload: { scope: "workspace", id: "workspace-1" } },
      { type: "subscribe", payload: { scope: "task", id: "task-1" } },
    ]);
    emitFrame(socket!, "task:progress", { task_id: "task-1", summary: "仍在等待 task ack" });
    emitFrame(socket!, "subscribe_ack", { scope: "task", id: "task-1" });
    emitFrame(socket!, "task:progress", { task_id: "task-1", summary: "已放行" });

    await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toEqual([
      { type: "task:progress", payload: { task_id: "task-1", summary: "已放行" } },
    ]);
  });

  it("隔离多个 workspace 的连接和事件", async () => {
    const sockets: Array<MutableFakeSocket> = [];
    const fiber = await startStream({
      workspaceIds: ["workspace-1", "workspace-2"],
      sockets,
      take: 2,
    });
    expect(sockets).toHaveLength(2);
    const first = sockets[0]!;
    const second = sockets[1]!;
    authenticateWorkspace(first, "workspace-1");
    authenticateWorkspace(second, "workspace-2");

    emitFrame(first, "task:progress", { workspace_id: "workspace-2", task_id: "task-2" });
    emitFrame(first, "task:progress", { workspace_id: "workspace-1", task_id: "task-1" });
    emitFrame(second, "task:progress", { workspace_id: "workspace-2", task_id: "task-2" });

    await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toEqual([
      { type: "task:progress", payload: { workspace_id: "workspace-1", task_id: "task-1" } },
      { type: "task:progress", payload: { workspace_id: "workspace-2", task_id: "task-2" } },
    ]);
  });

  it("过滤 task scope，认证错误和非法帧不会伪造任务事件", async () => {
    const sockets: Array<MutableFakeSocket> = [];
    const fiber = await startStream({
      workspaceIds: ["workspace-1"],
      taskId: "task-1",
      sockets,
      take: 1,
    });
    const socket = sockets[0]!;
    authenticateWorkspace(socket, "workspace-1", "task-1");
    emitFrame(socket, "not-json", undefined);
    emitFrame(socket, "task:progress", { task_id: "task-2", summary: "其他任务" });
    emitFrame(socket, "task:progress", { task_id: "task-1", summary: "当前任务" });

    await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toEqual([
      { type: "task:progress", payload: { task_id: "task-1", summary: "当前任务" } },
    ]);
  });

  it("断线只安排一次有界重连，并在重连后重新认证和订阅", async () => {
    const sockets: Array<MutableFakeSocket> = [];
    const fiber = await startStream({
      workspaceIds: ["workspace-1"],
      taskId: "task-1",
      sockets,
      take: 1,
      reconnectDelaysMs: [0],
    });
    const first = sockets[0]!;
    authenticateWorkspace(first, "workspace-1", "task-1");
    first.emit("error", new Error("断线"));
    first.emit("close");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    authenticateWorkspace(second, "workspace-1", "task-1");
    emitFrame(second, "task:completed", { task_id: "task-1", output: "完成" });

    await expect(Effect.runPromise(Fiber.join(fiber))).resolves.toEqual([
      { type: "task:completed", payload: { task_id: "task-1", output: "完成" } },
    ]);
    expect(decodeSent(second)).toEqual([
      { type: "auth", payload: { token: "test-token" } },
      { type: "subscribe", payload: { scope: "workspace", id: "workspace-1" } },
      { type: "subscribe", payload: { scope: "task", id: "task-1" } },
    ]);
  });

  it("stream 中断后清理 socket 和 timer，旧连接迟到事件不再进入 stream", async () => {
    const sockets: Array<MutableFakeSocket> = [];
    const fiber = await startStream({
      workspaceIds: ["workspace-1"],
      sockets,
      take: 1,
      reconnectDelaysMs: [1_000],
      openTimeoutMs: 1_000,
    });
    const socket = sockets[0]!;
    authenticateWorkspace(socket, "workspace-1");
    emitFrame(socket, "task:progress", { task_id: "task-1", summary: "完成一次消费" });
    await Effect.runPromise(Fiber.join(fiber));

    expect(socket.closeCount).toBeGreaterThan(0);
    const before = sockets.length;
    socket.emit("close");
    socket.emit(
      "message",
      JSON.stringify({ type: "task:progress", payload: { task_id: "task-1" } }),
    );
    await flushEffects();
    expect(sockets).toHaveLength(before);
  });

  it("缺少 Authorization 或 workspace 时显式失败", async () => {
    const missingAuth = makeMulticaTaskEventWebSocketStream({
      baseUrl: "https://multica.test",
      headers: {},
      workspaceIds: ["workspace-1"],
    });
    await expect(Effect.runPromise(Stream.runCollect(missingAuth))).rejects.toMatchObject({
      code: "authorization_missing",
    });

    const missingWorkspace = makeMulticaTaskEventWebSocketStream({
      baseUrl: "https://multica.test",
      headers: { Authorization: "Bearer test-token" },
      workspaceIds: [],
    });
    await expect(Effect.runPromise(Stream.runCollect(missingWorkspace))).rejects.toMatchObject({
      code: "workspace_missing",
    });
  });
});
