import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { ServerConfig } from "../config.ts";
import { ProcessRunner, layer as processRunnerLayer } from "../processRunner.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

/**
 * Provider-derived long-lived helper processes (session transports, helper
 * servers) register their pid + command + platform identity here. On server
 * startup `reapStale` reconciles the ledger: dead pids drop their record,
 * records whose pid was reused by a different process drop the record without
 * killing, and surviving leftovers from a previous server run are terminated.
 *
 * Mirrors the managed-process registry contract in the Paseo reference (see
 * docs/internals/agent-adapter-reference-comparison.md §2.2-7). Records are
 * one JSON file per process under `<stateDir>/managed-processes/`.
 */

const MANAGED_PROCESS_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
// `ps -o lstart` emits a fixed-width 24-char ctime stamp, e.g. "Sat Jun 20 10:30:40 2026".
const POSIX_LSTART_WIDTH = 24;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const EXIT_POLL_INTERVAL_MS = 50;

export const ManagedProcessOwner = Schema.Struct({
  provider: Schema.String,
  kind: Schema.String,
});
export type ManagedProcessOwner = typeof ManagedProcessOwner.Type;

export const ManagedProcessRecord = Schema.Struct({
  id: Schema.String,
  owner: ManagedProcessOwner,
  pid: Schema.Int,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  identity: Schema.Struct({
    commandLine: Schema.NullOr(Schema.String),
    startedAt: Schema.NullOr(Schema.String),
  }),
  createdAt: Schema.String,
});
export type ManagedProcessRecord = typeof ManagedProcessRecord.Type;

const ManagedProcessRecordJson = Schema.fromJsonString(ManagedProcessRecord);

export class ManagedProcessError extends Schema.TaggedErrorClass<ManagedProcessError>()(
  "ManagedProcessError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

export interface ManagedProcessRecordInput {
  readonly owner: ManagedProcessOwner;
  readonly pid: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ManagedProcessSnapshot {
  readonly pid: number;
  readonly commandLine: string | null;
  readonly startedAt: string | null;
}

export type ManagedProcessInspection =
  | { readonly _tag: "alive"; readonly snapshot: ManagedProcessSnapshot }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "error"; readonly error: unknown };

export interface ManagedProcessTable {
  readonly inspect: (pid: number) => Effect.Effect<ManagedProcessInspection>;
}

export interface ManagedProcessReapResult {
  readonly checked: number;
  readonly dead: number;
  readonly mismatched: number;
  readonly removed: number;
  readonly terminated: number;
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export class ManagedProcessRegistry extends Context.Service<
  ManagedProcessRegistry,
  {
    readonly record: (
      input: ManagedProcessRecordInput,
    ) => Effect.Effect<ManagedProcessRecord, ManagedProcessError>;
    readonly remove: (id: string) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<
      ReadonlyArray<ManagedProcessRecord>,
      PlatformError.PlatformError
    >;
    readonly reapStale: () => Effect.Effect<ManagedProcessReapResult, PlatformError.PlatformError>;
  }
>()("codework/process/ManagedProcessRegistry") {}

const normalizeCommandLine = (commandLine: string): string =>
  commandLine.replace(/\s+/g, " ").trim().toLowerCase();

const commandNameOf = (command: string): string =>
  command.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? command.toLowerCase();

const commandLineMatchesRecord = (record: ManagedProcessRecord, commandLine: string): boolean => {
  // Require the command name and args as one contiguous run, not scattered
  // tokens. Without exact process identity (lstart), a reused PID whose
  // command line merely mentions the same words must not be mistaken for our
  // leftover and killed.
  const signature = [commandNameOf(record.command), ...record.args]
    .map((token) => token.toLowerCase())
    .join(" ");
  return normalizeCommandLine(commandLine).includes(signature);
};

const processIdentityMatches = (
  record: ManagedProcessRecord,
  snapshot: ManagedProcessSnapshot,
): boolean => {
  if (record.identity.startedAt !== null && snapshot.startedAt !== null) {
    if (record.identity.startedAt !== snapshot.startedAt) return false;
    return snapshot.commandLine !== null
      ? commandLineMatchesRecord(record, snapshot.commandLine)
      : true;
  }
  if (record.identity.commandLine !== null && snapshot.commandLine !== null) {
    return (
      normalizeCommandLine(record.identity.commandLine) ===
      normalizeCommandLine(snapshot.commandLine)
    );
  }
  return snapshot.commandLine !== null
    ? commandLineMatchesRecord(record, snapshot.commandLine)
    : false;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const waitForExit = (pid: number, timeoutMs: number) =>
  Effect.gen(function* () {
    const attempts = Math.ceil(timeoutMs / EXIT_POLL_INTERVAL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isProcessAlive(pid)) return true;
      yield* Effect.sleep(EXIT_POLL_INTERVAL_MS);
    }
    return !isProcessAlive(pid);
  });

const signalProcess = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  });

export interface ManagedProcessRegistryDeps {
  readonly directory: string;
  readonly table: ManagedProcessTable;
  readonly fileSystem: Context.Service.Shape<typeof FileSystem.FileSystem>;
  readonly path: Context.Service.Shape<typeof Path.Path>;
  readonly terminate: (pid: number) => Effect.Effect<void>;
}

const WindowsProcessSnapshotJson = Schema.fromJsonString(
  Schema.Struct({
    CommandLine: Schema.optional(Schema.NullOr(Schema.String)),
    CreationDate: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeWindowsProcessSnapshot = Schema.decodeUnknownEffect(WindowsProcessSnapshotJson);

export const makeManagedProcessTable = (deps: {
  readonly platform: NodeJS.Platform;
  readonly runner: ProcessRunner["Service"];
}): ManagedProcessTable => {
  const inspectPosix = (pid: number) =>
    deps.runner
      .run({
        command: "ps",
        args: ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
      })
      .pipe(
        Effect.map((output): ManagedProcessInspection => {
          const line = output.stdout.trimEnd();
          // `ps -p <pid>` prints nothing when no process matches; a spawn/read
          // failure reaches inspect() through the error channel instead.
          if (line.length === 0) return { _tag: "not-found" };
          const startedAt = line.slice(0, POSIX_LSTART_WIDTH).trim();
          const commandLine = line.slice(POSIX_LSTART_WIDTH).trim();
          return {
            _tag: "alive",
            snapshot: {
              pid,
              commandLine: commandLine.length > 0 ? commandLine : null,
              startedAt: startedAt.length > 0 ? startedAt : null,
            },
          };
        }),
        Effect.catch((error) =>
          Effect.succeed({ _tag: "error", error } satisfies ManagedProcessInspection),
        ),
      );

  const inspectWindows = (pid: number) =>
    Effect.gen(function* () {
      const psCommand = [
        `$process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';`,
        "if ($process) { $process | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress }",
      ].join(" ");
      const output = yield* deps.runner.run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", psCommand],
      });
      const trimmed = output.stdout.trim();
      if (trimmed.length === 0) return { _tag: "not-found" } as const;
      const record = yield* decodeWindowsProcessSnapshot(trimmed);
      return {
        _tag: "alive",
        snapshot: {
          pid,
          commandLine: record.CommandLine ?? null,
          startedAt: record.CreationDate ?? null,
        },
      } as const;
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({ _tag: "error", error } satisfies ManagedProcessInspection),
      ),
    );

  return {
    inspect: (pid) =>
      !Number.isInteger(pid) || pid <= 0
        ? Effect.succeed({ _tag: "not-found" } satisfies ManagedProcessInspection)
        : deps.platform === "win32"
          ? inspectWindows(pid)
          : inspectPosix(pid),
  };
};

const makeTerminateByPid = (deps: {
  readonly platform: NodeJS.Platform;
  readonly runner: ProcessRunner["Service"];
}): ((pid: number) => Effect.Effect<void>) => {
  if (deps.platform === "win32") {
    // taskkill /t covers the helper's child processes too (cmd shim trees).
    return (pid) =>
      deps.runner.run({ command: "taskkill.exe", args: ["/pid", String(pid), "/t", "/f"] }).pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
      );
  }
  return (pid) =>
    Effect.gen(function* () {
      if (!isProcessAlive(pid)) return;
      // Signal the process group first: detached helpers (e.g. `opencode
      // serve`) lead their own group, and members must not outlive the reap.
      // `kill(-pid)` no-ops harmlessly when no group exists; the plain-pid
      // signal then covers non-detached leftovers.
      yield* signalProcess(-pid, "SIGTERM");
      yield* signalProcess(pid, "SIGTERM");
      if (yield* waitForExit(pid, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;
      yield* signalProcess(-pid, "SIGKILL");
      yield* signalProcess(pid, "SIGKILL");
      yield* waitForExit(pid, FORCE_SHUTDOWN_TIMEOUT_MS);
    });
};

export const makeManagedProcessRegistry = (deps: ManagedProcessRegistryDeps) => {
  const { directory, table, fileSystem, path, terminate } = deps;
  const encodeRecord = Schema.encodeEffect(ManagedProcessRecordJson);
  const decodeRecord = Schema.decodeUnknownEffect(ManagedProcessRecordJson);

  const recordPath = (id: string): string => {
    if (!MANAGED_PROCESS_ID_PATTERN.test(id)) {
      throw new ManagedProcessError({
        operation: "recordPath",
        detail: `Invalid managed process record id: ${id}`,
      });
    }
    return path.join(directory, `${id}.json`);
  };

  const readEntries = Effect.gen(function* () {
    const fileNames = yield* fileSystem
      .readDirectory(directory)
      .pipe(
        Effect.catch((error) =>
          error._tag === "PlatformError" && error.reason._tag === "NotFound"
            ? Effect.succeed([] as ReadonlyArray<string>)
            : Effect.fail(error),
        ),
      );
    const entries: Array<{ readonly filePath: string; readonly record: ManagedProcessRecord }> = [];
    for (const fileName of fileNames) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = path.join(directory, fileName);
      const read = yield* Effect.exit(
        fileSystem.readFileString(filePath).pipe(Effect.flatMap(decodeRecord)),
      );
      if (read._tag === "Failure") {
        // A single corrupt or partially-written record must not abort the
        // whole reconcile and leave every other leftover un-reaped. Skip it.
        yield* Effect.logWarning("skipping unreadable managed process record", {
          filePath,
          cause: read.cause,
        });
        continue;
      }
      entries.push({ filePath, record: read.value });
    }
    return entries;
  });

  const record: ManagedProcessRegistry["Service"]["record"] = (input) =>
    Effect.gen(function* () {
      if (!Number.isInteger(input.pid) || input.pid <= 0) {
        return yield* new ManagedProcessError({
          operation: "record",
          detail: `Refusing to record managed process with invalid pid ${input.pid}`,
        });
      }
      const inspection = yield* table.inspect(input.pid);
      const snapshot = inspection._tag === "alive" ? inspection.snapshot : null;
      const record: ManagedProcessRecord = {
        id: NodeCrypto.randomUUID(),
        owner: input.owner,
        pid: input.pid,
        command: input.command,
        args: [...input.args],
        metadata: input.metadata ?? {},
        identity: {
          commandLine: snapshot?.commandLine ?? null,
          startedAt: snapshot?.startedAt ?? null,
        },
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      const contents = yield* encodeRecord(record).pipe(
        Effect.mapError(
          (error) =>
            new ManagedProcessError({ operation: "record", detail: String(error.issue ?? error) }),
        ),
      );
      yield* writeFileStringAtomically({
        filePath: recordPath(record.id),
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (error) => new ManagedProcessError({ operation: "record", detail: String(error) }),
        ),
      );
      return record;
    });

  const remove: ManagedProcessRegistry["Service"]["remove"] = (id) =>
    fileSystem.remove(recordPath(id), { force: true }).pipe(Effect.catch(() => Effect.void));

  const list: ManagedProcessRegistry["Service"]["list"] = () =>
    readEntries.pipe(Effect.map((entries) => entries.map((entry) => entry.record)));

  const reapStale: ManagedProcessRegistry["Service"]["reapStale"] = () =>
    Effect.gen(function* () {
      const result: {
        checked: number;
        dead: number;
        mismatched: number;
        removed: number;
        terminated: number;
        errors: Array<{ id: string; message: string }>;
      } = { checked: 0, dead: 0, mismatched: 0, removed: 0, terminated: 0, errors: [] };

      for (const entry of yield* readEntries) {
        result.checked += 1;
        const inspection = yield* table.inspect(entry.record.pid);
        if (inspection._tag === "not-found") {
          yield* remove(entry.record.id);
          result.dead += 1;
          result.removed += 1;
          continue;
        }
        if (inspection._tag === "error") {
          // Inspection failed, so we cannot tell whether the helper is still
          // alive. Keep the record and retry on the next reconcile rather
          // than orphaning a live process by deleting its record unchecked.
          const message =
            inspection.error instanceof Error ? inspection.error.message : String(inspection.error);
          result.errors.push({ id: entry.record.id, message });
          yield* Effect.logWarning(
            "could not inspect managed helper process; leaving record for next reconcile",
            {
              id: entry.record.id,
              pid: entry.record.pid,
              owner: entry.record.owner,
              error: inspection.error,
            },
          );
          continue;
        }
        if (!processIdentityMatches(entry.record, inspection.snapshot)) {
          yield* remove(entry.record.id);
          result.mismatched += 1;
          result.removed += 1;
          continue;
        }
        const termination = yield* Effect.exit(terminate(entry.record.pid));
        if (termination._tag === "Failure") {
          result.errors.push({ id: entry.record.id, message: String(termination.cause) });
          yield* Effect.logWarning("failed to reap managed helper process", {
            id: entry.record.id,
            pid: entry.record.pid,
            owner: entry.record.owner,
            cause: termination.cause,
          });
          // The record stays when termination could not be observed — the
          // next reconcile retries instead of losing track of a live helper.
          continue;
        }
        result.terminated += 1;
        yield* remove(entry.record.id);
        result.removed += 1;
      }
      return result satisfies ManagedProcessReapResult;
    });

  return Effect.succeed(ManagedProcessRegistry.of({ record, remove, list, reapStale }));
};

/**
 * Register a freshly spawned provider helper for cross-restart reconcile.
 * Returns None when the registry is not in scope or the record cannot be
 * written — registration must never fail a spawn.
 */
export const recordSpawnedChild = (input: ManagedProcessRecordInput) =>
  !Number.isInteger(input.pid) || input.pid <= 0
    ? Effect.succeed(Option.none<ManagedProcessRecord>())
    : Effect.serviceOption(ManagedProcessRegistry).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<ManagedProcessRecord>()),
            onSome: (registry) =>
              registry.record(input).pipe(
                Effect.map(Option.some),
                Effect.catch((error) =>
                  Effect.logWarning("failed to record managed helper process", {
                    pid: input.pid,
                    owner: input.owner,
                    error,
                  }).pipe(Effect.as(Option.none<ManagedProcessRecord>())),
                ),
              ),
          }),
        ),
      );

/** Remove a record when its process exits normally; never fails. */
export const removeManagedRecord = (record: ManagedProcessRecord) =>
  Effect.serviceOption(ManagedProcessRegistry).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (registry) => registry.remove(record.id),
      }),
    ),
  );

export const layer = Layer.effect(
  ManagedProcessRegistry,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const directory = path.join(config.stateDir, "managed-processes");
    const table = makeManagedProcessTable({ platform, runner });
    const terminate = makeTerminateByPid({ platform, runner });
    return yield* makeManagedProcessRegistry({ directory, table, fileSystem, path, terminate });
  }),
).pipe(Layer.provide(processRunnerLayer));
