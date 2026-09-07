// @effect-diagnostics globalDateInEffect:off nodeBuiltinImport:off - 对账节流按墙上时间判断；watcher 需要递归 fs.watch。
/**
 * CodeIndexService - per-workspace-root symbol index with incremental refresh.
 *
 * One `CodeIndexRoot` resource per workspace root, managed by a LayerMap with
 * a 15-minute idle TTL (same lifecycle as `WorkspaceSearchIndexMap`). Opening
 * a root runs a full FileFinder scan (gitignore-respecting) and starts a
 * recursive fs watcher. Watch events only mark paths pending; the debounced
 * trailing flush re-extracts them, and every reconcile ends by flushing its
 * own queue inline in the caller's fiber — so both MCP queries and tests get
 * deterministic freshness without waiting on background fibers.
 *
 * @module CodeIndexService
 */
import { FileFinder } from "@ff-labs/fff-node";
import { isCodeworkCanvasArtifactPath } from "@codework/shared/path";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { codeIndexLanguageOf, extractSymbols, type ExtractedSymbol } from "./SymbolExtractor.ts";
import {
  CodeIndexStore,
  layerCodeIndexStore,
  type IndexedFileRecord,
  type IndexedSymbol,
} from "./CodeIndexStore.ts";

const CODE_INDEX_IDLE_TTL = "15 minutes";
const CODE_INDEX_SCAN_TIMEOUT_MS = 15_000;
/** Initial-scan and reconcile listings cap; matches the workspace search index ceiling. */
const CODE_INDEX_MAX_FILES = 25_000;
/** Declaration-line extraction is useless past this size; skip instead of stalling the flush. */
const CODE_INDEX_MAX_FILE_BYTES = 1_000_000;
/** Watcher activity settles for this long before the trailing flush runs. */
const CODE_INDEX_FLUSH_QUIET_MS = 300;
/** MCP queries older than this trigger an mtime reconcile before answering. */
const CODE_INDEX_RECONCILE_MIN_INTERVAL_MS = 10 * 60_000;

export class CodeIndexError extends Schema.TaggedErrorClass<CodeIndexError>()("CodeIndexError", {
  root: Schema.String,
  operation: Schema.String,
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Code index ${this.operation} failed for '${this.root}': ${this.reason}`;
  }
}

export interface CodeIndexRootStatus {
  readonly state: "indexing" | "idle";
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly lastIndexedAtUnixMs: number | null;
}

export interface CodeIndexSearchInput {
  readonly query: string;
  readonly kind?: string | undefined;
  readonly limit: number;
}

export class CodeIndexRoot extends Context.Service<
  CodeIndexRoot,
  {
    /** Current counts plus whether paths are still pending extraction. */
    readonly status: () => Effect.Effect<CodeIndexRootStatus, CodeIndexError>;
    /** Substring symbol lookup against the indexed root. */
    readonly search: (
      input: CodeIndexSearchInput,
    ) => Effect.Effect<ReadonlyArray<IndexedSymbol>, CodeIndexError>;
    /** Declarations of one root-relative file, ordered by line. */
    readonly fileSymbols: (
      path: string,
    ) => Effect.Effect<ReadonlyArray<ExtractedSymbol>, CodeIndexError>;
    /** mtime/size reconcile against the filesystem, flushing its own queue inline. */
    readonly reconcile: () => Effect.Effect<void, CodeIndexError>;
    /**
     * Watcher event handler; the production stream taps this. Exposed so tests
     * drive "new file appears" deterministically instead of racing fs events.
     */
    readonly handleWatchEvent: (event: { readonly filename: string | null }) => Effect.Effect<void>;
    /** Extract symbols for everything currently pending, in the caller's fiber. */
    readonly flushPending: () => Effect.Effect<void>;
  }
>()("codework/codeIndex/CodeIndexService/CodeIndexRoot") {}

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/** Root-relative posix path; watcher filenames and FileFinder listings share this shape. */
const normalizeRelativePath = (filename: string): string =>
  toPosixPath(filename).replace(/^\.\//, "").replace(/\/$/, "");

const isIndexablePath = (relativePath: string): boolean =>
  codeIndexLanguageOf(relativePath) !== undefined &&
  !isCodeworkCanvasArtifactPath(relativePath) &&
  !relativePath.split("/").includes("node_modules");

const createFinder = Effect.fn("CodeIndexRoot.createFinder")(function* (root: string) {
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: root,
        disableMmapCache: true,
        // Symbol indexing only needs paths and fresh listings; content search
        // has its own on-demand index in WorkspaceSearchIndex.
        disableContentIndexing: true,
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new CodeIndexError({ root, operation: "open", reason: "FileFinder.create threw.", cause }),
  });
  if (!result.ok) {
    return yield* new CodeIndexError({ root, operation: "open", reason: result.error });
  }
  const ready = yield* Effect.tryPromise({
    try: () => result.value.waitForIndexReady(CODE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      new CodeIndexError({
        root,
        operation: "open",
        reason: "FileFinder.waitForIndexReady rejected.",
        cause,
      }),
  });
  if (!ready) {
    return yield* new CodeIndexError({
      root,
      operation: "open",
      reason: `FileFinder did not become ready within ${CODE_INDEX_SCAN_TIMEOUT_MS}ms.`,
    });
  }
  return result.value;
});

export const makeCodeIndexRoot = Effect.fn("makeCodeIndexRoot")(function* (
  root: string,
): Effect.fn.Return<
  CodeIndexRoot["Service"],
  CodeIndexError,
  CodeIndexStore | Scope.Scope | FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const store = yield* CodeIndexStore;
  const normalizedRoot = NodePath.resolve(root);
  const rootKey = normalizedRoot;

  const finder = yield* Effect.acquireRelease(createFinder(normalizedRoot), (instance) =>
    Effect.sync(() => instance.destroy()),
  );

  const pending = yield* Ref.make(new Set<string>());
  const lastReconcileAtMs = yield* Ref.make(0);

  const statFile = (absolutePath: string) =>
    fs.stat(absolutePath).pipe(Effect.orElseSucceed(() => undefined));

  const mtimeMsOf = (stat: { readonly mtime: Option.Option<Date> }): number =>
    Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0;

  const processFile = Effect.fn("CodeIndexRoot.processFile")(function* (relativePath: string) {
    const absolutePath = NodePath.join(normalizedRoot, relativePath);
    const stat = yield* statFile(absolutePath);
    const sizeBytes = stat === undefined ? 0 : Number(stat.size);
    // Deleted, replaced by a directory, renamed to a non-code extension, or
    // oversized: the file must not keep stale rows.
    if (
      stat === undefined ||
      stat.type !== "File" ||
      sizeBytes > CODE_INDEX_MAX_FILE_BYTES ||
      !isIndexablePath(relativePath)
    ) {
      yield* store.removeFile(rootKey, relativePath).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Code index could not drop stale file", {
            rootKey,
            relativePath,
            cause,
          }),
        ),
      );
      return;
    }
    const text = yield* fs.readFileString(absolutePath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Code index could not read file", {
          rootKey,
          relativePath,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (text === null) return;
    const symbols = extractSymbols(relativePath, text);
    yield* store
      .replaceFile({
        rootKey,
        file: { path: relativePath, mtimeMs: mtimeMsOf(stat), size: sizeBytes },
        symbols,
        indexedAtUnixMs: Date.now(),
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Code index could not persist file", { rootKey, relativePath, cause }),
        ),
      );
  });

  const queuePath = (relativePath: string) =>
    Ref.update(pending, (set) => {
      set.add(relativePath);
      return set;
    });

  const flushPending = Effect.fn("CodeIndexRoot.flushPending")(function* () {
    const queued = yield* Ref.getAndUpdate(pending, () => new Set<string>());
    for (const relativePath of queued) {
      yield* processFile(relativePath);
    }
  });

  /**
   * FileFinder caches its tree index; reconcile must rescan before listing or
   * it compares against a stale snapshot and misses new files.
   */
  const refreshFinder = Effect.fn("CodeIndexRoot.refreshFinder")(function* () {
    const scanned = yield* Effect.try({
      try: () => finder.scanFiles(),
      catch: (cause) =>
        new CodeIndexError({
          root,
          operation: "scan",
          reason: "FileFinder.scanFiles threw.",
          cause,
        }),
    });
    if (!scanned.ok) {
      return yield* new CodeIndexError({ root, operation: "scan", reason: scanned.error });
    }
    const ready = yield* Effect.tryPromise({
      try: () => finder.waitForIndexReady(CODE_INDEX_SCAN_TIMEOUT_MS),
      catch: (cause) =>
        new CodeIndexError({
          root,
          operation: "scan",
          reason: "FileFinder.waitForIndexReady rejected.",
          cause,
        }),
    });
    if (!ready) {
      return yield* new CodeIndexError({
        root,
        operation: "scan",
        reason: `FileFinder did not become ready within ${CODE_INDEX_SCAN_TIMEOUT_MS}ms.`,
      });
    }
  });

  const listIndexableFiles = Effect.fn("CodeIndexRoot.listIndexableFiles")(function* () {
    const result = yield* Effect.try({
      try: () => finder.fileSearch("", { pageSize: CODE_INDEX_MAX_FILES }),
      catch: (cause) =>
        new CodeIndexError({
          root,
          operation: "scan",
          reason: "FileFinder.fileSearch threw.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new CodeIndexError({ root, operation: "scan", reason: result.error });
    }
    return result.value.items
      .map((item) => normalizeRelativePath(item.relativePath))
      .filter(isIndexablePath);
  });

  /**
   * Full mtime/size pass: prunes vanished files, re-extracts changed and new
   * ones. Doubles as the initial scan on root open.
   */
  const reconcile = Effect.fn("CodeIndexRoot.reconcile")(function* () {
    yield* refreshFinder();
    const freshPaths = yield* listIndexableFiles();
    const storedFiles = yield* store.files(rootKey).pipe(
      Effect.mapError(
        (cause) =>
          new CodeIndexError({
            root,
            operation: "reconcile",
            reason: "store files failed.",
            cause,
          }),
      ),
    );
    const storedByPath = new Map<string, IndexedFileRecord>(
      storedFiles.map((record) => [record.path, record]),
    );
    const freshSet = new Set(freshPaths);
    for (const record of storedFiles) {
      if (freshSet.has(record.path)) continue;
      yield* store.removeFile(rootKey, record.path).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Code index could not prune vanished file", {
            rootKey,
            path: record.path,
            cause,
          }),
        ),
      );
    }
    for (const relativePath of freshPaths) {
      const existing = storedByPath.get(relativePath);
      const stat = yield* statFile(NodePath.join(normalizedRoot, relativePath));
      if (stat === undefined) continue;
      const sizeBytes = Number(stat.size);
      if (existing && existing.mtimeMs === mtimeMsOf(stat) && existing.size === sizeBytes) continue;
      yield* queuePath(relativePath);
    }
    yield* flushPending();
    yield* Ref.set(lastReconcileAtMs, Date.now());
  });

  // Recursive watching is not exposed by Effect FileSystem; fs.promises.watch
  // provides it on every platform this server supports. Events only mark
  // paths pending; once activity quiets down the trailing flush re-extracts
  // them, and the next reconcile catches renames the watcher swallowed.
  const handleWatchEvent = (event: { readonly filename: string | null }): Effect.Effect<void> => {
    const filename = typeof event.filename === "string" ? event.filename : null;
    if (filename === null) return Effect.void;
    const relativePath = normalizeRelativePath(filename);
    return isIndexablePath(relativePath) ? queuePath(relativePath) : Effect.void;
  };
  const abortWatch = yield* Effect.sync(() => new AbortController());
  const watchEvents = yield* Effect.try({
    try: () =>
      NodeFSP.watch(normalizedRoot, {
        recursive: true,
        signal: abortWatch.signal,
      }),
    catch: (cause) =>
      new CodeIndexError({ root, operation: "watch", reason: "fs.watch threw.", cause }),
  });
  yield* Stream.fromAsyncIterable(
    watchEvents,
    (cause) =>
      new CodeIndexError({ root, operation: "watch", reason: "fs.watch iterator failed.", cause }),
  ).pipe(
    Stream.tap(handleWatchEvent),
    Stream.debounce(Duration.millis(CODE_INDEX_FLUSH_QUIET_MS)),
    Stream.runForEach(() =>
      flushPending().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Code index trailing flush failed", { rootKey, cause }),
        ),
      ),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  // Registered after the fork so scope close aborts the iterator before the
  // fiber interrupt unwinds the stream.
  const watchScope = yield* Effect.scope;
  yield* Scope.addFinalizer(
    watchScope,
    Effect.sync(() => abortWatch.abort()),
  );

  // Initial scan enqueues the whole tree and flushes inline, so the first
  // status/query already sees the project's declarations.
  yield* reconcile().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Code index initial reconcile failed", { rootKey, cause }),
    ),
  );

  const maybeReconcileBeforeQuery = Effect.fn("CodeIndexRoot.maybeReconcileBeforeQuery")(
    function* () {
      const last = yield* Ref.get(lastReconcileAtMs);
      if (Date.now() - last < CODE_INDEX_RECONCILE_MIN_INTERVAL_MS) return;
      yield* reconcile().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Code index pre-query reconcile failed", { rootKey, cause }),
        ),
      );
    },
  );

  const status = Effect.fn("CodeIndexRoot.status")(function* (): Effect.fn.Return<
    CodeIndexRootStatus,
    CodeIndexError
  > {
    const stats = yield* store
      .stats(rootKey)
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodeIndexError({ root, operation: "status", reason: "store stats failed.", cause }),
        ),
      );
    const backlog = yield* Ref.get(pending);
    return {
      state: backlog.size > 0 ? "indexing" : "idle",
      ...stats,
    };
  });

  const search = Effect.fn("CodeIndexRoot.search")(function* (input: CodeIndexSearchInput) {
    yield* maybeReconcileBeforeQuery();
    return yield* store.searchSymbols({ rootKey, ...input }).pipe(
      Effect.mapError(
        (cause) =>
          new CodeIndexError({
            root,
            operation: "search",
            reason: "store search failed.",
            cause,
          }),
      ),
    );
  });

  const fileSymbols = Effect.fn("CodeIndexRoot.fileSymbols")(function* (path: string) {
    const relativePath = normalizeRelativePath(path);
    if (!isIndexablePath(relativePath)) return [];
    return yield* store.fileSymbols(rootKey, relativePath).pipe(
      Effect.mapError(
        (cause) =>
          new CodeIndexError({
            root,
            operation: "fileSymbols",
            reason: "store lookup failed.",
            cause,
          }),
      ),
    );
  });

  return CodeIndexRoot.of({
    status,
    search,
    fileSymbols,
    reconcile,
    handleWatchEvent,
    flushPending,
  });
});

export const layerCodeIndexRoot = (root: string) =>
  Layer.effect(CodeIndexRoot, makeCodeIndexRoot(root));

export class CodeIndexRootMap extends LayerMap.Service<CodeIndexRootMap>()(
  "codework/codeIndex/CodeIndexService/CodeIndexRootMap",
  {
    lookup: layerCodeIndexRoot,
    idleTimeToLive: CODE_INDEX_IDLE_TTL,
  },
) {}

/** Everything the MCP index toolkit needs on top of the ambient node services. */
export const CodeIndexServerLive = Layer.mergeAll(
  CodeIndexRootMap.layer.pipe(Layer.provide(layerCodeIndexStore)),
  layerCodeIndexStore,
);
