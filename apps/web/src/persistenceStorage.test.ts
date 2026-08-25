import { describe, expect, it } from "vite-plus/test";

import {
  canonicalStorageKey,
  createCanonicalFirstStorage,
  migrateRawStorageValue,
  readAndMigrateStorageValue,
} from "./persistenceStorage";

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("persistenceStorage", () => {
  it("derives Code Work keys from legacy t3code keys", () => {
    expect(canonicalStorageKey("t3code:client-settings:v1")).toBe("codework:client-settings:v1");
  });

  it("reads canonical values without touching legacy values", () => {
    const storage = createStorage({
      "codework:settings": JSON.stringify({ version: 2 }),
      "t3code:settings": JSON.stringify({ version: 1 }),
    });

    const result = readAndMigrateStorageValue({
      storage,
      canonicalKey: "codework:settings",
      legacyKey: "t3code:settings",
      decode: JSON.parse,
      encode: JSON.stringify,
    });

    expect(result).toEqual({ value: { version: 2 }, source: "canonical" });
    expect(storage.values.get("t3code:settings")).toBe(JSON.stringify({ version: 1 }));
  });

  it("writes validated legacy values canonically before removing the legacy value", () => {
    const storage = createStorage({ "t3code:settings": JSON.stringify({ version: 1 }) });

    const result = readAndMigrateStorageValue({
      storage,
      canonicalKey: "codework:settings",
      legacyKey: "t3code:settings",
      decode: JSON.parse,
      encode: JSON.stringify,
    });

    expect(result).toEqual({ value: { version: 1 }, source: "legacy" });
    expect(storage.values.get("codework:settings")).toBe(JSON.stringify({ version: 1 }));
    expect(storage.values.has("t3code:settings")).toBe(false);
  });

  it("keeps the legacy value when canonical writing fails", () => {
    const storage = createStorage({ "t3code:settings": JSON.stringify({ version: 1 }) });
    storage.setItem = () => {
      throw new Error("quota exceeded");
    };

    expect(() =>
      readAndMigrateStorageValue({
        storage,
        canonicalKey: "codework:settings",
        legacyKey: "t3code:settings",
        decode: JSON.parse,
        encode: JSON.stringify,
      }),
    ).toThrow("quota exceeded");
    expect(storage.values.get("t3code:settings")).toBe(JSON.stringify({ version: 1 }));
  });

  it("does not use legacy data when canonical data is malformed", () => {
    const storage = createStorage({
      "codework:settings": "not-json",
      "t3code:settings": JSON.stringify({ version: 1 }),
    });

    expect(
      migrateRawStorageValue({
        storage,
        canonicalKey: "codework:settings",
        legacyKey: "t3code:settings",
        validate: (raw) => raw.startsWith("{") && raw.endsWith("}"),
      }),
    ).toBeNull();
    expect(storage.values.get("t3code:settings")).toBe(JSON.stringify({ version: 1 }));
  });

  it("promotes legacy values through the canonical-first storage wrapper", () => {
    const storage = createStorage({ "t3code:settings": JSON.stringify({ version: 1 }) });
    const canonical = createCanonicalFirstStorage({
      storage,
      canonicalKey: "codework:settings",
      legacyKey: "t3code:settings",
      validate: (raw) => raw.startsWith("{") && raw.endsWith("}"),
    });

    expect(canonical.getItem("codework:settings")).toBe(JSON.stringify({ version: 1 }));
    expect(storage.values.get("codework:settings")).toBe(JSON.stringify({ version: 1 }));
    expect(storage.values.has("t3code:settings")).toBe(false);
  });

  it("does not migrate malformed legacy raw values", () => {
    const storage = createStorage({ "t3code:settings": "not-json" });

    expect(
      migrateRawStorageValue({
        storage,
        canonicalKey: "codework:settings",
        legacyKey: "t3code:settings",
        validate: (raw) => {
          try {
            JSON.parse(raw);
            return true;
          } catch {
            return false;
          }
        },
      }),
    ).toBeNull();
    expect(storage.values.has("t3code:settings")).toBe(true);
  });
});
