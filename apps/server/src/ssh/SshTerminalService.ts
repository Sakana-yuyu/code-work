/**
 * SshTerminalService - 交互式 SSH 终端会话。
 *
 * 与本地 TerminalManager 完全并行：会话键同为 (threadId, terminalId)，事件族
 * 同形（started/output/exited/closed/error），但底层是 ssh2 shell 通道而不是
 * 本地 pty，因此没有 pid、进程轮询、端口归因这些本地语义。输出维护内存
 * scrollback（256KB 截断），面板重挂载时经 attach 流回放。
 *
 * @module SshTerminalService
 */
// @effect-diagnostics globalDate:off
import {
  SshConnectionError,
  type SshError,
  type SshServerId,
  type SshTerminalAttachInput,
  SshTerminalAttachStreamEvent,
  type SshTerminalCloseInput,
  type SshTerminalEvent,
  SshTerminalNotRunningError,
  type SshTerminalOpenInput,
  type SshTerminalResizeInput,
  type SshTerminalSessionSnapshot,
  SshTerminalSessionLookupError,
  type SshTerminalSessionStatus,
  type SshTerminalWriteInput,
  type SshTerminalError,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SshShellChannel } from "./SshServerConnection.ts";
import * as SshServerServiceModule from "./SshServerService.ts";

const SCROLLBACK_CAP_BYTES = 256 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface SshTerminalSession {
  readonly threadId: string;
  readonly terminalId: string;
  readonly serverId: SshServerId;
  readonly serverLabel: string;
  readonly channel: SshShellChannel;
  status: SshTerminalSessionStatus;
  history: string;
  readonly listeners: Set<(event: SshTerminalEvent) => void>;
  readonly releaseConnection: () => void;
  unsubscribeData: () => void;
  unsubscribeClose: () => void;
  closed: boolean;
}

export class SshTerminalService extends Context.Service<
  SshTerminalService,
  {
    readonly open: (
      input: SshTerminalOpenInput,
    ) => Effect.Effect<SshTerminalSessionSnapshot, SshError | SshTerminalError>;

    /** 重挂载：先发快照（含 scrollback），随后是本终端的实时事件。 */
    readonly attachStream: (
      input: SshTerminalAttachInput,
      listener: (event: SshTerminalAttachStreamEvent) => void,
    ) => () => void;

    readonly write: (input: SshTerminalWriteInput) => Effect.Effect<void, SshTerminalError>;

    readonly resize: (input: SshTerminalResizeInput) => Effect.Effect<void, SshTerminalError>;

    readonly close: (input: SshTerminalCloseInput) => Effect.Effect<void>;

    /** 全局事件订阅（客户端按 threadId 过滤）。 */
    readonly subscribe: (listener: (event: SshTerminalEvent) => void) => () => void;
  }
>()("codework/ssh/SshTerminalService") {}

const sessionKey = (threadId: string, terminalId: string): string => `${threadId}\0${terminalId}`;

const nowIso = () => new Date().toISOString();

export const make = Effect.gen(function* () {
  const sshServers = yield* SshServerServiceModule.SshServerService;

  const sessions = new Map<string, SshTerminalSession>();
  const globalListeners = new Set<(event: SshTerminalEvent) => void>();

  const emit = (session: SshTerminalSession, event: SshTerminalEvent) => {
    for (const listener of session.listeners) listener(event);
    for (const listener of globalListeners) listener(event);
  };

  const snapshotOf = (session: SshTerminalSession): SshTerminalSessionSnapshot => ({
    threadId: session.threadId,
    terminalId: session.terminalId,
    serverId: session.serverId,
    status: session.status,
    serverLabel: session.serverLabel,
    history: session.history,
    updatedAt: nowIso(),
  });

  const teardownSession = (session: SshTerminalSession) => {
    if (session.closed) return;
    session.closed = true;
    session.status = "exited";
    session.unsubscribeData();
    session.unsubscribeClose();
    session.releaseConnection();
    sessions.delete(sessionKey(session.threadId, session.terminalId));
    emit(session, {
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      serverId: session.serverId,
    });
    emit(session, {
      type: "closed",
      threadId: session.threadId,
      terminalId: session.terminalId,
      serverId: session.serverId,
    });
  };

  const open = (input: SshTerminalOpenInput) =>
    Effect.gen(function* () {
      const key = sessionKey(input.threadId, input.terminalId);
      const existing = sessions.get(key);
      if (
        existing !== undefined &&
        (existing.status === "running" || existing.status === "starting")
      ) {
        // open 是「确保在跑」：面板重挂载、页面刷新恢复都走这里，活会话
        // 原样复用（scrollback 保留），只有死会话才重建。
        emit(existing, {
          type: "started",
          threadId: existing.threadId,
          terminalId: existing.terminalId,
          serverId: existing.serverId,
          snapshot: snapshotOf(existing),
        });
        return snapshotOf(existing);
      }
      if (existing !== undefined) {
        // 同键重开死会话 = 顶掉重建。
        existing.unsubscribeClose();
        teardownSession(existing);
      }

      const resolved = yield* sshServers.resolveServer(input.serverId);
      const pinned = yield* sshServers.pinConnection(resolved.serverId);
      const channel = yield* pinned.connection
        .openShell({
          cols: input.cols ?? DEFAULT_COLS,
          rows: input.rows ?? DEFAULT_ROWS,
        })
        .pipe(
          Effect.tapError(() => Effect.sync(pinned.release)),
          Effect.mapError(
            (failure): SshError =>
              failure._tag === "SshConnectFailure"
                ? new SshConnectionError({ reason: failure.message })
                : new SshConnectionError({ reason: failure.message }),
          ),
        );

      const session: SshTerminalSession = {
        threadId: input.threadId,
        terminalId: input.terminalId,
        serverId: resolved.serverId,
        serverLabel: resolved.config.label,
        channel,
        status: "running",
        history: "",
        listeners: new Set(),
        releaseConnection: pinned.release,
        unsubscribeData: () => undefined,
        unsubscribeClose: () => undefined,
        closed: false,
      };
      session.unsubscribeData = channel.onData((data) => {
        session.history =
          session.history.length + data.length > SCROLLBACK_CAP_BYTES
            ? (session.history + data).slice(-SCROLLBACK_CAP_BYTES)
            : session.history + data;
        emit(session, {
          type: "output",
          threadId: session.threadId,
          terminalId: session.terminalId,
          serverId: session.serverId,
          data,
        });
      });
      session.unsubscribeClose = channel.onClose(() => {
        teardownSession(session);
      });
      sessions.set(key, session);
      const snapshot = snapshotOf(session);
      emit(session, {
        type: "started",
        threadId: session.threadId,
        terminalId: session.terminalId,
        serverId: session.serverId,
        snapshot,
      });
      return snapshot;
    });

  const lookup = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }): Effect.Effect<SshTerminalSession, SshTerminalSessionLookupError> =>
    Effect.suspend(() => {
      const session = sessions.get(sessionKey(input.threadId, input.terminalId));
      return session === undefined
        ? Effect.fail(
            new SshTerminalSessionLookupError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          )
        : Effect.succeed(session);
    });

  const attachStream = (
    input: SshTerminalAttachInput,
    listener: (event: SshTerminalAttachStreamEvent) => void,
  ) => {
    const session = sessions.get(sessionKey(input.threadId, input.terminalId));
    if (session === undefined) {
      listener({
        type: "error",
        threadId: input.threadId,
        terminalId: input.terminalId,
        serverId: "" as SshServerId,
        message: "SSH terminal session not found",
      });
      return () => undefined;
    }
    listener({
      type: "snapshot",
      snapshot: snapshotOf(session),
    });
    // SshTerminalAttachStreamEvent = snapshot 头 + 全部 SshTerminalEvent 成员，直接透传。
    const wrapped = (event: SshTerminalEvent) => {
      listener(event);
    };
    session.listeners.add(wrapped);
    return () => {
      session.listeners.delete(wrapped);
    };
  };

  const write = (input: SshTerminalWriteInput) =>
    Effect.flatMap(lookup(input), (session) =>
      session.status !== "running" || session.closed
        ? Effect.fail(
            new SshTerminalNotRunningError({
              threadId: input.threadId,
              terminalId: input.terminalId,
            }),
          )
        : Effect.sync(() => {
            session.channel.write(input.data);
          }),
    );

  const resize = (input: SshTerminalResizeInput) =>
    Effect.flatMap(lookup(input), (session) =>
      Effect.sync(() => {
        session.channel.resize(input.cols, input.rows);
      }),
    );

  const close = (input: SshTerminalCloseInput) =>
    Effect.sync(() => {
      const session = sessions.get(sessionKey(input.threadId, input.terminalId));
      if (session === undefined) return;
      // 关通道通常触发 onClose → teardown；这里直接兜底收敛，幂等。
      session.channel.close();
      teardownSession(session);
    });

  return SshTerminalService.of({
    open,
    attachStream,
    write,
    resize,
    close,
    subscribe: (listener: (event: SshTerminalEvent) => void) => {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },
  });
});

export const SshTerminalServiceLayer = Layer.effect(SshTerminalService, make).pipe(
  Layer.provide(SshServerServiceModule.SshServerServiceLayer),
);
