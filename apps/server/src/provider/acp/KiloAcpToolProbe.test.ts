// @effect-diagnostics nodeBuiltinImport:off - 直接验证官方 CLI 的原始 OpenAI SSE 请求与响应。
/** 官方 Kilo 自定义端点工具探针；不调用 Kilo 账号或外部模型。 */
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
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

const cliPath = process.env.CODEWORK_KILO_CLI_PATH;
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
describe.runIf(Boolean(cliPath))("Kilo 官方 CLI + 本机模型", () => {
  it.effect(
    "固定版本配置、真实工具、拒绝、取消和历史恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* Effect.acquireRelease(
          fs.makeTempDirectory({ prefix: "codework-kilo-local-" }),
          (root) => {
            if (!path.isAbsolute(root) || !path.basename(root).startsWith("codework-kilo-local-"))
              return Effect.die(new Error("拒绝回收不属于本探针的临时目录。"));
            return Effect.promise(() =>
              NodeFSP.rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 }),
            );
          },
        );
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "KILO_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let promptMarker = "",
          promptSequence = 0,
          completionSequence = 0,
          toolSequence = 0;
        let restoring = false;
        let selectedModel = "codework-loopback";
        let titleRequests = 0;
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
                const titleRequest =
                  body.messages.length === 2 &&
                  body.messages[0]?.role === "system" &&
                  typeof body.messages[0].content === "string" &&
                  body.messages[0].content.startsWith("You are a title generator.") &&
                  body.messages[1]?.role === "user" &&
                  typeof body.messages[1].content === "string" &&
                  body.messages[1].content.startsWith("Generate a title for this conversation:") &&
                  !body.tools?.length;
                if (titleRequest) titleRequests++;
                expect(body.model).toBe(titleRequest ? "codework-loopback" : selectedModel);
                for (const message of body.messages)
                  if (message.role === "tool") toolResults.push(message.content);
                const current = body.messages.at(-1);
                const action =
                  !titleRequest &&
                  current?.role === "user" &&
                  encodeJson(current.content).includes(promptMarker);
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
                        encodeJson(message.content).includes("KILO_SOURCE_72319"),
                    ),
                  ).toBe(true);
                const message = tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_kilo_${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content: titleRequest
                        ? "本机协议验证"
                        : restoring && action
                          ? "KILO_RESTORED_OK"
                          : "KILO_LOOPBACK_OK",
                    };
                const id = `kilo-completion-${++completionSequence}`,
                  finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ])
                    response.write(
                      `data: ${encodeJson({ ...chunk, id, object: "chat.completion.chunk", created: 1, model: body.model })}\n\n`,
                    );
                  response.end("data: [DONE]\n\n");
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    encodeJson({
                      id,
                      object: "chat.completion",
                      created: 1,
                      model: body.model,
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
        const configPath = path.join(home, "kilo.json");
        yield* fs.writeFileString(
          configPath,
          encodeJson({
            model: "codework-local/codework-loopback",
            small_model: "codework-local/codework-loopback",
            enabled_providers: ["codework-local"],
            autoupdate: false,
            share: "disabled",
            plugin: [],
            lsp: false,
            formatter: false,
            permission: "ask",
            provider: {
              "codework-local": {
                npm: "@ai-sdk/openai-compatible",
                name: "本机协议模型",
                options: {
                  baseURL: `http://127.0.0.1:${address.port}/v1`,
                  apiKey: "local-test-only",
                },
                models: Object.fromEntries(
                  ["codework-loopback", "codework-alternate"].map((id) => [
                    id,
                    { name: id, tool_call: true, limit: { context: 32768, output: 4096 } },
                  ]),
                ),
              },
            },
          }),
        );
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: cliPath!,
            args: ["acp", "--pure"],
            cwd,
            env: {
              ...isolatedProbeEnvironment(home),
              XDG_CONFIG_HOME: path.join(home, "config"),
              XDG_DATA_HOME: path.join(home, "data"),
              XDG_CACHE_HOME: path.join(home, "cache"),
              XDG_STATE_HOME: path.join(home, "state"),
              KILO_CONFIG: configPath,
              KILO_CONFIG_CONTENT: "",
              KILO_DISABLE_AUTOUPDATE: "true",
              KILO_DISABLE_MODELS_FETCH: "true",
              KILO_DISABLE_DEFAULT_PLUGINS: "true",
              KILO_DISABLE_EXTERNAL_SKILLS: "true",
              KILO_DISABLE_LSP_DOWNLOAD: "true",
              KILO_DISABLE_PROJECT_CONFIG: "true",
              KILO_DISABLE_CLAUDE_CODE: "true",
            },
          },
          cwd,
          authMethodId: "",
          clientInfo: { name: "codework-kilo-local", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        };
        const prompt = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) => {
          promptMarker = `KILO_ACTION_${++promptSequence}`;
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
          const cancelledPermissions: unknown[] = [];
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              decisions.push(permission);
              if (permission === "cancel") {
                cancelledPermissions.push(request);
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find((option) => option.kind === permission);
              if (!choice) throw new Error(`官方未广告审批选项 ${permission}`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const started = yield* runtime.start();
          expect(started.initializeResult.agentInfo).toMatchObject({
            name: "Kilo",
            version: "7.8.1",
          });
          expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);
          expect((yield* runtime.getModeState)?.currentModeId).toBe("code");
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
          expect(text.join("")).toContain("KILO_LOOPBACK_OK");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("codework-local/codework-loopback");
          expect((yield* runtime.getAvailableCommands).length).toBeGreaterThan(0);
          yield* runtime.setModel("codework-local/codework-alternate");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.category === "model")
              ?.currentValue,
          ).toBe("codework-local/codework-alternate");
          selectedModel = "codework-alternate";
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          nextTool = { name: "read", args: { filePath: path.join(cwd, "source.txt") } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("KILO_SOURCE_72319");
          const read = [...tools.values()].findLast((tool) => tool.kind === "read");
          expect(read).toMatchObject({ status: "completed" });
          expect(read?.detail).toContain("KILO_SOURCE_72319");
          nextTool = {
            name: "write",
            args: { filePath: path.join(cwd, "approved.txt"), content: "APPROVED" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
          expect(decisions).toContain("allow_once");
          nextTool = { name: "bash", args: { command: "echo KILO_SHELL_72319" } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("KILO_SHELL_72319");
          expect([...tools.values()].findLast((tool) => tool.kind === "execute")).toMatchObject({
            status: "completed",
            detail: expect.stringContaining("KILO_SHELL_72319"),
          });
          const priorIds = new Set(tools.keys());
          nextTool = { name: "bash", args: { command: "exit 7" } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect([...tools.values()].filter((tool) => !priorIds.has(tool.toolCallId))).toEqual([
            expect.objectContaining({
              kind: "execute",
              status: "failed",
              detail: expect.stringContaining("Exit code: 7"),
              data: expect.objectContaining({
                rawOutput: expect.objectContaining({
                  exitCode: 7,
                  metadata: expect.objectContaining({ exit: 7 }),
                }),
              }),
            }),
          ]);
          expect(originalFailures).toContainEqual(
            expect.objectContaining({
              update: expect.objectContaining({
                status: "completed",
                rawOutput: expect.objectContaining({
                  metadata: expect.objectContaining({ exit: 7 }),
                }),
              }),
            }),
          );
          permission = "reject_once";
          const beforeDenied = new Set(tools.keys());
          nextTool = {
            name: "write",
            args: { filePath: path.join(cwd, "denied.txt"), content: "DENIED" },
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
            name: "write",
            args: { filePath: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
          };
          expect((yield* prompt(runtime)).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          expect(cancelledPermissions).toEqual([
            expect.objectContaining({
              toolCall: expect.objectContaining({ toolCallId: "call_kilo_6" }),
            }),
          ]);
          expect(encodeJson(cancelledPermissions)).toContain("cancelled.txt");
          // 仅审批尚未执行，不制造工具终态；实际执行工具仍按通知显示。
          expect([...tools.values()].filter((tool) => !beforeCancel.has(tool.toolCallId))).toEqual(
            [],
          );
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("KILO_LOOPBACK_OK");
          yield* Fiber.interrupt(consumer);
          return started.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(options)), Effect.scoped);
        restoring = true;
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          expect((yield* runtime.start()).sessionId).toBe(sessionId);
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
          expect(text.join("")).toContain("KILO_RESTORED_OK");
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
          Effect.scoped,
        );
        expect(errors).toEqual([]);
        expect(toolSequence).toBe(6);
        expect(titleRequests).toBeGreaterThan(0);
        expect(requestPaths.length).toBeGreaterThan(0);
        expect(requests.some((event) => event.method === "authenticate")).toBe(false);
        expect(
          requests.some((event) => event.method === "session/load" && event.status === "succeeded"),
        ).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
