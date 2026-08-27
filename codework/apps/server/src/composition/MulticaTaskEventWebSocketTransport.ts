// @effect-diagnostics globalTimers:off - WebSocket 生命周期由原生连接定时器管理。

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  decodeMulticaWebSocketFrame,
  encodeMulticaWebSocketFrame,
  MulticaDaemonProtocolFailure,
  type MulticaWebSocketFrame,
} from "./MulticaDaemonProtocol.ts";

export type MulticaTaskEventWebSocket = {
  readonly on: {
    (event: "open", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
    (event: "error", listener: (error: unknown) => void): void;
    (event: "close", listener: () => void): void;
  };
  readonly off?: {
    (event: "open", listener: () => void): void;
    (event: "message", listener: (data: unknown) => void): void;
    (event: "error", listener: (error: unknown) => void): void;
    (event: "close", listener: () => void): void;
  };
  readonly send: (data: string) => void;
  readonly close: () => void;
  readonly terminate?: () => void;
};

export type MulticaTaskEventWebSocketFactory = (
  url: string,
  options: { readonly headers: Readonly<Record<string, string>> },
) => MulticaTaskEventWebSocket;

export type MulticaTaskEventWebSocketTransportOptions = {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly taskId?: string;
  readonly reconnectDelaysMs?: ReadonlyArray<number>;
  readonly openTimeoutMs?: number;
  readonly webSocketFactory?: MulticaTaskEventWebSocketFactory;
};

const DEFAULT_RECONNECT_DELAYS_MS = [250, 1_000, 3_000] as const;
const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

const normalizeBaseUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) throw new Error("Multica baseUrl 不能为空。");
  return trimmed.replace(/\/+$/, "");
};

export const makeMulticaTaskEventWebSocketUrl = (baseUrl: string, workspaceId: string): string => {
  const trimmedWorkspaceId = workspaceId.trim();
  if (trimmedWorkspaceId.length === 0) throw new Error("workspaceId 不能为空。");
  const url = new URL(normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const path = url.pathname.replace(/\/+$/, "");
  // Multica 的 HTTP API 位于 /api，而普通 realtime WebSocket 位于同一部署前缀下的 /ws。
  // 配置通常复用 API baseUrl，因此只去掉末尾的 /api，不影响反向代理前缀。
  const deploymentPath = path.endsWith("/api") ? path.slice(0, -"/api".length) : path;
  url.pathname = deploymentPath.endsWith("/ws")
    ? deploymentPath || "/ws"
    : `${deploymentPath}/ws` || "/ws";
  for (const key of ["token", "access_token", "api_key", "authorization"]) {
    url.searchParams.delete(key);
  }
  url.searchParams.set("workspace_id", trimmedWorkspaceId);
  return url.toString();
};

const authorizationHeader = (headers: Readonly<Record<string, string>>): string | undefined => {
  const value = headers.Authorization ?? headers.authorization;
  return value?.trim().length === 0 ? undefined : value;
};

const authorizationToken = (headers: Readonly<Record<string, string>>): string | undefined => {
  const value = authorizationHeader(headers);
  if (value === undefined) return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
};

const defaultWebSocketFactory: MulticaTaskEventWebSocketFactory = (url, options) =>
  new NodeSocket.NodeWS.WebSocket(url, {
    headers: options.headers,
  }) as unknown as MulticaTaskEventWebSocket;

const frame = (type: string, payload: unknown): string =>
  encodeMulticaWebSocketFrame({ type, payload });

const textFromMessage = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (Array.isArray(value)) return new TextDecoder().decode(new Uint8Array(value as number[]));
  return String(value);
};

const protocolFailure = (operation: string, code: string, detail: string) =>
  new MulticaDaemonProtocolFailure({ operation, code, detail });

const frameWorkspaceId = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const value = record.workspace_id ?? record.workspaceId;
  return typeof value === "string" ? value : undefined;
};

const frameTaskId = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const value = record.task_id ?? record.taskId ?? record.id;
  return typeof value === "string" ? value : undefined;
};

const scopeFromPayload = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).scope;
  return typeof value === "string" ? value : undefined;
};

const idFromPayload = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>).id;
  return typeof value === "string" ? value : undefined;
};

const isTaskEvent = (type: string): boolean =>
  type === "task:progress" ||
  type === "task:completed" ||
  type === "task:failed" ||
  type === "task:cancelled" ||
  type === "task:message";

const isIgnoredFrame = (type: string): boolean =>
  type === "auth_ack" || type === "subscribe_ack" || type === "unsubscribe_ack" || type === "pong";

const isErrorFrame = (type: string): boolean =>
  type === "auth_error" || type === "subscribe_error" || type === "unsubscribe_error";

type WorkspaceConnection = {
  readonly workspaceId: string;
  readonly socket: MulticaTaskEventWebSocket;
  openTimer: ReturnType<typeof setTimeout> | undefined;
  opened: boolean;
  closed: boolean;
  authenticated: boolean;
  workspaceSubscribed: boolean;
  taskSubscribed: boolean;
  reconnectIndex: number;
  reconnectScheduled: boolean;
};

/**
 * 创建 Multica 普通实时任务事件通道。
 *
 * /api/daemon/ws 是控制通道，本 transport 只连接 /ws；认证仍通过官方首帧，
 * workspace scope 使用独立连接，避免多个 workspace 的事件互相串流。
 */
export const makeMulticaTaskEventWebSocketStream = (
  options: MulticaTaskEventWebSocketTransportOptions,
): Stream.Stream<MulticaWebSocketFrame, MulticaDaemonProtocolFailure> => {
  const workspaceIds = [...new Set(options.workspaceIds.map((id) => id.trim()).filter(Boolean))];
  const reconnectDelaysMs = [...(options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)];
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const token = authorizationToken(options.headers);
  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;

  if (token === undefined) {
    return Stream.fail(
      protocolFailure(
        "taskEventStream",
        "authorization_missing",
        "Multica 任务事件 WebSocket 缺少 Authorization。",
      ),
    );
  }
  if (workspaceIds.length === 0) {
    return Stream.fail(
      protocolFailure("taskEventStream", "workspace_missing", "至少需要一个 Multica workspaceId。"),
    );
  }

  return Stream.callback<MulticaWebSocketFrame, MulticaDaemonProtocolFailure>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let stopped = false;
        const connections = new Map<string, WorkspaceConnection>();
        const timers = new Set<ReturnType<typeof setTimeout>>();

        const stop = () => {
          if (stopped) return;
          stopped = true;
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
          for (const connection of connections.values()) {
            connection.closed = true;
            connection.socket.terminate?.();
            connection.socket.close();
          }
          connections.clear();
        };

        const fail = (failure: MulticaDaemonProtocolFailure) => {
          if (stopped) return;
          stop();
          Effect.runFork(Queue.fail(queue, failure));
        };

        const clearOpenTimer = (connection: WorkspaceConnection) => {
          if (connection.openTimer === undefined) return;
          clearTimeout(connection.openTimer);
          timers.delete(connection.openTimer);
          connection.openTimer = undefined;
        };

        const isCurrent = (connection: WorkspaceConnection): boolean =>
          !stopped && connections.get(connection.workspaceId) === connection;

        const scheduleReconnect = (workspaceId: string) => {
          if (stopped) return;
          const current = connections.get(workspaceId);
          if (current === undefined || current.reconnectScheduled) return;
          if (current.reconnectIndex >= reconnectDelaysMs.length) {
            fail(
              protocolFailure(
                "taskEventStream",
                "reconnect_exhausted",
                "Multica 任务事件 WebSocket 重连次数已耗尽。",
              ),
            );
            return;
          }
          current.reconnectScheduled = true;
          const delay = reconnectDelaysMs[current.reconnectIndex++];
          const timer = setTimeout(() => {
            timers.delete(timer);
            const latest = connections.get(workspaceId);
            if (latest === undefined || stopped) return;
            latest.reconnectScheduled = false;
            connect(workspaceId);
          }, delay);
          timers.add(timer);
        };

        const connect = (workspaceId: string) => {
          if (stopped) return;
          const previous = connections.get(workspaceId);
          if (previous !== undefined && !previous.closed && previous.opened) return;
          const socket = webSocketFactory(
            makeMulticaTaskEventWebSocketUrl(options.baseUrl, workspaceId),
            {
              headers: options.headers,
            },
          );
          const connection: WorkspaceConnection = {
            workspaceId,
            socket,
            openTimer: undefined,
            opened: false,
            closed: false,
            authenticated: false,
            workspaceSubscribed: false,
            taskSubscribed: options.taskId === undefined,
            reconnectIndex: previous?.reconnectIndex ?? 0,
            reconnectScheduled: false,
          } satisfies WorkspaceConnection;
          connections.set(workspaceId, connection);
          if (previous !== undefined && previous.socket !== socket) {
            previous.closed = true;
            clearOpenTimer(previous);
            previous.socket.terminate?.();
            previous.socket.close();
          }
          const openTimer = setTimeout(() => {
            if (!isCurrent(connection) || connection.opened || connection.closed) return;
            connection.closed = true;
            clearOpenTimer(connection);
            socket.terminate?.();
            socket.close();
            scheduleReconnect(workspaceId);
          }, openTimeoutMs);
          connection.openTimer = openTimer;
          timers.add(openTimer);

          socket.on("open", () => {
            if (!isCurrent(connection) || connection.closed) return;
            connection.opened = true;
            connection.reconnectIndex = 0;
            clearOpenTimer(connection);
            socket.send(frame("auth", { token }));
          });
          socket.on("message", (data) => {
            if (!isCurrent(connection) || connection.closed) return;
            try {
              const received = decodeMulticaWebSocketFrame(textFromMessage(data));
              if (received.type === "auth_ack") {
                if (connection.authenticated) return;
                connection.authenticated = true;
                socket.send(frame("subscribe", { scope: "workspace", id: workspaceId }));
                return;
              }
              if (received.type === "subscribe_ack") {
                const scope = scopeFromPayload(received.payload);
                const id = idFromPayload(received.payload);
                if (scope === "workspace" && id === workspaceId)
                  connection.workspaceSubscribed = true;
                if (scope === "task" && options.taskId !== undefined && id === options.taskId) {
                  connection.taskSubscribed = true;
                }
                if (
                  scope === "workspace" &&
                  id === workspaceId &&
                  options.taskId !== undefined &&
                  connection.taskSubscribed === false
                ) {
                  socket.send(frame("subscribe", { scope: "task", id: options.taskId }));
                }
                return;
              }
              if (isErrorFrame(received.type)) {
                const scope = scopeFromPayload(received.payload);
                const detail =
                  scope === undefined
                    ? "Multica WebSocket 请求被拒绝。"
                    : `Multica ${scope} 订阅被拒绝。`;
                if (
                  received.type === "auth_error" ||
                  scope === "workspace" ||
                  scope === undefined
                ) {
                  fail(protocolFailure("taskEventStream", received.type, detail));
                } else if (scope === "task") {
                  connection.taskSubscribed = false;
                  connection.closed = true;
                  socket.terminate?.();
                  socket.close();
                  scheduleReconnect(workspaceId);
                }
                return;
              }
              if (isIgnoredFrame(received.type) || !isTaskEvent(received.type)) return;
              if (
                !connection.authenticated ||
                !connection.workspaceSubscribed ||
                !connection.taskSubscribed
              )
                return;
              const payloadWorkspaceId = frameWorkspaceId(received.payload);
              if (payloadWorkspaceId !== undefined && payloadWorkspaceId !== workspaceId) return;
              if (options.taskId !== undefined && frameTaskId(received.payload) !== options.taskId)
                return;
              Queue.offerUnsafe(queue, received);
            } catch (cause) {
              fail(
                protocolFailure(
                  "taskEventStream",
                  "invalid_frame",
                  cause instanceof Error ? cause.message : String(cause),
                ),
              );
            }
          });
          socket.on("error", () => {
            if (!isCurrent(connection) || connection.closed) return;
            connection.closed = true;
            clearOpenTimer(connection);
            scheduleReconnect(workspaceId);
          });
          socket.on("close", () => {
            if (!isCurrent(connection)) return;
            connection.closed = true;
            clearOpenTimer(connection);
            scheduleReconnect(workspaceId);
          });
        };

        for (const workspaceId of workspaceIds) connect(workspaceId);
        return { stop };
      }),
      ({ stop }) => Effect.sync(stop),
    ),
  );
};
