// @effect-diagnostics nodeBuiltinImport:off - 直接验证官方 CLI 的原始 OpenAI SSE 请求与响应。
/** 官方 Copilot 离线 BYOK 工具探针；不调用 GitHub 账号或外部模型。 */
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
import { toAcpConfigOptions, type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { applyAcpConfigSelections } from "./AcpAdapterSupport.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_COPILOT_OFFLINE_CLI_PATH;
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
const agentMode = "https://agentclientprotocol.com/protocol/session-modes#agent";
const planMode = "https://agentclientprotocol.com/protocol/session-modes#plan";

describe.runIf(Boolean(cliPath))("Copilot 官方 CLI + 离线本机模型", () => {
  it.effect(
    "固定版本配置、真实工具、拒绝、取消和历史恢复",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-copilot-offline-" });
        const cwd = path.join(root, "workspace"),
          home = path.join(root, "home");
        yield* fs.makeDirectory(cwd);
        yield* fs.makeDirectory(path.join(home, "agents"), { recursive: true });
        yield* fs.writeFileString(
          path.join(home, "agents", "codework-profile.agent.md"),
          "---\nname: codework-profile\ndescription: 合成协议角色\ntools: []\n---\n只回复合成文本，不调用工具。\n",
        );
        yield* fs.writeFileString(path.join(cwd, "source.txt"), "COPILOT_SOURCE_72319");
        let nextTool: { name: string; args: Record<string, unknown> } | undefined;
        let promptMarker = "",
          promptSequence = 0,
          completionSequence = 0,
          toolSequence = 0;
        let restoring = false;
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
                expect(body.model).toBe("codework-loopback");
                for (const message of body.messages)
                  if (message.role === "tool") toolResults.push(message.content);
                const current = body.messages.at(-1);
                const action =
                  current?.role === "user" && encodeJson(current.content).includes(promptMarker);
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
                  expect(encodeJson(body.messages)).toContain("COPILOT_SOURCE_72319");
                const message = tool
                  ? {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_copilot_${++toolSequence}`,
                          type: "function",
                          function: { name: tool.name, arguments: encodeJson(tool.args) },
                        },
                      ],
                    }
                  : {
                      role: "assistant",
                      content: restoring && action ? "COPILOT_RESTORED_OK" : "COPILOT_LOOPBACK_OK",
                    };
                const id = `copilot-completion-${++completionSequence}`,
                  finishReason = tool ? "tool_calls" : "stop";
                if (body.stream) {
                  response.writeHead(200, { "content-type": "text/event-stream" });
                  for (const chunk of [
                    { choices: [{ index: 0, delta: message, finish_reason: null }] },
                    { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
                  ])
                    response.write(
                      `data: ${encodeJson({ ...chunk, id, object: "chat.completion.chunk", created: 1, model: "codework-loopback" })}\n\n`,
                    );
                  response.end("data: [DONE]\n\n");
                } else {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    encodeJson({
                      id,
                      object: "chat.completion",
                      created: 1,
                      model: "codework-loopback",
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
        const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
          spawn: {
            command: cliPath!,
            args: [
              "--acp",
              "--no-auto-update",
              "--no-custom-instructions",
              "--disable-builtin-mcps",
              "--log-level",
              "error",
              "--available-tools",
              "view,create,powershell",
            ],
            cwd,
            env: {
              ...isolatedProbeEnvironment(home),
              COPILOT_HOME: home,
              COPILOT_OFFLINE: "true",
              COPILOT_ALLOW_ALL: "false",
              COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
              COPILOT_PROVIDER_TYPE: "openai",
              COPILOT_PROVIDER_WIRE_API: "completions",
              COPILOT_PROVIDER_API_KEY: "local-test-only",
              COPILOT_MODEL: "codework-loopback",
            },
          },
          cwd,
          authMethodId: "",
          clientInfo: { name: "codework-copilot-offline", version: "0.0.0" },
        };
        const prompt = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) => {
          promptMarker = `COPILOT_ACTION_${++promptSequence}`;
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
          expect(started.initializeResult.agentInfo).toMatchObject({
            name: "Copilot",
            version: "1.0.89",
          });
          const configs = yield* runtime.getConfigOptions;
          expect(configs.find((option) => option.id === "allow_all")?.currentValue).toBe("off");
          expect(
            toAcpConfigOptions(configs).find((option) => option.id === "acpConfig:agent")
              ?.currentValue,
          ).toBe("value:");
          expect(yield* runtime.getAvailableModels).toBeNull();
          for (const [agent, allow] of [
            ["codework-profile", "on"],
            ["", "off"],
          ]) {
            yield* applyAcpConfigSelections(runtime, [
              { id: "acpConfig:agent", value: `value:${agent}` },
              { id: "acpConfig:allow_all", value: `value:${allow}` },
            ]);
            const current = yield* runtime.getConfigOptions;
            expect(current.find((option) => option.id === "agent")?.currentValue).toBe(agent);
            expect(current.find((option) => option.id === "allow_all")?.currentValue).toBe(allow);
          }
          expect(
            (yield* applyAcpConfigSelections(runtime, [
              { id: "acpConfig:agent", value: "value:missing" },
            ]).pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* runtime.setMode(planMode);
          expect((yield* runtime.getModeState)?.currentModeId).toBe(planMode);
          yield* runtime.setMode(agentMode);
          expect((yield* runtime.getModeState)?.currentModeId).toBe(agentMode);
          const consumer = yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier")
                return Deferred.succeed(event.acknowledge, undefined);
              if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                text.push(event.text);
              if (event._tag === "ToolCallUpdated") {
                tools.set(event.toolCall.toolCallId, event.toolCall);
                if (event.toolCall.status === "failed") originalFailures.push(event.rawPayload);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
          yield* runtime.drainEvents;
          expect(text.join("")).toContain("COPILOT_LOOPBACK_OK");
          expect(
            (yield* runtime.getAvailableCommands).some((command) => command.name === "usage"),
          ).toBe(true);
          nextTool = { name: "view", args: { path: path.join(cwd, "source.txt") } };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("COPILOT_SOURCE_72319");
          expect(
            [...tools.values()].some((tool) => tool.kind === "read" && tool.status === "completed"),
          ).toBe(true);
          nextTool = {
            name: "create",
            args: { path: path.join(cwd, "approved.txt"), file_text: "APPROVED" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
          expect(decisions).toContain("allow_once");
          nextTool = {
            name: "powershell",
            args: { command: "Write-Output 'COPILOT_SHELL_72319'", description: "输出合成标记" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(encodeJson(toolResults)).toContain("COPILOT_SHELL_72319");
          expect(
            [...tools.values()].some(
              (tool) => tool.kind === "execute" && tool.status === "completed",
            ),
          ).toBe(true);
          expect(
            [...tools.values()].findLast((tool) => tool.kind === "execute")?.data.rawOutput,
          ).toMatchObject({ exitCode: 0 });
          nextTool = {
            name: "powershell",
            args: { command: "exit 7", description: "验证非零退出码" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect([...tools.values()].findLast((tool) => tool.kind === "execute")).toMatchObject({
            status: "failed",
            data: { rawOutput: { exitCode: 7 } },
          });
          expect(originalFailures).toContainEqual(
            expect.objectContaining({
              update: expect.objectContaining({ status: "completed" }),
            }),
          );
          permission = "reject_once";
          nextTool = {
            name: "create",
            args: { path: path.join(cwd, "denied.txt"), file_text: "DENIED" },
          };
          yield* prompt(runtime);
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("reject_once");
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          permission = "cancel";
          nextTool = {
            name: "create",
            args: { path: path.join(cwd, "cancelled.txt"), file_text: "CANCELLED" },
          };
          expect((yield* prompt(runtime)).stopReason).toBe("cancelled");
          yield* runtime.drainEvents;
          expect(nextTool).toBeUndefined();
          expect(decisions).toContain("cancel");
          expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
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
          expect(text.join("")).toContain("COPILOT_RESTORED_OK");
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
          Effect.scoped,
        );
        expect(errors).toEqual([]);
        expect(requestPaths.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 90000 },
  );
});
