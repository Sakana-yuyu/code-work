/** 显式提供官方 bundle/gemini.js 路径才运行；此探针不登录、不调用模型。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_GEMINI_CLI_PATH;

describe.runIf(Boolean(cliPath))("Gemini 官方 ACP CLI 认证边界", () => {
  for (const methodId of ["login", "gemini-api-key"]) {
    it.effect(
      `${methodId} 缺少有效认证时不能启动会话`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-gemini-auth-" });
          const cwd = path.join(root, "workspace");
          yield* fs.makeDirectory(cwd);
          // Runtime 会继承宿主环境，显式空值阻止探针使用真实凭据。
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
          const result = yield* Effect.gen(function* () {
            const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
            return yield* runtime.start().pipe(Effect.result);
          }).pipe(
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command: process.execPath,
                  args: [cliPath!, "--acp"],
                  cwd,
                  env: {
                    ...env,
                    HOME: root,
                    USERPROFILE: root,
                    APPDATA: root,
                    LOCALAPPDATA: root,
                    GEMINI_CLI_HOME: root,
                    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "no-system.json"),
                    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "no-defaults.json"),
                    GEMINI_TELEMETRY_ENABLED: "false",
                  },
                },
                cwd,
                authMethodId: methodId,
                clientInfo: { name: "codework-gemini-probe", version: "0.0.0" },
                requestLogger: (event) =>
                  Effect.sync(() => {
                    requests.push(event);
                  }),
              }),
            ),
            Effect.scoped,
          );
          expect(
            requests.find((event) => event.method === "initialize" && event.status === "succeeded")
              ?.result,
          ).toMatchObject({
            agentInfo: { name: "gemini-cli", version: "0.61.0" },
            authMethods: expect.arrayContaining([
              {
                id: "oauth-personal",
                name: "Log in with Google",
                description: "Log in with your Google account",
              },
            ]),
          });
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") throw new Error("缺少认证时错误地建立了会话");
          expect(result.failure).toMatchObject({
            _tag: "AcpRequestError",
            method: methodId === "login" ? "authenticate" : "session/new",
          });
          if (methodId === "login") {
            expect(result.failure).toMatchObject({ code: -32602 });
            expect(requests.some((event) => event.method === "session/new")).toBe(false);
          } else {
            expect(
              requests.some(
                (event) => event.method === "authenticate" && event.status === "succeeded",
              ),
            ).toBe(true);
            expect(result.failure.message).toContain("Gemini API key is missing or not configured");
          }
          expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 60000 },
    );
  }
});
