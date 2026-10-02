/** 官方 @agentclientprotocol/codex-acp 握手；不发明 OpenAI/ChatGPT 凭据。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

import { isProbeExecutableAvailable } from "./acpCliProbeGate.ts";

const cliPath = process.env.CODEWORK_CODEX_ACP_CLI_PATH;

describe.runIf(isProbeExecutableAvailable(cliPath))("Codex ACP adapter 官方 ACP CLI 握手", () => {
  it.live(
    "initialize 成功；会话结果如实记录",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-codex-acp-probe-" });
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
          )?.result as
            | {
                agentInfo?: { name?: string; version?: string };
                authMethods?: ReadonlyArray<{ id?: string; type?: string }>;
              }
            | undefined;
          expect(initialize).toMatchObject({
            agentInfo: { name: "@agentclientprotocol/codex-acp", version: "2.0.0" },
          });
          expect(initialize?.authMethods?.map((method) => method.id)).toEqual(
            expect.arrayContaining(["api-key", "chat-gpt"]),
          );
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
              clientInfo: { name: "codework-codex-acp-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 180000 },
  );
});
