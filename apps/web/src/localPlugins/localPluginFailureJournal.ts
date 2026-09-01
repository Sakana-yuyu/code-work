export type LocalPluginFailurePhase =
  | "restore"
  | "synchronize"
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "invoke"
  | "render";

export type LocalPluginManagementFailureCode =
  | "schema-invalid"
  | "api-incompatible"
  | "manifest-invalid"
  | "plugin-not-found"
  | "storage-invalid"
  | "storage-duplicate-id"
  | "storage-lock-unavailable"
  | "storage-conflict"
  | "storage-write-failed";

export type LocalPluginFailureCode =
  | LocalPluginManagementFailureCode
  | "invalid-json"
  | "manifest-read-failed"
  | "contribution-invoke-failed"
  | "contribution-render-failed"
  | "timeline-storage-restore-failed";

export interface LocalPluginFailure {
  readonly id: string;
  readonly pluginId: string;
  readonly phase: LocalPluginFailurePhase;
  readonly code: LocalPluginFailureCode;
  readonly contributionKind?: string;
  readonly contributionId?: string;
  readonly message: string;
  readonly occurredAtUnixMs: number;
}

type Listener = () => void;

export class LocalPluginFailureJournal {
  private failures: ReadonlyArray<LocalPluginFailure> = [];
  private readonly listeners = new Set<Listener>();
  private sequence = 0;

  constructor(
    private readonly options: {
      readonly now: () => number;
      readonly makeId: (sequence: number) => string;
      readonly maxEntries?: number;
    },
  ) {}

  getSnapshot = (): ReadonlyArray<LocalPluginFailure> => this.failures;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  record(input: {
    readonly pluginId: string;
    readonly phase: LocalPluginFailurePhase;
    readonly code: LocalPluginFailureCode;
    readonly contributionKind?: string;
    readonly contributionId?: string;
    readonly error: unknown;
  }): LocalPluginFailure {
    this.sequence += 1;
    const failure: LocalPluginFailure = {
      id: this.options.makeId(this.sequence),
      pluginId: input.pluginId,
      phase: input.phase,
      code: input.code,
      ...(input.contributionKind === undefined ? {} : { contributionKind: input.contributionKind }),
      ...(input.contributionId === undefined ? {} : { contributionId: input.contributionId }),
      message: input.error instanceof Error ? input.error.message : String(input.error),
      occurredAtUnixMs: this.options.now(),
    };
    const maxEntries = this.options.maxEntries ?? 100;
    this.failures = [...this.failures, failure].slice(-maxEntries);
    this.publish();
    return failure;
  }

  clear(pluginId?: string): void {
    const next =
      pluginId === undefined
        ? []
        : this.failures.filter((failure) => failure.pluginId !== pluginId);
    if (next.length === this.failures.length) return;
    this.failures = next;
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不能改变失败记录状态或中断其他订阅者。
      }
    }
  }
}
