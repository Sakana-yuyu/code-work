// @effect-diagnostics globalDateInEffect:off nodeBuiltinImport:off - 索引时间戳按墙上时间记录；node:sqlite 无 Effect 等价。
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ExtractedSymbol } from "./SymbolExtractor.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

export class CodeIndexStoreError extends Schema.TaggedErrorClass<CodeIndexStoreError>()(
  "CodeIndexStoreError",
  {
    operation: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Code index store ${this.operation} failed: ${this.reason}`;
  }
}

export interface IndexedFileRecord {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** A symbol match joined with its file path; the shape MCP queries return. */
export interface IndexedSymbol extends ExtractedSymbol {
  readonly path: string;
}

export interface CodeIndexStats {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly lastIndexedAtUnixMs: number | null;
}

const SCHEMA_STATEMENTS = [
  // One row per indexed file; (mtime, size) is the reconcile fingerprint.
  `CREATE TABLE IF NOT EXISTS files (
    root_key TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (root_key, path)
  )`,
  `CREATE TABLE IF NOT EXISTS symbols (
    root_key TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    name_lower TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    parent TEXT,
    PRIMARY KEY (root_key, path, name, kind, line)
  )`,
  `CREATE INDEX IF NOT EXISTS symbols_name_lookup ON symbols (root_key, name_lower)`,
  `CREATE TABLE IF NOT EXISTS roots (
    root_key TEXT PRIMARY KEY,
    last_indexed_at_unix_ms INTEGER
  )`,
];

/** LIKE is a substring search; % and _ in the user query are literals. */
function likePattern(query: string): string {
  return `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

export const makeCodeIndexStore = Effect.fn("makeCodeIndexStore")(function* (filename: string) {
  const db = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        // The store may be built before ensureServerDirectories runs (tests,
        // alternate assemblies); sqlite won't create missing parent dirs.
        if (filename !== ":memory:") {
          NodeFS.mkdirSync(NodePath.dirname(filename), { recursive: true });
        }
        const database = new NodeSqlite.DatabaseSync(filename);
        database.exec("PRAGMA busy_timeout = 5000;");
        if (filename !== ":memory:") {
          // A disposable cache still wants crash safety against the shared state dir.
          database.exec("PRAGMA journal_mode = WAL;");
        }
        for (const statement of SCHEMA_STATEMENTS) {
          database.exec(statement);
        }
        return database;
      },
      catch: (cause) =>
        new CodeIndexStoreError({ operation: "open", reason: "sqlite open threw.", cause }),
    }),
    (database) =>
      Effect.try({
        try: () => database.close(),
        catch: (cause) =>
          new CodeIndexStoreError({ operation: "close", reason: "sqlite close threw.", cause }),
      }).pipe(Effect.orDie),
  );

  const run = <A>(operation: string, execute: (database: NodeSqlite.DatabaseSync) => A) =>
    Effect.try({
      try: () => execute(db),
      catch: (cause) =>
        new CodeIndexStoreError({ operation, reason: "sqlite statement threw.", cause }),
    });

  const inTransaction = <A>(operation: string, execute: (database: NodeSqlite.DatabaseSync) => A) =>
    Effect.try({
      try: () => {
        db.exec("BEGIN");
        try {
          const result = execute(db);
          db.exec("COMMIT");
          return result;
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      },
      catch: (cause) =>
        new CodeIndexStoreError({ operation, reason: "sqlite transaction threw.", cause }),
    });

  const replaceFile = (input: {
    readonly rootKey: string;
    readonly file: IndexedFileRecord;
    readonly symbols: ReadonlyArray<ExtractedSymbol>;
    readonly indexedAtUnixMs: number;
  }) =>
    inTransaction("replaceFile", (database) => {
      database
        .prepare("DELETE FROM symbols WHERE root_key = ? AND path = ?")
        .run(input.rootKey, input.file.path);
      database
        .prepare(
          `INSERT INTO files (root_key, path, mtime_ms, size) VALUES (?, ?, ?, ?)
           ON CONFLICT (root_key, path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
        )
        .run(input.rootKey, input.file.path, input.file.mtimeMs, input.file.size);
      const insertSymbol = database.prepare(
        "INSERT OR IGNORE INTO symbols (root_key, path, name, name_lower, kind, line, parent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const symbol of input.symbols) {
        insertSymbol.run(
          input.rootKey,
          input.file.path,
          symbol.name,
          symbol.name.toLowerCase(),
          symbol.kind,
          symbol.line,
          symbol.parent ?? null,
        );
      }
      database
        .prepare(
          `INSERT INTO roots (root_key, last_indexed_at_unix_ms) VALUES (?, ?)
           ON CONFLICT (root_key) DO UPDATE SET last_indexed_at_unix_ms = excluded.last_indexed_at_unix_ms`,
        )
        .run(input.rootKey, input.indexedAtUnixMs);
    });

  const removeFile = (rootKey: string, path: string) =>
    inTransaction("removeFile", (database) => {
      database.prepare("DELETE FROM symbols WHERE root_key = ? AND path = ?").run(rootKey, path);
      database.prepare("DELETE FROM files WHERE root_key = ? AND path = ?").run(rootKey, path);
    });

  const removeRoot = (rootKey: string) =>
    inTransaction("removeRoot", (database) => {
      database.prepare("DELETE FROM symbols WHERE root_key = ?").run(rootKey);
      database.prepare("DELETE FROM files WHERE root_key = ?").run(rootKey);
      database.prepare("DELETE FROM roots WHERE root_key = ?").run(rootKey);
    });

  const files = (rootKey: string) =>
    run(
      "files",
      (database) =>
        database
          .prepare("SELECT path, mtime_ms AS mtimeMs, size FROM files WHERE root_key = ?")
          .all(rootKey) as unknown as ReadonlyArray<IndexedFileRecord>,
    );

  const fileSymbols = (rootKey: string, path: string) =>
    run("fileSymbols", (database) =>
      (
        database
          .prepare(
            "SELECT path, name, kind, line, parent FROM symbols WHERE root_key = ? AND path = ? ORDER BY line",
          )
          .all(rootKey, path) as unknown as ReadonlyArray<
          Omit<IndexedSymbol, "parent"> & { parent: string | null }
        >
      ).map(({ parent, ...symbol }) => (parent === null ? symbol : { ...symbol, parent })),
    );

  const searchSymbols = (input: {
    readonly rootKey: string;
    readonly query: string;
    readonly kind?: string | undefined;
    readonly limit: number;
  }) =>
    run("searchSymbols", (database) => {
      const pattern = likePattern(input.query);
      const rows = (input.kind === undefined
        ? database
            .prepare(
              `SELECT path, name, kind, line, parent FROM symbols
                 WHERE root_key = ? AND name_lower LIKE ? ESCAPE '\\' ORDER BY name_lower, line LIMIT ?`,
            )
            .all(input.rootKey, pattern, input.limit)
        : database
            .prepare(
              `SELECT path, name, kind, line, parent FROM symbols
                 WHERE root_key = ? AND name_lower LIKE ? ESCAPE '\\' AND kind = ? ORDER BY name_lower, line LIMIT ?`,
            )
            .all(input.rootKey, pattern, input.kind, input.limit)) as unknown as ReadonlyArray<
        Omit<IndexedSymbol, "parent"> & { parent: string | null }
      >;
      return rows.map(({ parent, ...symbol }) =>
        parent === null ? symbol : { ...symbol, parent },
      );
    });

  const stats = (rootKey: string) =>
    run("stats", (database) => {
      const fileCount = (
        database.prepare("SELECT COUNT(*) AS count FROM files WHERE root_key = ?").get(rootKey) as {
          count: number;
        }
      ).count;
      const symbolCount = (
        database
          .prepare("SELECT COUNT(*) AS count FROM symbols WHERE root_key = ?")
          .get(rootKey) as { count: number }
      ).count;
      const projectRow = database
        .prepare(
          "SELECT last_indexed_at_unix_ms AS lastIndexedAtUnixMs FROM roots WHERE root_key = ?",
        )
        .get(rootKey) as { lastIndexedAtUnixMs: number | null } | undefined;
      return {
        fileCount,
        symbolCount,
        lastIndexedAtUnixMs: projectRow?.lastIndexedAtUnixMs ?? null,
      } satisfies CodeIndexStats;
    });

  return CodeIndexStore.of({
    replaceFile,
    removeFile,
    removeRoot,
    files,
    fileSymbols,
    searchSymbols,
    stats,
  });
});

export interface CodeIndexStoreService {
  readonly replaceFile: (input: {
    readonly rootKey: string;
    readonly file: IndexedFileRecord;
    readonly symbols: ReadonlyArray<ExtractedSymbol>;
    readonly indexedAtUnixMs: number;
  }) => Effect.Effect<void, CodeIndexStoreError>;
  readonly removeFile: (rootKey: string, path: string) => Effect.Effect<void, CodeIndexStoreError>;
  readonly removeRoot: (rootKey: string) => Effect.Effect<void, CodeIndexStoreError>;
  readonly files: (
    rootKey: string,
  ) => Effect.Effect<ReadonlyArray<IndexedFileRecord>, CodeIndexStoreError>;
  readonly fileSymbols: (
    rootKey: string,
    path: string,
  ) => Effect.Effect<ReadonlyArray<ExtractedSymbol>, CodeIndexStoreError>;
  readonly searchSymbols: (input: {
    readonly rootKey: string;
    readonly query: string;
    readonly kind?: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<IndexedSymbol>, CodeIndexStoreError>;
  readonly stats: (rootKey: string) => Effect.Effect<CodeIndexStats, CodeIndexStoreError>;
}

export class CodeIndexStore extends Context.Service<CodeIndexStore, CodeIndexStoreService>()(
  "codework/codeIndex/CodeIndexStore",
) {}

/**
 * The index is a disposable cache, so it lives in its own sqlite file under
 * the state dir instead of the event-sourced state database.
 */
export const layerCodeIndexStore = Layer.unwrap(
  Effect.gen(function* () {
    const { codeIndexDir } = yield* ServerConfig;
    return layerCodeIndexStoreFor(NodePath.join(codeIndexDir, "index.sqlite"));
  }),
);

export const layerCodeIndexStoreFor = (filename: string) =>
  Layer.effect(CodeIndexStore, makeCodeIndexStore(filename));
