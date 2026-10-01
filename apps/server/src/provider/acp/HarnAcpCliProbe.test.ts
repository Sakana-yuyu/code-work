/** 官方 Harn ACP 握手；auth none + environmentPolicy.inherited 可建会话；不发明密钥、不发 prompt。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_HARN_CLI_PATH;

describe.runIf(Boolean(cliPath))("Harn 官方 ACP CLI 握手", () => {
  it.live(
    "initialize、authenticate(none)、session/new(inherited) 成功",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-harn-probe-" });
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
          expect(started._tag).toBe("Success");
          if (started._tag !== "Success") return;
          expect(started.success.initializeResult).toMatchObject({
            agentInfo: { name: "harn", version: "0.10.151" },
            authMethods: [{ id: "none" }],
          });
          expect(
            requests.some((event) => event.method === "authenticate" && event.status === "succeeded"),
          ).toBe(true);
          expect(
            requests.some((event) => event.method === "session/new" && event.status === "succeeded"),
          ).toBe(true);
          const sessionNew = requests.find(
            (event) => event.method === "session/new" && event.status === "started",
          );
          expect(sessionNew?.payload).toMatchObject({
            environmentPolicy: { kind: "inherited" },
          });
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          yield* runtime.close.pipe(Effect.catchTag("AcpRequestError", () => Effect.void));
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["serve", "acp"],
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
              authMethodId: "none",
              clientInfo: { name: "codework-harn-probe", version: "0.0.0" },
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
