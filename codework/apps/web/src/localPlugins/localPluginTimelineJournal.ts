import {
  decodeLocalPluginTimelineStorageDocument,
  encodeLocalPluginTimelineStorageDocument,
  type LocalPluginTimelineStorage,
  type StoredLocalPluginTimelineEvent,
} from "./localPluginTimelineStorage";

export interface LocalPluginTimelineJournalSnapshot {
  readonly events: ReadonlyArray<StoredLocalPluginTimelineEvent>;
}

type Listener = () => void;

export class LocalPluginTimelineJournal {
  private snapshot: LocalPluginTimelineJournalSnapshot = { events: [] };
  private readonly listeners = new Set<Listener>();
  private sequence = 0;

  constructor(
    private readonly options: {
      readonly storage: LocalPluginTimelineStorage;
      readonly now: () => number;
      readonly makeId: (sequence: number) => string;
      readonly maxEntriesPerThread?: number;
      readonly maxEntries?: number;
    },
  ) {}

  getSnapshot = (): LocalPluginTimelineJournalSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  restore(): void {
    const value = this.options.storage.read();
    const events =
      value === null ? [] : [...decodeLocalPluginTimelineStorageDocument(value).events];
    this.publish(events);
  }

  list(threadKey: string): ReadonlyArray<StoredLocalPluginTimelineEvent> {
    return this.snapshot.events.filter((event) => event.threadKey === threadKey);
  }

  append(
    input: Omit<StoredLocalPluginTimelineEvent, "id" | "createdAt">,
  ): StoredLocalPluginTimelineEvent {
    let id: string;
    do {
      this.sequence += 1;
      id = this.options.makeId(this.sequence);
    } while (this.snapshot.events.some((event) => event.id === id));
    const event: StoredLocalPluginTimelineEvent = {
      ...input,
      id,
      createdAt: new Date(this.options.now()).toISOString(),
    };
    const maxEntriesPerThread = this.options.maxEntriesPerThread ?? 100;
    const maxEntries = this.options.maxEntries ?? 500;
    const appended = [...this.snapshot.events, event].toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const threadEvents = appended
      .filter((candidate) => candidate.threadKey === event.threadKey)
      .slice(-maxEntriesPerThread);
    const keptThreadEventIds = new Set(threadEvents.map((candidate) => candidate.id));
    const next = appended
      .filter(
        (candidate) =>
          candidate.threadKey !== event.threadKey || keptThreadEventIds.has(candidate.id),
      )
      .slice(-maxEntries);

    this.options.storage.write(encodeLocalPluginTimelineStorageDocument(next));
    this.publish(next);
    return event;
  }

  private publish(events: ReadonlyArray<StoredLocalPluginTimelineEvent>): void {
    this.snapshot = { events: [...events] };
    for (const listener of this.listeners) listener();
  }
}
