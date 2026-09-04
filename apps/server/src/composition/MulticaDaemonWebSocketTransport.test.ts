// @effect-diagnostics globalTimers:off - 测试需要驱动原生 fake WebSocket 的事件循环。
// @effect-diagnostics preferSchemaOverJson:off - 测试报文使用 JSON 字符串模拟真实 WebSocket 帧。

import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  makeMulticaDaemonWebSocketStream,
  makeMulticaDaemonWebSocketUrl,
  type MulticaDaemonWebSocket,
  type MulticaDaemonWebSocketFactory,
} from "./MulticaDaemonWebSocketTransport.ts";

type FakeSocketEvent = "open" | "message" | "error" | "close";

class FakeSocketImpl implements MulticaDaemonWebSocket {
  readonly url: string;
  readonly sent: Array<string> = [];
  closeCount = 0;
  terminateCount = 0;
  pingCount = 0;
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

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
  }

  terminate(): void {
    this.terminateCount += 1;
  }

  ping(): void {
    this.pingCount += 1;
  }

  emit(event: "open"): void;
  emit(event: "message", data: unknown): void;
  emit(event: "error", error: unknown): void;
  emit(event: "close"): void;
  emit(event: FakeSocketEvent, value?: unknown): void {
    if (event === "open") for (const listener of this.listeners.open) listener();
    if (event === "message") for (const listener of this.listeners.message) listener(value);
    if (event === "error") for (const listener of this.listeners.error) listener(value);
    if (event === "close") for (const listener of this.listeners.close) listener();
  }
}

const decodeSent = (socket: FakeSocketImpl): Array<{ type: string; payload?: unknown }> =>
  socket.sent.map(
    (value) =>
      Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(value) as {
        type: string;
        payload?: unknown;
      },
  );

const flushEffects = Effect.yieldNow.pipe(
  Effect.andThen(Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))),
);

const makeFactory =
  (sockets: Array<FakeSocketImpl>): MulticaDaemonWebSocketFactory =>
  (url) => {
    const socket = new FakeSocketImpl(url);
    sockets.push(socket);
    return socket;
  };

describe("MulticaDaemonWebSocketTransport", () => {
  it("构造独立 daemon 控制地址，并且不把 token 放进 URL", () => {
    const url = makeMulticaDaemonWebSocketUrl("https://multica.test/api/?token=secret", [
      "runtime-1",
      "runtime-2",
    ]);
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("wss:");
    expect(parsed.pathname).toBe("/api/daemon/ws");
    expect(parsed.searchParams.getAll("runtime_id")).toEqual(["runtime-1", "runtime-2"]);
    expect(parsed.searchParams.has("runtime_ids")).toBe(false);
    expect(parsed.search).not.toContain("token");
  });

  effectIt.effect("打开后立即发送每个 runtime 的 heartbeat，并接收 heartbeat ack", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1", "runtime-2"],
        webSocketFactory: makeFactory(sockets),
      });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(transport.stream, 1)));
      yield* flushEffects;
      const socket = sockets[0];
      expect(socket).toBeDefined();
      expect(new URL(socket!.url).searchParams.getAll("runtime_id")).toEqual([
        "runtime-1",
        "runtime-2",
      ]);
      socket!.emit("open");
      expect(decodeSent(socket!)).toEqual([
        {
          type: "daemon:heartbeat",
          payload: { runtime_id: "runtime-1", supports_batch_import: true },
        },
        {
          type: "daemon:heartbeat",
          payload: { runtime_id: "runtime-2", supports_batch_import: true },
        },
      ]);
      socket!.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        }),
      );
      const events = yield* Fiber.join(fiber);
      expect(events).toEqual([
        {
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        },
      ]);
    }),
  );

  effectIt.effect("忽略不属于当前连接 runtime scope 的 heartbeat ack，也不提前解锁 RPC", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1"],
        webSocketFactory: makeFactory(sockets),
      });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(transport.stream, 1)));
      yield* flushEffects;
      const socket = sockets[0]!;
      socket.emit("open");
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-not-authorized", status: "online" },
        }),
      );
      expect(transport.supportsRpc()).toBe(false);
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "online", server_capabilities: ["rpc-v1"] },
        }),
      );
      const events = yield* Fiber.join(fiber);
      expect(events).toEqual([
        {
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "online", server_capabilities: ["rpc-v1"] },
        },
      ]);
      transport.close();
    }),
  );

  effectIt.effect("多 runtime 连接合并 heartbeat ack 的 server capabilities", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1", "runtime-2"],
        webSocketFactory: makeFactory(sockets),
      });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(transport.stream, 2)));
      yield* flushEffects;
      const socket = sockets[0]!;
      socket.emit("open");
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "online", server_capabilities: ["rpc-v1"] },
        }),
      );
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: {
            runtime_id: "runtime-2",
            status: "online",
            server_capabilities: ["task-events-v1"],
          },
        }),
      );

      yield* Fiber.join(fiber);
      expect(transport.supportsRpc()).toBe(true);
    }),
  );

  effectIt.effect("把匹配 request_id 的 RPC response 返回给请求方，并拒绝非 2xx", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1"],
        webSocketFactory: makeFactory(sockets),
      });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(transport.stream, 2)));
      yield* flushEffects;
      const socket = sockets[0]!;
      socket.emit("open");
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        }),
      );
      yield* flushEffects;

      const request = transport.request({
        method: "tasks.claim",
        body: { runtime_id: "runtime-1" },
      });
      const requestFiber = yield* Effect.forkChild(request);
      yield* flushEffects;
      yield* flushEffects;
      const sent = decodeSent(socket);
      const rpc = sent.at(-1);
      expect(rpc?.type).toBe("daemon:rpc_request");
      const requestId = (rpc?.payload as { request_id: string }).request_id;
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:rpc_response",
          payload: { request_id: requestId, status: 200, body: { task_id: "task-1" } },
        }),
      );
      const response = yield* Fiber.join(requestFiber);
      expect(response).toMatchObject({
        status: 200,
        body: { task_id: "task-1" },
      });

      const failedRequest = yield* Effect.forkChild(
        transport.request({ method: "tasks.claim", body: { runtime_id: "runtime-1" } }),
      );
      yield* flushEffects;
      yield* flushEffects;
      const failedRpc = decodeSent(socket).at(-1)!;
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:rpc_response",
          payload: {
            request_id: (failedRpc.payload as { request_id: string }).request_id,
            status: 409,
            error: "claim unavailable",
          },
        }),
      );
      const failedError = yield* Effect.flip(Fiber.join(failedRequest));
      expect(failedError).toMatchObject({
        code: "rpc_error",
        status: 409,
      });
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:task_available",
          payload: { runtime_id: "runtime-1", task_id: "task-1" },
        }),
      );
      yield* Fiber.join(fiber);
    }),
  );

  effectIt.effect("RPC 在当前连接收到 rpc-v1 heartbeat ack 前等待，不会提前发送", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test?token=must-not-leak",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1"],
        webSocketFactory: makeFactory(sockets),
      });
      const requestFiber = yield* Effect.forkChild(transport.request({ method: "tasks.claim" }));
      yield* flushEffects;
      const socket = sockets[0]!;
      expect(socket.url).not.toContain("token=");
      socket.emit("open");
      yield* flushEffects;
      expect(decodeSent(socket).some((message) => message.type === "daemon:rpc_request")).toBe(
        false,
      );

      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        }),
      );
      yield* flushEffects;
      const rpc = decodeSent(socket).at(-1)!;
      expect(rpc.type).toBe("daemon:rpc_request");
      const requestId = (rpc.payload as { request_id: string }).request_id;
      socket.emit(
        "message",
        JSON.stringify({
          type: "daemon:rpc_response",
          payload: { request_id: requestId, status: 200, body: { ok: true } },
        }),
      );
      const response = yield* Fiber.join(requestFiber);
      expect(response).toMatchObject({
        status: 200,
        body: { ok: true },
      });
    }),
  );

  effectIt.effect("重连后必须等待新 heartbeat ack 才能发送新的 RPC", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1"],
        reconnectDelaysMs: [0],
        webSocketFactory: makeFactory(sockets),
      });
      const firstRequest = yield* Effect.forkChild(transport.request({ method: "tasks.claim" }));
      yield* flushEffects;
      const first = sockets[0]!;
      first.emit("open");
      first.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        }),
      );
      yield* flushEffects;
      const firstRpc = decodeSent(first).at(-1)!;
      first.emit(
        "message",
        JSON.stringify({
          type: "daemon:rpc_response",
          payload: {
            request_id: (firstRpc.payload as { request_id: string }).request_id,
            status: 200,
          },
        }),
      );
      yield* Fiber.join(firstRequest);
      first.emit("close");
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

      const second = sockets[1]!;
      second.emit("open");
      const secondRequest = yield* Effect.forkChild(transport.request({ method: "tasks.claim" }));
      yield* flushEffects;
      expect(decodeSent(second).some((message) => message.type === "daemon:rpc_request")).toBe(
        false,
      );

      second.emit(
        "message",
        JSON.stringify({
          type: "daemon:heartbeat_ack",
          payload: { runtime_id: "runtime-1", status: "ok", server_capabilities: ["rpc-v1"] },
        }),
      );
      yield* flushEffects;
      const secondRpc = decodeSent(second).at(-1)!;
      expect(secondRpc.type).toBe("daemon:rpc_request");
      second.emit(
        "message",
        JSON.stringify({
          type: "daemon:rpc_response",
          payload: {
            request_id: (secondRpc.payload as { request_id: string }).request_id,
            status: 200,
          },
        }),
      );
      const response = yield* Fiber.join(secondRequest);
      expect(response).toMatchObject({
        status: 200,
      });
      transport.close();
    }),
  );

  effectIt.effect("断线后有限重连，重连时重新发送 heartbeat，停止后清理旧连接", () =>
    Effect.gen(function* () {
      const sockets: Array<FakeSocketImpl> = [];
      const transport = makeMulticaDaemonWebSocketStream({
        baseUrl: "https://multica.test",
        headers: { Authorization: "Bearer test-token" },
        runtimeIds: ["runtime-1"],
        reconnectDelaysMs: [0],
        webSocketFactory: makeFactory(sockets),
      });
      const fiber = yield* Effect.forkChild(Stream.runCollect(Stream.take(transport.stream, 1)));
      yield* flushEffects;
      const first = sockets[0]!;
      first.emit("open");
      first.emit("close");
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      expect(sockets).toHaveLength(2);
      const second = sockets[1]!;
      second.emit("open");
      second.emit(
        "message",
        JSON.stringify({
          type: "daemon:task_available",
          payload: { runtime_id: "runtime-1", task_id: "task-1" },
        }),
      );
      yield* Fiber.join(fiber);
      expect(first.closeCount + first.terminateCount).toBeGreaterThan(0);
      expect(second.closeCount + second.terminateCount).toBeGreaterThan(0);
    }),
  );
});
