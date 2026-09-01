// @effect-diagnostics globalTimers:off - Standalone scheduler owns cancellable native timers.
import { performance } from "node:perf_hooks";
import { clearTimeout, setTimeout } from "node:timers";

export type DelegationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "queue_timed_out"
  | "execution_timed_out";

export type DelegationTerminalStatus = Exclude<DelegationStatus, "queued" | "running">;

export interface DelegationRequest<TInput> {
  readonly input: TInput;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly queueTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
}

export interface DelegationError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface DelegationSnapshot<TInput, TResult> {
  readonly id: string;
  readonly sequence: number;
  readonly status: DelegationStatus;
  readonly request: DelegationRequest<TInput>;
  readonly submittedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly result?: TResult;
  readonly error?: DelegationError;
}

export interface DelegationEvent<TInput, TResult> {
  readonly id: number;
  readonly snapshot: DelegationSnapshot<TInput, TResult>;
}

export interface DelegationExecutionContext {
  readonly delegationId: string;
  readonly signal: AbortSignal;
}

export interface DelegationExecutor<TInput, TResult> {
  execute(
    request: DelegationRequest<TInput>,
    context: DelegationExecutionContext,
  ): Promise<TResult>;
}

export interface TerminalRetentionHooks<TInput, TResult> {
  onTerminal?(snapshot: DelegationSnapshot<TInput, TResult>): void | Promise<void>;
  shouldRetain?(snapshot: DelegationSnapshot<TInput, TResult>): boolean;
}

export interface DelegationSchedulerOptions<TInput, TResult> {
  readonly maxConcurrency: number;
  readonly defaultQueueTimeoutMs?: number;
  readonly defaultExecutionTimeoutMs?: number;
  readonly retention?: TerminalRetentionHooks<TInput, TResult>;
  readonly now?: () => number;
}

export type DelegationEventListener<TInput, TResult> = (
  event: DelegationEvent<TInput, TResult>,
) => void;

export class DelegationQueueFullError extends Error {
  readonly code = "DELEGATION_QUEUE_FULL";
  readonly queueLimit: number;

  constructor(queueLimit: number) {
    super(`Delegation queue is full (limit ${queueLimit})`);
    this.name = "DelegationQueueFullError";
    this.queueLimit = queueLimit;
  }
}

export class DelegationScheduler<TInput, TResult> {
  readonly queueLimit: number;

  private readonly records = new Map<string, MutableRecord<TInput, TResult>>();
  private readonly queue: Array<MutableRecord<TInput, TResult>> = [];
  private readonly listeners = new Set<DelegationEventListener<TInput, TResult>>();
  private readonly now: () => number;
  private runningCount = 0;
  private nextDelegationId = 1;
  private nextEventId = 1;

  private readonly executor: DelegationExecutor<TInput, TResult>;
  private readonly options: DelegationSchedulerOptions<TInput, TResult>;

  constructor(
    executor: DelegationExecutor<TInput, TResult>,
    options: DelegationSchedulerOptions<TInput, TResult>,
  ) {
    this.executor = executor;
    this.options = options;
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive integer");
    }
    validateTimeout(options.defaultQueueTimeoutMs, "defaultQueueTimeoutMs");
    validateTimeout(options.defaultExecutionTimeoutMs, "defaultExecutionTimeoutMs");
    this.queueLimit = options.maxConcurrency * 4;
    this.now = options.now ?? (() => performance.now());
  }

  submit(request: DelegationRequest<TInput>): DelegationSnapshot<TInput, TResult> {
    validateTimeout(request.queueTimeoutMs, "queueTimeoutMs");
    validateTimeout(request.executionTimeoutMs, "executionTimeoutMs");
    if (this.queue.length >= this.queueLimit) {
      throw new DelegationQueueFullError(this.queueLimit);
    }

    const record: MutableRecord<TInput, TResult> = {
      id: `delegation-${this.nextDelegationId++}`,
      sequence: 0,
      status: "queued",
      request: clone(request),
      submittedAt: this.now(),
      controller: new AbortController(),
    };
    this.records.set(record.id, record);
    this.queue.push(record);
    this.publish(record);

    const queueTimeoutMs = request.queueTimeoutMs ?? this.options.defaultQueueTimeoutMs;
    if (queueTimeoutMs !== undefined) {
      record.queueTimer = setTimeout(() => {
        if (record.status !== "queued") return;
        this.removeFromQueue(record);
        this.finish(record, "queue_timed_out", {
          error: timeoutError("QueueTimeoutError", "Delegation timed out while queued"),
        });
        this.drain();
      }, queueTimeoutMs);
    }

    this.drain();
    return this.snapshot(record);
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (record === undefined || isTerminal(record.status)) return false;

    if (record.status === "queued") {
      this.removeFromQueue(record);
      this.finish(record, "cancelled");
      this.drain();
      return true;
    }

    record.controller.abort();
    this.finish(record, "cancelled");
    return true;
  }

  get(id: string): DelegationSnapshot<TInput, TResult> | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : this.snapshot(record);
  }

  list(): ReadonlyArray<DelegationSnapshot<TInput, TResult>> {
    return Object.freeze(Array.from(this.records.values(), (record) => this.snapshot(record)));
  }

  subscribe(listener: DelegationEventListener<TInput, TResult>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private drain(): void {
    while (this.runningCount < this.options.maxConcurrency && this.queue.length > 0) {
      const record = this.queue.shift();
      if (record !== undefined && record.status === "queued") this.start(record);
    }
  }

  private start(record: MutableRecord<TInput, TResult>): void {
    if (record.queueTimer !== undefined) clearTimeout(record.queueTimer);
    delete record.queueTimer;
    record.status = "running";
    record.startedAt = this.now();
    this.runningCount += 1;
    this.publish(record);

    const executionTimeoutMs =
      record.request.executionTimeoutMs ?? this.options.defaultExecutionTimeoutMs;
    if (executionTimeoutMs !== undefined) {
      record.executionTimer = setTimeout(() => {
        if (record.status !== "running") return;
        record.controller.abort();
        this.finish(record, "execution_timed_out", {
          error: timeoutError("ExecutionTimeoutError", "Delegation execution timed out"),
        });
      }, executionTimeoutMs);
    }

    void Promise.resolve()
      .then(() =>
        this.executor.execute(clone(record.request), {
          delegationId: record.id,
          signal: record.controller.signal,
        }),
      )
      .then(
        (result) => {
          if (record.status === "running") this.finish(record, "succeeded", { result });
        },
        (error: unknown) => {
          if (record.status === "running") {
            this.finish(record, record.controller.signal.aborted ? "cancelled" : "failed", {
              error: sanitizeError(error),
            });
          }
        },
      );
  }

  private finish(
    record: MutableRecord<TInput, TResult>,
    status: DelegationTerminalStatus,
    outcome: { readonly result?: TResult; readonly error?: DelegationError } = {},
  ): void {
    const wasRunning = record.status === "running";
    if (record.queueTimer !== undefined) clearTimeout(record.queueTimer);
    if (record.executionTimer !== undefined) clearTimeout(record.executionTimer);
    delete record.queueTimer;
    delete record.executionTimer;
    record.status = status;
    record.finishedAt = this.now();
    if (outcome.result !== undefined) record.result = clone(outcome.result);
    if (outcome.error !== undefined) record.error = outcome.error;
    if (wasRunning) this.runningCount -= 1;

    const snapshot = this.publish(record);
    const retention = this.options.retention;
    if (retention?.onTerminal !== undefined) {
      void Promise.resolve(retention.onTerminal(snapshot)).catch(() => undefined);
    }
    if (retention?.shouldRetain?.(snapshot) === false) this.records.delete(record.id);
    if (wasRunning) this.drain();
  }

  private removeFromQueue(record: MutableRecord<TInput, TResult>): void {
    const index = this.queue.indexOf(record);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private publish(record: MutableRecord<TInput, TResult>): DelegationSnapshot<TInput, TResult> {
    record.sequence += 1;
    const snapshot = this.snapshot(record);
    const event = deepFreeze({ id: this.nextEventId++, snapshot });
    for (const listener of this.listeners) listener(event);
    return snapshot;
  }

  private snapshot(record: MutableRecord<TInput, TResult>): DelegationSnapshot<TInput, TResult> {
    const snapshot: DelegationSnapshot<TInput, TResult> = {
      id: record.id,
      sequence: record.sequence,
      status: record.status,
      request: clone(record.request),
      submittedAt: record.submittedAt,
      ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
      ...(record.result === undefined ? {} : { result: clone(record.result) }),
      ...(record.error === undefined ? {} : { error: clone(record.error) }),
    };
    return deepFreeze(snapshot);
  }
}

interface MutableRecord<TInput, TResult> {
  readonly id: string;
  sequence: number;
  status: DelegationStatus;
  readonly request: DelegationRequest<TInput>;
  readonly submittedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: TResult;
  error?: DelegationError;
  readonly controller: AbortController;
  queueTimer?: ReturnType<typeof setTimeout>;
  executionTimer?: ReturnType<typeof setTimeout>;
}

function validateTimeout(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

function isTerminal(status: DelegationStatus): status is DelegationTerminalStatus {
  return status !== "queued" && status !== "running";
}

function timeoutError(name: string, message: string): DelegationError {
  return deepFreeze({ name, message, code: "DELEGATION_TIMEOUT" });
}

export function sanitizeError(error: unknown): DelegationError {
  if (error instanceof Error) {
    const code = readErrorCode(error);
    return deepFreeze({
      name: cleanText(error.name, "Error", 100),
      message: cleanText(error.message, "Delegation failed", 1_000),
      ...(code === undefined ? {} : { code }),
    });
  }
  return deepFreeze({
    name: "Error",
    message:
      typeof error === "string"
        ? cleanText(error, "Delegation failed", 1_000)
        : "Delegation failed",
  });
}

function readErrorCode(error: Error): string | undefined {
  const value = (error as Error & { readonly code?: unknown }).code;
  return typeof value === "string" ? cleanText(value, "UNKNOWN", 100) : undefined;
}

function cleanText(value: string, fallback: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  return (cleaned.length === 0 ? fallback : cleaned).slice(0, maxLength);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
