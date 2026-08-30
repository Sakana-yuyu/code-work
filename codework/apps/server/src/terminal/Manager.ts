/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for thread-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  DEFAULT_TERMINAL_ID,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalManagerShutdownError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalProcessTerminationError,
  TerminalSessionOwnershipError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
} from "@codework/contracts";
import { makeKeyedCoalescingWorker } from "@codework/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { getTerminalLabel } from "@codework/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PtyAdapter from "./PtyAdapter.ts";
import * as PtyExitObservationGap from "./PtyExitObservationGap.ts";
import * as PtyProcessActivation from "./PtyProcessActivation.ts";
import * as PtyProcessActivationCleanup from "./PtyProcessActivationCleanup.ts";
import * as PtyProcessExitObserver from "./PtyProcessExitObserver.ts";
import * as PtyProcessTermination from "./PtyProcessTermination.ts";
import * as PtyProcessTerminationCoordinator from "./PtyProcessTerminationCoordinator.ts";
import {
  terminalSessionOwnerEquals,
  type TerminalSessionOwner,
} from "./TerminalSessionOwnership.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalManagerShutdownError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalProcessTerminationError,
  TerminalSessionOwnershipError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_PROCESS_EXIT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;

class TerminalSubprocessCheckError extends Schema.TaggedErrorClass<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same thread/terminal id and restores
     * persisted history on first open.
     */
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly runCommand: (
      input: TerminalRunCommandInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * 只读获取终端历史；允许 Workspace Script 专用日志链路读取 owned session，
     * 但不得借此附加、输入或改变进程状态。
     */
    readonly getHistory: (
      input: TerminalHistoryInput,
    ) => Effect.Effect<string, TerminalHistoryError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the thread.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    readonly kill: (input: TerminalKillInput) => Effect.Effect<void, TerminalError>;

    readonly inspectSession: (
      input: TerminalInspectSessionInput,
    ) => Effect.Effect<TerminalSessionInspection, TerminalError>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("codework/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        threadId: session.threadId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalRunCommandInput extends TerminalOpenInput {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly owner?: TerminalSessionOwner;
}

export interface TerminalKillInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly expectedOwner?: TerminalSessionOwner;
}

export interface TerminalInspectSessionInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly expectedOwner?: TerminalSessionOwner;
}

export type TerminalSessionInspection = "active" | "inactive" | "missing" | "quarantined";

export interface TerminalHistoryInput {
  readonly threadId: string;
  readonly terminalId: string;
}

export interface TerminalSessionState {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  processExitDrainsInFlight: number;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  processGeneration: number;
  processExit: PtyProcessTermination.PtyProcessExitState | null;
  exitObservationGapHandled: boolean;
  owner: TerminalSessionOwner | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
  persistenceMode: "debounced" | "on_exit";
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent = PtyProcessActivation.PtyProcessActivationEvent;

type EnqueueProcessEventResult = "ignored" | "queued" | "start-drain";

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      threadId: string;
      terminalId: string;
      sequence: number;
      history: string | null;
      data: string;
    }
  | {
      type: "exit";
      processExit: PtyProcessTermination.PtyProcessExitState | null;
      listenerCleanupFailures: ReadonlyArray<TerminalProcessListenerCleanupFailure>;
      threadId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  lifecycle: "open" | "closing" | "closed";
  sessions: Map<string, TerminalSessionState>;
  terminations: Map<
    PtyAdapter.PtyProcess,
    PtyProcessTerminationCoordinator.PtyProcessTerminationRecord
  >;
  exitDrainsInFlight: number;
}

interface TerminalProcessListenerCleanupFailure {
  readonly listener: "data" | "exit";
  readonly cause: unknown;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.threadId === initialSnapshot.threadId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(
  session: TerminalSessionState,
): ReadonlyArray<TerminalProcessListenerCleanupFailure> {
  const unsubscribeData = session.unsubscribeData;
  const unsubscribeExit = session.unsubscribeExit;
  session.unsubscribeData = null;
  session.unsubscribeExit = null;

  const failures: TerminalProcessListenerCleanupFailure[] = [];
  if (unsubscribeData) {
    try {
      unsubscribeData();
    } catch (cause) {
      failures.push({ listener: "data", cause });
    }
  }
  if (unsubscribeExit) {
    try {
      unsubscribeExit();
    } catch (cause) {
      failures.push({ listener: "exit", cause });
    }
  }
  return failures;
}

function isSupervisedProcessStatus(status: TerminalSessionStatus): boolean {
  return status === "running" || status === "error";
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedProcess: PtyAdapter.PtyProcess,
  expectedProcessGeneration: number,
  event: PendingProcessEvent,
): EnqueueProcessEventResult {
  if (
    session.process !== expectedProcess ||
    session.processGeneration !== expectedProcessGeneration ||
    !isSupervisedProcessStatus(session.status)
  ) {
    return "ignored";
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return "queued";
  }

  session.processEventDrainRunning = true;
  return "start-drain";
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // `comm=` is the final column and may itself contain spaces, so only the
    // first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function parseWindowsProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    const [pidRaw, parentPidRaw, nameRaw] = line.trim().split("|", 3);
    const pid = Number(pidRaw);
    const parentPid = Number(parentPidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, nameRaw?.trim() ?? "");
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? [])[0];
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = normalizeChildCommandName(snapshot.commandById.get(childPid) ?? "", platform);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve `ps` to an absolute path once at startup. Spawning by bare name
// walks every PATH entry per spawn (one failed posix_spawn per directory
// until the hit), which is measurable at a 1s poll cadence on long PATHs.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Not authoritative: an empty or partial table would mark every terminal
    // idle and clear its registered process ids. Failing skips the tick.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        // powershell.exe is a real executable — never spawn it through cmd.exe
        // shell mode, which would re-tokenize the `-Command` payload (pipes,
        // semicolons) before PowerShell ever sees it.
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalSubprocessCheckError({
              cause,
              command: "powershell",
            }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      // Not authoritative: an empty or partial table would mark every terminal
      // idle and clear its registered process ids. Failing skips the tick.
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    return parseWindowsProcessTable(result.stdout);
  },
);

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  // DECRQM mode queries (…$p) and DECRPM replies (…$y): replaying a stored
  // query makes the terminal answer again, and the shell echoes the answer as
  // junk at the prompt. The `$` guard keeps setters like DECSTR (!p) and
  // DECSCL ("p) intact.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// DECRQSS ($q) and XTGETTCAP (+q) queries plus their replies ([01]$r / [01]+r):
// pure request/response traffic with no visual value, and replaying a stored
// query triggers a fresh reply.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("CODEWORK_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// Colon-separated search-path variables the AppImage runtime points at its
// temporary mount (e.g. /tmp/.mount_T3-XXXX/usr/bin, the bundled glib schemas,
// and an $APPDIR/usr/share XDG data entry). Only the mount segments are
// dropped; the user's real entries are preserved. When nothing but mount
// segments remain the variable is removed entirely so consumers fall back to
// their platform default (e.g. gsettings finds the host schemas instead of
// reporting "No schemas installed"). See issues #1699 and #5059.
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  processExitTimeoutMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  onExitDrained?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
  afterProcessCommitted?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processGeneration: number;
  }) => Effect.Effect<void>;
  afterGapTerminationClaimed?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processGeneration: number;
  }) => Effect.Effect<void>;
  afterTerminationRecordPublished?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processGeneration: number;
  }) => Effect.Effect<void>;
  afterExitObserverPublished?: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly processGeneration: number;
  }) => Effect.Effect<void>;
}

export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  // One process-table snapshot per poll tick, shared across every terminal.
  // Per-terminal `pgrep`/`ps` calls multiply spawn load by terminal count and
  // can exhaust the PID space on hosts with many sessions (#6332).
  const fetchProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    TerminalSubprocessInspector,
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed(customSubprocessInspector)
      : Effect.map(
          fetchProcessTableSnapshot,
          (snapshot): TerminalSubprocessInspector =>
            (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
        );
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const processExitTimeoutMs = options.processExitTimeoutMs ?? DEFAULT_PROCESS_EXIT_TIMEOUT_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);
  const onExitDrained = options.onExitDrained ?? (() => Effect.void);
  const afterProcessCommitted = options.afterProcessCommitted ?? (() => Effect.void);
  const afterGapTerminationClaimed = options.afterGapTerminationClaimed ?? (() => Effect.void);
  const afterTerminationRecordPublished =
    options.afterTerminationRecordPublished ?? (() => Effect.void);
  const afterExitObserverPublished = options.afterExitObserverPublished ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    lifecycle: "open",
    sessions: new Map(),
    terminations: new Map(),
    exitDrainsInFlight: 0,
  });
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  const terminationScope = yield* Scope.make("sequential");
  let keepTerminationScopeAliveAfterManagerClose = false;
  let terminationScopeCloseStarted = false;
  yield* Effect.addFinalizer(() =>
    keepTerminationScopeAliveAfterManagerClose
      ? Effect.void
      : Scope.close(terminationScope, Exit.void),
  );
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
  const terminalEventQueue = yield* Queue.unbounded<{
    readonly event: TerminalEvent;
    readonly listeners: ReadonlyArray<(event: TerminalEvent) => Effect.Effect<void>>;
  }>();

  const deliverEvent = Effect.fn("terminal.deliverEvent")(function* (delivery: {
    readonly event: TerminalEvent;
    readonly listeners: ReadonlyArray<(event: TerminalEvent) => Effect.Effect<void>>;
  }) {
    for (const listener of delivery.listeners) {
      yield* listener(delivery.event).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  yield* Effect.forever(Queue.take(terminalEventQueue).pipe(Effect.flatMap(deliverEvent))).pipe(
    Effect.forkIn(workerScope),
  );

  const publishEvent = (event: TerminalEvent) =>
    Queue.offer(terminalEventQueue, {
      event,
      listeners: [...terminalEventListeners],
    }).pipe(Effect.asVoid);

  const historyPath = (threadId: string, terminalId: string) => {
    const threadPart = toSafeThreadId(threadId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${threadPart}.log`);
    }
    return path.join(logsDir, `${threadPart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const legacyHistoryPath = (threadId: string) =>
    path.join(logsDir, `${legacySafeThreadId(threadId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const assertManagerOpen = Effect.fn("terminal.assertManagerOpen")(function* (
    operation: TerminalManagerShutdownError["operation"],
  ) {
    const lifecycle = yield* readManagerState.pipe(Effect.map((state) => state.lifecycle));
    if (lifecycle === "open") return;
    return yield* new TerminalManagerShutdownError({ operation });
  });

  const insertSessionWhileOpen = Effect.fn("terminal.insertSessionWhileOpen")(function* (
    sessionKey: string,
    session: TerminalSessionState,
    operation: TerminalManagerShutdownError["operation"],
  ) {
    const inserted = yield* modifyManagerState((state) => {
      if (state.lifecycle !== "open") {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.set(sessionKey, session);
      return [true, { ...state, sessions }] as const;
    });
    if (!inserted) {
      return yield* new TerminalManagerShutdownError({ operation });
    }
  });

  const closeTerminationScopeIfDrained = Effect.fn("terminal.closeTerminationScopeIfDrained")(
    function* () {
      const shouldClose = yield* modifyManagerState((state) => {
        if (
          state.lifecycle !== "closed" ||
          state.sessions.size > 0 ||
          state.terminations.size > 0 ||
          state.exitDrainsInFlight > 0 ||
          terminationScopeCloseStarted
        ) {
          return [false, state] as const;
        }
        terminationScopeCloseStarted = true;
        return [true, state] as const;
      });
      if (shouldClose) {
        yield* Scope.close(terminationScope, Exit.void);
      }
    },
  );

  const completeProcessExitDrain = Effect.fn("terminal.completeProcessExitDrain")(function* (
    session: TerminalSessionState,
  ) {
    yield* modifyManagerState((state) => {
      session.processExitDrainsInFlight = Math.max(0, session.processExitDrainsInFlight - 1);
      const exitDrainsInFlight = Math.max(0, state.exitDrainsInFlight - 1);
      const key = toSessionKey(session.threadId, session.terminalId);
      const current = state.sessions.get(key);
      if (
        state.lifecycle !== "closed" ||
        current !== session ||
        current.process !== null ||
        current.processExitDrainsInFlight > 0
      ) {
        return [undefined, { ...state, exitDrainsInFlight }] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [undefined, { ...state, sessions, exitDrainsInFlight }] as const;
    });
    yield* closeTerminationScopeIfDrained();
  });

  const getThreadSemaphore = (threadId: string) =>
    SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(threadId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(threadId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withThreadLock = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

  const mapTerminationError = (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    error: PtyProcessTermination.PtyProcessTerminationError,
  ): TerminalProcessTerminationError => {
    switch (error._tag) {
      case "PtyProcessSignalError":
        return new TerminalProcessTerminationError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          terminalPid: process.pid,
          reason: error.signal === "SIGKILL" ? "force-signal-failed" : "signal-failed",
          signal: error.signal,
          cause: error.cause,
        });
      case "PtyProcessExitTimeoutError":
        return new TerminalProcessTerminationError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          terminalPid: process.pid,
          reason: error.phase === "forced" ? "force-exit-timeout" : "exit-timeout",
          signal: error.phase === "forced" ? "SIGKILL" : "platform-default",
        });
      case "PtyProcessIdentityChangedError":
        return new TerminalProcessTerminationError({
          threadId: session.threadId,
          terminalId: session.terminalId,
          terminalPid: process.pid,
          reason: "session-replaced",
          signal: null,
        });
    }
  };

  const failIfExitObservationGap = Effect.fn("terminal.failIfExitObservationGap")(function* (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    processGeneration: number,
    observerFailure?: unknown,
  ) {
    return yield* PtyExitObservationGap.failIfPresent({
      threadId: session.threadId,
      terminalId: session.terminalId,
      process,
      processGeneration,
      ...(observerFailure === undefined ? {} : { observerFailure }),
      claim: modifyManagerState((state) => {
        const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
        const observation = process.exitObservation;
        if (
          current !== session ||
          current.process !== process ||
          current.processGeneration !== processGeneration ||
          observation.status !== "gap"
        ) {
          return [null, state] as const;
        }
        const shouldSignal = platform === "win32" && !current.exitObservationGapHandled;
        current.exitObservationGapHandled = true;
        return [
          {
            observationCause: observation.cause,
            shouldSignal,
            signal: platform === "win32" ? ("platform-default" as const) : null,
          },
          state,
        ] as const;
      }),
      afterClaimed: afterGapTerminationClaimed({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processGeneration,
      }),
      signalIfCurrent: (_signal) =>
        modifyManagerState<PtyExitObservationGap.PtyExitObservationGapSignalResult>((state) => {
          const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
          const observedExit =
            current?.processExit !== null && current?.processExit !== undefined
              ? current.processExit.observedExit.current
              : null;
          if (
            current !== session ||
            current.process !== process ||
            current.processGeneration !== processGeneration ||
            !isSupervisedProcessStatus(current.status) ||
            process.exitObservation.status !== "gap" ||
            observedExit !== null
          ) {
            return [{ signalAttempted: false as const, signalFailure: undefined }, state] as const;
          }

          let signalFailure: unknown;
          try {
            process.kill();
          } catch (cause) {
            signalFailure = cause;
          }
          return [{ signalAttempted: true as const, signalFailure }, state] as const;
        }),
    });
  });

  const removeTerminationRecord = (
    process: PtyAdapter.PtyProcess,
    record: PtyProcessTerminationCoordinator.PtyProcessTerminationRecord,
  ) =>
    modifyManagerState((state) => {
      if (state.terminations.get(process) !== record) {
        return [undefined, state] as const;
      }
      const terminations = new Map(state.terminations);
      terminations.delete(process);
      return [undefined, { ...state, terminations }] as const;
    });

  const isCurrentTerminationTarget = (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    processGeneration: number,
    owner: TerminalSessionOwner | null,
  ) =>
    readManagerState.pipe(
      Effect.map((state) => {
        const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
        return (
          current === session &&
          current.process === process &&
          current.processGeneration === processGeneration &&
          isSupervisedProcessStatus(current.status) &&
          terminalSessionOwnerEquals(current.owner, owner ?? undefined)
        );
      }),
    );

  const terminateProcess = Effect.fn("terminal.terminateProcess")(function* (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    processGeneration: number,
    processExit: PtyProcessTermination.PtyProcessExitState,
    owner: TerminalSessionOwner | null,
  ) {
    return yield* PtyProcessTerminationCoordinator.terminate({
      process,
      processGeneration,
      processExit,
      owner,
      platform,
      gracefulTimeoutMs: processKillGraceMs,
      forceExitTimeoutMs: processExitTimeoutMs,
      terminationScope,
      select: (candidate) =>
        modifyManagerState<PtyProcessTerminationCoordinator.PtyProcessTerminationSelection>(
          (state) => {
            const existing = state.terminations.get(process);
            if (existing) {
              const sameOwner = terminalSessionOwnerEquals(existing.owner, owner ?? undefined);
              return [
                existing.processGeneration === processGeneration && sameOwner
                  ? ({ type: "existing", record: existing } as const)
                  : ({ type: "identity-changed" } as const),
                state,
              ] as const;
            }
            const terminations = new Map(state.terminations);
            terminations.set(process, candidate);
            return [
              { type: "created", record: candidate } as const,
              { ...state, terminations },
            ] as const;
          },
        ),
      remove: (record) => removeTerminationRecord(process, record),
      isCurrent: isCurrentTerminationTarget(session, process, processGeneration, owner),
      afterRecordPublished: afterTerminationRecordPublished({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processGeneration,
      }),
      onWorkerDrained: () => runFork(closeTerminationScopeIfDrained()),
    });
  });

  const writeHistoryNow = Effect.fn("terminal.writeHistoryNow")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* fileSystem.writeFileString(historyPath(threadId, terminalId), history).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to persist terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
  });

  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [threadId, terminalId] = sessionKey.split("\u0000");
      if (!threadId || !terminalId) {
        return;
      }

      yield* writeHistoryNow(threadId, terminalId, request.history);
    }),
  }).pipe(Effect.provideService(Scope.Scope, terminationScope));

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(threadId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    threadId: string,
    terminalId: string,
    history: string,
  ) {
    yield* persistWorker.enqueue(toSessionKey(threadId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(threadId, terminalId);
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(threadId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        )
    ) {
      const raw = yield* fileSystem
        .readFileString(nextPath)
        .pipe(
          Effect.mapError(
            (cause) => new TerminalHistoryError({ operation: "read", threadId, terminalId, cause }),
          ),
        );
      const capped = capHistory(raw, historyLineLimit);
      if (capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", threadId, terminalId, cause }),
            ),
          );
      }
      return capped;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = legacyHistoryPath(threadId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
          ),
        ))
    ) {
      return "";
    }

    const raw = yield* fileSystem
      .readFileString(legacyPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    const capped = capHistory(raw, historyLineLimit);
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", threadId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          threadId,
          error: cleanupError,
        }),
      ),
    );
    return capped;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    threadId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(threadId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          threadId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(threadId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            threadId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForThread = Effect.fn("terminal.deleteAllHistoryForThread")(function* (
    threadId: string,
  ) {
    const threadPrefix = `${toSafeThreadId(threadId)}_`;
    const entries = yield* fileSystem
      .readDirectory(logsDir, { recursive: false })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    yield* Effect.forEach(
      entries.filter(
        (name) =>
          name === `${toSafeThreadId(threadId)}.log` ||
          name === `${legacySafeThreadId(threadId)}.log` ||
          name.startsWith(threadPrefix),
      ),
      (name) =>
        fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to delete terminal histories for thread", {
              threadId,
              error,
            }),
          ),
        ),
      { discard: true },
    );
  });

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(threadId, terminalId))),
    );
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    threadId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(threadId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              threadId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const assertSessionOwner = Effect.fn("terminal.assertSessionOwner")(function* (
    session: TerminalSessionState,
    expectedOwner: TerminalSessionOwner | undefined,
  ) {
    if (terminalSessionOwnerEquals(session.owner, expectedOwner)) return;
    return yield* new TerminalSessionOwnershipError({
      threadId: session.threadId,
      terminalId: session.terminalId,
    });
  });

  const sessionsForThread = Effect.fn("terminal.sessionsForThread")(function* (threadId: string) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.threadId === threadId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) =>
            session.process === null &&
            session.processExitDrainsInFlight === 0 &&
            (session.status === "exited" || session.status === "error"),
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.threadId.localeCompare(right.threadId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.threadId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedProcess: PtyAdapter.PtyProcess,
    expectedProcessGeneration: number,
  ) {
    while (true) {
      const action = yield* modifyManagerState<DrainProcessEventAction>((state) => {
        if (
          session.process !== expectedProcess ||
          session.processGeneration !== expectedProcessGeneration ||
          !isSupervisedProcessStatus(session.status)
        ) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return [{ type: "idle" } as const, state] as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return [{ type: "idle" } as const, state] as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history = capHistory(
              `${session.history}${sanitized.visibleText}`,
              historyLineLimit,
            );
          }
          const eventStamp = advanceEventSequence(session);

          return [
            {
              type: "output",
              threadId: session.threadId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              history:
                session.persistenceMode === "debounced" && sanitized.visibleText.length > 0
                  ? session.history
                  : null,
              data: nextEvent.data,
            } as const,
            state,
          ] as const;
        }

        const processExit = session.processExit;
        const listenerCleanupFailures = cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.processExit = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.processExitDrainsInFlight += 1;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return [
          {
            type: "exit",
            processExit,
            listenerCleanupFailures,
            threadId: session.threadId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            exitCode: session.exitCode,
            exitSignal: session.exitSignal,
          } as const,
          { ...state, exitDrainsInFlight: state.exitDrainsInFlight + 1 },
        ] as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.threadId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      const processExit = action.processExit;
      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          for (const failure of action.listenerCleanupFailures) {
            yield* Effect.logWarning("failed to dispose exited terminal listener", {
              listener: failure.listener,
              threadId: action.threadId,
              terminalId: action.terminalId,
              terminalPid: expectedProcess.pid,
              cause: failure.cause,
            });
          }
          yield* unregisterTerminal({
            threadId: action.threadId,
            terminalId: action.terminalId,
          });
          if (session.persistenceMode === "on_exit") {
            yield* writeHistoryNow(action.threadId, action.terminalId, session.history);
          } else {
            yield* persistHistory(action.threadId, action.terminalId, session.history);
          }
        }).pipe(Effect.ensuring(completeProcessExitDrain(session)));
        yield* evictInactiveSessionsIfNeeded();
        yield* publishEvent({
          type: "exited",
          threadId: action.threadId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          exitCode: action.exitCode,
          exitSignal: action.exitSignal,
        });
        yield* onExitDrained({
          threadId: action.threadId,
          terminalId: action.terminalId,
        });
      }).pipe(
        Effect.ensuring(
          processExit
            ? Effect.sync(() => PtyProcessTermination.completeProcessExitHandling(processExit))
            : Effect.void,
        ),
      );
      return;
    }
  });

  const dispatchSupervisedProcessEvent = (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
    processGeneration: number,
    processExit: PtyProcessTermination.PtyProcessExitState,
    event: PendingProcessEvent,
  ) => {
    const enqueueResult = enqueueProcessEvent(session, process, processGeneration, event);
    if (enqueueResult === "ignored") {
      if (event.type === "exit") {
        PtyProcessTermination.completeProcessExitHandling(processExit);
      }
      return;
    }
    if (enqueueResult === "start-drain") {
      runFork(drainProcessEvents(session, process, processGeneration));
    }
  };

  const ensureProcessExitObserver = Effect.fn("terminal.ensureProcessExitObserver")(function* (
    session: TerminalSessionState,
    process: PtyAdapter.PtyProcess,
  ) {
    if (session.processExit) {
      return session.processExit;
    }

    const processGeneration = session.processGeneration;
    return yield* PtyProcessExitObserver.install({
      threadId: session.threadId,
      terminalId: session.terminalId,
      process,
      processGeneration,
      publish: (processExit, unsubscribeExit) =>
        modifyManagerState((state) => {
          const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
          if (
            current !== session ||
            current.process !== process ||
            current.processGeneration !== processGeneration ||
            !isSupervisedProcessStatus(current.status)
          ) {
            return [null, state] as const;
          }
          if (current.processExit) {
            return [current.processExit, state] as const;
          }
          current.processExit = processExit;
          current.unsubscribeExit = unsubscribeExit;
          return [processExit, state] as const;
        }),
      dispatch: (processExit, event) =>
        dispatchSupervisedProcessEvent(session, process, processGeneration, processExit, {
          type: "exit",
          event,
        }),
      afterPublished: afterExitObserverPublished({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processGeneration,
      }),
    });
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;
    const processGeneration = session.processGeneration;
    const processExitResult = yield* ensureProcessExitObserver(session, process).pipe(
      Effect.result,
    );
    yield* failIfExitObservationGap(
      session,
      process,
      processGeneration,
      processExitResult._tag === "Failure" ? processExitResult.failure : undefined,
    );
    if (processExitResult._tag === "Failure") {
      return yield* processExitResult.failure;
    }
    const processExit = processExitResult.success;

    yield* terminateProcess(
      session,
      process,
      session.processGeneration,
      processExit,
      session.owner,
    ).pipe(Effect.mapError((error) => mapTerminationError(session, process, error)));
    yield* evictInactiveSessionsIfNeeded();
    yield* closeTerminationScopeIfDrained();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const cleanupPendingActivation = Effect.fn("terminal.cleanupPendingActivation")(function* (
    session: TerminalSessionState,
    activation: PtyProcessActivation.PendingPtyProcessActivation,
  ) {
    return yield* PtyProcessActivationCleanup.cleanup({
      threadId: session.threadId,
      terminalId: session.terminalId,
      activation,
      platform,
      gracefulTimeoutMs: processKillGraceMs,
      forceExitTimeoutMs: processExitTimeoutMs,
      publishRetained: modifyManagerState((state) => {
        const current = state.sessions.get(toSessionKey(session.threadId, session.terminalId));
        if (current !== session || current.process !== null) {
          return [false, state] as const;
        }
        current.process = activation.process;
        current.pid = activation.process.pid;
        current.processGeneration = activation.processGeneration;
        current.processExit = activation.unsubscribeExit ? activation.processExit : null;
        current.exitObservationGapHandled = false;
        current.status = "error";
        current.unsubscribeData = activation.unsubscribeData;
        current.unsubscribeExit = activation.unsubscribeExit;
        current.hasRunningSubprocess = false;
        current.childCommandLabel = null;
        return [true, state] as const;
      }),
      quarantine: (observerFailure) =>
        failIfExitObservationGap(
          session,
          activation.process,
          activation.processGeneration,
          observerFailure,
        ),
      mapTerminationError: (error) => mapTerminationError(session, activation.process, error),
    });
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
    spawnCandidates?: ReadonlyArray<ShellCandidate>,
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.thread_id": session.threadId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates =
              spawnCandidates ?? resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
            yield* Effect.acquireUseRelease(
              Effect.gen(function* () {
                const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
                ptyProcess = spawnResult.process;
                startedShell = spawnResult.shellLabel;
                return yield* PtyProcessActivation.make({
                  process: spawnResult.process,
                  shellLabel: spawnResult.shellLabel,
                  processGeneration: session.processGeneration + 1,
                  dispatch: (processGeneration, processExit, event) =>
                    dispatchSupervisedProcessEvent(
                      session,
                      spawnResult.process,
                      processGeneration,
                      processExit,
                      event,
                    ),
                });
              }),
              (activation) =>
                Effect.gen(function* () {
                  activation.unsubscribeData =
                    yield* PtyProcessActivation.registerDataListener(activation);
                  activation.unsubscribeExit =
                    yield* PtyProcessActivation.registerExitListener(activation);

                  let eventStamp: ReturnType<typeof advanceEventSequence> = {
                    updatedAt: session.updatedAt,
                    sequence: session.eventSequence,
                  };
                  yield* modifyManagerState((state) => {
                    session.process = activation.process;
                    session.pid = activation.process.pid;
                    session.processGeneration = activation.processGeneration;
                    session.processExit = activation.processExit;
                    session.exitObservationGapHandled = false;
                    session.status = "running";
                    session.unsubscribeData = activation.unsubscribeData;
                    session.unsubscribeExit = activation.unsubscribeExit;
                    eventStamp = advanceEventSequence(session);
                    activation.committed = true;
                    return [undefined, state] as const;
                  });
                  yield* afterProcessCommitted({
                    threadId: session.threadId,
                    terminalId: session.terminalId,
                    processGeneration: activation.processGeneration,
                  });

                  yield* publishEvent({
                    type: eventType,
                    threadId: session.threadId,
                    terminalId: session.terminalId,
                    sequence: eventStamp.sequence,
                    snapshot: snapshot(session),
                  });
                  PtyProcessActivation.activate(activation);
                }),
              (activation) =>
                activation.committed
                  ? Effect.sync(() => PtyProcessActivation.activate(activation))
                  : cleanupPendingActivation(session, activation),
            );
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess && session.process === ptyProcess && session.status === "running") {
        yield* stopProcess(session);
      }

      let listenerCleanupFailures: ReadonlyArray<TerminalProcessListenerCleanupFailure> = [];
      yield* modifyManagerState((state) => {
        const retainedProcess = ptyProcess !== null && session.process === ptyProcess;
        if (!retainedProcess) {
          listenerCleanupFailures = cleanupProcessHandles(session);
          session.pid = null;
          session.process = null;
          session.processExit = null;
        }
        if (session.status !== "exited") {
          session.status = "error";
        }
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        if (!retainedProcess) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
        }
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      for (const failure of listenerCleanupFailures) {
        yield* Effect.logWarning("failed to dispose rejected terminal listener", {
          listener: failure.listener,
          threadId: session.threadId,
          terminalId: session.terminalId,
          cause: failure.cause,
        });
      }
      yield* unregisterTerminal({
        threadId: session.threadId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        threadId: session.threadId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    threadId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const key = toSessionKey(threadId, terminalId);
    const session = yield* getSession(threadId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* assertSessionOwner(session.value, undefined);
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ threadId, terminalId });
      if (session.value.persistenceMode === "on_exit") {
        yield* writeHistoryNow(threadId, terminalId, session.value.history);
      } else {
        yield* persistHistory(threadId, terminalId, session.value.history);
      }
    }

    if (Option.isNone(session) || session.value.persistenceMode === "debounced") {
      yield* flushPersist(threadId, terminalId);
    }

    const removed = yield* modifyManagerState((state) => {
      if (!state.sessions.has(key)) {
        return [false, state] as const;
      }
      const sessions = new Map(state.sessions);
      sessions.delete(key);
      return [true, { ...state, sessions }] as const;
    });

    if (removed) {
      yield* publishEvent({
        type: "closed",
        threadId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      yield* deleteHistory(threadId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return;
    }

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.map(Option.some),
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(Effect.as(Option.none<TerminalSubprocessInspector>())),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      return;
    }

    const subprocessInspector = inspectorOption.value;

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            threadId: session.threadId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        threadId: session.threadId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.threadId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            threadId: liveSession.value.threadId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
            )
          : Effect.sleep(subprocessPollIntervalMs),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const sessions = yield* modifyManagerState((state) => [
        [...state.sessions.values()],
        state.lifecycle === "open" ? { ...state, lifecycle: "closing" as const } : state,
      ]);

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        yield* withThreadLock(
          session.threadId,
          Effect.gen(function* () {
            const current = yield* getSession(session.threadId, session.terminalId);
            if (Option.isNone(current) || !current.value.process) return;
            yield* stopProcess(current.value);
          }),
        );
      });

      const cleanupResults = yield* Effect.forEach(
        sessions,
        (session) =>
          cleanupSession(session).pipe(
            Effect.exit,
            Effect.map((exit) => ({ session, exit })),
          ),
        {
          concurrency: "unbounded",
        },
      );

      for (const result of cleanupResults) {
        if (Exit.isSuccess(result.exit)) continue;
        yield* Effect.logWarning("failed to terminate terminal during manager shutdown", {
          threadId: result.session.threadId,
          terminalId: result.session.terminalId,
          cause: result.exit.cause,
        });
      }

      const hasRetainedTerminationWork = yield* modifyManagerState((state) => {
        const sessions = new Map(
          [...state.sessions].filter(
            ([, session]) => session.process !== null || session.processExitDrainsInFlight > 0,
          ),
        );
        const retainedProcesses = new Set(
          [...sessions.values()].flatMap((session) =>
            session.process === null ? [] : [session.process],
          ),
        );
        const terminations = new Map(
          [...state.terminations].filter(([process]) => retainedProcesses.has(process)),
        );
        return [
          retainedProcesses.size > 0 || state.exitDrainsInFlight > 0,
          { ...state, lifecycle: "closed" as const, sessions, terminations },
        ] as const;
      });
      keepTerminationScopeAliveAfterManagerClose = hasRetainedTerminationWork;
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (input: TerminalOpenInput) {
    yield* assertManagerOpen("open");
    const terminalId = input.terminalId;
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.threadId, terminalId);
    const existing = yield* getSession(input.threadId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.threadId, terminalId);
      const history = yield* readHistory(input.threadId, terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        threadId: input.threadId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        processExitDrainsInFlight: 0,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        processGeneration: 0,
        processExit: null,
        exitObservationGapHandled: false,
        owner: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
        persistenceMode: "debounced",
      };

      yield* insertSessionWhileOpen(sessionKey, session, "open");

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    yield* assertSessionOwner(liveSession, undefined);
    if (liveSession.process?.exitObservation.status === "gap") {
      return snapshot(liveSession);
    }
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      yield* stopProcess(liveSession);
      liveSession.cwd = input.cwd;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.history = "";
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    } else if (liveSession.status === "exited" || liveSession.status === "error") {
      liveSession.runtimeEnv = nextRuntimeEnv;
      liveSession.worktreePath = nextWorktreePath;
      liveSession.history = "";
      liveSession.pendingHistoryControlSequence = "";
      liveSession.pendingProcessEvents = [];
      liveSession.pendingProcessEventIndex = 0;
      liveSession.processEventDrainRunning = false;
      yield* persistHistory(liveSession.threadId, liveSession.terminalId, liveSession.history);
    }

    if (!liveSession.process) {
      yield* startSession(
        liveSession,
        {
          threadId: input.threadId,
          terminalId,
          cwd: input.cwd,
          worktreePath: liveSession.worktreePath,
          cols: targetCols,
          rows: targetRows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(liveSession);
    }

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    withThreadLock(input.threadId, openLocked(input));

  const runCommandLocked = Effect.fn("terminal.runCommandLocked")(function* (
    input: TerminalRunCommandInput,
  ) {
    yield* assertManagerOpen("run-command");
    yield* assertValidCwd(input.cwd);
    const existing = yield* getSession(input.threadId, input.terminalId);
    if (Option.isSome(existing)) {
      yield* assertSessionOwner(existing.value, input.owner);
      return snapshot(existing.value);
    }

    const cols = input.cols ?? DEFAULT_OPEN_COLS;
    const rows = input.rows ?? DEFAULT_OPEN_ROWS;
    const session: TerminalSessionState = {
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "starting",
      pid: null,
      history: "",
      pendingHistoryControlSequence: "",
      pendingProcessEvents: [],
      pendingProcessEventIndex: 0,
      processEventDrainRunning: false,
      processExitDrainsInFlight: 0,
      exitCode: null,
      exitSignal: null,
      updatedAt: yield* nowIso,
      eventSequence: 0,
      cols,
      rows,
      process: null,
      processGeneration: 0,
      processExit: null,
      exitObservationGapHandled: false,
      owner: input.owner ?? null,
      unsubscribeData: null,
      unsubscribeExit: null,
      hasRunningSubprocess: false,
      childCommandLabel: null,
      runtimeEnv: normalizedRuntimeEnv(input.env),
      persistenceMode: "on_exit",
    };
    yield* writeHistoryNow(input.threadId, input.terminalId, "");
    yield* insertSessionWhileOpen(
      toSessionKey(input.threadId, input.terminalId),
      session,
      "run-command",
    );
    yield* startSession(
      session,
      {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
        cols,
        rows,
        ...(input.env ? { env: input.env } : {}),
      },
      "started",
      [{ shell: input.command, args: [...(input.args ?? [])] }],
    );
    return snapshot(session);
  });

  const runCommand: TerminalManager["Service"]["runCommand"] = (input) =>
    withThreadLock(input.threadId, runCommandLocked(input));

  const inspectSession: TerminalManager["Service"]["inspectSession"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* getSession(input.threadId, input.terminalId);
        if (Option.isNone(session)) return "missing" as const;
        yield* assertSessionOwner(session.value, input.expectedOwner);
        if (session.value.process?.exitObservation.status === "gap") {
          return "quarantined" as const;
        }
        return session.value.process !== null ? ("active" as const) : ("inactive" as const);
      }),
    );

  const getHistory: TerminalManager["Service"]["getHistory"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        // WorkspaceScriptService.getLogs 依赖此只读入口；owner 门禁只阻止进程与历史 mutation。
        const session = yield* getSession(input.threadId, input.terminalId);
        if (Option.isSome(session)) return session.value.history;
        return yield* readHistory(input.threadId, input.terminalId);
      }),
    );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* assertManagerOpen("attach");
        const terminalId = input.terminalId;
        const existing = yield* getSession(input.threadId, terminalId);

        if (Option.isNone(existing)) {
          if (!input.cwd) {
            return yield* new TerminalSessionLookupError({
              threadId: input.threadId,
              terminalId,
            });
          }

          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        const session = existing.value;
        yield* assertSessionOwner(session, undefined);
        const targetCols = input.cols ?? session.cols;
        const targetRows = input.rows ?? session.rows;

        if (!session.process && input.cwd && input.restartIfNotRunning === true) {
          return yield* openLocked({
            ...input,
            terminalId,
            cwd: input.cwd,
          });
        }

        if (
          session.process &&
          session.status === "running" &&
          (session.cols !== targetCols || session.rows !== targetRows)
        ) {
          const process = session.process;
          yield* resizePtyProcess(session, process, targetCols, targetRows);
          session.cols = targetCols;
          session.rows = targetRows;
          session.updatedAt = yield* nowIso;
        }

        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()]
          .map(summary)
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.threadId.localeCompare(right.threadId) ||
              left.terminalId.localeCompare(right.terminalId),
          ),
      ),
    );

  const readTerminalMetadata = (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.threadId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;
      let synchronizedSnapshot: TerminalSessionSnapshot | null = null;
      let snapshotBoundaryActive = true;

      const shouldSkipSynchronizedEvent = (event: TerminalEvent) => {
        if (
          snapshotBoundaryActive &&
          synchronizedSnapshot !== null &&
          isDuplicateAttachSnapshotEvent(event, synchronizedSnapshot)
        ) {
          return true;
        }

        if (
          synchronizedSnapshot !== null &&
          (event.type === "exited" ||
            event.type === "closed" ||
            (typeof event.sequence === "number" &&
              typeof synchronizedSnapshot.sequence === "number" &&
              event.sequence > synchronizedSnapshot.sequence))
        ) {
          snapshotBoundaryActive = false;
        }
        return false;
      };

      unsubscribe = yield* subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        if (shouldSkipSynchronizedEvent(event)) {
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });
      synchronizedSnapshot = initialSnapshot;

      for (const event of bufferedEvents) {
        if (shouldSkipSynchronizedEvent(event)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    if (event.type === "closed") {
      return Effect.succeed({
        type: "remove" as const,
        threadId: event.threadId,
        terminalId: event.terminalId,
      });
    }

    return readTerminalMetadata({
      threadId: event.threadId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const write: TerminalManager["Service"]["write"] = Effect.fn("terminal.write")(function* (input) {
    yield* assertManagerOpen("write");
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.threadId, terminalId);
    yield* assertSessionOwner(session, undefined);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited") return;
      return yield* new TerminalNotRunningError({
        threadId: input.threadId,
        terminalId,
      });
    }
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          threadId: input.threadId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    yield* assertManagerOpen("resize");
    const session = yield* getSession(input.threadId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    yield* assertSessionOwner(session.value, undefined);
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withThreadLock(input.threadId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* assertManagerOpen("clear");
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.threadId, terminalId);
        yield* assertSessionOwner(session, undefined);
        if (session.process?.exitObservation.status === "gap") {
          yield* failIfExitObservationGap(session, session.process, session.processGeneration);
        }
        session.history = "";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          threadId: input.threadId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* assertManagerOpen("restart");
        yield* increment(terminalRestartsTotal, { scope: "thread" });
        const terminalId = input.terminalId;
        yield* assertValidCwd(input.cwd);

        const sessionKey = toSessionKey(input.threadId, terminalId);
        const existingSession = yield* getSession(input.threadId, terminalId);
        let session: TerminalSessionState;
        if (Option.isNone(existingSession)) {
          const cols = input.cols ?? DEFAULT_OPEN_COLS;
          const rows = input.rows ?? DEFAULT_OPEN_ROWS;
          session = {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            status: "starting",
            pid: null,
            history: "",
            pendingHistoryControlSequence: "",
            pendingProcessEvents: [],
            pendingProcessEventIndex: 0,
            processEventDrainRunning: false,
            processExitDrainsInFlight: 0,
            exitCode: null,
            exitSignal: null,
            updatedAt: yield* nowIso,
            eventSequence: 0,
            cols,
            rows,
            process: null,
            processGeneration: 0,
            processExit: null,
            exitObservationGapHandled: false,
            owner: null,
            unsubscribeData: null,
            unsubscribeExit: null,
            hasRunningSubprocess: false,
            childCommandLabel: null,
            runtimeEnv: normalizedRuntimeEnv(input.env),
            persistenceMode: "debounced",
          };
          yield* insertSessionWhileOpen(sessionKey, session, "restart");
          yield* evictInactiveSessionsIfNeeded();
        } else {
          session = existingSession.value;
          yield* assertSessionOwner(session, undefined);
          yield* stopProcess(session);
          session.cwd = input.cwd;
          session.worktreePath = input.worktreePath ?? null;
          session.runtimeEnv = normalizedRuntimeEnv(input.env);
        }

        const cols = input.cols ?? session.cols;
        const rows = input.rows ?? session.rows;

        session.history = "";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        yield* persistHistory(input.threadId, terminalId, session.history);
        yield* startSession(
          session,
          {
            threadId: input.threadId,
            terminalId,
            cwd: input.cwd,
            ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
            cols,
            rows,
            ...(input.env ? { env: input.env } : {}),
          },
          "restarted",
        );
        return snapshot(session);
      }),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* assertManagerOpen("close");
        if (input.terminalId) {
          yield* closeSession(input.threadId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const threadSessions = yield* sessionsForThread(input.threadId);
        // 无 terminalId 的通用清理只处理普通终端；owned session 由对应服务按 owner 终止。
        const ordinarySessions = threadSessions.filter((session) => session.owner === null);
        const hasOwnedSessions = ordinarySessions.length !== threadSessions.length;
        const closeResults = yield* Effect.forEach(
          ordinarySessions,
          (session) =>
            closeSession(
              input.threadId,
              session.terminalId,
              input.deleteHistory === true && hasOwnedSessions,
            ).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );

        for (const result of closeResults) {
          if (Exit.isFailure(result)) {
            return yield* Effect.failCause(result.cause);
          }
        }

        if (input.deleteHistory && !hasOwnedSessions) {
          yield* deleteAllHistoryForThread(input.threadId);
        }
      }),
    );

  const kill: TerminalManager["Service"]["kill"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* requireSession(input.threadId, input.terminalId);
        yield* assertSessionOwner(session, input.expectedOwner);
        if (!session.process) return;
        yield* stopProcess(session);
      }),
    );

  return TerminalManager.of({
    open,
    runCommand,
    getHistory,
    attachStream,
    write,
    resize,
    clear,
    restart,
    close,
    kill,
    inspectSession,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
