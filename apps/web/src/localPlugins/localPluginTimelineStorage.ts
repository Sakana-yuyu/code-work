import { TrimmedNonEmptyString } from "@codework/contracts";
import * as Schema from "effect/Schema";

const LocalPluginTimelineEvent = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  threadKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  pluginId: TrimmedNonEmptyString.check(Schema.isMaxLength(96)),
  timelineId: TrimmedNonEmptyString.check(Schema.isMaxLength(96)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  tone: Schema.Literals(["info", "success", "warning", "error"]),
  createdAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});

const LocalPluginTimelineStorageDocument = Schema.Struct({
  version: Schema.Literal(1),
  events: Schema.Array(LocalPluginTimelineEvent).check(Schema.isMaxLength(500)),
});

export type StoredLocalPluginTimelineEvent = typeof LocalPluginTimelineEvent.Type;
export type LocalPluginTimelineStorageDocument = typeof LocalPluginTimelineStorageDocument.Type;

const decodeStorageDocument = Schema.decodeUnknownSync(LocalPluginTimelineStorageDocument);

export interface LocalPluginTimelineStorage {
  read(): string | null;
  write(value: string): void;
}

export class BrowserLocalPluginTimelineStorage implements LocalPluginTimelineStorage {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly key = "codework:local-plugin-timeline:v1",
  ) {}

  read(): string | null {
    return this.storage.getItem(this.key);
  }

  write(value: string): void {
    this.storage.setItem(this.key, value);
  }
}

export function decodeLocalPluginTimelineStorageDocument(
  value: string,
): LocalPluginTimelineStorageDocument {
  const document = decodeStorageDocument(JSON.parse(value));
  for (const event of document.events) {
    const timestamp = Date.parse(event.createdAt);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== event.createdAt) {
      throw new Error(`本地插件 Timeline 事件 ${event.id} 的时间无效。`);
    }
  }
  return document;
}

export function encodeLocalPluginTimelineStorageDocument(
  events: ReadonlyArray<StoredLocalPluginTimelineEvent>,
): string {
  return JSON.stringify({ version: 1, events } satisfies LocalPluginTimelineStorageDocument);
}
