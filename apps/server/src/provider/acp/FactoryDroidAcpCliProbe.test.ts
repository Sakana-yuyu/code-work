/** 固定公共版 Factory CLI 无认证探针：握手成功不代表可建立模型会话。 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_FACTORY_DROID_CLI_PATH;

describe.runIf(Boolean(cliPath))("Factory Droid 官方无认证 ACP", () => {
  it.effect(
    "固定版本握手后明确拒绝 session/new，不发送模型请求",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-factory-auth-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        const shell = process.env.COMSPEC;
        if (!shell) throw new Error("Windows Factory 探针需要 COMSPEC 启动 shell");
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const started = yield* runtime.start().pipe(Effect.result);
          expect(
            requests.find((event) => event.method === "initialize" && event.status === "succeeded")
              ?.result,
          ).toMatchObject({
            agentInfo: { name: "@factory/cli", version: "0.229.0" },
            authMethods: expect.arrayContaining([
              expect.objectContaining({ id: "device-pairing" }),
              expect.objectContaining({ id: "factory-api-key" }),
            ]),
          });
          expect(started).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "AcpRequestError",
              code: -32000,
              method: "session/new",
              errorMessage: expect.stringContaining("Authentication required:"),
            },
          });
          expect(
            requests.some((event) => event.method === "session/new" && event.status === "failed"),
          ).toBe(true);
          expect(requests.find((event) => event.method === "session/new")?.payload).toMatchObject({
            mcpServers: [],
          });
          expect(
            requests.some(
              (event) => event.method === "authenticate" || event.method === "session/prompt",
            ),
          ).toBe(false);
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: cliPath!,
                args: ["exec", "--output-format", "acp-daemon"],
                cwd,
                env: {
                  ...isolatedProbeEnvironment(home),
                  SHELL: shell,
                  DROID_DISABLE_AUTO_UPDATE: "true",
                  FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
                },
              },
              cwd,
              authMethodId: "",
              clientInfo: { name: "codework-factory-auth", version: "0.0.0" },
              requestLogger: (event) =>
                Effect.sync(() => {
                  requests.push(event);
                }),
            }),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );
});
