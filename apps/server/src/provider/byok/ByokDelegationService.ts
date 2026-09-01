// @effect-diagnostics nodeBuiltinImport:off - The scheduler owns cancellable child processes directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import type {
  ByokDelegationCancelRequest,
  ByokDelegationConfig,
  ByokDelegationExecutor,
  ByokDelegationExecutorAttempt,
  ByokDelegationExecutorProbe,
  ByokDelegationSnapshot,
  ByokDelegationSubmitRequest,
  ByokSettings,
  CompositionTaskCancelRequest,
  CompositionTaskCancelResult,
  ServerSettings as ServerSettingsContract,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import {
  cancelProjectedByokDelegationTask,
  isTerminalByokDelegationStatus,
  type ByokDelegationRuntimeCancelResult,
} from "../../composition/CompositionByokDelegationCancel.ts";
import {
  makeByokDelegationProjectionScope,
  projectByokDelegationTransition,
  type ByokDelegationProjectionScope,
  type ByokDelegationProjectionTransition,
} from "../../composition/CompositionByokDelegationProjection.ts";
import { recoverInterruptedByokDelegations } from "../../composition/CompositionByokDelegationSupervisor.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
} from "../../persistence/Services/CompositionTaskStore.ts";
import {
  DelegationScheduler,
  type DelegationExecutionContext,
  type DelegationRequest,
  type DelegationSnapshot,
  type DelegationStatus,
} from "../../orchestration/byokDelegation/DelegationScheduler.ts";
import {
  byokAdapterForModel,
  collectChatText,
  streamChat,
  type ByokEngineError,
} from "../Layers/byokChatClient.ts";
import {
  applySubagentPromptFragment,
  buildSupervisorReviewPrompt,
  INITIAL_SUPERVISION_COUNTERS,
  nextSupervisionAction,
  parseSupervisionDecision,
  resolveSubagentPromptFragment,
  type SupervisionCounters,
} from "./DelegationSupervision.ts";
import {
  clampFailoverLimit,
  ExecutorAttemptError,
  ExecutorProbeRegistry,
  type ExecutorProbeOutcome,
  diagnosticPreview,
  effectiveExecutorList,
  isExecutorCancellation,
  isSwitchableExecutorFailure,
  EXECUTOR_PROBE_TIMEOUT_MS,
  MAX_EXECUTOR_ATTEMPT_ROWS,
  probeFromVersionRun,
  resolveExecutablePath,
} from "./DelegationExecutors.ts";

/** Executor stdout is capped so a runaway command cannot exhaust memory. */
const DELEGATION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Preview lengths keep snapshots bounded and free of large payloads. */
const TASK_PREVIEW_MAX_CHARS = 200;
const RESULT_PREVIEW_MAX_CHARS = 2_000;
/** How many terminal snapshots the live scheduler retains per instance. */
const RETAINED_DELEGATIONS = 50;
/** Failover attempt chains retained for run-history lookups. */
const RETAINED_ATTEMPT_CHAINS = 500;
/** Metadata key threading the attempt-chain bucket through the scheduler. */
const ATTEMPT_KEY_METADATA = "byokDelegationAttemptKey";

interface SchedulerEntry {
  readonly fingerprint: string;
  readonly scheduler: DelegationScheduler<string, string>;
}

interface LiveProjectedDelegation {
  readonly runId: string;
  readonly instanceId: string;
  readonly delegationId: string;
  readonly scheduler: DelegationScheduler<string, string>;
}

const schedulers = new Map<string, SchedulerEntry>();
const liveProjectedDelegations = new Map<string, LiveProjectedDelegation>();
let interruptSweepStarted = false;

/**
 * Failover attempt chains, keyed by the per-submission attempt key and
 * mirrored to delegation ids for run-history lookups. Both maps stay bounded
 * by FIFO eviction; rows themselves are capped by MAX_EXECUTOR_ATTEMPT_ROWS.
 */
const executorAttemptsByKey = new Map<string, ByokDelegationExecutorAttempt[]>();
const attemptKeysByDelegationId = new Map<string, string>();

const rememberAttemptChain = (delegationId: string, attemptKey: string): void => {
  attemptKeysByDelegationId.set(delegationId, attemptKey);
  while (attemptKeysByDelegationId.size > RETAINED_ATTEMPT_CHAINS) {
    const oldest = attemptKeysByDelegationId.keys().next().value;
    if (oldest === undefined) break;
    const key = attemptKeysByDelegationId.get(oldest);
    attemptKeysByDelegationId.delete(oldest);
    if (key !== undefined) executorAttemptsByKey.delete(key);
  }
};

const attemptsForDelegation = (delegationId: string): ByokDelegationExecutorAttempt[] | undefined => {
  const key = attemptKeysByDelegationId.get(delegationId);
  return key === undefined ? undefined : executorAttemptsByKey.get(key);
};

/** Per-instance probe registries: cache, single-flight and failure cooldown. */
const probeRegistries = new Map<string, ExecutorProbeRegistry>();

const probeRegistryFor = (instanceId: string): ExecutorProbeRegistry => {
  const existing = probeRegistries.get(instanceId);
  if (existing !== undefined) return existing;
  const registry = new ExecutorProbeRegistry(probeExecutorCandidate);
  probeRegistries.set(instanceId, registry);
  return registry;
};

/**
 * Availability probe for one candidate (cursor-byok probe parity). With
 * `probeArguments` a short version command runs (5s timeout); without them
 * the executable is only resolved on PATH — nothing is executed.
 */
const probeExecutorCandidate = async (
  executor: ByokDelegationExecutor,
): Promise<ExecutorProbeOutcome> => {
  const tokens = parseExecutorCommand(executor.command);
  if (tokens.length === 0) {
    return { state: "unhealthy", diagnosticCode: "empty_command" };
  }
  const probeArguments = parseExecutorCommand(executor.probeArguments);
  if (probeArguments.length === 0) {
    const resolved = resolveExecutablePath(tokens[0]!, {
      platform: process.platform,
      paths: (process.env["PATH"] ?? "").split(NodePath.delimiter).filter((part) => part.length > 0),
      pathExt: (process.env["PATHEXT"] ?? "")
        .split(NodePath.delimiter)
        .filter((part) => part.length > 0),
      exists: (path) => {
        try {
          return NodeFs.statSync(path).isFile();
        } catch {
          return false;
        }
      },
    });
    return resolved !== undefined ? { state: "ready" } : { state: "not_installed" };
  }
  return new Promise((resolve) => {
    // spawn 的内建 timeout 到点强杀进程：close 事件带信号到达，等价于探测超时。
    const child = NodeChildProcess.spawn(tokens[0]!, [...tokens.slice(1), ...probeArguments], {
      env: buildChildEnv(executor.environmentVariables),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: EXECUTOR_PROBE_TIMEOUT_MS,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (outcome: ExecutorProbeOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(
        probeFromVersionRun({
          failureKind: error.code === "ENOENT" ? "not_found" : "spawn_failed",
          stdout: "",
          stderr: "",
        }),
      );
    });
    child.on("close", (code, signal) => {
      if (signal !== null) {
        settle({ state: "unhealthy", diagnosticCode: "probe_timeout" });
        return;
      }
      settle(probeFromVersionRun({ exitCode: code ?? -1, stdout, stderr }));
    });
  });
};

const DEFAULT_DELEGATION_CONFIG: ByokDelegationConfig = {
  enabled: false,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
};

const configOf = (settings: ServerSettingsContract, instanceId: string): ByokDelegationConfig => {
  const instance =
    settings.providerInstances[instanceId as keyof typeof settings.providerInstances];
  if (instance?.driver !== "byok") return DEFAULT_DELEGATION_CONFIG;
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return DEFAULT_DELEGATION_CONFIG;
  }
  const delegation = (config as Record<string, unknown>)["delegation"];
  if (delegation === null || typeof delegation !== "object" || Array.isArray(delegation)) {
    return DEFAULT_DELEGATION_CONFIG;
  }
  return { ...DEFAULT_DELEGATION_CONFIG, ...(delegation as ByokDelegationConfig) };
};

/**
 * The instance's model adapters, used to resolve supervision/review adapters.
 * Only the adapter list is read — the supervisor sees bounded task/result
 * text, never credentials.
 */
const adaptersOf = (
  settings: ServerSettingsContract,
  instanceId: string,
): ByokSettings["adapters"] => {
  const instance =
    settings.providerInstances[instanceId as keyof typeof settings.providerInstances];
  if (instance?.driver !== "byok") return [];
  const config = instance.config;
  if (config === null || typeof config !== "object" || Array.isArray(config)) return [];
  const adapters = (config as Record<string, unknown>)["adapters"];
  return Array.isArray(adapters) ? (adapters as ByokSettings["adapters"]) : [];
};

const fingerprintOf = (config: ByokDelegationConfig): string =>
  JSON.stringify([
    config.enabled,
    config.maxConcurrency,
    config.queueTimeoutMs,
    config.executionTimeoutMs,
    config.executorCommand,
    config.executorEnvironmentVariables,
    config.executors,
    config.executorFailoverLimit,
  ]);

/**
 * Split an executor command line without a shell. Whitespace separates
 * tokens; double quotes group a token (needed for Windows paths with spaces,
 * e.g. `"C:\Program Files\...\tool.exe" --flag`). No metacharacter ever
 * reaches a shell because none is interpreted.
 */
const parseExecutorCommand = (command: string): readonly string[] => {
  const tokens: string[] = [];
  for (const match of command.trim().matchAll(/"([^"]*)"|(\S+)/g)) {
    const token = match[1] ?? match[2] ?? "";
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
};

/**
 * Build the child environment from the allowlist: only variables the user
 * explicitly named, resolved from the server process environment. Values from
 * settings never reach this map — settings only ever stores the names. A
 * supervision reassign round overrides the routed model per delegation via
 * the scheduler request metadata (still just a model id, never a secret).
 */
const buildChildEnv = (names: readonly string[]): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/**
 * Resolve the model an enabled delegation group routes to: the group's
 * defaultModelId when set, else its first modelId. Model ids reference
 * configured adapters and are not secret.
 */
export function resolveDelegationModel(config: ByokDelegationConfig): string | undefined {
  const group = config.modelGroups.find((candidate) => candidate.enabled);
  if (group === undefined) return undefined;
  return group.defaultModelId ?? group.modelIds[0];
}

const runExecutorCandidate = (
  request: DelegationRequest<string>,
  context: DelegationExecutionContext,
  candidate: ByokDelegationExecutor,
  config: ByokDelegationConfig,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const tokens = parseExecutorCommand(candidate.command);
    if (tokens.length === 0) {
      reject(new ExecutorAttemptError("spawn_failed", "No executor command is configured."));
      return;
    }
    const childEnv = buildChildEnv(candidate.environmentVariables);
    const metadataModel = request.metadata?.["byokDelegationModel"];
    const delegationModel =
      typeof metadataModel === "string" && metadataModel.trim().length > 0
        ? metadataModel.trim()
        : resolveDelegationModel(config);
    if (delegationModel !== undefined) {
      childEnv["BYOK_DELEGATION_MODEL"] = delegationModel;
    }
    const child = NodeChildProcess.spawn(tokens[0]!, tokens.slice(1), {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const onAbort = () => {
      killed = true;
      child.kill();
    };
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < DELEGATION_MAX_OUTPUT_BYTES) {
        stdout += chunk.toString("utf8").slice(0, DELEGATION_MAX_OUTPUT_BYTES - stdout.length);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < TASK_PREVIEW_MAX_CHARS) {
        stderr += chunk.toString("utf8").slice(0, TASK_PREVIEW_MAX_CHARS - stderr.length);
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      context.signal.removeEventListener("abort", onAbort);
      reject(
        new ExecutorAttemptError(
          error.code === "ENOENT" ? "not_found" : "spawn_failed",
          `Executor "${candidate.id}" failed to start: ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      context.signal.removeEventListener("abort", onAbort);
      if (killed || context.signal.aborted) {
        reject(new ExecutorAttemptError("cancelled", "Executor was cancelled."));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const diagnostic = stderr.trim();
      reject(
        new ExecutorAttemptError(
          "exit_nonzero",
          `Executor "${candidate.id}" exited with code ${code ?? "unknown"}.${
            diagnostic.length > 0 ? ` ${diagnostic}` : ""
          }`,
          code ?? undefined,
        ),
      );
    });

    child.stdin.on("error", () => {
      // Executor closed stdin early (e.g. prompt-only CLIs); the write below
      // failing is fine, execution continues.
    });
    child.stdin.end(request.input);
  });

/**
 * Run one delegation across the enabled executor candidates: candidates in
 * priority order, probing availability first (skipping not-installed /
 * cooling-down ones without consuming the budget), and failing over to the
 * next candidate on switchable failures — up to `executorFailoverLimit`
 * executions per delegation (original failover parity). Cancellations and
 * timeouts are terminal: they never switch executors.
 */
const runExecutorWithFailover = async (
  request: DelegationRequest<string>,
  context: DelegationExecutionContext,
  config: ByokDelegationConfig,
  registry: ExecutorProbeRegistry,
  instanceId: string,
): Promise<string> => {
  const candidates = effectiveExecutorList(config);
  if (candidates.length === 0) {
    throw new Error("No executor command is configured.");
  }
  const budget = Math.min(clampFailoverLimit(config.executorFailoverLimit), candidates.length);
  const attempts: ByokDelegationExecutorAttempt[] = [];
  let lastError: unknown;
  let executions = 0;
  for (const candidate of candidates) {
    if (executions >= budget) break;
    if (registry.isCoolingDown(candidate)) {
      attempts.push({
        executorId: candidate.id,
        status: "skipped",
        diagnosticPreview: "cooldown",
      });
      continue;
    }
    const probe = await registry.probe(candidate).catch(() => undefined);
    if (probe !== undefined && (probe.state === "not_installed" || probe.state === "unhealthy")) {
      attempts.push({
        executorId: candidate.id,
        status: "skipped",
        diagnosticPreview: probe.diagnosticCode ?? probe.state,
      });
      continue;
    }
    executions += 1;
    try {
      const result = await runExecutorCandidate(request, context, candidate, config);
      registry.recordSuccess(candidate);
      attempts.push({ executorId: candidate.id, status: "completed" });
      executorAttemptsByKey.set(String(request.metadata?.[ATTEMPT_KEY_METADATA] ?? ""), [
        ...attempts.slice(-MAX_EXECUTOR_ATTEMPT_ROWS),
      ]);
      return result;
    } catch (error) {
      lastError = error;
      if (isExecutorCancellation(error)) throw error;
      if (isSwitchableExecutorFailure(error)) {
        registry.recordFailure(candidate);
        attempts.push({
          executorId: candidate.id,
          status: "failed",
          diagnosticPreview: diagnosticPreview(
            error instanceof Error ? error.message : String(error),
          ),
        });
        continue;
      }
      throw error;
    }
  }
  executorAttemptsByKey.set(String(request.metadata?.[ATTEMPT_KEY_METADATA] ?? ""), [
    ...attempts.slice(-MAX_EXECUTOR_ATTEMPT_ROWS),
  ]);
  if (lastError instanceof Error) throw lastError;
  throw new Error(`No eligible delegation executor for instance "${instanceId}".`);
};

const preview = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

const failedSnapshot = (
  input: { readonly task: string },
  errorCode: string,
  errorMessage: string,
): ByokDelegationSnapshot => ({
  id: `delegation-error-${errorCode.toLowerCase()}`,
  status: "failed",
  taskPreview: preview(input.task, 200),
  errorCode,
  errorMessage: preview(errorMessage, 200),
  submittedAt: 0,
});

const toSnapshot = (snapshot: DelegationSnapshot<string, string>): ByokDelegationSnapshot => ({
  id: snapshot.id,
  status: snapshot.status,
  taskPreview: preview(snapshot.request.input, TASK_PREVIEW_MAX_CHARS),
  ...(snapshot.result !== undefined
    ? { resultPreview: preview(snapshot.result, RESULT_PREVIEW_MAX_CHARS) }
    : {}),
  ...(snapshot.error !== undefined
    ? {
        errorCode: snapshot.error.code ?? snapshot.error.name,
        errorMessage: preview(snapshot.error.message, TASK_PREVIEW_MAX_CHARS),
      }
    : {}),
  submittedAt: snapshot.submittedAt,
  ...(snapshot.startedAt !== undefined ? { startedAt: snapshot.startedAt } : {}),
  ...(snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {}),
  ...attemptsToSnapshot(snapshot.id),
});

/** Attach the recorded failover attempt chain, when one exists. */
const attemptsToSnapshot = (
  delegationId: string,
): { readonly executorAttempts: readonly ByokDelegationExecutorAttempt[] } | {} => {
  const attempts = attemptsForDelegation(delegationId);
  return attempts === undefined || attempts.length === 0
    ? {}
    : { executorAttempts: [...attempts] };
};

const delegationTransitionOf = (
  snapshot: DelegationSnapshot<string, string>,
): ByokDelegationProjectionTransition => ({
  status: snapshot.status,
  ...(snapshot.error?.code === undefined ? {} : { errorCode: snapshot.error.code }),
  ...(snapshot.result === undefined ? {} : { resultChars: snapshot.result.length }),
});

const registerLiveProjectedDelegation = (
  scope: ByokDelegationProjectionScope,
  scheduler: DelegationScheduler<string, string>,
): (() => void) => {
  const live: LiveProjectedDelegation = {
    runId: scope.runId,
    instanceId: scope.instanceId,
    delegationId: scope.delegationId,
    scheduler,
  };
  liveProjectedDelegations.set(scope.taskId, live);
  return () => {
    if (liveProjectedDelegations.get(scope.taskId) === live) {
      liveProjectedDelegations.delete(scope.taskId);
    }
  };
};

const cancelRuntimeDelegation = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly instanceId: string;
  readonly delegationId: string;
}): ByokDelegationRuntimeCancelResult => {
  const live = liveProjectedDelegations.get(input.taskId);
  const scheduler =
    live !== undefined &&
    live.runId === input.runId &&
    live.instanceId === input.instanceId &&
    live.delegationId === input.delegationId
      ? live.scheduler
      : undefined;
  const snapshot = scheduler?.get(input.delegationId);
  if (snapshot === undefined) return { status: "not_found" };
  if (isTerminalByokDelegationStatus(snapshot.status)) {
    return { status: "already_terminal", transition: delegationTransitionOf(snapshot) };
  }

  const accepted = scheduler?.cancel(input.delegationId) ?? false;
  const terminal = scheduler?.get(input.delegationId);
  if (accepted && terminal?.status === "cancelled") return { status: "cancelled" };
  if (terminal !== undefined && isTerminalByokDelegationStatus(terminal.status)) {
    return { status: "already_terminal", transition: delegationTransitionOf(terminal) };
  }
  return { status: "not_found" };
};

export interface ByokDelegationService {
  readonly submit: (input: ByokDelegationSubmitRequest) => Effect.Effect<ByokDelegationSnapshot>;
  readonly list: (instanceId: string) => Effect.Effect<ReadonlyArray<ByokDelegationSnapshot>>;
  readonly cancel: (
    input: ByokDelegationCancelRequest,
  ) => Effect.Effect<ByokDelegationSnapshot | null>;
  readonly cancelCompositionTask: (
    input: CompositionTaskCancelRequest,
  ) => Effect.Effect<CompositionTaskCancelResult | undefined, CompositionTaskStoreError>;
  /** Probe one configured executor candidate's availability on demand. */
  readonly probeExecutor: (
    input: ByokDelegationExecutorProbeRequest,
  ) => Effect.Effect<ByokDelegationExecutorProbe | null>;
}

export interface ByokDelegationExecutorProbeRequest {
  readonly instanceId: string;
  readonly executorId: string;
}

export class DelegationNotConfiguredError extends Data.TaggedError("DelegationNotConfiguredError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "No delegation executor command is configured." });
  }
}

export class DelegationDisabledError extends Data.TaggedError("DelegationDisabledError")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Delegation is disabled for this BYOK instance." });
  }
}

export class DelegationExecutorError extends Data.TaggedError("DelegationExecutorError")<{
  readonly message: string;
}> {}

/** Live per-instance scheduler registry, rebuilt when the config changes. */
export function resolveScheduler(
  config: ByokDelegationConfig,
  instanceId: string,
): DelegationScheduler<string, string> {
  const fingerprint = fingerprintOf(config);
  const existing = schedulers.get(instanceId);
  if (existing !== undefined && existing.fingerprint === fingerprint) {
    return existing.scheduler;
  }
  let terminalRetained = 0;
  const scheduler = new DelegationScheduler<string, string>(
    {
      execute: (request, context) =>
        runExecutorWithFailover(request, context, config, probeRegistryFor(instanceId), instanceId),
    },
    {
      maxConcurrency: config.maxConcurrency,
      defaultQueueTimeoutMs: config.queueTimeoutMs,
      defaultExecutionTimeoutMs: config.executionTimeoutMs,
      // Terminal snapshots accumulate only up to RETAINED_DELEGATIONS; later
      // ones are dropped at completion. In-flight records are always retained.
      retention: {
        shouldRetain: () => {
          if (terminalRetained >= RETAINED_DELEGATIONS) return false;
          terminalRetained += 1;
          return true;
        },
      },
    },
  );
  schedulers.set(instanceId, { fingerprint, scheduler });
  return scheduler;
}

export const listInFlightDelegationIds = (): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const { scheduler } of schedulers.values()) {
    for (const snapshot of scheduler.list()) {
      if (snapshot.status === "queued" || snapshot.status === "running") {
        ids.add(snapshot.id);
      }
    }
  }
  return ids;
};

const isTerminalStatus = (status: DelegationStatus): boolean =>
  status !== "queued" && status !== "running";

/**
 * Buffered per-delegation transition feed over the scheduler's sync event
 * stream, so the Effect side can consume queued→running→terminal in order
 * without missing events published while it is projecting.
 */
const watchDelegationTransitions = (scheduler: DelegationScheduler<string, string>, id: string) => {
  const buffered: Array<DelegationSnapshot<string, string>> = [];
  let pending: ((snapshot: DelegationSnapshot<string, string>) => void) | undefined;
  const unsubscribe = scheduler.subscribe((event) => {
    if (event.snapshot.id !== id) return;
    if (pending !== undefined) {
      const resolve = pending;
      pending = undefined;
      resolve(event.snapshot);
      return;
    }
    buffered.push(event.snapshot);
  });
  return {
    next: (): Promise<DelegationSnapshot<string, string>> => {
      const head = buffered.shift();
      if (head !== undefined) return Promise.resolve(head);
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    close: unsubscribe,
  };
};

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  // Composition 台账为可选依赖：注入后每次委派状态迁移都会投影成幂等事件行，
  // 使 Composition Task/Run 成为委派状态的可查询单一状态源。
  const taskStore = yield* Effect.serviceOption(CompositionTaskStore);

  if (Option.isSome(taskStore) && !interruptSweepStarted) {
    interruptSweepStarted = true;
    // 跨重启收口是全表扫描，fork 成后台 fiber：Layer 构造发生在 HTTP 监听
    // 之前，同步执行会把新连接的可用时间推迟一个扫描周期。fiber 绑定在
    // Layer scope 上，server 退出时随作用域收口；错误已在 fiber 内兜住。
    yield* Effect.forkScoped(
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowUnixMs) =>
          recoverInterruptedByokDelegations({
            store: taskStore.value,
            liveDelegationIds: listInFlightDelegationIds(),
            nowUnixMs,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError("BYOK 委派跨重启收口失败", { cause }).pipe(Effect.as([])),
        ),
      ),
    );
  }

  const projectTransition = (
    scope: ByokDelegationProjectionScope,
    transition: ByokDelegationProjectionTransition,
  ): Effect.Effect<void> =>
    Option.isNone(taskStore)
      ? Effect.void
      : Effect.gen(function* () {
          const nowUnixMs = yield* Clock.currentTimeMillis;
          yield* projectByokDelegationTransition({
            store: taskStore.value,
            scope,
            transition,
            nowUnixMs,
          });
        }).pipe(
          // 台账投影失败不改变委派本身的结果；此时调度器内存仍是权威来源，
          // 该双源风险已在迁移进度文档中登记。
          Effect.catch(() => Effect.void),
        );

  /** 入队前拒绝也创建唯一台账身份，避免固定错误快照互相覆盖。 */
  const rejectBeforeEnqueue = (
    input: ByokDelegationSubmitRequest,
    errorCode: string,
    errorMessage: string,
  ) =>
    Effect.gen(function* () {
      const uniqueKey = NodeCrypto.randomUUID();
      const delegationId = `delegation-rejected-${uniqueKey}`;
      const scope = makeByokDelegationProjectionScope({
        instanceId: input.instanceId,
        delegationId,
        uniqueKey,
        taskText: input.task,
      });
      yield* projectTransition(scope, { status: "failed", errorCode });
      return {
        ...failedSnapshot(input, errorCode, errorMessage),
        id: delegationId,
      } satisfies ByokDelegationSnapshot;
    });

  /**
   * Submit to the scheduler, projecting each observed transition in order.
   * `taskText` is the (role-fragment-applied) task body and `modelOverride`
   * threads a supervision reassign round's model through the executor env.
   */
  const runDelegationToTerminal = (
    input: ByokDelegationSubmitRequest,
    config: ByokDelegationConfig,
    taskText: string,
    modelOverride: string | undefined,
  ) =>
    Effect.gen(function* () {
      const scheduler = resolveScheduler(config, input.instanceId);
      // 提交与订阅必须发生在同一同步 tick：一旦让出执行权，中间发布的事件
      // 既不在返回快照里也不在订阅缓冲里，终态等待就会悬挂。
      const { submitted, feed } = yield* Effect.try({
        try: () => {
          // The attempt key buckets the failover attempt chain recorded by the
          // execute callback; it carries no user content.
          const attemptKey = NodeCrypto.randomUUID();
          const submitted = scheduler.submit({
            input: taskText,
            queueTimeoutMs: config.queueTimeoutMs,
            executionTimeoutMs: config.executionTimeoutMs,
            metadata: {
              [ATTEMPT_KEY_METADATA]: attemptKey,
              ...(modelOverride === undefined ? {} : { byokDelegationModel: modelOverride }),
            },
          });
          rememberAttemptChain(submitted.id, attemptKey);
          return { submitted, feed: watchDelegationTransitions(scheduler, submitted.id) };
        },
        catch: (cause) =>
          new DelegationExecutorError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      const scope = makeByokDelegationProjectionScope({
        instanceId: input.instanceId,
        delegationId: submitted.id,
        uniqueKey: NodeCrypto.randomUUID(),
        taskText,
      });
      const unregisterLive = registerLiveProjectedDelegation(scope, scheduler);
      return yield* Effect.gen(function* () {
        // 每个委派都真实经过 queued；submit 内部的同步 drain 可能让返回快照已是 running。
        yield* projectTransition(scope, { status: "queued" });
        let last = submitted;
        if (last.status !== "queued") {
          yield* projectTransition(scope, delegationTransitionOf(last));
        }
        while (!isTerminalStatus(last.status)) {
          const next = yield* Effect.promise(() => feed.next());
          if (next.sequence <= last.sequence) continue;
          if (next.status !== last.status) {
            yield* projectTransition(scope, delegationTransitionOf(next));
          }
          last = next;
        }
        return last;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            feed.close();
            unregisterLive();
          }),
        ),
      );
    });

  /** One supervisor/reviewer chat completion returning the raw model text. */
  const runSupervisorReview = (
    adapter: ByokSettings["adapters"][number],
    prompt: string,
  ): Effect.Effect<string, ByokEngineError> =>
    collectChatText(
      streamChat(httpClient, {
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
        modelId: adapter.modelId,
        messages: [{ role: "user", content: prompt }],
      }),
    );

  const withSupervisionSummary = (
    snapshot: ByokDelegationSnapshot,
    counters: SupervisionCounters | undefined,
  ): ByokDelegationSnapshot =>
    counters === undefined ? snapshot : { ...snapshot, supervision: counters };

  const submit = (input: ByokDelegationSubmitRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const config = configOf(settings, input.instanceId);
      if (!config.enabled) {
        return yield* rejectBeforeEnqueue(
          input,
          "DELEGATION_DISABLED",
          "Delegation is disabled for this BYOK instance.",
        );
      }
      if (effectiveExecutorList(config).length === 0) {
        return yield* rejectBeforeEnqueue(
          input,
          "DELEGATION_NOT_CONFIGURED",
          "No delegation executor command is configured.",
        );
      }
      const taskText = applySubagentPromptFragment(
        input.task,
        resolveSubagentPromptFragment(config.subagentProfiles, input.subagentType),
      );
      const supervision = config.supervision;
      const supervisionActive =
        supervision.enabled === true && supervision.supervisorModelId.trim().length > 0;
      if (!supervisionActive) {
        const outcome = yield* Effect.result(
          runDelegationToTerminal(input, config, taskText, undefined),
        );
        if (outcome._tag === "Failure") {
          return yield* rejectBeforeEnqueue(
            input,
            "DELEGATION_SUBMIT_FAILED",
            outcome.failure.message,
          );
        }
        return toSnapshot(outcome.success);
      }

      // Supervision path (original cursor-byok parity): the supervisor model
      // reviews each finished round and bounded accept/retry/reassign/escalate
      // decisions drive at most maxRounds worker submissions. Ledger rows stay
      // one-per-scheduler-run; the returned snapshot carries the counters.
      const instanceAdapters = adaptersOf(settings, input.instanceId);
      const supervisorAdapter = byokAdapterForModel(
        { adapters: instanceAdapters } as ByokSettings,
        supervision.supervisorModelId,
      );
      const reviewerAdapter =
        supervision.reviewerModelId.trim().length === 0
          ? supervisorAdapter
          : (byokAdapterForModel(
              { adapters: instanceAdapters } as ByokSettings,
              supervision.reviewerModelId,
            ) ?? supervisorAdapter);
      let counters = INITIAL_SUPERVISION_COUNTERS;
      let currentTask = taskText;
      let modelOverride: string | undefined;
      let last: ByokDelegationSnapshot | undefined;
      for (;;) {
        const outcome = yield* Effect.result(
          runDelegationToTerminal(input, config, currentTask, modelOverride),
        );
        if (outcome._tag === "Failure") {
          return yield* rejectBeforeEnqueue(
            input,
            "DELEGATION_SUBMIT_FAILED",
            outcome.failure.message,
          );
        }
        last = toSnapshot(outcome.success);
        // 取消与超时不进入监督循环：终局语义由调度器决定。
        if (last.status !== "succeeded" && last.status !== "failed") {
          return withSupervisionSummary(last, counters);
        }
        if (supervisorAdapter === undefined || reviewerAdapter === undefined) {
          // 监督模型未配置成功：不重试（严格模式下不可审查的结果不驱动重试）。
          return withSupervisionSummary(last, counters);
        }
        const reviewText = yield* Effect.result(
          runSupervisorReview(
            reviewerAdapter,
            buildSupervisorReviewPrompt({
              task: currentTask,
              result: last.resultPreview ?? "",
              errorMessage: last.errorMessage,
              counters,
              config: supervision,
            }),
          ),
        );
        const decision =
          reviewText._tag === "Success" ? parseSupervisionDecision(reviewText.success) : undefined;
        if (decision === undefined) {
          // 监督不可用或返回无法解析：保留本轮结果，不再驱动额外轮次。
          return withSupervisionSummary(last, counters);
        }
        const action = nextSupervisionAction({
          decision,
          counters,
          config: supervision,
          candidateModelIds: config.modelGroups.find((group) => group.enabled)?.modelIds ?? [],
          currentModelId: modelOverride ?? resolveDelegationModel(config),
          lastTask: currentTask,
        });
        if (action.kind === "done") {
          return withSupervisionSummary(last, action.counters);
        }
        if (action.kind === "fail") {
          // 执行成功时保留成果，仅携带监督计数；失败终局照常返回。
          return withSupervisionSummary(last, action.counters);
        }
        counters = action.counters;
        if (action.taskOverride !== undefined && action.taskOverride.trim().length > 0) {
          currentTask = action.taskOverride;
        }
        modelOverride = action.modelOverride;
      }
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(
          failedSnapshot(
            input,
            "DELEGATION_SUBMIT_FAILED",
            "Delegation submit failed unexpectedly.",
          ),
        ),
      ),
    );

  const list = (instanceId: string) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const config = configOf(settings, instanceId);
      const entry = schedulers.get(instanceId);
      if (entry === undefined || entry.fingerprint !== fingerprintOf(config)) {
        return [];
      }
      return entry.scheduler.list().map(toSnapshot);
    }).pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ByokDelegationSnapshot>)));

  /**
   * Per-task cancel (original cursor-byok parity): abort the executor and
   * report the post-cancel snapshot, or `null` when the id is unknown or was
   * dropped after a config change. Ledger settlement for the cancelled state
   * is owned by the submit fiber's transition watch, which projects every
   * status change idempotently until terminal.
   */
  const cancel = (input: ByokDelegationCancelRequest) =>
    Effect.sync(() => {
      const entry = schedulers.get(input.instanceId);
      const snapshot = entry?.scheduler.get(input.delegationId);
      if (entry === undefined || snapshot === undefined) return null;
      if (!isTerminalStatus(snapshot.status)) entry.scheduler.cancel(input.delegationId);
      return toSnapshot(entry.scheduler.get(input.delegationId) ?? snapshot);
    }).pipe(Effect.catch(() => Effect.succeed(null)));

  const cancelCompositionTask: ByokDelegationService["cancelCompositionTask"] = (input) =>
    Option.isNone(taskStore)
      ? Effect.succeed(undefined)
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowUnixMs) =>
            cancelProjectedByokDelegationTask({
              store: taskStore.value,
              input,
              cancelRuntime: cancelRuntimeDelegation,
              nowUnixMs,
            }),
          ),
        );

  /** On-demand availability probe for the settings page (bypasses the cache). */
  const probeExecutor: ByokDelegationService["probeExecutor"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const config = configOf(settings, input.instanceId);
      const candidate = effectiveExecutorList(config).find(
        (executor) => executor.id === input.executorId,
      );
      if (candidate === undefined) return null;
      const registry = probeRegistryFor(input.instanceId);
      const outcome = yield* Effect.promise(() => registry.probe(candidate, { force: true }));
      const probedAt = yield* Clock.currentTimeMillis;
      return {
        executorId: candidate.id,
        state: outcome.state,
        ...(outcome.diagnosticCode === undefined ? {} : { diagnosticCode: outcome.diagnosticCode }),
        ...(outcome.diagnosticPreview === undefined
          ? {}
          : { diagnosticPreview: outcome.diagnosticPreview }),
        probedAt,
      } satisfies ByokDelegationExecutorProbe;
    }).pipe(Effect.catch(() => Effect.succeed(null)));

  return {
    submit,
    list,
    cancel,
    cancelCompositionTask,
    probeExecutor,
  } satisfies ByokDelegationService;
});

export const __testables = {
  parseExecutorCommand,
  buildChildEnv,
  preview,
  registerLiveProjectedDelegation,
  effectiveExecutorList,
  rememberAttemptChain,
  executorAttemptsByKey,
  attemptKeysByDelegationId,
};

/**
 * Context tag so in-process consumers (the `delegate_task` tool handler in the
 * composition ToolBroker) can reach the delegation service through layers
 * instead of importing module state directly. `make` already resolves its own
 * dependencies; the layer simply publishes the service instance.
 */
export class ByokDelegationServiceTag extends Context.Service<
  ByokDelegationServiceTag,
  ByokDelegationService
>()("codework/provider/byok/ByokDelegationService/ByokDelegationServiceTag") {}

export const layer = Layer.effect(ByokDelegationServiceTag, make);
