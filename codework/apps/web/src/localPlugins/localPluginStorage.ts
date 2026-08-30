import { LocalPluginManifest, NonNegativeInt, TrimmedNonEmptyString } from "@codework/contracts";
import * as Schema from "effect/Schema";

const StoredLocalPlugin = Schema.Struct({
  manifest: LocalPluginManifest,
  enabled: Schema.Boolean,
  installedAtUnixMs: NonNegativeInt,
  updatedAtUnixMs: NonNegativeInt,
});

const LocalPluginStorageDocument = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.optional(NonNegativeInt),
  writerId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  plugins: Schema.Array(StoredLocalPlugin).check(Schema.isMaxLength(128)),
});

export type StoredLocalPlugin = typeof StoredLocalPlugin.Type;
export type LocalPluginStorageDocument = typeof LocalPluginStorageDocument.Type;

export interface LocalPluginStorageMetadata {
  readonly revision: number;
  readonly writerId: string;
}

export interface LocalPluginStorageCompareAndSwapInput {
  readonly expectedValue: string | null;
  readonly expectedRevision: number;
  readonly nextValue: string;
}

export interface LocalPluginStorageCompareAndSwapResult {
  readonly swapped: boolean;
  readonly currentValue: string | null;
}

interface LocalPluginStorageLockManager {
  request<A>(
    name: string,
    options: { readonly mode: "exclusive" },
    callback: () => A | Promise<A>,
  ): Promise<A>;
}

const decodeStorageDocument = Schema.decodeUnknownSync(LocalPluginStorageDocument);

export class LocalPluginStorageDuplicateIdError extends Error {
  override readonly name = "LocalPluginStorageDuplicateIdError";

  constructor(readonly pluginId: string) {
    super(`本地插件存储包含重复 ID ${pluginId}。`);
  }
}

export class LocalPluginStorageLockUnavailableError extends Error {
  override readonly name = "LocalPluginStorageLockUnavailableError";

  constructor() {
    super("当前浏览器不支持本地插件存储互斥锁，已拒绝不安全写入。");
  }
}

export class LocalPluginStorageInvalidDocumentError extends Error {
  override readonly name = "LocalPluginStorageInvalidDocumentError";

  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

function assertUniquePluginIds(plugins: ReadonlyArray<StoredLocalPlugin>): void {
  const ids = new Set<string>();
  for (const plugin of plugins) {
    const pluginId = plugin.manifest.id;
    if (ids.has(pluginId)) throw new LocalPluginStorageDuplicateIdError(pluginId);
    ids.add(pluginId);
  }
}

function assertCompleteStorageMetadata(document: LocalPluginStorageDocument): void {
  if ((document.revision === undefined) !== (document.writerId === undefined)) {
    throw new Error("本地插件存储修订信息不完整。");
  }
}

export interface LocalPluginStorage {
  read(): string | null;
  write(value: string): void;
  compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult>;
  subscribe?(listener: () => void): () => void;
}

function browserLockManager(): LocalPluginStorageLockManager | null {
  if (typeof navigator === "undefined" || navigator.locks === undefined) return null;
  return {
    request: (name, options, callback) => navigator.locks.request(name, options, () => callback()),
  };
}

export class BrowserLocalPluginStorage implements LocalPluginStorage {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly key = "codework:local-plugins:v1",
    private readonly eventTarget: Pick<
      EventTarget,
      "addEventListener" | "removeEventListener"
    > | null = typeof window === "undefined" ? null : window,
    private readonly lockManager: LocalPluginStorageLockManager | null = browserLockManager(),
  ) {}

  read(): string | null {
    return this.storage.getItem(this.key);
  }

  write(value: string): void {
    this.storage.setItem(this.key, value);
  }

  async compareAndSwap(
    input: LocalPluginStorageCompareAndSwapInput,
  ): Promise<LocalPluginStorageCompareAndSwapResult> {
    if (this.lockManager === null) throw new LocalPluginStorageLockUnavailableError();
    const nextDocument = decodeLocalPluginStorageDocument(input.nextValue);
    if (nextDocument.revision !== input.expectedRevision + 1) {
      throw new Error("本地插件存储下一修订号必须严格递增 1。");
    }
    return this.lockManager.request(`${this.key}:write`, { mode: "exclusive" }, () => {
      const currentValue = this.read();
      let currentRevision = 0;
      if (currentValue !== null) {
        try {
          currentRevision = decodeLocalPluginStorageDocument(currentValue).revision ?? 0;
        } catch (error) {
          throw new LocalPluginStorageInvalidDocumentError(
            "本地插件存储在原子写入前无法解析。",
            error,
          );
        }
      }
      if (currentValue !== input.expectedValue || currentRevision !== input.expectedRevision) {
        return { swapped: false, currentValue };
      }
      this.write(input.nextValue);
      const persistedValue = this.read();
      return {
        swapped: persistedValue === input.nextValue,
        currentValue: persistedValue,
      };
    });
  }

  subscribe(listener: () => void): () => void {
    if (this.eventTarget === null) return () => undefined;
    const handleStorage = (event: Event) => {
      const storageEvent = event as StorageEvent;
      if (storageEvent.key !== null && storageEvent.key !== this.key) return;
      if (
        storageEvent.storageArea !== null &&
        storageEvent.storageArea !== undefined &&
        storageEvent.storageArea !== (this.storage as Storage)
      ) {
        return;
      }
      listener();
    };
    this.eventTarget.addEventListener("storage", handleStorage);
    return () => this.eventTarget?.removeEventListener("storage", handleStorage);
  }
}

export function decodeLocalPluginStorageDocument(value: string): LocalPluginStorageDocument {
  const document = decodeStorageDocument(JSON.parse(value));
  assertCompleteStorageMetadata(document);
  assertUniquePluginIds(document.plugins);
  return document;
}

export function encodeLocalPluginStorageDocument(
  plugins: ReadonlyArray<StoredLocalPlugin>,
  metadata?: LocalPluginStorageMetadata,
): string {
  assertUniquePluginIds(plugins);
  const document =
    metadata === undefined
      ? ({ version: 1, plugins } satisfies LocalPluginStorageDocument)
      : ({ version: 1, ...metadata, plugins } satisfies LocalPluginStorageDocument);
  assertCompleteStorageMetadata(document);
  return JSON.stringify(document);
}
