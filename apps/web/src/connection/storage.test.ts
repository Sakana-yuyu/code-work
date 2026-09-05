import { ConnectionTransientError } from "@codework/client-runtime/connection";
import { ConnectionCatalogDocument } from "@codework/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, vi } from "vite-plus/test";

import { setCurrentLanguage } from "~/i18n/runtime";

import { createMemoryIndexedDbMigrationDatabase } from "../persistenceIndexedDb";
import { migrateConnectionRuntimeDatabase, makeCatalogBackend, makeCatalogStore } from "./storage";

// 断言英文目录文案，固定语言避免本机 locale 影响。
setCurrentLanguage("en");

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

describe("migrateConnectionRuntimeDatabase", () => {
  it("copies only schema-valid records and preserves canonical keys", async () => {
    const legacy = createMemoryIndexedDbMigrationDatabase({
      stores: {
        catalog: [
          { key: "document", value: JSON.stringify(emptyCatalog) },
          { key: "bad", value: "not-json" },
        ],
      },
    });
    const canonical = createMemoryIndexedDbMigrationDatabase({
      stores: {
        catalog: [{ key: "document", value: "canonical" }],
      },
    });

    const report = await migrateConnectionRuntimeDatabase({ legacy, canonical });

    expect(report).toEqual({
      copiedRecords: 0,
      skippedExistingRecords: 1,
      skippedInvalidRecords: 1,
    });
    expect(await canonical.listRecords("catalog")).toEqual([
      { key: "document", value: "canonical" },
    ]);
    expect(await legacy.listRecords("catalog")).toHaveLength(2);
  });

  it("preserves legacy records when a canonical write fails", async () => {
    const legacy = createMemoryIndexedDbMigrationDatabase({
      stores: { catalog: [{ key: "document", value: JSON.stringify(emptyCatalog) }] },
    });
    const canonical = createMemoryIndexedDbMigrationDatabase({ failWrites: true });

    await expect(migrateConnectionRuntimeDatabase({ legacy, canonical })).rejects.toThrow(
      "migration write failed",
    );
    expect(await legacy.listRecords("catalog")).toHaveLength(1);
  });
});

describe("makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = makeCatalogBackend({} as IDBDatabase);

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );
});
