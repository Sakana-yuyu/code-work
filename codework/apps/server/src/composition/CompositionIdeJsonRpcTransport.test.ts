// @effect-diagnostics globalTimers:off - 测试需要驱动原生 fake WebSocket 的事件循环。

import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  makeCompositionIdeJsonRpcAdapter,
  type CompositionIdeJsonRpcSocket,
  type CompositionIdeJsonRpcSocketFactory,
} from "./CompositionIdeJsonRpcTransport.ts";

type SocketEvent = "open" | "message" | "error" | "close";

class FakeSocket implements CompositionIdeJsonRpcSocket {
  readonly sent: string[] = [];
  closeCount = 0;
  terminateCount = 0;
  private readonly listeners = {
    open: new Set<() => void>(),
    message: new Set<(data: unknown) => void>(),
    error: new Set<(error: unknown) => void>(),
    close: new Set<() => void>(),
  };

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: SocketEvent, listener: (() => void) | ((value: unknown) => void)): void {
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

  emit(event: "open"): void;
  emit(event: "message", data: unknown): void;
  emit(event: "error", error: unknown): void;
  emit(event: "close"): void;
  emit(event: SocketEvent, value?: unknown): void {
    if (event === "open") for (const listener of this.listeners.open) listener();
    if (event === "message") for (const listener of this.listeners.message) listener(value);
    if (event === "error") for (const listener of this.listeners.error) listener(value);
    if (event === "close") for (const listener of this.listeners.close) listener();
  }
}

const flush = async (): Promise<void> => {
  await Effect.runPromise(Effect.yieldNow);
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const makeFactory =
  (
    socket: FakeSocket,
    expectedHeaders: Readonly<Record<string, string>> = { Authorization: "Bearer test-token" },
  ): CompositionIdeJsonRpcSocketFactory =>
  (url, options) => {
    expect(url).toBe("ws://127.0.0.1:4111/t3/ide");
    expect(options.headers).toEqual(expectedHeaders);
    return socket;
  };

const decode = (socket: FakeSocket): Array<Record<string, unknown>> =>
  socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);

describe("CompositionIdeJsonRpcTransport", () => {
  it("通过 JSON-RPC 完成 probe、handshake 和 invoke，并保持 task/run/agent scope", async () => {
    const socket = new FakeSocket();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      headers: { Authorization: "Bearer test-token" },
      webSocketFactory: makeFactory(socket),
    });

    const probePromise = Effect.runPromise(adapter.probe());
    void probePromise.catch(() => undefined);
    await flush();
    socket.emit("open");
    await flush();
    const probeRequest = decode(socket)[0];
    expect(probeRequest).toMatchObject({
      jsonrpc: "2.0",
      method: "t3.ide.probe",
      params: { sessionId: "vscode-session-1", profile: "vscode_ide" },
    });
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: probeRequest?.id,
        result: {
          sessionId: "vscode-session-1",
          profile: "vscode_ide",
          verifiedOperations: ["editor.read"],
          status: "ready",
        },
      }),
    );
    await expect(probePromise).resolves.toMatchObject({ status: "ready" });

    const handshakePromise = Effect.runPromise(
      adapter.handshake({
        sessionId: "vscode-session-1",
        requestedProfile: "vscode_ide",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityGrantIds: ["grant-ide"],
        requestedOperations: ["editor.read"],
      }),
    );
    await flush();
    const handshakeRequest = decode(socket)[1];
    expect(handshakeRequest?.method).toBe("t3.ide.handshake");
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: handshakeRequest?.id,
        result: {
          sessionId: "vscode-session-1",
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          profile: "vscode_ide",
          status: "accepted",
          handshakeId: "ide-handshake-1",
          acceptedGrantIds: ["grant-ide"],
          verifiedOperations: ["editor.read"],
        },
      }),
    );
    await expect(handshakePromise).resolves.toMatchObject({
      status: "accepted",
      handshakeId: "ide-handshake-1",
    });

    const invokePromise = Effect.runPromise(
      adapter.invoke({
        sessionId: "vscode-session-1",
        handshakeId: "ide-handshake-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        operation: "editor.read",
        arguments: { uri: "file:///workspace/app.ts" },
      }),
    );
    await flush();
    const invokeRequest = decode(socket)[2];
    expect(invokeRequest).toMatchObject({
      jsonrpc: "2.0",
      method: "t3.ide.invoke",
      params: {
        sessionId: "vscode-session-1",
        handshakeId: "ide-handshake-1",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        operation: "editor.read",
      },
    });
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: invokeRequest?.id,
        result: { contents: "export const answer = 42;" },
      }),
    );
    await expect(invokePromise).resolves.toEqual({ contents: "export const answer = 42;" });
  });

  it("连接关闭后拒绝新的请求，并关闭时释放 socket", async () => {
    const socket = new FakeSocket();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "cursor-session-1",
      profile: "cursor_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      webSocketFactory: makeFactory(socket, {}),
    });

    const probePromise = Effect.runPromise(adapter.probe());
    void probePromise.catch(() => undefined);
    await flush();
    socket.emit("open");
    await flush();
    socket.emit("close");
    await expect(probePromise).rejects.toMatchObject({ code: "ide_socket_closed" });

    adapter.close();
    expect(socket.closeCount).toBe(1);
    await expect(Effect.runPromise(adapter.probe())).rejects.toMatchObject({
      code: "ide_transport_closed",
    });
  });

  it("远端断线后下一次请求重新建立连接并继续发送 JSON-RPC", async () => {
    const sockets: FakeSocket[] = [];
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-reconnect",
      profile: "vscode_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      webSocketFactory: (url, options) => {
        expect(url).toBe("ws://127.0.0.1:4111/t3/ide");
        expect(options.headers).toEqual({});
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const firstProbe = Effect.runPromise(adapter.probe());
    void firstProbe.catch(() => undefined);
    await flush();
    const firstSocket = sockets[0];
    expect(firstSocket).toBeDefined();
    firstSocket!.emit("open");
    await flush();
    firstSocket!.emit("close");
    await expect(firstProbe).rejects.toMatchObject({ code: "ide_socket_closed" });

    const secondProbe = Effect.runPromise(adapter.probe());
    void secondProbe.catch(() => undefined);
    await flush();
    const secondSocket = sockets[1];
    expect(secondSocket).toBeDefined();
    secondSocket!.emit("open");
    await flush();
    const request = decode(secondSocket!)[0];
    expect(request).toMatchObject({
      jsonrpc: "2.0",
      method: "t3.ide.probe",
      params: { sessionId: "vscode-session-reconnect", profile: "vscode_ide" },
    });
    secondSocket!.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id,
        result: {
          sessionId: "vscode-session-reconnect",
          profile: "vscode_ide",
          verifiedOperations: ["editor.read"],
          status: "ready",
        },
      }),
    );

    await expect(secondProbe).resolves.toMatchObject({ status: "ready" });
    expect(sockets).toHaveLength(2);
    adapter.close();
  });

  it("JSON-RPC 错误不泄露认证 Header，并转换为稳定失败码", async () => {
    const socket = new FakeSocket();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      headers: { Authorization: "Bearer secret-token" },
      webSocketFactory: makeFactory(socket, { Authorization: "Bearer secret-token" }),
    });

    const probePromise = Effect.runPromise(adapter.probe());
    void probePromise.catch(() => undefined);
    await flush();
    socket.emit("open");
    await flush();
    const request = decode(socket)[0];
    socket.emit(
      "message",
      JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id,
        error: { code: -32001, message: "Authorization: Bearer secret-token denied" },
      }),
    );
    await expect(probePromise).rejects.toMatchObject({ code: "ide_rpc_error" });
    await expect(probePromise.catch((error) => String(error))).resolves.not.toContain(
      "secret-token",
    );
  });

  it("请求超时返回稳定错误，并拒绝带凭据查询参数的 URL", async () => {
    expect(() =>
      makeCompositionIdeJsonRpcAdapter({
        sessionId: "vscode-session-1",
        profile: "vscode_ide",
        url: "ws://127.0.0.1:4111/t3/ide?token=secret-token",
      }),
    ).toThrow("凭据查询参数");

    const socket = new FakeSocket();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      requestTimeoutMs: 5,
      webSocketFactory: makeFactory(socket, {}),
    });
    const probePromise = Effect.runPromise(adapter.probe());
    void probePromise.catch(() => undefined);
    await flush();
    socket.emit("open");
    await flush();
    await expect(probePromise).rejects.toMatchObject({ code: "ide_rpc_timeout" });
    adapter.close();
  });

  it("open 前关闭 adapter 也会释放等待中的请求", async () => {
    const socket = new FakeSocket();
    const adapter = makeCompositionIdeJsonRpcAdapter({
      sessionId: "vscode-session-1",
      profile: "vscode_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      webSocketFactory: makeFactory(socket, {}),
    });
    const probePromise = Effect.runPromise(adapter.probe());
    void probePromise.catch(() => undefined);
    await flush();
    adapter.close();
    await expect(probePromise).rejects.toMatchObject({ code: "ide_transport_closed" });
    expect(socket.closeCount).toBe(1);
  });
});
