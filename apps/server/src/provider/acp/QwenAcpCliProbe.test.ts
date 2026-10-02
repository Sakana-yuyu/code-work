// @effect-diagnostics nodeBuiltinImport:off - 测试端点直接发送原始 SSE 帧以核对外部 CLI 协议。
/** 官方 CLI + 本地模型响应夹具；不代表外部模型认证或推理验收。 */
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
import { isProbeScriptAvailable } from "./acpCliProbeGate.ts";

const cliPath = process.env.CODEWORK_QWEN_CLI_PATH;
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

describe.runIf(isProbeScriptAvailable(cliPath))("Qwen 官方 ACP CLI + 本地模型夹具", () => {
  it.effect(
    "真实握手、配置、文件工具、拒绝、取消和恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-qwen-probe-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(
          path.join(home, "settings.json"),
          encodeJson({
            general: { enableAutoUpdate: false },
            telemetry: { enabled: false },
            tools: { visible: ["run_shell_command"], shell: { enableInteractiveShell: false } },
          }),
        );
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "QWEN_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let toolSequence = 0;
        let completionSequence = 0;
        let promptSequence = 0;
        let promptMarker = "";
        let restoring = false;
        let restoredRequestCount = 0;
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        const toolResults: unknown[] = [];
        const serverErrors: unknown[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              try {
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const body = decodeRequest(raw);
                expect(body.model).toBe("codework-loopback");
                if (
                  restoring &&
                  body.messages.at(-1)?.role === "user" &&
                  encodeJson(body.messages.at(-1)?.content).includes(promptMarker)
                ) {
                  // 核对 CLI 重建后真正发出的旧工具内容，合成回复和同 ID 不能自证恢复。
                  const history = body.messages.filter((message) => message.role === "tool");
                  expect(encodeJson(history)).toContain("QWEN_SOURCE_72319");
                  expect(encodeJson(history)).toContain("QWEN_SHELL_72319");
                  restoredRequestCount++;
                }
                const completionId = `qwen-probe-${++completionSequence}`;
                for (const message of body.messages)
                  if (message.role === "tool") toolResults.push(message.content);
                const tool =
                  nextTool &&
                  body.messages.at(-1)?.role === "user" &&
                  encodeJson(body.messages.at(-1)?.content).includes(promptMarker) &&
                  body.tools?.some((entry) => entry.function.name === nextTool!.name)
                    ? nextTool
                    : undefined;
                if (tool) nextTool = undefined;
                const message = tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_qwen_probe_${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content: restoring ? "QWEN_RESTORED_OK" : "QWEN_LOOPBACK_OK",
                    };
                const finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ])
                    response.write(
                      `data: ${encodeJson({ ...chunk, id: completionId, object: "chat.completion.chunk" })}\n\n`,
                    );
                  response.end("data: [DONE]\n\n");
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    encodeJson({
                      id: completionId,
                      object: "chat.completion",
                      choices: [{ index: 0, message, finish_reason: finishReason }],
                    }),
                  );
                }
              } catch (error) {
                serverErrors.push(error);
                response.writeHead(500);
                response.end("模型夹具请求格式错误");
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
        if (!address || typeof address === "string") throw new Error("本地测试端口未建立");
        const env = isolatedProbeEnvironment(home);
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: process.execPath,
            args: ["--expose-gc", cliPath!, "--acp", "--experimental-skills"],
            cwd,
            env: {
              ...env,
              QWEN_HOME: home,
              QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, "no-system.json"),
              QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, "no-defaults.json"),
              OPENAI_API_KEY: "local-test-only",
              OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
              OPENAI_MODEL: "codework-loopback",
            },
          },
          cwd,
          authMethodId: "openai",
          clientInfo: { name: "codework-qwen-probe", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        };
        for (const methodId of ["login", "openai"]) {
          const unauthenticated = { ...options.spawn.env };
          unauthenticated.OPENAI_API_KEY = "";
          const result = yield* Effect.flatMap(AcpSessionRuntime.AcpSessionRuntime, (runtime) =>
            runtime.start(),
          ).pipe(
            Effect.result,
            Effect.provide(
              AcpSessionRuntime.layer({
                ...options,
                authMethodId: methodId,
                spawn: { ...options.spawn, env: unauthenticated },
              }),
            ),
            Effect.scoped,
          );
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") throw new Error("无认证会话不应成功");
          expect(result.failure).toMatchObject({ code: methodId === "login" ? -32602 : -32603 });
          if (methodId === "openai")
            expect(encodeJson(result.failure)).toContain("Missing API key");
        }
        const sessionId = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let permission: "allow_once" | "reject_once" | "cancel" = "allow_once";
          const decisions: string[] = [],
            text: string[] = [];
          const tools = new Map<string, AcpToolCallState>();
          const initialTitles = new Map<string, string | undefined>();
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              decisions.push(permission);
              if (permission === "cancel") {
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find((option) => option.kind === permission);
              if (!choice) throw new Error(`官方 CLI 没有 ${permission} 选项`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const start = yield* runtime.start();
          expect(start.initializeResult.agentInfo).toMatchObject({
            name: "qwen-code",
            version: "0.24.7",
          });
          expect(start.initializeResult.authMethods?.map((method) => method.id)).toEqual([
            "openai",
          ]);
          expect(start.initializeResult.agentCapabilities?.loadSession).toBe(true);
          expect((yield* runtime.getAvailableModels)?.length).toBeGreaterThan(0);
          yield* runtime.setMode("default");
          expect((yield* runtime.getModeState)?.currentModeId).toBe("default");
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              if (event._tag === "ToolCallUpdated") {
                if (!initialTitles.has(event.toolCall.toolCallId))
                  initialTitles.set(event.toolCall.toolCallId, event.toolCall.title);
                tools.set(event.toolCall.toolCallId, event.toolCall);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const prompt = () => {
            promptMarker = `CODEWORK_ACTION_${++promptSequence}`;
            return runtime.prompt({
              prompt: [{ type: "text", text: `${promptMarker} 执行本地协议验收动作。` }],
            });
          };
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("QWEN_LOOPBACK_OK");
          nextTool = { name: "read_file", args: { file_path: path.join(cwd, "source.txt") } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(encodeJson(toolResults)).toContain("QWEN_SOURCE_72319");
          const readTool = [...tools.values()].find((tool) => tool.kind === "read");
          expect(readTool?.title).toBe(initialTitles.get(readTool!.toolCallId));
          expect(readTool?.title).not.toBe("Tool");
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "approved.txt"), content: "APPROVED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
          expect(decisions).toContain("allow_once");
          expect([...tools.values()].some((tool) => tool.status === "completed")).toBe(true);
          nextTool = {
            name: "run_shell_command",
            args: { command: "echo QWEN_SHELL_72319", description: "输出合成验收标记" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("QWEN_SHELL_72319");
          expect(
            [...tools.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          expect([...tools.values()].find((tool) => tool.kind === "execute")?.data).toMatchObject({
            rawOutput: { exitCode: 0, output: expect.stringContaining("QWEN_SHELL_72319") },
          });
          permission = "reject_once";
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "denied.txt"), content: "DENIED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          permission = "cancel";
          nextTool = {
            name: "write_file",
            args: { file_path: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
          };
          expect((yield* prompt()).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          expect(nextTool).toBeUndefined();
          permission = "allow_once";
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          yield* Fiber.interrupt(consumer);
          return start.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(options)), Effect.scoped);
        restoring = true;
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          const start = yield* runtime.start();
          expect(start.sessionId).toBe(sessionId);
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
          promptMarker = `CODEWORK_RESTORE_${++promptSequence}`;
          expect(
            (yield* runtime.prompt({
              prompt: [{ type: "text", text: `${promptMarker} 验证恢复。` }],
            })).stopReason,
          ).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("QWEN_RESTORED_OK");
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
          Effect.scoped,
        );
        expect(restoredRequestCount).toBe(1);
        expect(toolSequence).toBe(5);
        expect(
          requests.filter(
            (event) => event.method === "session/load" && event.status === "succeeded",
          ),
        ).toHaveLength(1);
        expect(serverErrors).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
