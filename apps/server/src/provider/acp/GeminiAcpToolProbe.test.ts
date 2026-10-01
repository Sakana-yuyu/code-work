// @effect-diagnostics nodeBuiltinImport:off - 测试端点直接发送 Google API 的原始 SSE 帧。
/** 固定官方 CLI 配本机合成模型；不证明外部账号或推理成功。 */
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_GEMINI_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      contents: Schema.Array(
        Schema.Struct({
          role: Schema.String,
          parts: Schema.Array(
            Schema.Struct({
              text: Schema.optional(Schema.String),
              functionResponse: Schema.optional(Schema.Unknown),
            }),
          ),
        }),
      ),
      tools: Schema.optional(
        Schema.Array(
          Schema.Struct({
            functionDeclarations: Schema.optional(
              Schema.Array(Schema.Struct({ name: Schema.String })),
            ),
          }),
        ),
      ),
    }),
  ),
);

describe.runIf(Boolean(cliPath))("Gemini 官方 ACP CLI + 本机模型夹具", () => {
  it.effect(
    "固定版本的配置、读写、命令、拒绝、取消和恢复保护",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-gemini-tools-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(path.join(home, ".gemini"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, ".gemini", "settings.json"),
          encodeJson({
            general: { enableAutoUpdate: false },
            telemetry: { enabled: false },
            privacy: { usageStatisticsEnabled: false },
            tools: {
              core: ["read_file", "write_file", "run_shell_command"],
              confirmationRequired: ["write_file", "run_shell_command"],
              shell: { enableInteractiveShell: false },
            },
          }),
        );
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "GEMINI_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let promptMarker = "",
          promptSequence = 0,
          responseSequence = 0,
          toolSequence = 0;
        const toolResults: unknown[] = [],
          requests: { url: string; body: string }[] = [],
          serverErrors: unknown[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              try {
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const body = decodeRequest(raw);
                const url = request.url ?? "";
                requests.push({ url, body: raw });
                expect(request.headers["x-goog-api-key"]).toBe("local-test-only");
                for (const message of body.contents)
                  for (const part of message.parts)
                    if (part.functionResponse !== undefined)
                      toolResults.push(part.functionResponse);
                if (url.includes(":countTokens")) {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(encodeJson({ totalTokens: 32 }));
                  return;
                }
                if (!url.includes(":generateContent") && !url.includes(":streamGenerateContent"))
                  throw new Error(`未知模型请求 ${url}`);
                const last = body.contents.at(-1);
                const tool =
                  nextTool &&
                  last?.role === "user" &&
                  last.parts.some((part) => part.text?.includes(promptMarker)) &&
                  body.tools?.some((entry) =>
                    entry.functionDeclarations?.some(
                      (declaration) => declaration.name === nextTool!.name,
                    ),
                  )
                    ? nextTool
                    : undefined;
                if (tool) nextTool = undefined;
                const part = tool
                  ? {
                      functionCall: {
                        id: `gemini-tool-${++toolSequence}`,
                        name: tool.name,
                        args: tool.args,
                      },
                    }
                  : { text: "GEMINI_LOOPBACK_OK" };
                const result = {
                  candidates: [
                    { content: { role: "model", parts: [part] }, index: 0, finishReason: "STOP" },
                  ],
                  responseId: `gemini-response-${++responseSequence}`,
                  modelVersion: "gemini-2.5-pro",
                  usageMetadata: {
                    promptTokenCount: 32,
                    candidatesTokenCount: 8,
                    totalTokenCount: 40,
                  },
                };
                if (url.includes(":streamGenerateContent")) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  response.end(`data: ${encodeJson(result)}\n\n`);
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(encodeJson(result));
                }
              } catch (error) {
                serverErrors.push(error);
                response.writeHead(500);
                response.end("本机模型请求格式错误");
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
        if (!address || typeof address === "string") throw new Error("本机模型端口未建立");
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: process.execPath,
            args: [cliPath!, "--acp", "--model", "gemini-2.5-pro"],
            cwd,
            env: {
              ...isolatedProbeEnvironment(home),
              GEMINI_CLI_HOME: home,
              GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "no-system.json"),
              GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(root, "no-defaults.json"),
              GEMINI_TELEMETRY_ENABLED: "false",
              GEMINI_API_KEY: "local-test-only",
              GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${address.port}`,
            },
          },
          cwd,
          authMethodId: "gateway",
          clientInfo: { name: "codework-gemini-tools", version: "0.0.0" },
        };
        const sessionId = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let permission: "allow_once" | "reject_once" | "cancel" = "allow_once";
          const decisions: string[] = [],
            text: string[] = [];
          const tools = new Map<string, AcpToolCallState>();
          const originalFailures: unknown[] = [];
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              decisions.push(permission);
              if (permission === "cancel") {
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find((option) => option.kind === permission);
              if (!choice) throw new Error(`官方CLI没有${permission}选项`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const started = yield* runtime.start();
          expect(started.initializeResult.agentInfo).toMatchObject({
            name: "gemini-cli",
            version: "0.61.0",
          });
          expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);
          expect(
            started.initializeResult.authMethods?.some((method) => method.id === "gateway"),
          ).toBe(true);
          const models = yield* runtime.getAvailableModels;
          expect(models?.map((model) => model.slug)).toContain("gemini-2.5-pro");
          yield* runtime.setModel("gemini-2.5-pro");
          yield* runtime.setMode("default");
          expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              if (event._tag === "ToolCallUpdated") {
                tools.set(event.toolCall.toolCallId, event.toolCall);
                if (event.toolCall.status === "failed" && event.toolCall.data.rawOutput)
                  originalFailures.push(event.rawPayload);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const prompt = () => {
            promptMarker = `GEMINI_ACTION_${++promptSequence}`;
            return runtime.prompt({
              prompt: [{ type: "text", text: `${promptMarker} 执行本机协议动作。` }],
            });
          };
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("GEMINI_LOOPBACK_OK");
          expect((yield* runtime.getAvailableCommands).length).toBeGreaterThan(0);
          nextTool = { name: "read_file", args: { file_path: path.join(cwd, "source.txt") } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("GEMINI_SOURCE_72319");
          expect(
            [...tools.values()].some((tool) => tool.kind === "read" && tool.status === "completed"),
          ).toBe(true);
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "approved.txt"), content: "APPROVED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
          expect(decisions).toContain("allow_once");
          nextTool = {
            name: "run_shell_command",
            args: { command: "echo GEMINI_SHELL_72319", description: "输出合成验收标记" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("GEMINI_SHELL_72319");
          expect([...tools.values()].find((tool) => tool.kind === "execute")).toMatchObject({
            status: "completed",
            detail: expect.stringContaining("GEMINI_SHELL_72319"),
          });
          nextTool = {
            name: "run_shell_command",
            args: { command: "exit 7", description: "验证非零退出码" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect([...tools.values()].findLast((tool) => tool.kind === "execute")).toMatchObject({
            status: "failed",
            data: { rawOutput: { exitCode: 7 } },
          });
          expect(originalFailures).toContainEqual(
            expect.objectContaining({ update: expect.objectContaining({ status: "completed" }) }),
          );
          expect(encodeJson(toolResults)).toContain("Exit Code: 7");
          permission = "reject_once";
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "denied.txt"), content: "DENIED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          permission = "cancel";
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
          };
          expect((yield* prompt()).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          yield* Fiber.interrupt(consumer);
          return started.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(options)), Effect.scoped);
        const chatsDir = path.join(home, ".gemini", "tmp", "workspace", "chats");
        const savedHistory = new Map<string, string>();
        for (const file of yield* fs.readDirectory(chatsDir)) {
          if (file.endsWith(`-${sessionId.slice(0, 8)}.jsonl`))
            savedHistory.set(file, yield* fs.readFileString(path.join(chatsDir, file)));
        }
        expect(savedHistory.size).toBe(1);
        expect(
          [...savedHistory.values()].some((history) => history.includes("GEMINI_SOURCE_72319")),
        ).toBe(true);
        const resumeRequests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const result = yield* runtime.start().pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "AcpRequestError",
              method: "session/load",
              code: -32000,
              data: { reason: "gemini-0.61.0-session-load-history-loss" },
            },
          });
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              ...options,
              resumeSessionId: sessionId,
              requestLogger: (event) =>
                Effect.sync(() => {
                  resumeRequests.push(event);
                }),
            }),
          ),
          Effect.scoped,
        );
        expect(resumeRequests.some((request) => request.method === "session/load")).toBe(false);
        for (const [file, contents] of savedHistory)
          expect(yield* fs.readFileString(path.join(chatsDir, file))).toBe(contents);
        expect(serverErrors).toEqual([]);
        expect(requests.some((request) => request.url.includes(":streamGenerateContent"))).toBe(
          true,
        );
        expect(requests.some((request) => request.url.includes("models/gemini-2.5-pro:"))).toBe(
          true,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
