// @effect-diagnostics nodeBuiltinImport:off - 官方 CLI 的模型目录仅连接本机端点。
/** 显式提供固定官方 hermes-acp 可执行文件，避免把未安装误报为验证成功。 */
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const cliPath = process.env.CODEWORK_HERMES_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe.runIf(Boolean(cliPath))("Hermes 官方 ACP 认证与配置", () => {
  for (const scenario of ["login", "configured", "missing-config"]) {
    const authMethodId = scenario === "login" ? "login" : "";
    it.effect(
      scenario === "missing-config"
        ? "缺少模型配置时建会话失败"
        : authMethodId
          ? "上游未广告 login，空认证响应不能作为登录证据"
          : "已配置本机模型时省略认证，保留模型与编辑审批模式",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-hermes-probe-" });
          const cwd = path.join(root, "workspace");
          const home = path.join(root, "home");
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(home);
          const modelRequests: string[] = [];
          const server = yield* Effect.acquireRelease(
            Effect.sync(() =>
              NodeHttp.createServer((request, response) => {
                if (request.method !== "GET")
                  modelRequests.push(`${request.method} ${request.url}`);
                response.setHeader("Content-Type", "application/json");
                if (request.method === "GET" && request.url === "/v1/models") {
                  response.end(
                    encodeJson({
                      object: "list",
                      data: [{ id: "hermes-probe-model", object: "model" }],
                    }),
                  );
                } else {
                  response.statusCode = 404;
                  response.end(encodeJson({ error: "本机探针只提供模型目录" }));
                }
              }),
            ),
            (server) =>
              Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                  }),
              ),
          );
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("没有本机端口");
          yield* fs.writeFileString(
            path.join(home, "config.yaml"),
            encodeJson(
              scenario === "missing-config"
                ? {}
                : {
                    model: {
                      provider: "custom",
                      default: "hermes-probe-model",
                      base_url: `http://127.0.0.1:${address.port}/v1`,
                    },
                    platform_toolsets: { acp: ["file", "terminal", "no_mcp"] },
                  },
            ),
          );
          // Runtime 合并宿主环境，因此显式清空非系统项，避免继承真实账号或代理端点。
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
            if (scenario === "missing-config") {
              expect(started._tag).toBe("Failure");
              expect(
                requests.some(
                  (event) => event.method === "session/new" && event.status === "failed",
                ),
              ).toBe(true);
              expect(requests.some((event) => event.method === "authenticate")).toBe(false);
              return;
            }
            if (started._tag === "Failure") throw new Error(started.failure.message);
            const result = started.success;
            expect(result.initializeResult.agentInfo).toMatchObject({
              name: "hermes-agent",
              version: "0.21.5",
            });
            expect(result.initializeResult.authMethods).toEqual(
              expect.arrayContaining([expect.objectContaining({ id: "custom" })]),
            );
            expect(
              result.initializeResult.authMethods?.some((method) => method.id === "login"),
            ).toBe(false);
            if (authMethodId) {
              expect(
                requests.find(
                  (event) => event.method === "authenticate" && event.status === "succeeded",
                )?.result,
              ).toEqual({});
              return;
            }
            expect((yield* runtime.getAvailableModels)?.map((model) => model.slug)).toContain(
              "custom:hermes-probe-model",
            );
            expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
            yield* runtime.setMode("accept_edits");
            expect((yield* runtime.getModeState)?.currentModeId).toBe("accept_edits");
            yield* runtime.setMode("default");
            expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
            expect(requests.some((event) => event.method === "authenticate")).toBe(false);
            // 上游启动时会探测 Ollama 能力；POST /api/show 不是模型生成。
            expect(modelRequests.every((route) => route === "POST /api/show")).toBe(true);
            expect(requests.some((event) => event.method === "session/prompt")).toBe(false);
          }).pipe(
            Effect.provide(
              AcpSessionRuntime.layer({
                spawn: {
                  command: cliPath!,
                  args: [],
                  cwd,
                  env: {
                    ...env,
                    HERMES_HOME: home,
                    HOME: home,
                    USERPROFILE: home,
                    APPDATA: home,
                    LOCALAPPDATA: home,
                    OPENAI_API_KEY: scenario === "missing-config" ? "" : "local-test-only",
                    PYTHONUTF8: "1",
                  },
                },
                cwd,
                authMethodId,
                clientInfo: { name: "codework-hermes-probe", version: "0.0.0" },
                requestLogger: (event) =>
                  Effect.sync(() => {
                    requests.push(event);
                  }),
              }),
            ),
            Effect.scoped,
          );
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 90000 },
    );
  }
});
