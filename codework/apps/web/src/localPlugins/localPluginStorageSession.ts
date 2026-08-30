import { decodeAllowedLocalPluginManifest } from "./localPluginPolicy";
import type { LocalPluginRegistry } from "./localPluginRegistry";
import {
  decodeLocalPluginStorageDocument,
  encodeLocalPluginStorageDocument,
  LocalPluginStorageInvalidDocumentError,
  type LocalPluginStorage,
  type StoredLocalPlugin,
} from "./localPluginStorage";

export interface LocalPluginStorageSnapshot {
  readonly value: string | null;
  readonly plugins: ReadonlyArray<StoredLocalPlugin>;
  readonly revision: number;
  readonly writerId: string | null;
}

export interface LocalPluginStorageConflict {
  readonly previousRevision: number;
  readonly previousWriterId: string | null;
  readonly currentRevision: number;
  readonly currentWriterId: string | null;
}

export class LocalPluginStorageSession {
  private observed = false;
  private observedValue: string | null = null;
  private observedRevision = 0;
  private observedWriterId: string | null = null;

  constructor(
    private readonly options: {
      readonly registry: LocalPluginRegistry;
      readonly storage: LocalPluginStorage;
      readonly writerId: string;
    },
  ) {}

  restore(): void {
    this.observe(this.readSnapshot(), true);
  }

  readLatest(): LocalPluginStorageSnapshot {
    const snapshot = this.readSnapshot();
    this.observe(snapshot);
    return snapshot;
  }

  synchronize(): LocalPluginStorageConflict | null {
    const snapshot = this.readSnapshot();
    const conflict =
      this.observed &&
      snapshot.value !== this.observedValue &&
      snapshot.revision <= this.observedRevision
        ? {
            previousRevision: this.observedRevision,
            previousWriterId: this.observedWriterId,
            currentRevision: snapshot.revision,
            currentWriterId: snapshot.writerId,
          }
        : null;
    this.observe(snapshot);
    return conflict;
  }

  async persist(
    base: LocalPluginStorageSnapshot,
    plugins: ReadonlyArray<StoredLocalPlugin>,
  ): Promise<boolean> {
    const revision = base.revision + 1;
    const writerId = this.options.writerId;
    const value = encodeLocalPluginStorageDocument(plugins, { revision, writerId });
    const result = await this.options.storage.compareAndSwap({
      expectedValue: base.value,
      expectedRevision: base.revision,
      nextValue: value,
    });
    let persisted: LocalPluginStorageSnapshot;
    try {
      persisted = this.snapshotFromValue(result.currentValue);
    } catch (error) {
      throw new LocalPluginStorageInvalidDocumentError(
        `本地插件设置写入后无法验证：${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
    this.observe(persisted);
    return (
      result.swapped &&
      persisted.value === value &&
      persisted.revision === revision &&
      persisted.writerId === writerId
    );
  }

  private readSnapshot(): LocalPluginStorageSnapshot {
    return this.snapshotFromValue(this.options.storage.read());
  }

  private snapshotFromValue(value: string | null): LocalPluginStorageSnapshot {
    if (value === null) {
      return { value, plugins: [], revision: 0, writerId: null };
    }
    const document = decodeLocalPluginStorageDocument(value);
    for (const plugin of document.plugins) {
      decodeAllowedLocalPluginManifest(plugin.manifest);
    }
    return {
      value,
      plugins: document.plugins,
      revision: document.revision ?? 0,
      writerId: document.writerId ?? null,
    };
  }

  private observe(snapshot: LocalPluginStorageSnapshot, forcePublish = false): void {
    const changed = snapshot.value !== this.observedValue;
    this.observed = true;
    this.observedValue = snapshot.value;
    this.observedRevision = snapshot.revision;
    this.observedWriterId = snapshot.writerId;
    if (forcePublish || changed) this.options.registry.replace(snapshot.plugins);
  }
}
