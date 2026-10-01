/** 官方 @autohandai/autohand-acp；隔离握手。底层 Autohand CLI 未装时仍可 initialize，不发明密钥。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_AUTOHAND_CLI_PATH;

describe.runIf(Boolean(cliPath))("Autohand ACP 适配器握手", () => {
  it.live(
    "initialize 广告适配器版本；底层 CLI 缺失时记录 auth=autohand-install",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-autohand-probe-" });
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
            agentInfo: { name: "@autohandai/autohand-acp", version: "0.2.1" },
            authMethods: [{ id: "autohand-install" }],
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
                  PATH: process.env.PATH ?? "",
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-autohand-probe", version: "0.0.0" },
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
