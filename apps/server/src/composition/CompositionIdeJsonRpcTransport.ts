// @effect-diagnostics globalTimers:off - IDE transport 的连接与请求超时由原生 socket 生命周期管理。

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  CompositionIdeAdapterFailure,
  type CompositionIdeAdapter,
  type CompositionIdeCapabilityHandshakeRequest,
  type CompositionIdeCapabilityHandshakeResult,
  type CompositionIdeInvocation,
} from "./CompositionIdeSessionRegistry.ts";
import {
  ProviderRuntimeEvent,
  type CompositionIdeProfile,
  type CompositionIdeResolveResult,
} from "@codework/contracts";

export type CompositionIdeJsonRpcSocket = {
  readonly on: {
    (event: "open", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
    (event: "error", listener: (error: unknown) => void): void;
    (event: "close", listener: () => void): void;
  };
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly terminate?: () => void;
};

export type CompositionIdeJsonRpcSocketFactory = (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => CompositionIdeJsonRpcSocket;

export type CompositionIdeJsonRpcTransportOptions = {
  readonly sessionId: string;
  readonly profile: Exclude<CompositionIdeProfile, "unknown">;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly openTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly reconnectDelaysMs?: ReadonlyArray<number>;
  readonly webSocketFactory?: CompositionIdeJsonRpcSocketFactory;
};

export type CompositionIdeJsonRpcAdapter = CompositionIdeAdapter & {
  readonly close: () => void;
};

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
};

type JsonRpcNotification = {
  readonly jsonrpc: "2.0";
  readonly method: "t3.ide.event";
  readonly params: unknown;
};

type PendingRequest = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: CompositionIdeAdapterFailure) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;

const sensitivePatterns = [
  /(api[_-]?key\s*[:=]\s*)([^\s\n]+)/gi,
  /(authorization\s*:\s*bearer\s+)([^\s\n]+)/gi,
  /(token\s*[:=]\s*)([^\s\n]+)/gi,
];

const redact = (value: string): string =>
  sensitivePatterns.reduce((current, pattern) => current.replace(pattern, "$1[REDACTED]"), value);

const recordFrom = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const stringFrom = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const stringArrayFrom = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)
    ? value.map((item) => (item as string).trim())
    : undefined;

const textFromMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (Array.isArray(value)) return new TextDecoder().decode(new Uint8Array(value as number[]));
  return String(value);
};

const defaultWebSocketFactory: CompositionIdeJsonRpcSocketFactory = (url, options) =>
  new NodeSocket.NodeWS.WebSocket(url, {
    headers: options.headers,
  }) as unknown as CompositionIdeJsonRpcSocket;

const validateUrl = (value: string): string => {
  const url = new URL(value.trim());
  for (const key of ["token", "access_token", "api_key", "authorization"]) {
    if (url.searchParams.has(key)) {
      throw new Error("IDE WebSocket URL 不得包含凭据查询参数。");
    }
  }
  return url.toString();
};

const failure = (sessionId: string, code: string, detail: string): CompositionIdeAdapterFailure =>
  new CompositionIdeAdapterFailure({ sessionId, code, detail: redact(detail) });

const invalidResponse = (sessionId: string, detail: string): CompositionIdeAdapterFailure =>
  failure(sessionId, "ide_invalid_response", detail);

const parseMessage = (sessionId: string, data: unknown): JsonRpcResponse | JsonRpcNotification => {
  let value: unknown;
  try {
    value = JSON.parse(textFromMessage(data));
  } catch {
    throw invalidResponse(sessionId, "IDE JSON-RPC response 不是有效 JSON。");
  }
  const record = recordFrom(value);
  if (record?.jsonrpc !== "2.0") {
    throw invalidResponse(sessionId, "IDE JSON-RPC message 格式无效。");
  }
  if (record.method === "t3.ide.event" && record.id === undefined) {
    return record as unknown as JsonRpcNotification;
  }
  if (
    (typeof record.id !== "string" && typeof record.id !== "number") ||
    (record.result === undefined && record.error === undefined)
  ) {
    throw invalidResponse(sessionId, "IDE JSON-RPC response 格式无效。");
  }
  return record as unknown as JsonRpcResponse;
};

const parseTaskEvent = (sessionId: string, value: unknown): ProviderRuntimeEvent => {
  const params = recordFrom(value);
  if (stringFrom(params?.sessionId) !== sessionId) {
    throw invalidResponse(sessionId, "IDE task event 的 sessionId 不匹配。");
  }
  let event: ProviderRuntimeEvent;
  try {
    event = Schema.decodeUnknownSync(ProviderRuntimeEvent)(params?.event);
  } catch {
    throw invalidResponse(sessionId, "IDE task event 不符合 ProviderRuntimeEvent 合同。");
  }
  if (
    event.raw?.source !== "ide.jsonrpc" ||
    event.raw.method !== "t3.ide.event" ||
    event.raw.runtimeId !== `ide:${sessionId}` ||
    event.raw.runtimeTaskId === undefined
  ) {
    throw invalidResponse(sessionId, "IDE task event 缺少受信任的 runtime correlation。");
  }
  return {
    ...event,
    raw: {
      source: "ide.jsonrpc" as const,
      method: "t3.ide.event",
      runtimeId: event.raw.runtimeId,
      runtimeTaskId: event.raw.runtimeTaskId,
      payload: { sessionId },
    },
  };
};

const parseProbeResult = (sessionId: string, value: unknown): CompositionIdeResolveResult => {
  const record = recordFrom(value);
  const responseSessionId = stringFrom(record?.sessionId);
  const profile = stringFrom(record?.profile);
  const verifiedOperations = stringArrayFrom(record?.verifiedOperations);
  const status = stringFrom(record?.status);
  if (
    responseSessionId === undefined ||
    profile === undefined ||
    verifiedOperations === undefined ||
    (status !== "ready" && status !== "incomplete" && status !== "unavailable")
  ) {
    throw invalidResponse(sessionId, "IDE probe result 格式无效。");
  }
  return {
    sessionId: responseSessionId,
    profile: profile as CompositionIdeProfile,
    verifiedOperations,
    status,
    ...(stringFrom(record?.reasonCode) === undefined
      ? {}
      : { reasonCode: stringFrom(record?.reasonCode) }),
  };
};

const parseHandshakeResult = (
  sessionId: string,
  value: unknown,
): CompositionIdeCapabilityHandshakeResult => {
  const record = recordFrom(value);
  const responseSessionId = stringFrom(record?.sessionId);
  const taskId = stringFrom(record?.taskId);
  const runId = stringFrom(record?.runId);
  const agentId = stringFrom(record?.agentId);
  const profile = stringFrom(record?.profile);
  const status = stringFrom(record?.status);
  const acceptedGrantIds = stringArrayFrom(record?.acceptedGrantIds);
  const verifiedOperations = stringArrayFrom(record?.verifiedOperations);
  const handshakeId = stringFrom(record?.handshakeId);
  if (
    responseSessionId === undefined ||
    taskId === undefined ||
    runId === undefined ||
    agentId === undefined ||
    profile === undefined ||
    (status !== "accepted" && status !== "rejected" && status !== "unsupported") ||
    acceptedGrantIds === undefined ||
    verifiedOperations === undefined ||
    (status === "accepted" && handshakeId === undefined)
  ) {
    throw invalidResponse(sessionId, "IDE capability handshake result 格式无效。");
  }
  const expiresAtUnixMs = record?.expiresAtUnixMs;
  const reasonCode = stringFrom(record?.reasonCode);
  if (
    expiresAtUnixMs !== undefined &&
    (typeof expiresAtUnixMs !== "number" ||
      !Number.isSafeInteger(expiresAtUnixMs) ||
      expiresAtUnixMs <= 0)
  ) {
    throw invalidResponse(sessionId, "IDE capability handshake 的过期时间无效。");
  }
  return {
    sessionId: responseSessionId,
    taskId,
    runId,
    agentId,
    profile: profile as CompositionIdeProfile,
    status,
    ...(handshakeId === undefined ? {} : { handshakeId }),
    acceptedGrantIds,
    verifiedOperations,
    ...(typeof expiresAtUnixMs === "number" ? { expiresAtUnixMs } : {}),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
};

export const makeCompositionIdeJsonRpcAdapter = (
  options: CompositionIdeJsonRpcTransportOptions,
): CompositionIdeJsonRpcAdapter => {
  const sessionId = options.sessionId.trim();
  if (sessionId.length === 0 || sessionId !== options.sessionId) {
    throw new Error("IDE sessionId 必须为非空且已去除首尾空白的字符串。");
  }
  const url = validateUrl(options.url);
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectDelaysMs = [...(options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)];
  if (!Number.isFinite(openTimeoutMs) || openTimeoutMs <= 0) {
    throw new Error("IDE WebSocket openTimeoutMs 必须是正数。");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("IDE JSON-RPC requestTimeoutMs 必须是正数。");
  }
  if (reconnectDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error("IDE WebSocket 重连延迟必须是非负有限数。");
  }

  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
  const headers = options.headers ?? {};
  const pending = new Map<string, PendingRequest>();
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  let socket: CompositionIdeJsonRpcSocket | undefined;
  let opening: Promise<void> | undefined;
  let rejectOpening: ((cause: CompositionIdeAdapterFailure) => void) | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let nextRequestId = 1;
  let terminalFailure: CompositionIdeAdapterFailure | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectIndex = 0;

  const clearOpenTimer = (): void => {
    if (openTimer !== undefined) clearTimeout(openTimer);
    openTimer = undefined;
  };

  const rejectPending = (cause: CompositionIdeAdapterFailure): void => {
    for (const [requestId, request] of pending) {
      clearTimeout(request.timer);
      request.reject(cause);
      pending.delete(requestId);
    }
  };

  const settleOpening = (): void => {
    opening = undefined;
    rejectOpening = undefined;
    clearOpenTimer();
  };

  const disconnect = (cause: CompositionIdeAdapterFailure): void => {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const current = socket;
    socket = undefined;
    rejectOpening?.(cause);
    settleOpening();
    rejectPending(cause);
    current?.terminate?.();
    current?.close();
    if (terminalFailure === undefined && reconnectDelaysMs.length > 0) {
      if (reconnectIndex < reconnectDelaysMs.length) {
        const delay = reconnectDelaysMs[reconnectIndex++];
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          void ensureOpen().catch(() => undefined);
        }, delay);
      }
    }
  };

  const closePermanently = (cause: CompositionIdeAdapterFailure): void => {
    if (terminalFailure !== undefined) return;
    terminalFailure = cause;
    disconnect(cause);
    Effect.runFork(PubSub.shutdown(events));
  };

  const ensureOpen = (): Promise<void> => {
    if (terminalFailure !== undefined) return Promise.reject(terminalFailure);
    if (socket !== undefined && opening === undefined) return Promise.resolve();
    if (opening !== undefined) return opening;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;

    let resolveOpen!: () => void;
    let rejectOpen!: (cause: CompositionIdeAdapterFailure) => void;
    const openingPromise = new Promise<void>((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    opening = openingPromise;
    rejectOpening = rejectOpen;

    let current: CompositionIdeJsonRpcSocket;
    try {
      current = webSocketFactory(url, { headers });
    } catch (cause) {
      const transportFailure = failure(
        sessionId,
        "ide_socket_create_failed",
        cause instanceof Error ? cause.message : String(cause),
      );
      disconnect(transportFailure);
      return openingPromise;
    }
    socket = current;

    openTimer = setTimeout(() => {
      if (socket !== current || opening === undefined) return;
      const transportFailure = failure(
        sessionId,
        "ide_socket_open_timeout",
        "IDE WebSocket 建立连接超时。",
      );
      disconnect(transportFailure);
    }, openTimeoutMs);

    current.on("open", () => {
      if (socket !== current || terminalFailure !== undefined) return;
      resolveOpen();
      settleOpening();
      reconnectIndex = 0;
    });
    current.on("message", (data) => {
      if (socket !== current || terminalFailure !== undefined) return;
      let message: JsonRpcResponse | JsonRpcNotification;
      try {
        message = parseMessage(sessionId, data);
      } catch (cause) {
        const transportFailure = Schema.is(CompositionIdeAdapterFailure)(cause)
          ? cause
          : invalidResponse(sessionId, String(cause));
        closePermanently(transportFailure);
        return;
      }
      if ("method" in message) {
        let event: ProviderRuntimeEvent;
        try {
          event = parseTaskEvent(sessionId, message.params);
        } catch (cause) {
          const transportFailure = Schema.is(CompositionIdeAdapterFailure)(cause)
            ? cause
            : invalidResponse(sessionId, String(cause));
          closePermanently(transportFailure);
          return;
        }
        Effect.runFork(PubSub.publish(events, event).pipe(Effect.asVoid));
        return;
      }
      const response = message;
      const requestId = String(response.id);
      const request = pending.get(requestId);
      if (request === undefined) return;
      pending.delete(requestId);
      clearTimeout(request.timer);
      if (response.error !== undefined) {
        const message =
          typeof response.error.message === "string"
            ? response.error.message
            : "IDE JSON-RPC request 被拒绝。";
        request.reject(failure(sessionId, "ide_rpc_error", message));
        return;
      }
      request.resolve(response.result);
    });
    current.on("error", (cause) => {
      if (socket !== current || terminalFailure !== undefined) return;
      disconnect(
        failure(
          sessionId,
          "ide_socket_error",
          cause instanceof Error ? cause.message : "IDE WebSocket 发生错误。",
        ),
      );
    });
    current.on("close", () => {
      if (socket !== current || terminalFailure !== undefined) return;
      const transportFailure = failure(sessionId, "ide_socket_closed", "IDE WebSocket 已关闭。");
      disconnect(transportFailure);
    });
    return openingPromise;
  };

  const request = (
    method: string,
    params: unknown,
  ): Effect.Effect<unknown, CompositionIdeAdapterFailure> =>
    Effect.tryPromise({
      try: async () => {
        await ensureOpen();
        if (socket === undefined || terminalFailure !== undefined) {
          throw (
            terminalFailure ?? failure(sessionId, "ide_transport_closed", "IDE transport 不可用。")
          );
        }
        const id = `ide-rpc-${nextRequestId++}`;
        const currentSocket = socket;
        return await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(failure(sessionId, "ide_rpc_timeout", `IDE JSON-RPC request 超时：${method}。`));
          }, requestTimeoutMs);
          pending.set(id, {
            resolve,
            reject,
            timer,
          });
          try {
            currentSocket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          } catch (cause) {
            clearTimeout(timer);
            pending.delete(id);
            reject(
              failure(
                sessionId,
                "ide_socket_send_failed",
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          }
        });
      },
      catch: (cause) =>
        Schema.is(CompositionIdeAdapterFailure)(cause)
          ? cause
          : failure(sessionId, "ide_transport_failed", String(cause)),
    });

  const probe: CompositionIdeAdapter["probe"] = () =>
    request("t3.ide.probe", { sessionId, profile: options.profile }).pipe(
      Effect.map((value) => parseProbeResult(sessionId, value)),
      Effect.mapError((cause) =>
        Schema.is(CompositionIdeAdapterFailure)(cause)
          ? cause
          : invalidResponse(sessionId, String(cause)),
      ),
    );

  const handshake: CompositionIdeAdapter["handshake"] = (input) =>
    request("t3.ide.handshake", input).pipe(
      Effect.map((value) => parseHandshakeResult(sessionId, value)),
      Effect.mapError((cause) =>
        Schema.is(CompositionIdeAdapterFailure)(cause)
          ? cause
          : invalidResponse(sessionId, String(cause)),
      ),
    );

  const invoke: CompositionIdeAdapter["invoke"] = (input: CompositionIdeInvocation) =>
    request("t3.ide.invoke", input);

  const close = (): void => {
    if (terminalFailure !== undefined) return;
    closePermanently(failure(sessionId, "ide_transport_closed", "IDE transport 已关闭。"));
  };

  return {
    sessionId,
    profile: options.profile,
    probe,
    handshake,
    invoke,
    streamEvents: () => Stream.fromPubSub(events),
    close,
  };
};
