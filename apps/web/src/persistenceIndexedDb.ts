export interface IndexedDbRecord {
  readonly key: IDBValidKey;
  readonly value: unknown;
}

export interface IndexedDbMigrationDatabase {
  readonly listRecords: (storeName: string) => Promise<readonly IndexedDbRecord[]>;
  readonly putRecord: (storeName: string, key: IDBValidKey, value: unknown) => Promise<void>;
}

export interface IndexedDbStoreMigration {
  readonly storeName: string;
  readonly validate?: (value: unknown) => boolean;
}

export interface IndexedDbMigrationReport {
  readonly copiedRecords: number;
  readonly skippedExistingRecords: number;
  readonly skippedInvalidRecords: number;
}

function keyToken(key: IDBValidKey): string {
  if (key instanceof Date) return `date:${key.toISOString()}`;
  if (key instanceof ArrayBuffer)
    return `array-buffer:${Array.from(new Uint8Array(key)).join(",")}`;
  if (Array.isArray(key)) return `array:${key.map(keyToken).join("|")}`;
  return `${typeof key}:${String(key)}`;
}

export async function migrateIndexedDbStores(input: {
  readonly source: IndexedDbMigrationDatabase;
  readonly target: IndexedDbMigrationDatabase;
  readonly stores: readonly IndexedDbStoreMigration[];
}): Promise<IndexedDbMigrationReport> {
  let copiedRecords = 0;
  let skippedExistingRecords = 0;
  let skippedInvalidRecords = 0;

  for (const store of input.stores) {
    const [sourceRecords, targetRecords] = await Promise.all([
      input.source.listRecords(store.storeName),
      input.target.listRecords(store.storeName),
    ]);
    const existingKeys = new Set(targetRecords.map((record) => keyToken(record.key)));

    for (const record of sourceRecords) {
      if (existingKeys.has(keyToken(record.key))) {
        skippedExistingRecords += 1;
        continue;
      }
      if (store.validate !== undefined && !store.validate(record.value)) {
        skippedInvalidRecords += 1;
        continue;
      }
      await input.target.putRecord(store.storeName, record.key, record.value);
      existingKeys.add(keyToken(record.key));
      copiedRecords += 1;
    }
  }

  return { copiedRecords, skippedExistingRecords, skippedInvalidRecords };
}

export function createNativeIndexedDbMigrationDatabase(
  database: IDBDatabase,
): IndexedDbMigrationDatabase {
  return {
    listRecords: (storeName) =>
      new Promise<readonly IndexedDbRecord[]>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(storeName, "readonly");
        } catch (cause) {
          reject(cause);
          return;
        }
        const records: IndexedDbRecord[] = [];
        const request = transaction.objectStore(storeName).openCursor();
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB cursor read failed.")),
        );
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (cursor === null) {
            resolve(records);
            return;
          }
          records.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        });
      }),
    putRecord: (storeName, key, value) =>
      new Promise<void>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
          transaction = database.transaction(storeName, "readwrite");
        } catch (cause) {
          reject(cause);
          return;
        }
        transaction.addEventListener("error", () =>
          reject(transaction.error ?? new Error("IndexedDB write failed.")),
        );
        transaction.addEventListener("complete", () => resolve());
        transaction.objectStore(storeName).put(value, key);
      }),
  };
}

export function createMemoryIndexedDbMigrationDatabase(input?: {
  readonly stores?: Readonly<Record<string, readonly IndexedDbRecord[]>>;
  readonly failWrites?: boolean;
}): IndexedDbMigrationDatabase & {
  readonly records: ReadonlyMap<string, ReadonlyMap<string, IndexedDbRecord>>;
} {
  const stores = new Map<string, Map<string, IndexedDbRecord>>();
  for (const [storeName, records] of Object.entries(input?.stores ?? {})) {
    stores.set(storeName, new Map(records.map((record) => [keyToken(record.key), record])));
  }

  return {
    get records() {
      return stores;
    },
    listRecords: async (storeName) => [...(stores.get(storeName)?.values() ?? [])],
    putRecord: async (storeName, key, value) => {
      if (input?.failWrites === true) throw new Error("IndexedDB migration write failed.");
      const store = stores.get(storeName) ?? new Map<string, IndexedDbRecord>();
      store.set(keyToken(key), { key, value });
      stores.set(storeName, store);
    },
  };
}

export async function indexedDbDatabaseExists(
  databaseName: string,
  factory: IDBFactory = globalThis.indexedDB,
): Promise<boolean | null> {
  const listDatabases = (
    factory as IDBFactory & {
      readonly databases?: () => Promise<readonly { readonly name?: string }[]>;
    }
  ).databases;
  if (listDatabases === undefined) return null;
  const databases = await listDatabases.call(factory);
  return databases.some((database) => database.name === databaseName);
}
