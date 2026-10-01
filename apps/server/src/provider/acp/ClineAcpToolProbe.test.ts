// @effect-diagnostics nodeBuiltinImport:off - 本地响应端点验证官方 CLI 的原始模型请求。
/** 官方 Cline 执行真实工具；模型回复由本机夹具产生，不代表外部模型验收。 */
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

const cliPath = process.env.CODEWORK_CLINE_CLI_PATH;
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

describe.runIf(Boolean(cliPath))("Cline 官方 CLI + 本地模型工具链路", () => {
  it.effect(
    "文本、读写、命令、拒绝、取消与新进程恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-cline-tools-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home"),
          data = path.join(root, "data");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(path.join(data, "settings"), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "CLINE_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let completionSequence = 0,
          toolSequence = 0,
          promptSequence = 0;
        let promptMarker = "",
          restoredHistory = false,
          resuming = false;
        const toolResults: unknown[] = [],
          errors: unknown[] = [],
          requestedModels: string[] = [];
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeHttp.createServer(async (request, response) => {
              try {
                if (request.method !== "POST" || request.url !== "/v1/chat/completions")
                  throw new Error("非预期模型路由");
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const body = decodeRequest(raw);
                if (
                  resuming &&
                  body.messages.some(
                    (message) =>
                      message.role === "tool" &&
                      encodeJson(message.content).includes("CLINE_SOURCE_72319"),
                  )
                )
                  restoredHistory = true;
                requestedModels.push(body.model);
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
                          id: `cline-tool-${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : { role: "assistant", content: "CLINE_LOOPBACK_OK" };
                const id = `cline-response-${++completionSequence}`,
                  finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ])
                    response.write(
                      `data: ${encodeJson({ ...chunk, id, object: "chat.completion.chunk" })}\n\n`,
                    );
                  response.end("data: [DONE]\n\n");
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    encodeJson({
                      id,
                      object: "chat.completion",
                      choices: [{ index: 0, message, finish_reason: finishReason }],
                    }),
                  );
                }
              } catch (error) {
                errors.push(error);
                response.writeHead(500);
                response.end("本地模型夹具格式错误");
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
        if (!address || typeof address === "string") throw new Error("本地端口未建立");
        // 使用官方 auth 命令实际生成的配置形状，端点和合成密钥均只用于本机。
        yield* fs.writeFileString(
          path.join(data, "settings", "providers.json"),
          encodeJson({
            version: 1,
            lastUsedProvider: "openai-compatible",
            modes: {},
            providers: {
              "openai-compatible": {
                settings: {
                  provider: "openai-compatible",
                  apiKey: "local-test-only",
                  model: "gpt-4o",
                  baseUrl: `http://127.0.0.1:${address.port}/v1`,
                },
                updatedAt: "2026-09-30T00:00:00.000Z",
                tokenSource: "manual",
              },
            },
          }),
        );
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: cliPath!,
            args: ["--acp", "--config", home],
            cwd,
            // 3.0.65 的 ACP 分支早于 --data-dir 处理；显式设置实际读取的数据目录。
            env: {
              ...isolatedProbeEnvironment(home),
              CLINE_DATA_DIR: data,
              CLINE_API_KEY: "local-test-only",
              CLINE_PROVIDER: "openai-compatible",
              CLINE_MODEL: "gpt-4o",
            },
          },
          cwd,
          authMethodId: "",
          clientInfo: { name: "codework-cline-tools", version: "0.0.0" },
        };
        const sessionId = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let permission: "allow_once" | "reject_once" | "cancel" = "allow_once";
          const decisions: string[] = [],
            text: string[] = [];
          const tools = new Map<string, AcpToolCallState>(),
            initialTitles = new Map<string, string | undefined>();
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              decisions.push(permission);
              if (permission === "cancel") {
                yield* runtime.cancel.pipe(Effect.orDie);
                return { outcome: { outcome: "cancelled" as const } };
              }
              const choice = request.options.find((option) => option.kind === permission);
              if (!choice) throw new Error(`缺少原生 ${permission} 选项`);
              return { outcome: { outcome: "selected" as const, optionId: choice.optionId } };
            }),
          );
          const start = yield* runtime.start();
          expect(start.initializeResult.agentInfo).toMatchObject({
            name: "cline",
            version: "3.0.65",
          });
          expect((yield* runtime.getAvailableModels)?.map((model) => model.slug)).toContain(
            "gpt-4o",
          );
          yield* runtime.setModel("gpt-4o");
          expect(
            (yield* runtime.getConfigOptions).find((option) => option.id === "auto_approve")
              ?.currentValue,
          ).toBe(false);
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
              prompt: [{ type: "text", text: `${promptMarker} 执行隔离协议验收动作。` }],
            });
          };
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("CLINE_LOOPBACK_OK");
          nextTool = {
            name: "read_files",
            args: { files: [{ path: path.join(cwd, "source.txt") }] },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("CLINE_SOURCE_72319");
          expect(
            [...tools.values()].some((tool) => tool.kind === "read" && tool.status === "completed"),
          ).toBe(true);
          const readTool = [...tools.values()].find((tool) => tool.kind === "read")!;
          expect(readTool.title).toBe(initialTitles.get(readTool.toolCallId));
          expect(readTool.title).not.toBe("Tool");
          expect(readTool.detail).toContain("CLINE_SOURCE_72319");
          nextTool = {
            name: "apply_patch",
            args: {
              input: "*** Begin Patch\n*** Add File: approved.txt\n+APPROVED\n*** End Patch",
            },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect((yield* fs.readFileString(path.join(cwd, "approved.txt"))).trim()).toBe(
            "APPROVED",
          );
          expect(decisions).toContain("allow_once");
          nextTool = { name: "run_commands", args: { commands: ["echo CLINE_SHELL_72319"] } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("CLINE_SHELL_72319");
          expect(
            [...tools.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          expect([...tools.values()].find((tool) => tool.kind === "execute")?.data).toMatchObject({
            command: "echo CLINE_SHELL_72319",
            rawOutput: [
              {
                query: "echo CLINE_SHELL_72319",
                success: true,
                result: expect.stringContaining("CLINE_SHELL_72319"),
              },
            ],
          });
          expect([...tools.values()].find((tool) => tool.kind === "execute")?.detail).toContain(
            "CLINE_SHELL_72319",
          );
          nextTool = { name: "run_commands", args: { commands: ["exit 7"] } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect([...tools.values()].find((tool) => tool.data.command === "exit 7")).toMatchObject({
            status: "failed",
            data: { rawOutput: [{ query: "exit 7", success: false }] },
          });
          permission = "reject_once";
          nextTool = {
            name: "apply_patch",
            args: { input: "*** Begin Patch\n*** Add File: denied.txt\n+DENIED\n*** End Patch" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          permission = "cancel";
          nextTool = {
            name: "apply_patch",
            args: {
              input: "*** Begin Patch\n*** Add File: cancelled.txt\n+CANCELLED\n*** End Patch",
            },
          };
          expect((yield* prompt()).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          yield* Fiber.interrupt(consumer);
          return start.sessionId;
        }).pipe(Effect.provide(AcpSessionRuntime.layer(options)), Effect.scoped);
        resuming = true;
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          expect((yield* runtime.start()).sessionId).toBe(sessionId);
          expect(
            (yield* runtime.prompt({ prompt: [{ type: "text", text: "恢复后回复验证" }] }))
              .stopReason,
          ).toBe("end_turn");
        }).pipe(
          Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
          Effect.scoped,
        );
        expect(requestedModels.length).toBeGreaterThan(0);
        expect(new Set(requestedModels)).toEqual(new Set(["gpt-4o"]));
        expect(restoredHistory).toBe(true);
        expect(errors).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
