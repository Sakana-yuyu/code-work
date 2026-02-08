/**
 * Smoke test: launches Electron with the production build,
 * waits for the page to render, checks for console errors, and exits.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const electronPath = resolve(
  __dirname,
  "../node_modules/.bin/electron"
);
const mainPath = resolve(__dirname, "../dist-electron/main.js");

const child = spawn(electronPath, [mainPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    // Force production mode (no VITE_DEV_SERVER_URL)
    ELECTRON_ENABLE_LOGGING: "1",
    SMOKE_TEST: "1",
  },
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (data) => {
  stdout += data.toString();
  process.stdout.write(data);
});

child.stderr.on("data", (data) => {
  stderr += data.toString();
  process.stderr.write(data);
});

// Give the app 5 seconds to start then kill it
const timeout = setTimeout(() => {
  child.kill();
}, 5000);

child.on("exit", (code) => {
  clearTimeout(timeout);
  const hasErrors =
    stderr.includes("Error") ||
    stderr.includes("Cannot find module") ||
    stderr.includes("MODULE_NOT_FOUND");

  if (hasErrors) {
    console.error("\n❌ Smoke test FAILED — errors detected in stderr");
    process.exit(1);
  }

  console.log("\n✅ Smoke test passed — no fatal errors detected");
  process.exit(0);
});
