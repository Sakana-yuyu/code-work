// @effect-diagnostics nodeBuiltinImport:off - The scheduler owns cancellable child processes directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";

import type {
  ByokDelegationConfig,
  ByokDelegationSnapshot,
  ByokDelegationSubmitRequest,
  CompositionTaskCancelRequest,
  CompositionTaskCancelResult,
  ServerSettings as ServerSettingsContract,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

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

/** Executor stdout is capped so a runaway command cannot exhaust memory. */
const DELEGATION_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Preview lengths keep snapshots bounded and free of large payloads. */
const TASK_PREVIEW_MAX_CHARS = 200;
const RESULT_PREVIEW_MAX_CHARS = 2_000;
/** How many terminal snapshots the live scheduler retains per instance. */
const RETAINED_DELEGATIONS = 50;

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

const DEFAULT_DELEGATION_CONFIG: ByokDelegationConfig = {
  enabled: false,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
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

const fingerprintOf = (config: ByokDelegationConfig): string =>
  JSON.stringify([
    config.enabled,
    config.maxConcurrency,
    config.queueTimeoutMs,
    config.executionTimeoutMs,
    config.executorCommand,
    config.executorEnvironmentVariables,
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
 * settings never reach this map — settings only ever stores the names.
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

const runExecutor = (
  request: DelegationRequest<string>,
  context: DelegationExecutionContext,
  config: ByokDelegationConfig,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const tokens = parseExecutorCommand(config.executorCommand);
    if (tokens.length === 0) {
      reject(new Error("No executor command is configured."));
      return;
    }
    const childEnv = buildChildEnv(config.executorEnvironmentVariables);
    const delegationModel = resolveDelegationModel(config);
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
    child.on("error", (error) => {
      context.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      context.signal.removeEventListener("abort", onAbort);
      if (killed || context.signal.aborted) {
        reject(new Error("Executor was cancelled."));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `Executor exited with code ${code ?? "unknown"}.${stderr.trim().length > 0 ? ` ${stderr.trim()}` : ""}`,
        ),
      );
    });

    child.stdin.on("error", () => {
      // Executor closed stdin early (e.g. prompt-only CLIs); the write below
      // failing is fine, execution continues.
    });
    child.stdin.end(request.input);
  });

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
});

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
  readonly cancelCompositionTask: (
    input: CompositionTaskCancelRequest,
  ) => Effect.Effect<CompositionTaskCancelResult | undefined, CompositionTaskStoreError>;
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
      execute: (request, context) => runExecutor(request, context, config),
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
  // Composition 台账为可选依赖：注入后每次委派状态迁移都会投影成幂等事件行，
  // 使 Composition Task/Run 成为委派状态的可查询单一状态源。
  const taskStore = yield* Effect.serviceOption(CompositionTaskStore);

  if (Option.isSome(taskStore) && !interruptSweepStarted) {
    interruptSweepStarted = true;
    yield* Clock.currentTimeMillis.pipe(
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

  /** Submit to the scheduler, projecting each observed transition in order. */
  const runDelegationToTerminal = (
    input: ByokDelegationSubmitRequest,
    config: ByokDelegationConfig,
  ) =>
    Effect.gen(function* () {
      const scheduler = resolveScheduler(config, input.instanceId);
      // 提交与订阅必须发生在同一同步 tick：一旦让出执行权，中间发布的事件
      // 既不在返回快照里也不在订阅缓冲里，终态等待就会悬挂。
      const { submitted, feed } = yield* Effect.try({
        try: () => {
          const submitted = scheduler.submit({
            input: input.task,
            queueTimeoutMs: config.queueTimeoutMs,
            executionTimeoutMs: config.executionTimeoutMs,
          });
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
        taskText: input.task,
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
      if (config.executorCommand.trim().length === 0) {
        return yield* rejectBeforeEnqueue(
          input,
          "DELEGATION_NOT_CONFIGURED",
          "No delegation executor command is configured.",
        );
      }
      const outcome = yield* Effect.result(runDelegationToTerminal(input, config));
      if (outcome._tag === "Failure") {
        return yield* rejectBeforeEnqueue(
          input,
          "DELEGATION_SUBMIT_FAILED",
          outcome.failure.message,
        );
      }
      return toSnapshot(outcome.success);
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

  return { submit, list, cancelCompositionTask } satisfies ByokDelegationService;
});

export const __testables = {
  parseExecutorCommand,
  buildChildEnv,
  preview,
  registerLiveProjectedDelegation,
};
