/**
 * PtyAdapter - Terminal PTY adapter service contract.
 *
 * Defines the process primitives required by terminal session management
 * without binding to a specific PTY implementation.
 *
 * @module PtyAdapter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * PtySpawnError - Error type for PTY spawn failures.
 */
export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export class PtyProcessListenerRegistrationError extends Schema.TaggedErrorClass<PtyProcessListenerRegistrationError>()(
  "PtyProcessListenerRegistrationError",
  {
    listener: Schema.Literals(["data", "exit"]),
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to register terminal ${this.listener} listener for process ${this.terminalPid}`;
  }
}

export class PtyProcessListenerDisposalError extends Schema.TaggedErrorClass<PtyProcessListenerDisposalError>()(
  "PtyProcessListenerDisposalError",
  {
    listener: Schema.Literals(["data", "exit"]),
    terminalPid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to dispose terminal ${this.listener} listener for process ${this.terminalPid}`;
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export type PtyExitObservation =
  | { readonly status: "reliable" }
  | { readonly status: "gap"; readonly cause: unknown };

export interface PtyProcess {
  readonly pid: number;
  /**
   * `reliable` 表示观察覆盖整个 handle 生命周期或底层支持迟取重放；否则 acquisition
   * 失败必须先暴露 `gap`。调用方必须隔离 gap handle，不能据超时推断进程仍存活或已退出。
   */
  readonly exitObservation: PtyExitObservation;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** 无参数表示使用当前平台的默认终止方式；Windows 不支持 POSIX signal。 */
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  /** `exitObservation` 为 reliable 时，退出后迟订阅必须同步重放同一 handle 的事件。 */
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 */
export class PtyAdapter extends Context.Service<
  PtyAdapter,
  {
    /**
     * Spawn a PTY process for a terminal session.
     */
    readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
  }
>()("codework/terminal/PtyAdapter") {}
