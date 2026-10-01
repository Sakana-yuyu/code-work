// @effect-diagnostics nodeBuiltinImport:off - 本地响应端点验证官方 CLI 的原始模型请求。
/** 官方 Hermes 执行真实工具；模型回复由本机夹具产生，不代表外部模型验收。 */
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

const cliPath = process.env.CODEWORK_HERMES_CLI_PATH;
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

describe.runIf(Boolean(cliPath))("Hermes 官方 CLI + 本地模型工具链路", () => {
  it.effect(
    "文本、读写、命令、拒绝、取消与新进程恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-hermes-tools-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(home);
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "HERMES_SOURCE_72319");
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
                if (request.method === "GET" && request.url === "/v1/models") {
                  response.setHeader("content-type", "application/json");
                  response.end(
                    encodeJson({
                      object: "list",
                      data: ["hermes-probe-model", "hermes-probe-alternate"].map((id) => ({
                        id,
                        object: "model",
                      })),
                    }),
                  );
                  return;
                }
                // 上游探测本机服务的模型元数据；未提供的能力明确返回 404。
                if (
                  (request.method === "POST" && request.url === "/api/show") ||
                  (request.method === "GET" &&
                    [
                      "/api/tags",
                      "/api/v1/models",
                      "/v1/props",
                      "/props",
                      "/version",
                      "/v1/models/hermes-probe-model",
                      "/v1/models/hermes-probe-alternate",
                    ].includes(request.url ?? ""))
                ) {
                  response.writeHead(404, { "content-type": "application/json" });
                  response.end(encodeJson({ error: "本机探针不提供此模型元数据" }));
                  return;
                }
                if (request.method !== "POST" || request.url !== "/v1/chat/completions")
                  throw new Error(`非预期模型路由：${request.method} ${request.url}`);
                let raw = "";
                for await (const chunk of request) raw += chunk;
                const body = decodeRequest(raw);
                if (
                  resuming &&
                  body.messages.some(
                    (message) =>
                      message.role === "tool" &&
                      encodeJson(message.content).includes("HERMES_SOURCE_72319"),
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
                          id: `hermes-tool-${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : { role: "assistant", content: "HERMES_LOOPBACK_OK" };
                const id = `hermes-response-${++completionSequence}`,
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
        yield* fs.writeFileString(
          path.join(home, "config.yaml"),
          encodeJson({
            model: {
              provider: "custom",
              default: "hermes-probe-model",
              base_url: `http://127.0.0.1:${address.port}/v1`,
            },
            platform_toolsets: { acp: ["file", "terminal", "no_mcp"] },
          }),
        );
        const env = isolatedProbeEnvironment(home);
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
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
              OPENAI_API_KEY: "local-test-only",
              PYTHONUTF8: "1",
              HERMES_GIT_BASH_PATH: process.env.CODEWORK_HERMES_GIT_BASH_PATH ?? "",
            },
          },
          cwd,
          authMethodId: "",
          clientInfo: { name: "codework-hermes-tools", version: "0.0.0" },
        };
        const sessionId = yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          let permission: "allow_once" | "reject_once" | "cancel" = "allow_once";
          const decisions: string[] = [],
            text: string[] = [];
          const tools = new Map<string, AcpToolCallState>(),
            initialTitles = new Map<string, string | undefined>();
          const permissionIds = new Set<string>();
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              permissionIds.add(request.toolCall.toolCallId);
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
            name: "hermes-agent",
            version: "0.21.5",
          });
          expect((yield* runtime.getAvailableModels)?.map((model) => model.slug)).toContain(
            "custom:hermes-probe-model",
          );
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
              prompt: [{ type: "text", text: `${promptMarker} 执行隔离协议验收动作。` }],
            });
          };
          expect((yield* prompt()).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("HERMES_LOOPBACK_OK");
          yield* runtime.setModel("custom:hermes-probe-alternate");
          expect((yield* runtime.getAvailableModels)?.find((model) => model.isDefault)?.slug).toBe(
            "custom:hermes-probe-alternate",
          );
          nextTool = {
            name: "read_file",
            args: { path: path.join(cwd, "source.txt") },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("HERMES_SOURCE_72319");
          expect(
            [...tools.values()].some((tool) => tool.kind === "read" && tool.status === "completed"),
          ).toBe(true);
          const readTool = [...tools.values()].find((tool) => tool.kind === "read")!;
          expect(readTool.title).toBe(initialTitles.get(readTool.toolCallId));
          expect(readTool.title).not.toBe("Tool");
          expect(encodeJson(readTool.data)).toContain("HERMES_SOURCE_72319");
          expect(readTool.detail).toContain("HERMES_SOURCE_72319");
          nextTool = {
            name: "write_file",
            args: { path: path.join(cwd, "approved.txt"), content: "APPROVED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect((yield* fs.readFileString(path.join(cwd, "approved.txt"))).trim()).toBe(
            "APPROVED",
          );
          expect(decisions).toContain("allow_once");
          nextTool = { name: "terminal", args: { command: "echo HERMES_SHELL_72319" } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("HERMES_SHELL_72319");
          expect(
            [...tools.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          expect([...tools.values()].find((tool) => tool.kind === "execute")?.detail).toContain(
            "HERMES_SHELL_72319",
          );
          const previousToolIds = new Set(tools.keys());
          nextTool = { name: "terminal", args: { command: "exit 7" } };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          // Hermes 的精简事件不提供 rawInput，命令标题只含截断预览，按本次真实工具 ID 检查结果。
          expect(
            [...tools.values()].filter((tool) => !previousToolIds.has(tool.toolCallId)),
          ).toEqual([
            expect.objectContaining({
              kind: "execute",
              status: "failed",
              detail: expect.stringContaining("7"),
            }),
          ]);
          expect(encodeJson(toolResults)).toMatch(/exit_code\\?":\s*7/);
          permission = "reject_once";
          nextTool = {
            name: "write_file",
            args: { path: path.join(cwd, "denied.txt"), content: "DENIED" },
          };
          yield* prompt();
          yield* runtime.drainEvents;
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          permission = "cancel";
          nextTool = {
            name: "write_file",
            args: { path: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
          };
          expect((yield* prompt()).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
          expect([...tools.keys()].filter((id) => permissionIds.has(id))).toEqual([]);
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
        expect(new Set(requestedModels)).toEqual(
          new Set(["hermes-probe-model", "hermes-probe-alternate"]),
        );
        expect(requestedModels.at(-1)).toBe("hermes-probe-alternate");
        expect(restoredHistory).toBe(true);
        expect(errors).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 120000 },
  );
});
