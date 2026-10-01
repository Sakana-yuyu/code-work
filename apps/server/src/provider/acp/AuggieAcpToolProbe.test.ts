// @effect-diagnostics nodeBuiltinImport:off - Windows 上优先用 node 入口避开 .cmd spawn EINVAL。
/**
 * Auggie 会话边界探针：`authMethods=[]` 仍要求终端 `auggie login`。
 * 不发明 Augment 凭据；本文件证明无登录时无法建会话/跑工具，不是工具成功验收。
 */
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const configuredPath = process.env.CODEWORK_AUGGIE_CLI_PATH;

/** Prefer package `augment.mjs` so spawn is `node … --acp` without cmd.exe. */
function resolveAuggieNodeSpawn(cliPath: string): { command: string; args: string[] } {
  const normalized = cliPath.replace(/\\/g, "/");
  const marker = "/node_modules/@augmentcode/auggie/";
  const idx = normalized.toLowerCase().indexOf("/node_modules/");
  if (idx >= 0) {
    const packageRoot = NodePath.join(
      cliPath.slice(0, idx),
      "node_modules",
      "@augmentcode",
      "auggie",
      "augment.mjs",
    );
    return { command: process.execPath, args: [packageRoot, "--acp"] };
  }
  if (normalized.endsWith("augment.mjs")) {
    return { command: process.execPath, args: [cliPath, "--acp"] };
  }
  return { command: cliPath, args: ["--acp"] };
}

describe.runIf(Boolean(configuredPath))("Auggie 官方 CLI 会话/工具边界（node 入口）", () => {
  it.live(
    "initialize 成功但 session/new 要求 auggie login；不发送 prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-auggie-tools-" });
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
        const spawn = resolveAuggieNodeSpawn(configuredPath!);
        expect(spawn.command).toBe(process.execPath);
        expect(spawn.args[0]?.replace(/\\/g, "/")).toMatch(/augment\.mjs$/);
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const started = yield* runtime.start().pipe(Effect.result);
          const initialize = requests.find(
            (event) => event.method === "initialize" && event.status === "succeeded",
          )?.result as
            | {
                agentInfo?: { name?: string; version?: string };
                authMethods?: ReadonlyArray<unknown>;
              }
            | undefined;
          expect(initialize?.agentInfo?.name).toBe("auggie");
          expect(initialize?.agentInfo?.version).toMatch(/^0\.36\.0/);
          expect(initialize?.authMethods ?? []).toEqual([]);
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          // Empty authMethods does not mean anonymous sessions work.
          expect(started._tag).toBe("Failure");
          if (started._tag === "Failure") {
            expect(started.failure).toMatchObject({ _tag: "AcpRequestError" });
            const failure = started.failure as {
              message?: string;
              detail?: string;
              _tag?: string;
            };
            const message = String(failure.message ?? failure.detail ?? failure._tag ?? failure);
            expect(message.toLowerCase()).toMatch(/authentication required|auggie login/);
          }
          expect(
            requests.some(
              (event) => event.method === "session/new" && event.status === "succeeded",
            ),
          ).toBe(false);
          expect(requests.some((event) => event.method === "session/new")).toBe(true);
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
                  AUGMENT_DISABLE_AUTO_UPDATE: "1",
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-auggie-tool-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 120_000 },
  );
});
