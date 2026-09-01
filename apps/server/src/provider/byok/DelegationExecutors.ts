import type { ByokDelegationConfig, ByokDelegationExecutor } from "@codework/contracts";

/**
 * Executor registry primitives for delegation (original cursor-byok
 * executor-registry parity, adapted to codework's command-line executors):
 * candidate normalization/ordering, availability probing, switchable-failure
 * classification and the probe cache / cooldown registry.
 *
 * Pure logic lives here; process spawning stays in ByokDelegationService so
 * every branch is unit-testable without a real child process.
 */

export const DEFAULT_EXECUTOR_ID = "default";
export const DEFAULT_EXECUTOR_FAILOVER_LIMIT = 3;
export const MAX_EXECUTOR_FAILOVER_LIMIT = 5;
export const EXECUTOR_PROBE_CACHE_TTL_MS = 30_000;
export const EXECUTOR_FAILURE_COOLDOWN_MS = 30_000;
export const EXECUTOR_PROBE_TIMEOUT_MS = 5_000;
/** Snapshot attempts stay bounded regardless of candidate count. */
export const MAX_EXECUTOR_ATTEMPT_ROWS = 5;
export const EXECUTOR_DIAGNOSTIC_PREVIEW_MAX_CHARS = 160;

const EXECUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9-_.]*$/;

export const isValidExecutorId = (value: string): boolean => EXECUTOR_ID_PATTERN.test(value);

export const clampFailoverLimit = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value)
    ? DEFAULT_EXECUTOR_FAILOVER_LIMIT
    : Math.max(1, Math.min(MAX_EXECUTOR_FAILOVER_LIMIT, Math.trunc(value)));

const normalizePriority = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

/**
 * Drop rows with invalid/reserved ids or empty commands, clamp priorities and
 * dedupe by id (first wins). Reserved id: the synthetic legacy executor.
 */
export const normalizeExecutors = (
  executors: ReadonlyArray<ByokDelegationExecutor>,
): ByokDelegationExecutor[] => {
  const seen = new Set<string>([DEFAULT_EXECUTOR_ID]);
  const normalized: ByokDelegationExecutor[] = [];
  for (const executor of executors) {
    const id = executor.id.trim().toLowerCase();
    if (!isValidExecutorId(id) || seen.has(id)) continue;
    const command = executor.command.trim();
    if (command.length === 0) continue;
    seen.add(id);
    normalized.push({
      id,
      name: executor.name.trim(),
      enabled: executor.enabled !== false,
      priority: normalizePriority(executor.priority),
      command,
      environmentVariables: executor.environmentVariables.filter((name) => name.trim().length > 0),
      probeArguments: executor.probeArguments.trim(),
    });
  }
  return normalized;
};

/**
 * Enabled candidates in execution order: priority ascending (smaller first),
 * id ascending on ties. The legacy single `executorCommand` participates as
 * the synthetic `default` executor so existing configs keep working unchanged
 * while additional candidates become its failover backups.
 */
export const effectiveExecutorList = (
  config: ByokDelegationConfig,
): ReadonlyArray<ByokDelegationExecutor> => {
  const candidates = normalizeExecutors(config.executors ?? []);
  const legacyCommand = config.executorCommand.trim();
  if (legacyCommand.length > 0) {
    candidates.push({
      id: DEFAULT_EXECUTOR_ID,
      name: "",
      enabled: true,
      priority: 100,
      command: legacyCommand,
      environmentVariables: [...(config.executorEnvironmentVariables ?? [])],
      probeArguments: "",
    });
  }
  return candidates
    .filter((executor) => executor.enabled)
    .sort((left, right) =>
      left.priority === right.priority
        ? left.id.localeCompare(right.id)
        : left.priority - right.priority,
    );
};

export type ExecutorFailureKind = "not_found" | "spawn_failed" | "exit_nonzero" | "cancelled";

/**
 * Typed executor failure. `not_found`/`spawn_failed`/`exit_nonzero` are
 * switchable (failover may try the next candidate); `cancelled` is terminal —
 * the user or the execution timeout stopped the delegation on purpose.
 */
export class ExecutorAttemptError extends Error {
  readonly kind: ExecutorFailureKind;
  readonly exitCode: number | undefined;

  constructor(kind: ExecutorFailureKind, message: string, exitCode?: number) {
    super(message);
    this.name = "ExecutorAttemptError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export const isSwitchableExecutorFailure = (error: unknown): boolean =>
  error instanceof ExecutorAttemptError && error.kind !== "cancelled";

export const isExecutorCancellation = (error: unknown): boolean =>
  error instanceof ExecutorAttemptError && error.kind === "cancelled";

export type ExecutorProbeState = "ready" | "not_installed" | "unhealthy" | "unknown";

export type ExecutorProbeOutcome = {
  readonly state: ExecutorProbeState;
  readonly diagnosticCode?: string;
  readonly diagnosticPreview?: string;
};

export const diagnosticPreview = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length <= EXECUTOR_DIAGNOSTIC_PREVIEW_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, EXECUTOR_DIAGNOSTIC_PREVIEW_MAX_CHARS);
};

/**
 * Resolve an executable name to an existing file without running it — the
 * safe default probe for arbitrary commands (cursor-byok's custom-executor
 * probe without version arguments). Platform specifics are injected so tests
 * are deterministic across host OSes.
 */
export const resolveExecutablePath = (
  executable: string,
  options: {
    readonly platform: NodeJS.Platform;
    readonly paths: readonly string[];
    readonly pathExt: readonly string[];
    readonly exists: (path: string) => boolean;
  },
): string | undefined => {
  const hasDirectoryPart = /[\\/]/.test(executable);
  const extensions =
    options.platform === "win32" && !/\.[A-Za-z0-9]+$/.test(executable)
      ? ["", ...options.pathExt]
      : [""];
  const directories = hasDirectoryPart ? [""] : [...options.paths, ""];
  for (const directory of directories) {
    const joined =
      directory.length === 0
        ? executable
        : `${directory}${options.platform === "win32" ? "\\" : "/"}${executable}`;
    for (const extension of extensions) {
      const candidate = `${joined}${extension}`;
      if (options.exists(candidate)) return candidate;
    }
  }
  return undefined;
};

/** Interpret a version-command probe run (cursor-byok ProbeCLI semantics). */
export const probeFromVersionRun = (outcome: {
  readonly failureKind?: ExecutorFailureKind;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
}): ExecutorProbeOutcome => {
  if (outcome.failureKind === "not_found") return { state: "not_installed" };
  if (outcome.failureKind !== undefined) {
    return { state: "unhealthy", diagnosticCode: "spawn_failed" };
  }
  if (outcome.exitCode !== 0) {
    return {
      state: "unhealthy",
      diagnosticCode: "probe_failed",
      diagnosticPreview: diagnosticPreview(outcome.stderr || outcome.stdout),
    };
  }
  const version = (outcome.stdout || outcome.stderr).trim();
  if (version.length === 0) {
    return { state: "unhealthy", diagnosticCode: "version_missing" };
  }
  return { state: "ready", diagnosticPreview: diagnosticPreview(version.split(/\r?\n/)[0] ?? "") };
};

type RegistryEntry = {
  readonly fingerprint: string;
  outcome?: ExecutorProbeOutcome;
  probedAt?: number;
  expiresAt: number;
  inFlight?: Promise<ExecutorProbeOutcome> | undefined;
};

const executorFingerprint = (executor: ByokDelegationExecutor): string =>
  JSON.stringify([executor.command, executor.probeArguments, executor.environmentVariables]);

/**
 * Per-instance probe registry: 30s result cache, single-flight probes and a
 * 30s cooldown after switchable failures so a broken executor does not absorb
 * every delegation attempt.
 */
export class ExecutorProbeRegistry {
  private readonly probeFn: (executor: ByokDelegationExecutor) => Promise<ExecutorProbeOutcome>;
  private readonly now: () => number;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly cooldowns = new Map<string, { until: number; fingerprint: string }>();

  constructor(
    probeFn: (executor: ByokDelegationExecutor) => Promise<ExecutorProbeOutcome>,
    now: () => number = Date.now,
  ) {
    this.probeFn = probeFn;
    this.now = now;
  }

  async probe(
    executor: ByokDelegationExecutor,
    options: { readonly force?: boolean } = {},
  ): Promise<ExecutorProbeOutcome & { readonly probedAt: number }> {
    const fingerprint = executorFingerprint(executor);
    const at = this.now();
    let entry = this.entries.get(executor.id);
    if (entry === undefined || entry.fingerprint !== fingerprint) {
      entry = { fingerprint, expiresAt: 0 };
      this.entries.set(executor.id, entry);
    }
    if (
      options.force !== true &&
      entry.outcome !== undefined &&
      at < entry.expiresAt
    ) {
      return { ...entry.outcome, probedAt: entry.probedAt ?? at };
    }
    if (entry.inFlight !== undefined) {
      const outcome = await entry.inFlight;
      return { ...outcome, probedAt: entry.probedAt ?? at };
    }
    const inFlight = this.probeFn(executor)
      .then((outcome) => {
        const settledAt = this.now();
        const current = this.entries.get(executor.id);
        if (current !== undefined && current.fingerprint === fingerprint) {
          current.outcome = outcome;
          current.probedAt = settledAt;
          current.expiresAt = settledAt + EXECUTOR_PROBE_CACHE_TTL_MS;
        }
        return outcome;
      })
      .finally(() => {
        const current = this.entries.get(executor.id);
        if (current?.inFlight === inFlight) current.inFlight = undefined;
      });
    entry.inFlight = inFlight;
    const outcome = await inFlight;
    return { ...outcome, probedAt: entry.probedAt ?? this.now() };
  }

  recordFailure(executor: ByokDelegationExecutor): void {
    this.cooldowns.set(executor.id, {
      until: this.now() + EXECUTOR_FAILURE_COOLDOWN_MS,
      fingerprint: executorFingerprint(executor),
    });
  }

  recordSuccess(executor: ByokDelegationExecutor): void {
    this.cooldowns.delete(executor.id);
  }

  /**
   * A failed-over executor rests for a short cooldown before retries. The
   * cooldown is bound to the executor's fingerprint: fixing the command
   * clears it immediately instead of locking the repaired executor out.
   */
  isCoolingDown(executor: ByokDelegationExecutor): boolean {
    const cooldown = this.cooldowns.get(executor.id);
    if (cooldown === undefined) return false;
    if (cooldown.fingerprint !== executorFingerprint(executor)) {
      this.cooldowns.delete(executor.id);
      return false;
    }
    return this.now() < cooldown.until;
  }
}
