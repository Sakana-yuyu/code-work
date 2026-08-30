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
  return decodeStorageDocument(JSON.parse(value));
}

export function encodeLocalPluginStorageDocument(
  plugins: ReadonlyArray<StoredLocalPlugin>,
): string {
  return JSON.stringify({ version: 1, plugins } satisfies LocalPluginStorageDocument);
}
