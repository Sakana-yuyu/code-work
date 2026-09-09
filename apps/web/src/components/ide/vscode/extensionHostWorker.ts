// Bundled entry for the in-page (web worker) extension host. Imported with
// `?worker&url` in `bootstrap.ts` so Vite fully resolves the upstream worker's
// import graph into a same-origin URL. This is only the extension-host worker;
// the visible workbench parts still mount directly in the Code Work document.
import "@codingame/monaco-vscode-api/workers/extensionHost.worker";
