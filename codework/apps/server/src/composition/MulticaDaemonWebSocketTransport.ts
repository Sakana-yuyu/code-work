// @effect-diagnostics globalTimers:off - WebSocket 心跳、读超时和重连由原生连接生命周期管理。

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { Done } from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  decodeMulticaWebSocketFrame,
  encodeMulticaWebSocketFrame,
  MulticaDaemonCapability,
  MulticaDaemonProtocolFailure,
  type MulticaWebSocketFrame,
} from "./MulticaDaemonProtocol.ts";

export type MulticaDaemonWebSocket = {
  readonly on: {
    (event: "open", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
    (event: "error", listener: (error: unknown) => void): void;
    (event: "close", listener: () => void): void;
  };
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly terminate?: () => void;
  readonly ping?: () => void;
};

export type MulticaDaemonWebSocketFactory = (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => MulticaDaemonWebSocket;

export type MulticaDaemonWebSocketRpcRequest = {
  readonly method: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
};

export type MulticaDaemonWebSocketRpcResponse = {
  readonly requestId: string;
  readonly status: number;
  readonly body?: unknown;
  readonly error?: string;
};

export type MulticaDaemonWebSocketTransportOptions = {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly runtimeIds: ReadonlyArray<string>;
  readonly workspaceIds?: ReadonlyArray<string>;
  readonly reconnectDelaysMs?: ReadonlyArray<number>;
  readonly heartbeatIntervalMs?: number;
  readonly readTimeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly rpcTimeoutMs?: number;
  readonly webSocketFactory?: MulticaDaemonWebSocketFactory;
};

export type MulticaDaemonWebSocketTransport = {
  /** daemon 控制通道的入站事件；RPC response 会交给对应 request，不会重复进入此流。 */
  readonly stream: Stream.Stream<MulticaWebSocketFrame, MulticaDaemonProtocolFailure>;
  /** 仅在服务端 heartbeat ack 宣布 rpc-v1 后发送；失败时调用方应使用 HTTP fallback。 */
  readonly request: (
    input: MulticaDaemonWebSocketRpcRequest,
  ) => Effect.Effect<MulticaDaemonWebSocketRpcResponse, MulticaDaemonProtocolFailure>;
  readonly supportsRpc: () => boolean;
  readonly close: () => void;
};

const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

const normalizeBaseUrl = (baseUrl: string): URL => {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) throw new Error("Multica baseUrl 不能为空。");
  return new URL(trimmed.replace(/\/+$/, ""));
};

export const makeMulticaDaemonWebSocketUrl = (
  baseUrl: string,
  runtimeIds: ReadonlyArray<string> = [],
): string => {
  const url = normalizeBaseUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api") ? `${path}/daemon/ws` : `${path}/api/daemon/ws`;
  for (const key of [
    "token",
    "access_token",
    "api_key",
    "authorization",
    "runtime_id",
    "runtime_ids",
  ]) {
    url.searchParams.delete(key);
  }
  for (const runtimeId of [...new Set(runtimeIds.map((id) => id.trim()).filter(Boolean))]) {
    url.searchParams.append("runtime_id", runtimeId);
  }
  return url.toString();
};

const authorizationHeader = (headers: Readonly<Record<string, string>>): string | undefined => {
  const value = headers.Authorization ?? headers.authorization;
  return value?.trim().length === 0 ? undefined : value;
};

const defaultWebSocketFactory: MulticaDaemonWebSocketFactory = (url, options) =>
  new NodeSocket.NodeWS.WebSocket(url, {
    headers: options.headers,
  }) as unknown as MulticaDaemonWebSocket;

const frame = (type: string, payload: unknown): string =>
  encodeMulticaWebSocketFrame({ type, payload });

const textFromMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (Array.isArray(value)) return new TextDecoder().decode(new Uint8Array(value as number[]));
  return String(value);
};

const recordFrom = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const protocolFailure = (operation: string, code: string, detail: string, status?: number) =>
  new MulticaDaemonProtocolFailure({
    operation,
    code,
    ...(status === undefined ? {} : { status }),
    detail,
  });

const isRuntimeScopedFrame = (frameValue: MulticaWebSocketFrame): boolean =>
  frameValue.type === "daemon:task_available" || frameValue.type === "daemon:pending_work";

const isWorkspaceScopedFrame = (frameValue: MulticaWebSocketFrame): boolean =>
  frameValue.type === "daemon:runtime_profiles_changed";

export const makeMulticaDaemonWebSocketStream = (
  options: MulticaDaemonWebSocketTransportOptions,
): MulticaDaemonWebSocketTransport => {
  const runtimeIds = [...new Set(options.runtimeIds.map((id) => id.trim()).filter(Boolean))];
  const workspaceIds = new Set((options.workspaceIds ?? []).map((id) => id.trim()).filter(Boolean));
  const reconnectDelaysMs = [...(options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)];
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  const tokenHeader = authorizationHeader(options.headers);

  if (tokenHeader === undefined) {
    throw new Error("Multica daemon WebSocket 缺少 Authorization Header。");
  }
  if (runtimeIds.length === 0) throw new Error("至少需要一个 Multica runtimeId。");
  if (reconnectDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error("Multica daemon WebSocket 重连延迟必须是非负有限数。");
  }

  let queue:
    | Queue.Enqueue<MulticaWebSocketFrame, Done<void> | MulticaDaemonProtocolFailure>
    | undefined;
  let socket: MulticaDaemonWebSocket | undefined;
  let stopped = false;
  let started = false;
  let generation = 0;
  let reconnectIndex = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let serverCapabilities = new Set<string>();
  let nextRequestId = 1;
  let openPromise: Promise<void> | undefined;
  let resolveOpen: (() => void) | undefined;
  let rejectOpen: ((cause: unknown) => void) | undefined;
  let openSettled = false;
  let capabilitiesPromise: Promise<void> | undefined;
  let resolveCapabilities: (() => void) | undefined;
  let rejectCapabilities: ((cause: unknown) => void) | undefined;
  let capabilitiesSettled = false;

  const pending = new Map<
    string,
    {
      readonly resolve: (response: MulticaDaemonWebSocketRpcResponse) => void;
      readonly reject: (cause: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): void => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const clearConnectionTimers = (): void => {
    clearTimer(openTimer);
    openTimer = undefined;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    clearTimer(readTimer);
    readTimer = undefined;
  };

  const rejectOpenPromise = (cause: unknown): void => {
    if (openSettled) return;
    openSettled = true;
    rejectOpen?.(cause);
    resolveOpen = undefined;
    rejectOpen = undefined;
  };

  const resolveOpenPromise = (): void => {
    if (openSettled) return;
    openSettled = true;
    resolveOpen?.();
    resolveOpen = undefined;
    rejectOpen = undefined;
  };

  const rejectCapabilitiesPromise = (cause: unknown): void => {
    if (capabilitiesSettled) return;
    capabilitiesSettled = true;
    rejectCapabilities?.(cause);
    resolveCapabilities = undefined;
    rejectCapabilities = undefined;
  };

  const resolveCapabilitiesPromise = (): void => {
    if (capabilitiesSettled) return;
    capabilitiesSettled = true;
    resolveCapabilities?.();
    resolveCapabilities = undefined;
    rejectCapabilities = undefined;
  };

  const makeOpenPromise = (): Promise<void> => {
    openSettled = false;
    openPromise = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    return openPromise;
  };

  const makeCapabilitiesPromise = (): Promise<void> => {
    capabilitiesSettled = false;
    capabilitiesPromise = new Promise<void>((resolve, reject) => {
      resolveCapabilities = resolve;
      rejectCapabilities = reject;
    });
    return capabilitiesPromise;
  };

  const failPending = (cause: MulticaDaemonProtocolFailure): void => {
    for (const [requestId, request] of pending) {
      clearTimeout(request.timer);
      request.reject(cause);
      pending.delete(requestId);
    }
  };

  const isCurrent = (connection: MulticaDaemonWebSocket, connectionGeneration: number): boolean =>
    !stopped && socket === connection && generation === connectionGeneration;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimer(reconnectTimer);
    reconnectTimer = undefined;
    clearConnectionTimers();
    const closed = protocolFailure(
      "daemonWebSocket",
      "closed",
      "Multica daemon WebSocket 已关闭。",
    );
    rejectOpenPromise(closed);
    rejectCapabilitiesPromise(closed);
    failPending(closed);
    const current = socket;
    socket = undefined;
    current?.terminate?.();
    current?.close();
  };

  const failStream = (failure: MulticaDaemonProtocolFailure): void => {
    if (stopped) return;
    stop();
    if (queue !== undefined) Effect.runFork(Queue.fail(queue, failure));
  };

  const offerFrame = (frameValue: MulticaWebSocketFrame): void => {
    const payload = recordFrom(frameValue.payload);
    if (isRuntimeScopedFrame(frameValue)) {
      const runtimeId = stringFrom(payload?.runtime_id ?? payload?.runtimeId);
      if (runtimeId === undefined || !runtimeIds.includes(runtimeId)) return;
    }
    if (isWorkspaceScopedFrame(frameValue) && workspaceIds.size > 0) {
      const workspaceId = stringFrom(payload?.workspace_id ?? payload?.workspaceId);
      if (workspaceId === undefined || !workspaceIds.has(workspaceId)) return;
    }
    if (queue !== undefined) Queue.offerUnsafe(queue, frameValue);
  };

  const sendHeartbeats = (
    connection: MulticaDaemonWebSocket,
    connectionGeneration: number,
  ): void => {
    if (!isCurrent(connection, connectionGeneration)) return;
    for (const runtimeId of runtimeIds) {
      try {
        connection.send(
          frame("daemon:heartbeat", { runtime_id: runtimeId, supports_batch_import: true }),
        );
      } catch {
        connection.close();
        return;
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== undefined) return;
    if (reconnectIndex >= reconnectDelaysMs.length) {
      failStream(
        protocolFailure(
          "daemonWebSocket",
          "reconnect_exhausted",
          "Multica daemon WebSocket 重连次数已耗尽。",
        ),
      );
      return;
    }
    const delay = reconnectDelaysMs[reconnectIndex++];
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  const closeConnection = (
    connection: MulticaDaemonWebSocket,
    connectionGeneration: number,
    code: string,
  ): void => {
    if (!isCurrent(connection, connectionGeneration)) return;
    clearConnectionTimers();
    const failure = protocolFailure(
      "daemonWebSocket",
      code,
      "Multica daemon WebSocket 连接已中断。",
    );
    rejectOpenPromise(failure);
    rejectCapabilitiesPromise(failure);
    failPending(failure);
    connection.terminate?.();
    connection.close();
    scheduleReconnect();
  };

  const resetReadTimer = (
    connection: MulticaDaemonWebSocket,
    connectionGeneration: number,
  ): void => {
    clearTimer(readTimer);
    readTimer = setTimeout(() => {
      if (!isCurrent(connection, connectionGeneration)) return;
      closeConnection(connection, connectionGeneration, "read_timeout");
    }, readTimeoutMs);
  };

  const handleMessage = (
    connection: MulticaDaemonWebSocket,
    connectionGeneration: number,
    data: unknown,
  ): void => {
    if (!isCurrent(connection, connectionGeneration)) return;
    resetReadTimer(connection, connectionGeneration);
    let received: MulticaWebSocketFrame;
    try {
      received = decodeMulticaWebSocketFrame(textFromMessage(data));
    } catch (cause) {
      failStream(
        protocolFailure(
          "daemonWebSocket",
          "invalid_frame",
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
      return;
    }

    if (received.type === "daemon:heartbeat_ack") {
      const payload = recordFrom(received.payload);
      const capabilities = payload?.server_capabilities ?? payload?.serverCapabilities;
      if (Array.isArray(capabilities)) {
        serverCapabilities = new Set(
          capabilities.filter((value): value is string => typeof value === "string"),
        );
      }
      resolveCapabilitiesPromise();
      offerFrame(received);
      return;
    }

    if (received.type === "daemon:rpc_response") {
      const payload = recordFrom(received.payload);
      const requestId = stringFrom(payload?.request_id ?? payload?.requestId);
      const status = payload?.status;
      if (requestId === undefined || typeof status !== "number" || !Number.isInteger(status)) {
        failStream(
          protocolFailure(
            "daemonWebSocket",
            "invalid_rpc_response",
            "daemon RPC response 格式无效。",
          ),
        );
        return;
      }
      const request = pending.get(requestId);
      if (request === undefined) return;
      pending.delete(requestId);
      clearTimeout(request.timer);
      if (status < 200 || status >= 300) {
        request.reject(
          protocolFailure(
            "daemonRpc",
            "rpc_error",
            typeof payload?.error === "string" && payload.error.length > 0
              ? payload.error
              : "Multica daemon RPC 被服务器拒绝。",
            status,
          ),
        );
        return;
      }
      request.resolve({
        requestId,
        status,
        ...(payload?.body === undefined ? {} : { body: payload.body }),
        ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
      });
      return;
    }

    offerFrame(received);
  };

  const connect = (): void => {
    if (stopped) return;
    const previous = socket;
    clearConnectionTimers();
    serverCapabilities = new Set();
    const connection = webSocketFactory(
      makeMulticaDaemonWebSocketUrl(options.baseUrl, runtimeIds),
      {
        headers: options.headers,
      },
    );
    socket = connection;
    const connectionGeneration = ++generation;
    const currentOpen = makeOpenPromise();
    const currentCapabilities = makeCapabilitiesPromise();
    if (previous !== undefined && previous !== connection) {
      previous.terminate?.();
      previous.close();
    }

    openTimer = setTimeout(() => {
      if (!isCurrent(connection, connectionGeneration) || openSettled) return;
      closeConnection(connection, connectionGeneration, "open_timeout");
    }, openTimeoutMs);

    connection.on("open", () => {
      if (!isCurrent(connection, connectionGeneration)) return;
      clearTimer(openTimer);
      openTimer = undefined;
      reconnectIndex = 0;
      resolveOpenPromise();
      sendHeartbeats(connection, connectionGeneration);
      heartbeatTimer = setInterval(
        () => sendHeartbeats(connection, connectionGeneration),
        heartbeatIntervalMs,
      );
      resetReadTimer(connection, connectionGeneration);
    });
    connection.on("message", (data) => handleMessage(connection, connectionGeneration, data));
    connection.on("error", () => closeConnection(connection, connectionGeneration, "socket_error"));
    connection.on("close", () =>
      closeConnection(connection, connectionGeneration, "socket_closed"),
    );

    void currentOpen.catch(() => undefined);
    void currentCapabilities.catch(() => undefined);
  };

  const ensureStarted = (): void => {
    if (started || stopped) return;
    started = true;
    connect();
  };

  const supportsRpc = (): boolean => serverCapabilities.has(MulticaDaemonCapability.rpcV1);

  const request = (
    input: MulticaDaemonWebSocketRpcRequest,
  ): Effect.Effect<MulticaDaemonWebSocketRpcResponse, MulticaDaemonProtocolFailure> =>
    Effect.tryPromise({
      try: async () => {
        ensureStarted();
        if (stopped) {
          throw protocolFailure("daemonRpc", "closed", "Multica daemon WebSocket 已关闭。");
        }
        const open = openPromise;
        if (open !== undefined) await open;
        const capabilities = capabilitiesPromise;
        if (capabilities !== undefined) await capabilities;
        if (stopped) {
          throw protocolFailure("daemonRpc", "closed", "Multica daemon WebSocket 已关闭。");
        }
        if (!supportsRpc()) {
          throw protocolFailure(
            "daemonRpc",
            "rpc_unavailable",
            "Multica daemon 尚未通过 heartbeat ack 宣布 rpc-v1，调用方应回退 HTTP。",
          );
        }
        const current = socket;
        if (current === undefined || stopped) {
          throw protocolFailure(
            "daemonRpc",
            "unavailable",
            "Multica daemon WebSocket 当前不可用。",
          );
        }
        const requestId = `codework-rpc-${nextRequestId++}`;
        const timeoutMs = input.timeoutMs ?? rpcTimeoutMs;
        return await new Promise<MulticaDaemonWebSocketRpcResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(protocolFailure("daemonRpc", "timeout", "Multica daemon RPC 响应超时。"));
          }, timeoutMs);
          pending.set(requestId, { resolve, reject, timer });
          try {
            current.send(
              frame("daemon:rpc_request", {
                request_id: requestId,
                method: input.method,
                ...(input.body === undefined ? {} : { body: input.body }),
                ...(timeoutMs <= 0 ? {} : { timeout_ms: timeoutMs }),
              }),
            );
          } catch (cause) {
            clearTimeout(timer);
            pending.delete(requestId);
            reject(
              protocolFailure(
                "daemonRpc",
                "send_failed",
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          }
        });
      },
      catch: (cause) =>
        Schema.is(MulticaDaemonProtocolFailure)(cause)
          ? cause
          : protocolFailure(
              "daemonRpc",
              "transport_error",
              cause instanceof Error ? cause.message : String(cause),
            ),
    });

  const stream = Stream.callback<MulticaWebSocketFrame, MulticaDaemonProtocolFailure>((nextQueue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (queue !== undefined && queue !== nextQueue) {
          throw protocolFailure(
            "daemonWebSocket",
            "stream_already_consumed",
            "daemon WebSocket stream 只能被消费一次。",
          );
        }
        queue = nextQueue;
        ensureStarted();
        return { stop };
      }),
      ({ stop: release }) => Effect.sync(release),
    ),
  );

  return { stream, request, supportsRpc, close: stop };
};
