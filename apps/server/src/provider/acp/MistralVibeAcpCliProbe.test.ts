/** 官方 vibe-acp 二进制握手；不发明 Mistral 登录凭据、不发模型请求。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_MISTRAL_VIBE_CLI_PATH;

describe.runIf(Boolean(cliPath))("Mistral Vibe 官方 ACP CLI 握手", () => {
  it.live(
    "initialize 成功；会话结果如实记录",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-mistral-vibe-probe-" });
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
          const initialize = requests.find(
            (event) => event.method === "initialize" && event.status === "succeeded",
          )?.result;
          expect(initialize).toMatchObject({
            agentInfo: { name: "@mistralai/mistral-vibe", version: "2.25.8" },
            authMethods: [{ id: "browser-auth" }],
          });
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          if (started._tag === "Success") {
            yield* runtime.close.pipe(Effect.catchTag("AcpRequestError", () => Effect.void));
          } else {
            expect(started.failure).toMatchObject({ _tag: "AcpRequestError" });
          }
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: [],
                cwd,
                env: { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-mistral-vibe-probe", version: "0.0.0" },
              requestLogger: (event) => Effect.sync(() => { requests.push(event); }),
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120000 },
  );
});
