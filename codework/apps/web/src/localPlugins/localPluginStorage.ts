import { LocalPluginManifest, NonNegativeInt } from "@codework/contracts";
import * as Schema from "effect/Schema";

const StoredLocalPlugin = Schema.Struct({
  manifest: LocalPluginManifest,
  enabled: Schema.Boolean,
  installedAtUnixMs: NonNegativeInt,
  updatedAtUnixMs: NonNegativeInt,
});

const LocalPluginStorageDocument = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(StoredLocalPlugin).check(Schema.isMaxLength(128)),
});

export type StoredLocalPlugin = typeof StoredLocalPlugin.Type;
export type LocalPluginStorageDocument = typeof LocalPluginStorageDocument.Type;

const decodeStorageDocument = Schema.decodeUnknownSync(LocalPluginStorageDocument);

export class LocalPluginStorageDuplicateIdError extends Error {
  override readonly name = "LocalPluginStorageDuplicateIdError";

  constructor(readonly pluginId: string) {
    super(`本地插件存储包含重复 ID ${pluginId}。`);
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

export interface LocalPluginStorage {
  read(): string | null;
  write(value: string): void;
}

export class BrowserLocalPluginStorage implements LocalPluginStorage {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly key = "codework:local-plugins:v1",
  ) {}

  read(): string | null {
    return this.storage.getItem(this.key);
  }

  write(value: string): void {
    this.storage.setItem(this.key, value);
  }
}

export function decodeLocalPluginStorageDocument(value: string): LocalPluginStorageDocument {
  const document = decodeStorageDocument(JSON.parse(value));
  assertUniquePluginIds(document.plugins);
  return document;
}

export function encodeLocalPluginStorageDocument(
  plugins: ReadonlyArray<StoredLocalPlugin>,
): string {
  assertUniquePluginIds(plugins);
  return JSON.stringify({ version: 1, plugins } satisfies LocalPluginStorageDocument);
}
