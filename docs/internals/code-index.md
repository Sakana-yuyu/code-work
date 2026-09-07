# Code index

> For maintainers. Using Code Work? See [docs/user](../user/). User-facing behavior is documented in [../user/code-index.md](../user/code-index.md).

A per-workspace declaration index that lets agents resolve "where is this symbol defined" and "what does this file contain" through the `code-work` MCP server instead of grep-style exploration. It is a **disposable cache**: never event-sourced, never authoritative, always rebuildable.

## Constraints

- **Disposable cache, not state.** The index lives in `<stateDir>/index/index.sqlite`, separate from the event-sourced `state.sqlite`. It stores symbol declarations (name/kind/line/parent), file mtime fingerprints, and per-root stats — never file contents. Deleting the file at rest is always safe; the next reconcile rebuilds it.
- **Fresh enough without guarantees.** Two layers keep it current: a recursive `fs.watch` per root (debounced 300 ms) folds in changes as they land, and a throttled (10-minute) mtime/size reconcile backfills anything the watcher missed before a query reads stale data. "Eventually indexed" is the contract; "instantly indexed" is not.
- **Bounded.** Per root: max 25,000 indexable files, max 1 MB per file, `node_modules` and canvas artifacts excluded. The index must never become a background hog on large checkouts.
- **Capability-gated.** The MCP tools exist for every session, but `McpInvocationContext.requireMcpCapability("index")` rejects sessions whose credential was issued without the capability. `ProviderService.prepareMcpSession` appends `"index"` only when `ServerSettings.codeIndexEnabled` is on, read at session-attach time.

## Where things live

- `packages/contracts/src/codeIndex.ts` — wire shapes: status RPC types, MCP tool inputs/results, `CodeIndexUnavailableError`.
- `apps/server/src/codeIndex/SymbolExtractor.ts` — pure function `extractSymbols(path, text)` keyed by extension. This is the engine seam: v1 is declaration-line regexes; a v2 tree-sitter engine replaces the function without touching store, service, or tools.
- `apps/server/src/codeIndex/CodeIndexStore.ts` — its own `node:sqlite` database (WAL) with `files`/`symbols`/`symbols_name_lookup`/`roots` tables, keyed by `rootKey` (the workspace root path). Escaped-`LIKE` symbol search, per-file replace/remove, per-root stats.
- `apps/server/src/codeIndex/CodeIndexService.ts` — `CodeIndexRoot` (per-root lifecycle: initial reconcile, watcher, pending-path queue, queries) behind a `LayerMap` with a 15-minute idle TTL, mirroring `WorkspaceSearchIndex`. `CodeIndexServerLive` merges the map and the store layer.
- `apps/server/src/mcp/toolkits/index/` — `index_search` and `index_file_symbols` tools; handlers resolve the invoking thread's project root and require the `index` capability.
- `apps/server/src/ws.ts` — `serverCodeIndexStatus` read RPC backing the settings panel summary.
- `apps/web/src/components/settings/CodeIndexSettings.tsx` — the Integrations panel section (toggle + per-project status + refresh).

## Wiring

One `CodeIndexServerLive` instance is provided in `RuntimeCoreDependenciesIndexLive` in `server.ts`, so the WebSocket RPC and the MCP toolkit share a single `CodeIndexRootMap` (one sqlite handle, one watcher set per root). Alternate assemblies (tests) provide the same layer with an in-memory store via `layerCodeIndexStoreFor(":memory:")`.

Prompt-side truthfulness follows the browser-tools precedent: the issued credential's capabilities travel on `McpProviderSessionConfig`, the Codex adapter derives `indexToolsAvailable` from them, and `CodexDeveloperInstructions` renders the index steering block only when the turn's MCP config actually granted it — the prompt must never describe tools the turn does not have.

Provider coverage rides MCP injection: Codex, Claude, Cursor, Grok, and OpenCode get the tools for free. Harnesses without code-work MCP injection (Antigravity, Kimi) have no index path; the BYOK tool broker could adopt the toolkit later.

## Upgrade path

The v1 extractor deliberately trades recall for simplicity: declaration lines only, with method-level extraction for TypeScript and Python (parent attribution takes the nearest class-shaped declaration — an approximation, documented in its tests). `extractSymbols` is pure and total; swapping in tree-sitter means reimplementing one module and extending the `kind` vocabulary. The store schema is kind-agnostic, so old rows and new rows coexist until the next full reconcile rewrites each file's entry.
