/** Harn：NL prompt → Compilation error（上游）；表达式需 host/capabilities（Runtime 默认回复）。不发明密钥。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_HARN_CLI_PATH;

const isolatedEnv = (home: string) => {
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
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    PATH: process.env.PATH ?? "",
  };
};

describe.runIf(Boolean(cliPath))("Harn 官方 ACP prompt 边界", () => {
  it.live(
    "自然语言 prompt 返回 Compilation error（非 environmentPolicy/配置缺陷）",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-harn-nl-" });
        const cwd = path.join(root, "workspace");
        const home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* runtime.start();
          const result = yield* runtime
            .prompt({
              prompt: [{ type: "text", text: "Reply with exactly: HARN_OK" }],
            })
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure._tag).toBe("AcpRequestError");
            expect(result.failure.message).toMatch(/^Compilation error:/);
          }
          yield* runtime.close.pipe(Effect.catchTag("AcpRequestError", () => Effect.void));
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["serve", "acp"],
                cwd,
                env: isolatedEnv(home),
              },
              cwd,
              authMethodId: "none",
              clientInfo: { name: "codework-harn-tool-probe", version: "0.0.0" },
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120000 },
  );

  it.live(
    "表达式 prompt 经默认 host/capabilities 回复后 end_turn",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectory({ prefix: "codework-harn-expr-" });
        const cwd = path.join(root, "workspace");
        const home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* Effect.addFinalizer(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore));
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* runtime.start();
          const response = yield* runtime.prompt({
            prompt: [{ type: "text", text: "1 + 1" }],
          });
          expect(response.stopReason).toBe("end_turn");
          yield* runtime.close.pipe(Effect.catchTag("AcpRequestError", () => Effect.void));
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["serve", "acp"],
                cwd,
                env: isolatedEnv(home),
              },
              cwd,
              authMethodId: "none",
              clientInfo: { name: "codework-harn-expr-probe", version: "0.0.0" },
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120000 },
  );
});
