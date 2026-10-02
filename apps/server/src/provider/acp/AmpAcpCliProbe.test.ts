/** 官方 amp-acp 二进制；隔离握手，不发明凭据、不发外部模型请求。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

import { isProbeExecutableAvailable } from "./acpCliProbeGate.ts";

const cliPath = process.env.CODEWORK_AMP_CLI_PATH;

describe.runIf(isProbeExecutableAvailable(cliPath))("Amp 官方 ACP CLI 握手", () => {
  it.live(
    "initialize 成功；会话结果如实记录",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-amp-probe-" });
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
                authMethods?: ReadonlyArray<{ id?: string }>;
              }
            | undefined;
          expect(initialize).toMatchObject({
            agentInfo: { name: "amp-acp", version: "0.9.0" },
            authMethods: [{ id: "setup" }],
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
                env: {
                  ...env,
                  HOME: home,
                  USERPROFILE: home,
                  APPDATA: home,
                  LOCALAPPDATA: home,
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-amp-probe", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120000 },
  );
});
