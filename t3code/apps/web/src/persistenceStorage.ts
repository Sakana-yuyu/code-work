export type SynchronousStateStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type StorageValueDecoder<T> = (raw: string) => T;
export type StorageValueEncoder<T> = (value: T) => string;

export type StorageMigrationResult<T> = {
  readonly value: T | null;
  readonly source: "canonical" | "legacy" | "none";
};

export function canonicalStorageKey(legacyKey: string): string {
  return legacyKey.startsWith("codework:")
    ? `codework:${legacyKey.slice("codework:".length)}`
    : legacyKey;
}

function decodeStorageValue<T>(raw: string | null, decode: StorageValueDecoder<T>): T | null {
  if (raw === null) return null;
  try {
    return decode(raw);
  } catch {
    return null;
  }
}

export function readAndMigrateStorageValue<T>(input: {
  readonly storage: SynchronousStateStorage;
  readonly canonicalKey: string;
  readonly legacyKey: string;
  readonly decode: StorageValueDecoder<T>;
  readonly encode: StorageValueEncoder<T>;
}): StorageMigrationResult<T> {
  const canonicalRaw = input.storage.getItem(input.canonicalKey);
  const canonical = decodeStorageValue(canonicalRaw, input.decode);
  if (canonical !== null || canonicalRaw !== null) {
    return { value: canonical, source: "canonical" };
  }

  const legacyRaw = input.storage.getItem(input.legacyKey);
  const legacy = decodeStorageValue(legacyRaw, input.decode);
  if (legacy === null || legacyRaw === null) {
    return { value: null, source: "none" };
  }

  const encoded = input.encode(legacy);
  input.storage.setItem(input.canonicalKey, encoded);
  input.storage.removeItem(input.legacyKey);
  return { value: legacy, source: "legacy" };
}

export function createCanonicalFirstStorage(input: {
  readonly storage: SynchronousStateStorage;
  readonly canonicalKey: string;
  readonly legacyKey: string;
  readonly validate?: (raw: string) => boolean;
}): SynchronousStateStorage {
  const validate = input.validate ?? (() => true);
  let migrated = false;
  return {
    getItem: (name) => {
      if (name !== input.canonicalKey || migrated) {
        return input.storage.getItem(name);
      }
      migrated = true;
      return migrateRawStorageValue({
        storage: input.storage as SynchronousStateStorage,
        canonicalKey: input.canonicalKey,
        legacyKey: input.legacyKey,
        validate,
      });
    },
    setItem: (name, value) => input.storage.setItem(name, value),
    removeItem: (name) => input.storage.removeItem(name),
  };
}

export function migrateRawStorageValue(input: {
  readonly storage: SynchronousStateStorage;
  readonly canonicalKey: string;
  readonly legacyKey: string;
  readonly validate: (raw: string) => boolean;
}): string | null {
  const canonicalRaw = input.storage.getItem(input.canonicalKey);
  if (canonicalRaw !== null) {
    return input.validate(canonicalRaw) ? canonicalRaw : null;
  }

  const legacyRaw = input.storage.getItem(input.legacyKey);
  if (legacyRaw === null || !input.validate(legacyRaw)) {
    return null;
  }

  input.storage.setItem(input.canonicalKey, legacyRaw);
  input.storage.removeItem(input.legacyKey);
  return legacyRaw;
}
