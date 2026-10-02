/** 显式提供官方可执行文件才运行；合成密钥仅验证建会话，不发送模型请求。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

import { isProbeExecutableAvailable } from "./acpCliProbeGate.ts";

const cliPath = process.env.CODEWORK_CLINE_CLI_PATH;

describe.runIf(isProbeExecutableAvailable(cliPath))("Cline 官方 ACP CLI 认证与配置", () => {
  for (const scenario of ["invalid-method", "missing-key", "configured-key"]) {
    it.effect(
      scenario,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-cline-probe-" });
          const cwd = path.join(root, "workspace");
          yield* fs.makeDirectory(cwd);
          const env = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("CLINE_")),
          );
          const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
          yield* Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
            const result = yield* runtime.start().pipe(Effect.result);
            expect(
              requests.find(
                (event) => event.method === "initialize" && event.status === "succeeded",
              )?.result,
            ).toMatchObject({
              agentInfo: { name: "cline", version: "3.0.65" },
              authMethods: [
                { id: "cline", name: "Sign in with Cline" },
                { id: "cline-pass", name: "Sign in with ClinePass" },
                { id: "openai-codex", name: "Sign in with ChatGPT Subscription" },
              ],
            });
            if (scenario === "configured-key") {
              expect(result._tag).toBe("Success");
              if (result._tag !== "Success") throw new Error(result.failure.message);
              expect(yield* runtime.getAvailableModels).toEqual([]);
              expect((yield* runtime.getModeState)?.currentModeId).toBe("act");
              yield* runtime.setMode("plan");
              expect((yield* runtime.getModeState)?.currentModeId).toBe("plan");
              expect(
                (yield* runtime.getConfigOptions).find((option) => option.id === "auto_approve"),
              ).toMatchObject({ type: "boolean", currentValue: false });
              for (const value of [true, false]) {
                yield* runtime.setConfigOption("auto_approve", value);
                expect(
                  (yield* runtime.getConfigOptions).find((option) => option.id === "auto_approve")
                    ?.currentValue,
                ).toBe(value);
              }
            } else {
              expect(result._tag).toBe("Failure");
              if (result._tag !== "Failure") throw new Error("缺少认证时不应成功");
              expect(result.failure).toMatchObject({
                code: scenario === "invalid-method" ? -32602 : -32000,
              });
            }
            expect(requests.some((event) => event.method === "authenticate")).toBe(
              scenario === "invalid-method",
            );
            expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          }).pipe(
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command: cliPath!,
                  args: ["--acp", "--config", path.join(root, "home")],
                  cwd,
                  env: {
                    ...env,
                    CLINE_DATA_DIR: path.join(root, "data"),
                    CLINE_PROVIDER: "openai",
                    CLINE_MODEL: "gpt-4o",
                    ...(scenario === "configured-key" ? { CLINE_API_KEY: "local-test-only" } : {}),
                  },
                },
                cwd,
                authMethodId: scenario === "invalid-method" ? "login" : "",
                clientInfo: { name: "codework-cline-probe", version: "0.0.0" },
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
  }
});
