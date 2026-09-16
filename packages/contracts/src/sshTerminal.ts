import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SshServerId } from "./sshServers.ts";

/**
 * 远程 SSH 终端契约。与本地 terminal.ts 的形状刻意对齐（threadId + terminalId
 * 会话键、started/output/exited/closed/error 事件族），但完全并行：本地
 * TerminalManager 假设本地进程语义（pid/进程轮询/端口归因），SSH shell 通道
 * 不进入那套模型。
 */
const TerminalCols = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(1000),
);
const TerminalRows = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(500),
);
const TerminalId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const SshTerminalSessionInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  terminalId: TerminalId,
});
export type SshTerminalSessionInput = typeof SshTerminalSessionInput.Type;

export const SshTerminalOpenInput = Schema.Struct({
  ...SshTerminalSessionInput.fields,
  serverId: SshServerId,
  cols: Schema.optional(TerminalCols),
  rows: Schema.optional(TerminalRows),
});
export type SshTerminalOpenInput = Schema.Codec.Encoded<typeof SshTerminalOpenInput>;

export const SshTerminalWriteInput = Schema.Struct({
  ...SshTerminalSessionInput.fields,
  data: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(65_536)),
});
export type SshTerminalWriteInput = typeof SshTerminalWriteInput.Type;

export const SshTerminalResizeInput = Schema.Struct({
  ...SshTerminalSessionInput.fields,
  cols: TerminalCols,
  rows: TerminalRows,
});
export type SshTerminalResizeInput = typeof SshTerminalResizeInput.Type;

export const SshTerminalCloseInput = SshTerminalSessionInput;
export type SshTerminalCloseInput = typeof SshTerminalCloseInput.Type;

export const SshTerminalSessionStatus = Schema.Literals(["starting", "running", "exited", "error"]);
export type SshTerminalSessionStatus = typeof SshTerminalSessionStatus.Type;

export const SshTerminalSessionSnapshot = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  serverId: SshServerId,
  status: SshTerminalSessionStatus,
  /** 服务器 label，面板标题直接可用。 */
  serverLabel: Schema.String,
  /** 服务端内存 scrollback（上限截断），面板重挂载时回放。 */
  history: Schema.String,
  updatedAt: Schema.String,
});
export type SshTerminalSessionSnapshot = typeof SshTerminalSessionSnapshot.Type;

/** 已存在会话的重挂载：快照（含 scrollback）先行，随后是本终端的实时事件。 */
export const SshTerminalAttachInput = SshTerminalSessionInput;
export type SshTerminalAttachInput = typeof SshTerminalAttachInput.Type;

const SshTerminalEventBase = Schema.Struct({
  threadId: Schema.String.check(Schema.isNonEmpty()),
  terminalId: Schema.String.check(Schema.isNonEmpty()),
  serverId: SshServerId,
});

const SshTerminalStartedEvent = Schema.Struct({
  ...SshTerminalEventBase.fields,
  type: Schema.Literal("started"),
  snapshot: SshTerminalSessionSnapshot,
});

const SshTerminalOutputEvent = Schema.Struct({
  ...SshTerminalEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const SshTerminalExitedEvent = Schema.Struct({
  ...SshTerminalEventBase.fields,
  type: Schema.Literal("exited"),
});

const SshTerminalClosedEvent = Schema.Struct({
  ...SshTerminalEventBase.fields,
  type: Schema.Literal("closed"),
});

const SshTerminalErrorEvent = Schema.Struct({
  ...SshTerminalEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

export const SshTerminalEvent = Schema.Union([
  SshTerminalStartedEvent,
  SshTerminalOutputEvent,
  SshTerminalExitedEvent,
  SshTerminalClosedEvent,
  SshTerminalErrorEvent,
]);
export type SshTerminalEvent = typeof SshTerminalEvent.Type;

const SshTerminalSnapshotStreamEvent = Schema.Struct({
  type: Schema.Literal("snapshot"),
  snapshot: SshTerminalSessionSnapshot,
});

export const SshTerminalAttachStreamEvent = Schema.Union([
  SshTerminalSnapshotStreamEvent,
  SshTerminalStartedEvent,
  SshTerminalOutputEvent,
  SshTerminalExitedEvent,
  SshTerminalClosedEvent,
  SshTerminalErrorEvent,
]);
export type SshTerminalAttachStreamEvent = typeof SshTerminalAttachStreamEvent.Type;

export class SshTerminalSessionLookupError extends Schema.TaggedErrorClass<SshTerminalSessionLookupError>()(
  "SshTerminalSessionLookupError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `Unknown SSH terminal thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export class SshTerminalNotRunningError extends Schema.TaggedErrorClass<SshTerminalNotRunningError>()(
  "SshTerminalNotRunningError",
  {
    threadId: Schema.String,
    terminalId: Schema.String,
  },
) {
  override get message() {
    return `SSH terminal is not running for thread: ${this.threadId}, terminal: ${this.terminalId}`;
  }
}

export const SshTerminalError = Schema.Union([
  SshTerminalSessionLookupError,
  SshTerminalNotRunningError,
]);
export type SshTerminalError = typeof SshTerminalError.Type;
