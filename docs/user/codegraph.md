# CodeGraph Code Graph

CodeGraph gives agents a pre-indexed knowledge graph of how your code connects — call paths, data flow, and architecture — so relationship questions get answered in one structured query instead of being re-derived from repeated file reads and text searches. Code Work integrates the open-source [CodeGraph CLI](https://github.com/colbymchenry/codegraph); everything runs locally against your own projects.

## Turn It On

The integration is **on by default** (Settings → Integrations → **CodeGraph code graph**). There is nothing to configure per project: the first time an agent works on a project, Code Work builds the index in the background (running `codegraph init` in the project root) and keeps it out of your way — turns never wait on indexing.

The only requirement is the CodeGraph CLI on your PATH:

```bash
npm i -g @colbymchenry/codegraph
```

Without the CLI, nothing changes for your agents — they simply keep their regular tools. Installing it later is picked up automatically on a future turn. Turning the switch off stops background indexing and withdraws the query tool from agents; indexes already on disk are never deleted (remove one yourself with `codegraph uninit` inside the project).

Background indexing is refused for drive roots and your home directory itself, where an index would only be noise.

## Install & Health Panel

The same settings section doubles as the management surface:

- **One-click install** — when the CLI is missing, the panel offers to install it for you (npm global install of the latest release). While the install runs, the panel polls and shows the outcome; afterwards the detected version appears next to the row.
- **Per-project health cards** — every project shows its index state at a glance: file/node/edge counts, detected languages, index size, when it was last indexed, how many changes are pending sync, and a "rebuild recommended" hint when the index was built by an older CLI.
- **Live phases** — while a background index is being built or rebuilt, the card shows the current phase (scanning → parsing → resolving → linking). Phases only — the CLI does not report percentages, so none are shown.
- **Sync & rebuild** — each card has buttons to sync pending changes into the index or rebuild it from scratch, without touching a terminal.

## What Agents Get

Once a project has a `.codegraph/` index, agent sessions gain the **codegraph.explore** tool and a usage policy in their instructions:

- **Use it for relationships** — cross-file understanding, call chains, data flow, architecture analysis, bug root-cause hunting, refactoring, and change-impact questions.
- **Skip it for the simple stuff** — edits to files whose location is already known, string search, config, docs, style and comment changes, and single-file tasks stay on the regular search/read tools.

This keeps the graph a precision instrument: agents get fuller context when they need it and avoid bloating their own conversation with gratuitous queries. If a query fails or the index is missing, agents are told to fall back to regular tools rather than retry.

The index stays current by itself: the CLI watches your project and syncs changes, so there is nothing to schedule or refresh by hand.

## Staying Up to Date

Code Work ships against a validated CodeGraph CLI version and checks the upstream npm registry for newer releases before every Code Work release (`node scripts/check-codegraph-upstream.ts` in the repo). To update the CLI on your machine:

```bash
codegraph upgrade
```

After upgrading the CLI, run `codegraph index` once in projects you have already indexed so existing graphs pick up upstream fixes.
