/**
 * 官方 minion-code@0.1.44 默认 uv 工具入口。
 * 期望：无法完成 Code Work 可消费的 initialize（依赖 ImportError 或 JSON-RPC 写在 stderr）。
 * 不发明 OpenRouter 凭据；不把 pin/workaround 标成目录成功。
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_MINION_CODE_CLI_PATH;

describe.runIf(Boolean(cliPath))("Minion Code 默认 ACP 入口（预期失败）", () => {
  it.live(
    "initialize 不会在 stdout JSON-RPC 成功；不发 prompt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-minion-probe-" });
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
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const started = yield* runtime.start().pipe(Effect.result);
          const initializeOk = requests.some(
            (event) => event.method === "initialize" && event.status === "succeeded",
          );
          expect(initializeOk).toBe(false);
          expect(started._tag).toBe("Failure");
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["acp"],
                cwd,
                env: {
                  ...env,
                  HOME: home,
                  USERPROFILE: home,
                  APPDATA: home,
                  LOCALAPPDATA: home,
                  PATH: process.env.PATH ?? "",
                  MINION_ROOT: path.join(home, ".minion", "runtime"),
                  PYTHONUNBUFFERED: "1",
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-minion-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60000 },
  );
});
