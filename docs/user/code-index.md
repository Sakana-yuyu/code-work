# Code Indexing

Code indexing gives agents a prebuilt map of your projects. Instead of opening and scanning files one by one to find where a class or function lives, an agent queries the index and gets the answer in one step — faster answers, less context spent on dead ends.

## Turn It On

Open **Settings → Integrations → Code indexing** and enable **Code indexing**. The server immediately starts indexing every project it knows about, and the panel shows live progress: how many projects are indexed, how many files and symbols each one has, and when each was last updated.

The setting is server-wide: it applies to every project on that server and every client connected to it.

## What Agents Get

When indexing is on, agent sessions automatically receive two tools through Code Work's built-in `code-work` MCP server:

- **index_search** — find where a symbol is defined by name (case-insensitive substring), optionally filtered by kind (class, function, type, …).
- **index_file_symbols** — list every declaration in one file, an instant outline of its structure.

Agents already using Code Work's preview/canvas tools need no setup: the index tools ride the same connection. Sessions started before you flipped the switch pick the tools up on their next session.

This is a **declaration index**, not a text search. It answers "where is `GoalStore` defined?" and "what's in `auth.ts`?" — for finding every place a string appears, agents still use their regular search tools.

## Stays Current Automatically

New files and edits are picked up two ways, so the index doesn't go stale:

1. The server watches your projects for file changes and folds them in within moments.
2. Before an agent queries the index, the server double-checks file timestamps and backfills anything the watcher missed.

Re-indexing starts from the moment you enable it; there is nothing to schedule or run by hand.

## What Gets Indexed

The index covers declarations — names, kinds, and line numbers — for TypeScript/JavaScript/JSX, Python, Go, Rust, Java/Kotlin, C/C++, C#, Ruby, Swift, and PHP. Method-level members are currently extracted for TypeScript and Python; other languages index their top-level declarations.

To keep it fast and relevant, the index skips dependencies (`node_modules`) and generated canvas artifacts, and very large files are left out. Projects with more than 25,000 indexable files are capped.

## Private by Construction

The index lives in a single database inside your server's own data directory and never leaves your machine. It stores declarations and file metadata only — never file contents, and no code is uploaded anywhere. Deleting that database is always safe: Code Work rebuilds it on the next run.

## Turning It Off

Switch it off in the same settings panel. Running index work stops, and the tools disappear from new agent sessions. The collected index is kept on disk, so re-enabling later picks up where it left off.
