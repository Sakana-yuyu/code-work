// @effect-diagnostics nodeBuiltinImport:off - 直接验证官方 CLI 的原始 OpenAI SSE 请求与响应。
/** 官方 CodeBuddy 自定义模型工具探针；不调用腾讯账号或外部模型。 */
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
import { type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_CODEBUDDY_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      stream: Schema.optional(Schema.Boolean),
      tools: Schema.optional(
        Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
      ),
      messages: Schema.Array(
        Schema.Struct({ role: Schema.String, content: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
);
describe.runIf(Boolean(cliPath))("CodeBuddy 官方 CLI + 本机模型", () => {
  it.effect(
    "固定版本配置、真实工具、拒绝、取消和历史恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-codebuddy-local-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "CODEBUDDY_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let promptMarker = "",
          promptSequence = 0,
          completionSequence = 0,
          toolSequence = 0;
        let restoring = false;
        let selectedModel = "codework-loopback";
        const toolResults: unknown[] = [],
          errors: unknown[] = [];
        const requestPaths: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              try {
                let raw = "";
                for await (const chunk of request) raw += chunk;
                requestPaths.push(request.url ?? "");
                expect(request.url).toBe("/v1/chat/completions");
                expect(request.headers.authorization).toBe("Bearer local-test-only");
                const body = decodeRequest(raw);
                expect(body.model).toBe(selectedModel);
                for (const message of body.messages)
                  if (message.role === "tool") toolResults.push(message.content);
                const current = body.messages.at(-1);
                const action =
                  current?.role === "user" &&
                  encodeJson(current.content) ===
                    encodeJson([
                      {
                        type: "text",
                        text: `<user_query>${promptMarker} 执行本机协议动作。</user_query>`,
                      },
                    ]);
                if (
                  nextTool &&
                  action &&
                  !body.tools?.some((entry) => entry.function.name === nextTool!.name)
                )
                  throw new Error(
                    `官方未广告工具 ${nextTool.name}；实际目录 ${body.tools?.map((entry) => entry.function.name).join(",")}`,
                  );
                const tool = action ? nextTool : undefined;
                if (tool) nextTool = undefined;
                if (restoring && action)
                  expect(
                    body.messages.some(
                      (message) =>
                        message.role === "tool" &&
                        encodeJson(message.content).includes("CODEBUDDY_SOURCE_72319"),
                    ),
                  ).toBe(true);
                const message = tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_codebuddy_${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content:
                        restoring && action ? "CODEBUDDY_RESTORED_OK" : "CODEBUDDY_LOOPBACK_OK",
                    };
                const id = `codebuddy-completion-${++completionSequence}`,
                  finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ])
                    response.write(
                      `data: ${encodeJson({ ...chunk, id, object: "chat.completion.chunk", created: 1, model: selectedModel })}\n\n`,
                    );
                  response.end("data: [DONE]\n\n");
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    encodeJson({
                      id,
                      object: "chat.completion",
                      created: 1,
                      model: selectedModel,
                      choices: [{ index: 0, message, finish_reason: finishReason }],
                    }),
                  );
                }
              } catch (error) {
                errors.push(error);
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
        const configDir = path.join(home, ".codebuddy");
        yield* fs.makeDirectory(configDir);
        yield* fs.writeFileString(
          path.join(configDir, "models.json"),
          encodeJson({
            models: ["codework-loopback", "codework-alternate"].map((id) => ({
              id,
              name: id,
              vendor: "OpenAI",
              apiKey: "local-test-only",
              url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
              maxInputTokens: 32768,
              maxOutputTokens: 4096,
              supportsToolCall: true,
              relatedModels: { lite: id, reasoning: id, subagent: id },
            })),
            availableModels: ["codework-loopback", "codework-alternate"],
          }),
        );
        const configPath = path.join(configDir, "settings.json");
        yield* fs.writeFileString(
          configPath,
          encodeJson({
            model: "codework-loopback",
            permissions: { defaultMode: "default" },
            enabledPlugins: {},
            env: {},
          }),
        );
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: process.execPath,
            args: [
              cliPath!,
              "--acp",
              "--model",
              "codework-loopback",
              "--permission-mode",
              "default",
              "--tools",
              "Read,Write,PowerShell",
            ],
            cwd,
            env: {
              ...isolatedProbeEnvironment(home),
              CODEBUDDY_CONFIG_DIR: configDir,
              CODEBUDDY_API_KEY: "local-test-only",
              CODEBUDDY_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
              CODEBUDDY_DISABLE_AUTOUPDATER: "1",
              DISABLE_TELEMETRY: "1",
            },
          },
          cwd,
          authMethodId: "",
          clientInfo: { name: "codework-codebuddy-local", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        };
        const prompt = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) => {
          promptMarker = `CODEBUDDY_ACTION_${++promptSequence}`;
          return runtime.prompt({
            prompt: [{ type: "text", text: `${promptMarker} 执行本机协议动作。` }],
          });
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
              if (!choice) throw new Error(`官方未广告审批选项 ${permission}`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const started = yield* runtime.start();
          expect(started.initializeResult.agentInfo).toBeUndefined();
          expect(started.initializeResult.authMethods?.map((method) => method.id)).toEqual([
            "iOA",
            "external",
            "internal",
            "selfhosted",
          ]);
          expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);

          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              if (event._tag === "ToolCallUpdated") {
                if (event.toolCall.status === "failed") originalFailures.push(event.rawPayload);
                tools.set(event.toolCall.toolCallId, event.toolCall);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("CODEBUDDY_LOOPBACK_OK");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("codework-loopback");
          expect((yield* runtime.getAvailableCommands).length).toBeGreaterThan(0);
          yield* runtime.setModel("custom-local:codework-alternate");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("custom-local:codework-alternate");
          selectedModel = "codework-alternate";
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          nextTool = { name: "Read", args: { file_path: path.join(cwd, "source.txt") } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("CODEBUDDY_SOURCE_72319");
          const read = [...tools.values()].findLast((tool) => tool.kind === "read");
          expect(read).toMatchObject({ status: "completed" });
          expect(read?.detail).toContain("CODEBUDDY_SOURCE_72319");
          nextTool = {
            name: "Write",
            args: { file_path: path.join(cwd, "approved.txt"), content: "APPROVED" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
          expect(decisions).toContain("allow_once");
          nextTool = {
            name: "PowerShell",
            args: { command: "Write-Output CODEBUDDY_SHELL_72319" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("CODEBUDDY_SHELL_72319");
          expect([...tools.values()].findLast((tool) => tool.kind === "execute")).toMatchObject({
            status: "completed",
            detail: expect.stringContaining("CODEBUDDY_SHELL_72319"),
          });
          const priorIds = new Set(tools.keys());
          nextTool = { name: "PowerShell", args: { command: "exit 7" } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect([...tools.values()].filter((tool) => !priorIds.has(tool.toolCallId))).toEqual([
            expect.objectContaining({
              kind: "execute",
              status: "failed",
              detail: expect.stringContaining("7"),
              data: expect.objectContaining({
                rawOutput: expect.objectContaining({ exitCode: 7 }),
              }),
            }),
          ]);
          expect(originalFailures).toContainEqual(
            expect.objectContaining({
              update: expect.objectContaining({
                status: "completed",
                _meta: expect.objectContaining({
                  "codebuddy.ai/rawResponse": expect.objectContaining({ exitCode: 7 }),
                }),
              }),
            }),
          );
          permission = "reject_once";
          const beforeDenied = new Set(tools.keys());
          nextTool = {
            name: "Write",
            args: { file_path: path.join(cwd, "denied.txt"), content: "DENIED" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          expect([...tools.values()].filter((tool) => !beforeDenied.has(tool.toolCallId))).toEqual([
            expect.objectContaining({ status: "failed" }),
          ]);
          permission = "cancel";
          const beforeCancel = new Set(tools.keys());
          nextTool = {
            name: "Write",
            args: { file_path: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
          };
          expect((yield* prompt(runtime)).stopReason).toBe("cancelled");
          permission = "allow_once";
          const sentBeforeContinue = requests.filter(
            (event) => event.method === "session/prompt" && event.status === "started",
          ).length;
          const continued = yield* prompt(runtime).pipe(Effect.result);
          if (continued._tag === "Failure") {
            expect(continued.failure).toMatchObject({
              code: -32000,
              method: "session/prompt",
              errorMessage: expect.stringContaining("CodeBuddy 取消保护窗口"),
            });
            expect(
              requests.filter(
                (event) => event.method === "session/prompt" && event.status === "started",
              ),
            ).toHaveLength(sentBeforeContinue);
          } else expect(continued.success.stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          expect([...tools.values()].filter((tool) => !beforeCancel.has(tool.toolCallId))).toEqual([
            expect.objectContaining({ status: "failed" }),
          ]);
          yield* Fiber.interrupt(consumer);
          return started.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(options)), Effect.scoped);
        restoring = true;
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          expect((yield* runtime.start()).sessionId).toBe(sessionId);
          // 固定 CLI 的 --model 重置新进程默认；从实际广告重新选择，不推断持久化模型。
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("codework-loopback");
          yield* runtime.setModel("custom-local:codework-alternate");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("custom-local:codework-alternate");
          const text: string[] = [];
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              return Effect.void;
            }),
            Effect.forkChild,
          );
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("CODEBUDDY_RESTORED_OK");
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
          Effect.scoped,
        );
        expect(errors).toEqual([]);
        expect(toolSequence).toBe(6);
        expect(requestPaths.length).toBeGreaterThan(0);
        expect(requests.some((event) => event.method === "authenticate")).toBe(false);
        expect(
          requests.some((event) => event.method === "session/load" && event.status === "succeeded"),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
