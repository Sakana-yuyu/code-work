# Agent memory, hooks, and web search

These are Code Work product features. Configure them once on the server; every client connected to that server sees the same settings. In-process agents — including custom model sessions — pick them up automatically. CLI providers such as Codex and Claude keep their own memory and hook systems.

Open **Settings → Integrations** on web or desktop, or **Settings → Agent tools** on mobile. Custom model settings also link here.

## Memory

Memory is on by default. Empty notes do not take up context.

- **User notes** live on the server and are shared by every project. Edit them in Settings, or type `/memory` in chat to list them and `/memory` followed by text to append.
- **Project notes** live in `.codework/memory.md` inside the project. Agents write and read them with the memory tools. Writing project notes is a project change — in plan (approval-required) mode agents can only write user notes.

When memory is on, in-process agents receive the notes at the start of a turn and can call **memory.save** and **memory.recall**. Turn memory off to hide those tools and stop injecting notes.

## Hooks

Hooks are off by default. When on, Code Work runs a command you configure on the server at lifecycle points:

- when you submit a prompt
- before a tool runs
- after a tool runs
- when a turn stops

The command receives a JSON payload on stdin. To block a tool, print `{"decision":"deny","reason":"…"}` on stdout (or exit with a non-zero status). Commands time out after 10 seconds.

For before/after tool hooks you can add an optional matcher — a tool name or glob such as `terminal.*` — so the command only runs for matching tools.

Hooks apply only to in-process agents. They do not wrap Codex, Claude, or other CLI sessions. Type `/hooks` in chat to list the configured hooks.

## Web search

Web search is off by default. When on, in-process agents get a **web.search** tool that uses the engine you choose:

- **DuckDuckGo** — no key
- **SearXNG** — URL of your instance, without a trailing `/search`
- **Tavily** or **Brave Search** — API key kept in the server's secret store and never shown again; leave the field blank to keep the current key, or use Remove key to delete it

Type `/search-engine` in chat to see the current engine, or `/search-engine tavily` (or `duckduckgo`, `searxng`, `brave`) to switch and enable search.

## Chat shortcuts

In a custom model thread, `/` lists the session commands, including `/memory`, `/hooks`, and `/search-engine`. Settings remain the source of truth; the commands are a convenience for listing and small updates.
