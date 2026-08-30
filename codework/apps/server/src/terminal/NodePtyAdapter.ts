import * as NodeModule from "node:module";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";

import * as PtyAdapter from "./PtyAdapter.ts";
import { PtyExitLatch } from "./PtyExitLatch.ts";

export class NodePtyModuleLoadError extends Schema.TaggedErrorClass<NodePtyModuleLoadError>()(
  "NodePtyModuleLoadError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load node-pty for ${this.platform}-${this.architecture}.`;
  }
}

type NodePtyModuleLoader = () => Promise<typeof import("node-pty")>;

let didEnsureSpawnHelperExecutable = false;
const SYNC_EXIT_OBSERVER_ATTEMPTS = 2;

const resolveNodePtySpawnHelperPath = Effect.gen(function* () {
  const requireForNodePty = NodeModule.createRequire(import.meta.url);
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const packageJsonPath = requireForNodePty.resolve("node-pty/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const candidates = [
    path.join(packageDir, "build", "Release", "spawn-helper"),
    path.join(packageDir, "build", "Debug", "spawn-helper"),
    path.join(packageDir, "prebuilds", `${platform}-${architecture}`, "spawn-helper"),
  ];

  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}).pipe(Effect.orElseSucceed(() => null));

const ensureNodePtySpawnHelperExecutable = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcessPlatform;
  if (platform === "win32") return;
  if (didEnsureSpawnHelperExecutable) return;

  const helperPath = yield* resolveNodePtySpawnHelperPath;
  if (!helperPath) return;
  didEnsureSpawnHelperExecutable = true;

  if (!(yield* fs.exists(helperPath))) {
    return;
  }

  // Best-effort: avoid FileSystem.stat in packaged mode where some fs metadata can be missing.
  yield* fs.chmod(helperPath, 0o755).pipe(Effect.orElseSucceed(() => undefined));
});

class NodePtyProcess implements PtyAdapter.PtyProcess {
  private readonly process: import("node-pty").IPty;
  private readonly exitLatch = new PtyExitLatch();
  private exitObserverInstalled = false;
  private exitObserverAcquisitionError: PtyAdapter.PtyProcessListenerRegistrationError | null =
    null;
  private exitObservationGapError: PtyAdapter.PtyProcessListenerRegistrationError | null = null;

  constructor(process: import("node-pty").IPty) {
    this.process = process;
    for (let attempt = 0; attempt < SYNC_EXIT_OBSERVER_ATTEMPTS; attempt += 1) {
      try {
        this.installExitObserver();
        return;
      } catch (cause) {
        if (!this.exitLatch.exited) {
          this.exitObserverAcquisitionError = new PtyAdapter.PtyProcessListenerRegistrationError({
            listener: "exit",
            terminalPid: this.process.pid,
            cause,
          });
        }
      }
    }
    this.exitObservationGapError = this.exitObserverAcquisitionError;
  }

  get pid(): number {
    return this.process.pid;
  }

  get exitObservation(): PtyAdapter.PtyExitObservation {
    if (this.exitLatch.exited || !this.exitObservationGapError) {
      return { status: "reliable" };
    }
    return { status: "gap", cause: this.exitObservationGapError };
  }

  write(data: string): void {
    this.process.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.process.kill(signal);
  }

  onData(callback: (data: string) => void): () => void {
    if (this.exitObservation.status === "gap") {
      throw this.exitObservation.cause;
    }
    if (this.exitObserverAcquisitionError) {
      throw this.exitObserverAcquisitionError;
    }
    const disposable = this.process.onData(callback);
    return () => {
      disposable.dispose();
    };
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    if (!this.exitLatch.exited && !this.exitObserverInstalled) {
      try {
        this.installExitObserver();
      } catch (cause) {
        this.exitObserverAcquisitionError = new PtyAdapter.PtyProcessListenerRegistrationError({
          listener: "exit",
          terminalPid: this.process.pid,
          cause,
        });
        throw this.exitObserverAcquisitionError;
      }
    }
    return this.exitLatch.subscribe(callback);
  }

  private installExitObserver(): void {
    this.process.onExit((event) => {
      this.exitLatch.emit({
        exitCode: event.exitCode,
        signal: event.signal ?? null,
      });
    });
    this.exitObserverInstalled = true;
    this.exitObserverAcquisitionError = null;
  }
}

export const make = Effect.fn("NodePtyAdapter.make")(function* (
  loadNodePtyModule: NodePtyModuleLoader = () => import("node-pty"),
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;

  const nodePty = yield* Effect.tryPromise({
    try: loadNodePtyModule,
    catch: (cause) =>
      new NodePtyModuleLoadError({
        platform,
        architecture,
        cause,
      }),
  }).pipe(Effect.orDie);

  const ensureNodePtySpawnHelperExecutableCached = yield* Effect.cached(
    ensureNodePtySpawnHelperExecutable().pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, architecture),
      Effect.orElseSucceed(() => undefined),
    ),
  );

  return PtyAdapter.PtyAdapter.of({
    spawn: Effect.fn("NodePtyAdapter.spawn")(function* (input) {
      yield* ensureNodePtySpawnHelperExecutableCached;
      // node-pty only writes `name` into the child's TERM on the Unix path;
      // the ConPTY path leaves the environment untouched, so Windows children
      // inherit a missing or 16-color TERM unless it is set here.
      const env =
        platform === "win32" && input.env["TERM"] === undefined
          ? { ...input.env, TERM: "xterm-256color" }
          : input.env;
      const ptyProcess = yield* Effect.try({
        try: () =>
          nodePty.spawn(input.shell, input.args ?? [], {
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            env,
            name: "xterm-256color",
          }),
        catch: (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "node-pty",
            shell: input.shell,
            cause,
          }),
      });
      return new NodePtyProcess(ptyProcess);
    }),
  });
});

export const layer = Layer.effect(PtyAdapter.PtyAdapter, make());
