# Electron TODO Monorepo (Turborepo + Bun)

A long-lived Electron starter focused on:

1. Performance: Vite renderer, small typed IPC surface, serialized persistence writes.
2. Maintainability: strict TypeScript, explicit package boundaries, isolated renderer.
3. Modern best practices: Bun workspaces, Turborepo task graph, shared contracts.

## Workspace layout

- `apps/desktop`: Electron main + preload process.
- `apps/renderer`: React + Vite + Tailwind renderer UI.
- `packages/contracts`: shared runtime-validated schemas and IPC/type contracts.

## Security and boundary model

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Renderer talks only to `window.nativeApi` exposed by preload.
- Preload and main both validate inputs using shared Zod schemas.

## Scripts

- `bun run dev`: starts contract build/watch, renderer dev server, and Electron process.
- `bun run build`: builds contracts, renderer, and desktop bundles through Turbo.
- `bun run typecheck`: strict TypeScript checks for all packages.

Optional:
- `ELECTRON_RENDERER_PORT=5180 bun run dev` if `5173` is already in use.

## Notes for future native bindings

Add new main-process capabilities by extending `packages/contracts` first:

1. Add schema + types for payload/result.
2. Add an IPC channel constant.
3. Implement `ipcMain.handle` in `apps/desktop/src/main.ts`.
4. Expose a typed preload wrapper in `apps/desktop/src/preload.ts`.
5. Consume only via `window.nativeApi` in renderer.

This keeps native concerns out of React and makes refactors low risk.
