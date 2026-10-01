// @effect-diagnostics nodeBuiltinImport:off - 直接验证官方 CLI 的原始 OpenAI SSE 请求与响应。
/** 官方 Goose 自定义端点 工具探针；不调用 GitHub 账号或外部模型。 */
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import * as AcpErrors from "effect-acp/errors";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { type AcpToolCallState } from "./AcpRuntimeModel.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_GOOSE_CLI_PATH;
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
// oxlint-disable-next-line codework/no-global-process-runtime -- 注册 Windows CLI 探针时尚未进入 Effect 环境。
describe.runIf(Boolean(cliPath) && process.platform === "win32")(
  "Goose 官方 CLI + 本机模型",
  () => {
    it.effect(
      "固定版本配置、真实工具、拒绝、取消和历史恢复",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-goose-local-" });
          const cwd = path.join(root, "workspace"),
            home = path.join(root, "home");
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(home);
          yield* fs.writeFileString(path.join(cwd, "source.txt"), "GOOSE_SOURCE_72319");
          let nextTool: { name: string; args: Record<string, unknown> } | undefined;
          let promptMarker = "",
            promptSequence = 0,
            completionSequence = 0,
            toolSequence = 0;
          let restoring = false,
            restoredRequestCount = 0,
            modelListRequests = 0;
          const selectedModel = "codework-loopback";
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
                  expect(request.headers.authorization).toBe("Bearer local-test-only");
                  if (request.url === "/v1/models") {
                    expect(request.method).toBe("GET");
                    expect(raw).toBe("");
                    modelListRequests++;
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(
                      encodeJson({
                        object: "list",
                        data: [
                          {
                            id: selectedModel,
                            object: "model",
                            created: 1,
                            owned_by: "local-test",
                          },
                        ],
                      }),
                    );
                    return;
                  }
                  expect(request.url).toBe("/v1/chat/completions");
                  expect(request.method).toBe("POST");
                  const body = decodeRequest(raw);
                  expect(body.model).toBe(selectedModel);
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
                  if (restoring && action) {
                    restoredRequestCount++;
                    expect(
                      body.messages.some(
                        (message) =>
                          message.role === "tool" &&
                          encodeJson(message.content).includes("GOOSE_SOURCE_72319"),
                      ),
                    ).toBe(true);
                    expect(
                      body.messages.some(
                        (message) =>
                          message.role === "tool" &&
                          encodeJson(message.content).includes("GOOSE_SHELL_72319"),
                      ),
                    ).toBe(true);
                  }
                  const message = tool
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            index: 0,
                            id: `call_goose_${++toolSequence}`,
                            type: "function",
                            function: { name: tool.name, arguments: encodeJson(tool.args) },
                          },
                        ],
                      }
                    : {
                        role: "assistant",
                        content: restoring && action ? "GOOSE_RESTORED_OK" : "GOOSE_LOOPBACK_OK",
                      };
                  const id = `goose-completion-${++completionSequence}`,
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
          const configDir = path.join(home, "config");
          yield* fs.makeDirectory(configDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(configDir, "config.yaml"),
            [
              "GOOSE_PROVIDER: openai",
              "GOOSE_MODEL: codework-loopback",
              "GOOSE_MODE: approve",
              "active_provider: openai",
              "providers:",
              "  openai:",
              "    enabled: true",
              "    model: codework-loopback",
              "    configured: true",
              "extensions:",
              "  developer:",
              "    enabled: true",
              "  summon:",
              "    enabled: false",
            ].join("\n") + "\n",
          );
          const shellScript =
            "require('node:fs').appendFileSync('shell-count.txt','x'); console.log('GOOSE_SHELL_72319')";
          const shellCommand = '"' + process.execPath + '" -e "' + shellScript + '"';
          const failedCommand = '"' + process.execPath + '" -e "process.exit(7)"';
          const hostCalls: { method: string; target: string }[] = [];
          const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
          const options: AcpSessionRuntime.AcpSessionRuntimeOptions = {
            spawn: {
              command: cliPath!,
              args: ["acp"],
              cwd,
              env: {
                ...isolatedProbeEnvironment(home),

                GOOSE_PROVIDER: "openai",
                GOOSE_PATH_ROOT: home,
                GOOSE_MODEL: selectedModel,
                GOOSE_MODE: "approve",
                GOOSE_DISABLE_KEYRING: "1",
                GOOSE_DISABLE_SESSION_NAMING: "true",
                OPENAI_API_KEY: "local-test-only",
                OPENAI_HOST: "http://127.0.0.1:" + address.port,
                OPENAI_BASE_PATH: "v1/chat/completions",
              },
            },
            cwd,
            authMethodId: "",
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
            clientInfo: { name: "codework-goose-local", version: "0.0.0" },
            requestLogger: (event) =>
              Effect.sync(() => {
                requests.push(event);
              }),
          };
          const prompt = (runtime: AcpSessionRuntime.AcpSessionRuntime["Service"]) => {
            promptMarker = `GOOSE_ACTION_${++promptSequence}`;
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
            const scope = yield* Scope.Scope;
            let activeSessionId = "";
            const terminals = new Map<
              string,
              {
                child: NodeChildProcess.ChildProcess;
                output: string;
                exit: Promise<{ exitCode: number | null; signal: string | null }>;
                status?: { exitCode: number | null; signal: string | null };
              }
            >();
            const checkSession = (sessionId: string) => expect(sessionId).toBe(activeSessionId);
            const checkPath = (target: string) => {
              const relative = path.relative(cwd, path.resolve(target));
              expect(relative.startsWith("..")).toBe(false);
              expect(path.isAbsolute(relative)).toBe(false);
            };
            yield* runtime.handleReadTextFile((request) =>
              Effect.gen(function* () {
                checkSession(request.sessionId);
                checkPath(request.path);
                hostCalls.push({ method: "read", target: request.path });
                const contents = yield* fs
                  .readFileString(request.path)
                  .pipe(
                    Effect.mapError(() =>
                      AcpErrors.AcpRequestError.resourceNotFound("探针目标不存在或不可读"),
                    ),
                  );
                const lines = contents.split(/\r?\n/).slice((request.line ?? 1) - 1);
                return {
                  content: (request.limit == null ? lines : lines.slice(0, request.limit)).join(
                    "\n",
                  ),
                };
              }),
            );
            yield* runtime.handleWriteTextFile((request) =>
              Effect.gen(function* () {
                checkSession(request.sessionId);
                checkPath(request.path);
                hostCalls.push({ method: "write", target: request.path });
                yield* fs.writeFileString(request.path, request.content).pipe(Effect.orDie);
                return {};
              }),
            );
            yield* runtime.handleCreateTerminal((request) =>
              Effect.gen(function* () {
                checkSession(request.sessionId);
                expect([shellCommand, failedCommand]).toContain(request.command);
                expect(path.resolve(request.cwd ?? cwd)).toBe(path.resolve(cwd));
                expect(request.args ?? []).toEqual([]);
                hostCalls.push({ method: "terminal/create", target: request.command });
                const child = yield* Effect.acquireRelease(
                  Effect.sync(() =>
                    NodeChildProcess.spawn(request.command, [], {
                      shell: process.env.COMSPEC!,
                      cwd,
                      env: isolatedProbeEnvironment(home),
                      windowsHide: true,
                    }),
                  ),
                  (child) =>
                    Effect.sync(() => {
                      if (child.exitCode == null && child.signalCode == null) child.kill();
                    }),
                ).pipe(Effect.provideService(Scope.Scope, scope));
                const state: {
                  child: NodeChildProcess.ChildProcess;
                  output: string;
                  exit: Promise<{ exitCode: number | null; signal: string | null }>;
                  status?: { exitCode: number | null; signal: string | null };
                } = { child, output: "", exit: Promise.resolve({ exitCode: null, signal: null }) };
                state.exit = new Promise((resolve, reject) => {
                  child.once("error", reject);
                  child.once("close", (exitCode, signal) => {
                    state.status = { exitCode, signal };
                    resolve(state.status);
                  });
                });
                for (const stream of [child.stdout, child.stderr])
                  stream?.on("data", (chunk) => {
                    state.output = (state.output + chunk.toString()).slice(-8192);
                  });
                const terminalId = "goose-terminal-" + terminals.size;
                terminals.set(terminalId, state);
                return { terminalId };
              }),
            );
            const terminal = (sessionId: string, terminalId: string) => {
              checkSession(sessionId);
              const state = terminals.get(terminalId);
              if (!state) throw new Error("终端不属于本探针");
              return state;
            };
            yield* runtime.handleTerminalWaitForExit((request) =>
              Effect.promise(() => terminal(request.sessionId, request.terminalId).exit),
            );
            yield* runtime.handleTerminalOutput((request) =>
              Effect.sync(() => {
                const state = terminal(request.sessionId, request.terminalId);
                return {
                  output: state.output,
                  truncated: false,
                  ...(state.status ? { exitStatus: state.status } : {}),
                };
              }),
            );
            yield* runtime.handleTerminalKill((request) =>
              Effect.sync(() => {
                terminal(request.sessionId, request.terminalId).child.kill();
                return {};
              }),
            );
            yield* runtime.handleTerminalRelease((request) =>
              Effect.sync(() => {
                terminal(request.sessionId, request.terminalId);
                hostCalls.push({ method: "terminal/release", target: request.terminalId });
                return {};
              }),
            );
            const started = yield* runtime.start();
            activeSessionId = started.sessionId;
            expect(started.initializeResult.agentInfo).toMatchObject({
              name: "goose",
              version: "1.52.0",
            });
            expect(started.initializeResult.agentCapabilities?.loadSession).toBe(true);
            expect(started.initializeResult.authMethods?.map((method) => method.id)).toEqual([
              "goose-provider",
            ]);
            expect((yield* runtime.getModeState)?.currentModeId).toBe("approve");
            expect(
              (yield* runtime.getConfigOptions).find((option) => option.category === "model"),
            ).toMatchObject({ currentValue: selectedModel });
            const consumer = yield* runtime.getEvents().pipe(
              Stream.runForEach((event) => {
                if (event._tag === "EventStreamBarrier")
                  return Deferred.succeed(event.acknowledge, undefined);
                if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
                  text.push(event.text);
                if (event._tag === "ToolCallUpdated")
                  tools.set(event.toolCall.toolCallId, event.toolCall);
                return Effect.void;
              }),
              Effect.forkChild,
            );
            expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
            yield* runtime.drainEvents;
            expect(text.join("")).toContain("GOOSE_LOOPBACK_OK");
            expect((yield* runtime.getAvailableCommands).length).toBeGreaterThan(0);
            nextTool = { name: "read", args: { path: path.join(cwd, "source.txt") } };
            yield* prompt(runtime);
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect(encodeJson(toolResults)).toContain("GOOSE_SOURCE_72319");
            const read = [...tools.values()].findLast((tool) => tool.kind === "read");
            expect(read).toMatchObject({ status: "completed" });
            // Goose 的 ACP-aware 文件工具不在通知中附带读取正文；不从模型替身伪造显示结果。
            expect(read?.detail).toBe(path.join(cwd, "source.txt"));
            expect(read?.data.rawOutput).toBeUndefined();
            expect(read?.data.content).toBeUndefined();
            nextTool = {
              name: "write",
              args: { path: path.join(cwd, "approved.txt"), content: "APPROVED" },
            };
            yield* prompt(runtime);
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect(yield* fs.readFileString(path.join(cwd, "approved.txt"))).toBe("APPROVED");
            expect(decisions).toContain("allow_once");
            nextTool = {
              name: "shell",
              args: { command: shellCommand },
            };
            yield* prompt(runtime);
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect(encodeJson(toolResults)).toContain("GOOSE_SHELL_72319");
            expect([...tools.values()].findLast((tool) => tool.kind === "execute")).toMatchObject({
              status: "completed",
              data: { content: [{ type: "terminal", terminalId: "goose-terminal-0" }] },
            });
            expect(terminals.get("goose-terminal-0")).toMatchObject({
              output: expect.stringContaining("GOOSE_SHELL_72319"),
              status: { exitCode: 0, signal: null },
            });
            const priorIds = new Set(tools.keys());
            nextTool = {
              name: "shell",
              args: { command: failedCommand },
            };
            yield* prompt(runtime);
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect([...tools.values()].filter((tool) => !priorIds.has(tool.toolCallId))).toEqual([
              expect.objectContaining({
                kind: "execute",
                status: "failed",
                detail: expect.stringContaining("7"),
              }),
            ]);
            expect(terminals.get("goose-terminal-1")?.status).toEqual({
              exitCode: 7,
              signal: null,
            });
            permission = "reject_once";
            const beforeDenied = new Set(tools.keys());
            nextTool = {
              name: "write",
              args: { path: path.join(cwd, "denied.txt"), content: "DENIED" },
            };
            yield* prompt(runtime);
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect(decisions).toContain("reject_once");
            expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
            expect(
              [...tools.values()].filter((tool) => !beforeDenied.has(tool.toolCallId)),
            ).toEqual([expect.objectContaining({ status: "failed" })]);
            permission = "cancel";
            const beforeCancel = new Set(tools.keys());
            nextTool = {
              name: "write",
              args: { path: path.join(cwd, "cancelled.txt"), content: "CANCELLED" },
            };
            expect((yield* prompt(runtime)).stopReason).toBe("cancelled");
            yield* runtime.drainEvents;
            expect(nextTool).toBeUndefined();
            expect(decisions).toContain("cancel");
            expect(yield* fs.exists(path.join(cwd, "cancelled.txt"))).toBe(false);
            expect(
              [...tools.values()].filter((tool) => !beforeCancel.has(tool.toolCallId)),
            ).toEqual([expect.objectContaining({ status: "failed" })]);
            permission = "allow_once";
            expect((yield* prompt(runtime)).stopReason).toBe("end_turn");
            yield* runtime.drainEvents;
            expect(yield* fs.readFileString(path.join(cwd, "shell-count.txt"))).toBe("x");
            expect(
              hostCalls.filter(
                (call) => call.method === "read" && call.target === path.join(cwd, "source.txt"),
              ),
            ).toHaveLength(1);
            expect(hostCalls.filter((call) => call.method === "write")).toEqual([
              { method: "write", target: path.join(cwd, "approved.txt") },
            ]);
            expect(hostCalls.filter((call) => call.method === "terminal/create")).toHaveLength(2);
            expect(hostCalls.filter((call) => call.method === "terminal/release")).toHaveLength(2);
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
            expect(text.join("")).toContain("GOOSE_RESTORED_OK");
            yield* Fiber.interrupt(consumer);
          }).pipe(
            Effect.provide(AcpSessionRuntime.layer({ ...options, resumeSessionId: sessionId })),
            Effect.scoped,
          );
          expect(errors).toEqual([]);
          expect(toolSequence).toBe(6);
          expect(restoredRequestCount).toBe(1);
          expect(modelListRequests).toBeGreaterThan(0);
          expect(requestPaths.length).toBeGreaterThan(0);
          expect(requests.every((event) => event.method !== "authenticate")).toBe(true);
          expect(
            requests.some(
              (event) => event.method === "session/load" && event.status === "succeeded",
            ),
          ).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      { timeout: 90000 },
    );
  },
);
