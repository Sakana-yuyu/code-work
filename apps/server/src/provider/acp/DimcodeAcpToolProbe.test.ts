// @effect-diagnostics nodeBuiltinImport:off - Windows 上优先用 node 入口避开 .cmd spawn EINVAL。
/**
 * DimCode 会话边界探针：`authMethods=[]` 时尝试 session/new；
 * 若仍无法无密钥完成工具链，如实记录失败，不发明凭据、不把握手当工具验收。
 */
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const configuredPath = process.env.CODEWORK_DIMCODE_CLI_PATH;

function resolveDimcodeNodeSpawn(cliPath: string): { command: string; args: string[] } {
  const normalized = cliPath.replace(/\\/g, "/");
  const idx = normalized.toLowerCase().indexOf("/node_modules/");
  if (idx >= 0) {
    const packageRoot = NodePath.join(cliPath.slice(0, idx), "node_modules", "dimcode", "bin", "dim.mjs");
    return { command: process.execPath, args: [packageRoot, "acp"] };
  }
  if (normalized.endsWith("dim.mjs")) {
    return { command: process.execPath, args: [cliPath, "acp"] };
  }
  return { command: cliPath, args: ["acp"] };
}

describe.runIf(Boolean(configuredPath))("DimCode 官方 CLI 会话/工具边界（node 入口）", () => {
  it.live(
    "node 入口 initialize；session/new 结果如实记录（无密钥不伪造成功工具）",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-dimcode-tools-" });
        const cwd = path.join(root, "workspace");
        const home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
        const systemKeys = new Set([
          "PATH",
          "PATHEXT",
          "SYSTEMROOT",
          "SYSTEMDRIVE",
          "WINDIR",
          "COMSPEC",
          "TEMP",
          "TMP",
        ]);
        const env = Object.fromEntries(
          Object.entries(process.env).map(([key, value]) => [
            key,
            systemKeys.has(key.toUpperCase()) ? value : "",
          ]),
        );
        const spawn = resolveDimcodeNodeSpawn(configuredPath!);
        expect(spawn.command).toBe(process.execPath);
        expect(spawn.args[0]?.replace(/\\/g, "/")).toMatch(/dim\.mjs$/);
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const started = yield* runtime.start().pipe(Effect.result);
          const initialize = requests.find(
            (event) => event.method === "initialize" && event.status === "succeeded",
          )?.result;
          expect(initialize).toMatchObject({
            agentInfo: { name: "dimcode", version: "0.5.15" },
            authMethods: [],
          });
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          // Record honestly: empty auth may still allow or reject session/new depending on local binary state.
          if (started._tag === "Success") {
            yield* runtime.close.pipe(Effect.catchTag("AcpRequestError", () => Effect.void));
            expect(
              requests.some(
                (event) => event.method === "session/new" && event.status === "succeeded",
              ),
            ).toBe(true);
          } else {
            expect(started.failure).toMatchObject({ _tag: "AcpRequestError" });
            expect(
              requests.some(
                (event) => event.method === "session/new" && event.status === "succeeded",
              ),
            ).toBe(false);
            // Prefer a concrete session/new attempt (even if only "started"/failed) over silent skip.
            expect(requests.some((event) => event.method === "session/new")).toBe(true);
          }
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: spawn.command,
                args: spawn.args,
                cwd,
                env: {
                  ...env,
                  HOME: home,
                  USERPROFILE: home,
                  APPDATA: home,
                  LOCALAPPDATA: home,
                  PATH: process.env.PATH ?? "",
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-dimcode-tool-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 180_000 },
  );
});
