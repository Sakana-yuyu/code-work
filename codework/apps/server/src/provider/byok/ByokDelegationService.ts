// @effect-diagnostics nodeBuiltinImport:off - The scheduler owns cancellable child processes directly.
import { spawn } from "node:child_process";
import type {
  ByokDelegationConfig,
  ByokDelegationSnapshot,
  ByokDelegationSubmitRequest,
  ServerSettings as ServerSettingsContract,
} from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../serverSettings.ts";
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

const schedulers = new Map<string, SchedulerEntry>();

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
    const child = spawn(tokens[0]!, tokens.slice(1), {
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

export interface ByokDelegationService {
  readonly submit: (input: ByokDelegationSubmitRequest) => Effect.Effect<ByokDelegationSnapshot>;
  readonly list: (instanceId: string) => Effect.Effect<ReadonlyArray<ByokDelegationSnapshot>>;
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

const isTerminalStatus = (status: DelegationStatus): boolean =>
  status !== "queued" && status !== "running";

export const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const submit = (input: ByokDelegationSubmitRequest) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const config = configOf(settings, input.instanceId);
      if (!config.enabled) {
        return failedSnapshot(
          input,
          "DELEGATION_DISABLED",
          "Delegation is disabled for this BYOK instance.",
        );
      }
      if (config.executorCommand.trim().length === 0) {
        return failedSnapshot(
          input,
          "DELEGATION_NOT_CONFIGURED",
          "No delegation executor command is configured.",
        );
      }
      const scheduler = resolveScheduler(config, input.instanceId);
      const outcome = yield* Effect.result(
        Effect.tryPromise({
          try: async () => {
            const submitted = scheduler.submit({
              input: input.task,
              queueTimeoutMs: config.queueTimeoutMs,
              executionTimeoutMs: config.executionTimeoutMs,
            });
            return await waitForTerminal(scheduler, submitted.id);
          },
          catch: (cause) =>
            new DelegationExecutorError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
        }),
      );
      if (outcome._tag === "Failure") {
        const failure = outcome.failure as DelegationExecutorError;
        return failedSnapshot(input, "DELEGATION_SUBMIT_FAILED", failure.message);
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

  return { submit, list } satisfies ByokDelegationService;
});

/**
 * Await a delegation's terminal state through the scheduler event stream,
 * bounded by the scheduler's own queue/execution timeouts.
 */
function waitForTerminal(
  scheduler: DelegationScheduler<string, string>,
  id: string,
): Promise<DelegationSnapshot<string, string>> {
  return new Promise((resolve) => {
    const existing = scheduler.get(id);
    if (existing !== undefined && isTerminalStatus(existing.status)) {
      resolve(existing);
      return;
    }
    const unsubscribe = scheduler.subscribe((event) => {
      if (event.snapshot.id !== id) return;
      if (isTerminalStatus(event.snapshot.status)) {
        unsubscribe();
        resolve(event.snapshot);
      }
    });
    // Safety net: if the record was evicted before terminal, resolve with the
    // last known snapshot instead of hanging.
    const existingAfter = scheduler.get(id);
    if (existingAfter === undefined) {
      unsubscribe();
      resolve({
        id,
        sequence: 0,
        status: "failed",
        request: { input: "" },
        submittedAt: 0,
        error: {
          name: "DelegationEvictedError",
          message: "Delegation was evicted before completion.",
        },
      });
    }
  });
}

export const __testables = {
  parseExecutorCommand,
  buildChildEnv,
  preview,
};
