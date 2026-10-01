// @effect-diagnostics nodeBuiltinImport:off - 固定官方 CLI 的本机 HTTP 与真实进程取消检查。
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ACP_MODE_OPTION_ID,
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_GOOSE_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeModelRequest = Schema.decodeSync(
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
const decodeTerminal = Schema.decodeUnknownSync(Schema.Struct({ terminalId: Schema.String }));
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

// 普通测试也验证共用取消责任；此协议夹具不作为官方 Goose 的实测证据。
it.effect(
  "协议夹具：取消正在等待退出的宿主终端",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "acp-terminal-cancel-" });
      const adapter = yield* makeCursorAdapter(decodeCursorSettings({}), {
        provider: ProviderDriverKind.make("acpAgent"),
        instanceId: ProviderInstanceId.make("terminal-cancel-fixture"),
        acpCommand: process.execPath,
        acpArgs: [
          NodeURL.fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
        ],
        acpAuthMethodId: "",
        supportsModelSelection: false,
        environment: {
          ...isolatedProbeEnvironment(cwd),
          CODEWORK_ACP_TERMINAL_COMMAND: "受控夹具终端",
          CODEWORK_ACP_TERMINAL_CWD: cwd,
        },
      });
      const threadId = ThreadId.make("terminal-cancel-fixture");
      yield* Effect.addFinalizer(() =>
        adapter.hasSession(threadId).pipe(
          Effect.flatMap((hasSession) =>
            hasSession ? adapter.stopSession(threadId) : Effect.void,
          ),
          Effect.orDie,
        ),
      );
      const capabilityGrantIds = [
        "t3.terminal.exec",
        "t3.terminal.snapshot",
        "t3.terminal.kill",
        "t3.terminal.close",
      ];
      const handshake = yield* adapter.handshakeCapabilities!({
        runtimeId: "terminal-cancel-fixture",
        agentId: "terminal-cancel-fixture",
        runId: "run-cancel",
        taskId: "task-cancel",
        capabilityGrantIds,
      });
      expect(handshake.status).toBe("accepted");
      if (!handshake.handshakeId) throw new Error("缺能力握手");
      const waiting = yield* Deferred.make<void>();
      let ownedId: string | undefined;
      let running = true;
      const killed: string[] = [];
      yield* adapter.configureToolBroker!({
        threadId,
        context: {
          runtimeId: "terminal-cancel-fixture",
          agentId: "terminal-cancel-fixture",
          runId: "run-cancel",
          taskId: "task-cancel",
          capabilityGrantIds,
          capabilityHandshakeId: handshake.handshakeId,
          workspaceRoot: cwd,
          threadId,
        },
        bridge: {
          cancel: () => Effect.void,
          invoke: (invocation) =>
            Effect.gen(function* () {
              const { terminalId } = decodeTerminal(invocation.arguments);
              if (invocation.canonicalToolName === "terminal.exec") {
                expect(invocation.arguments).toMatchObject({
                  command: "受控夹具终端",
                  args: [],
                  cwd,
                });
                ownedId = terminalId;
              } else {
                expect(terminalId).toBe(ownedId);
                if (invocation.canonicalToolName === "terminal.snapshot") {
                  yield* Deferred.succeed(waiting, undefined);
                  return {
                    status: "succeeded" as const,
                    result: {
                      history: "",
                      status: running ? "running" : "exited",
                      exitCode: running ? null : 143,
                      exitSignal: null,
                    },
                  };
                }
                if (invocation.canonicalToolName === "terminal.kill") {
                  killed.push(terminalId);
                  running = false;
                } else {
                  expect(invocation.canonicalToolName).toBe("terminal.close");
                  running = false;
                }
              }
              return { status: "succeeded" as const, result: {} };
            }),
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("acpAgent"),
        cwd,
        runtimeMode: "full-access",
        capabilityHandshakeId: handshake.handshakeId,
      });
      const turn = yield* adapter
        .sendTurn({ threadId, input: "等待终端", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* adapter.interruptTurn(threadId);
      expect(killed).toEqual([ownedId]);
      expect(running).toBe(false);
      yield* Fiber.join(turn);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "acp-cancel-fixture-" })),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  { timeout: 10000 },
);

// oxlint-disable-next-line codework/no-global-process-runtime -- 注册本机 Windows CLI 检查时尚未进入 Effect 环境。
describe.runIf(Boolean(cliPath) && process.platform === "win32")(
  "Goose 共用 Adapter 运行中取消",
  () => {
    for (const scenario of ["running", "late", "denied", "late-denied"] as const) {
      const late = scenario.startsWith("late"),
        denied = scenario.endsWith("denied");
      it.effect(
        scenario + "：实际进程、原取消、资源归属与续聊",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const scope = yield* Scope.Scope;
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "codework-goose-cancel-" });
            const cwd = path.join(root, "workspace"),
              home = path.join(root, "home");
            yield* fs.makeDirectory(cwd);
            yield* fs.makeDirectory(path.join(home, "config"), { recursive: true });
            yield* fs.writeFileString(
              path.join(home, "config", "config.yaml"),
              "active_provider: openai\nproviders:\n  openai:\n    enabled: true\n    configured: true\n    model: codework-loopback\nextensions:\n  developer:\n    enabled: true\n  summon:\n    enabled: false\n",
            );
            const script =
              "process.stdout.write('GOOSE_PROCESS_READY'); process.stdin.resume(); process.stdin.on('data',()=>require('node:fs').appendFileSync('unexpected-write.txt','x'))";
            const command = '"' + process.execPath + '" -e "' + script + '"';
            let action = 0,
              requestedTools = 0;
            const errors: unknown[] = [];
            const server = yield* Effect.acquireRelease(
              Effect.sync(() =>
                NodeHttp.createServer(async (request, response) => {
                  try {
                    let raw = "";
                    for await (const chunk of request) raw += chunk;
                    expect(request.headers.authorization).toBe("Bearer local-test-only");
                    if (request.url === "/v1/models") {
                      expect(request.method).toBe("GET");
                      response.writeHead(200, { "content-type": "application/json" });
                      response.end(
                        encodeJson({
                          object: "list",
                          data: [
                            {
                              id: "codework-loopback",
                              object: "model",
                              created: 1,
                              owned_by: "local",
                            },
                          ],
                        }),
                      );
                      return;
                    }
                    expect(request.method).toBe("POST");
                    expect(request.url).toBe("/v1/chat/completions");
                    const body = decodeModelRequest(raw);
                    expect(body.model).toBe("codework-loopback");
                    const current = body.messages.at(-1);
                    const tool =
                      current?.role === "user" &&
                      action > 0 &&
                      encodeJson(current.content).includes("GOOSE_RUN_" + action);
                    if (tool) {
                      expect(body.tools?.some((tool) => tool.function.name === "shell")).toBe(true);
                      action = 0;
                      requestedTools++;
                    }
                    const message = tool
                      ? {
                          role: "assistant",
                          content: null,
                          tool_calls: [
                            {
                              index: 0,
                              id: "goose-run-" + requestedTools,
                              type: "function",
                              function: { name: "shell", arguments: encodeJson({ command }) },
                            },
                          ],
                        }
                      : { role: "assistant", content: "GOOSE_NEXT_OK" };
                    const finish_reason = tool ? "tool_calls" : "stop";
                    if (body.stream) {
                      response.writeHead(200, { "content-type": "text/event-stream" });
                      for (const part of [
                        { delta: message, finish_reason: null },
                        { delta: {}, finish_reason },
                      ])
                        response.write(
                          "data: " +
                            encodeJson({
                              id: "goose-cancel-completion",
                              object: "chat.completion.chunk",
                              created: 1,
                              model: body.model,
                              choices: [{ index: 0, ...part }],
                            }) +
                            "\n\n",
                        );
                      response.end("data: [DONE]\n\n");
                    } else {
                      response.writeHead(200, { "content-type": "application/json" });
                      response.end(
                        encodeJson({
                          id: "goose-cancel-completion",
                          object: "chat.completion",
                          created: 1,
                          model: body.model,
                          choices: [{ index: 0, message, finish_reason }],
                        }),
                      );
                    }
                  } catch (error) {
                    errors.push(error);
                    response.writeHead(500);
                    response.end("本机模型格式错误");
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
            if (!address || typeof address === "string") throw new Error("缺本机模型端口");
            const environment = {
              ...isolatedProbeEnvironment(home),
              GOOSE_PATH_ROOT: home,
              GOOSE_DISABLE_KEYRING: "1",
              GOOSE_DISABLE_SESSION_NAMING: "true",
              GOOSE_PROVIDER: "openai",
              GOOSE_MODEL: "codework-loopback",
              GOOSE_MODE: "auto",
              OPENAI_HOST: "http://127.0.0.1:" + address.port,
              OPENAI_BASE_PATH: "v1/chat/completions",
              OPENAI_API_KEY: "local-test-only",
            };
            const adapter = yield* makeCursorAdapter(
              decodeCursorSettings({ binaryPath: cliPath! }),
              {
                provider: ProviderDriverKind.make("acpAgent"),
                instanceId: ProviderInstanceId.make("goose-cancel"),
                acpCommand: cliPath!,
                acpArgs: ["acp"],
                acpAuthMethodId: "",
                supportsModelSelection: false,
                environment,
              },
            );
            const threadId = ThreadId.make("goose-cancel-" + scenario);
            yield* Effect.addFinalizer(() =>
              adapter.hasSession(threadId).pipe(
                Effect.flatMap((hasSession) =>
                  hasSession ? adapter.stopSession(threadId) : Effect.void,
                ),
                Effect.orDie,
              ),
            );
            const capabilityGrantIds = [
              "t3.terminal.exec",
              "t3.terminal.snapshot",
              "t3.terminal.kill",
              "t3.terminal.close",
            ];
            const handshake = yield* adapter.handshakeCapabilities!({
              runtimeId: "goose-cancel",
              agentId: "goose-cancel",
              runId: "run-cancel",
              taskId: "task-cancel",
              capabilityGrantIds,
            });
            expect(handshake.status).toBe("accepted");
            if (!handshake.handshakeId) throw new Error("缺能力握手");
            const created = yield* Deferred.make<void>(),
              waiting = yield* Deferred.make<void>(),
              createAllowed = yield* Deferred.make<void>(),
              killed = yield* Deferred.make<void>();
            const terminals = new Map<
              string,
              {
                child: NodeChildProcess.ChildProcess;
                output: string;
                status: "running" | "exited";
                exit: Promise<void>;
              }
            >();
            const killIds: string[] = [],
              closeIds: string[] = [];
            const spawn = Effect.acquireRelease(
              Effect.sync(() =>
                NodeChildProcess.spawn(process.execPath, ["-e", script], {
                  cwd,
                  env: isolatedProbeEnvironment(home),
                  windowsHide: true,
                }),
              ),
              (child) =>
                Effect.promise(
                  () =>
                    new Promise<void>((resolve, reject) => {
                      if (child.exitCode != null || child.signalCode != null) {
                        resolve();
                        return;
                      }
                      child.once("close", () => resolve());
                      child.once("error", reject);
                      child.kill();
                    }),
                ),
            ).pipe(Effect.provideService(Scope.Scope, scope));
            // 额外捕获的进程未交给 Adapter；取消不能因路径/名称匹配而结束它。
            const unrelated = yield* spawn;
            yield* adapter.configureToolBroker!({
              threadId,
              context: {
                runtimeId: "goose-cancel",
                agentId: "goose-cancel",
                runId: "run-cancel",
                taskId: "task-cancel",
                capabilityGrantIds,
                capabilityHandshakeId: handshake.handshakeId,
                workspaceRoot: cwd,
                threadId,
              },
              bridge: {
                cancel: () => Effect.void,
                invoke: (invocation) =>
                  Effect.gen(function* () {
                    const { terminalId } = decodeTerminal(invocation.arguments);
                    if (invocation.canonicalToolName === "terminal.exec") {
                      expect(invocation.arguments).toMatchObject({ command, args: [], cwd });
                      const child = yield* spawn;
                      const ready = new Promise<void>((resolve) =>
                        child.stdout!.on("data", (chunk) => {
                          const state = terminals.get(terminalId)!;
                          state.output += chunk.toString();
                          if (state.output.includes("GOOSE_PROCESS_READY")) resolve();
                        }),
                      );
                      const state = {
                        child,
                        output: "",
                        status: "running" as "running" | "exited",
                        exit: Promise.resolve(),
                      };
                      state.exit = new Promise((resolve, reject) => {
                        child.once("error", reject);
                        child.once("close", () => {
                          state.status = "exited";
                          resolve();
                        });
                      });
                      terminals.set(terminalId, state);
                      yield* Effect.promise(() => ready);
                      yield* Deferred.succeed(created, undefined);
                      if (late) yield* Deferred.await(createAllowed);
                      return { status: "succeeded" as const, result: {} };
                    }
                    const state = terminals.get(terminalId);
                    if (!state) throw new Error("终端不属于本机运行");
                    if (invocation.canonicalToolName === "terminal.snapshot") {
                      yield* Deferred.succeed(waiting, undefined);
                      return {
                        status: "succeeded" as const,
                        result: {
                          history: state.output,
                          status: state.status,
                          exitCode: state.status === "exited" ? 143 : null,
                          exitSignal: null,
                        },
                      };
                    }
                    if (invocation.canonicalToolName === "terminal.kill") {
                      killIds.push(terminalId);
                      if (denied)
                        return { status: "denied" as const, errorCode: "tool_capability_denied" };
                      state.child.kill();
                      yield* Effect.promise(() => state.exit);
                      yield* Deferred.succeed(killed, undefined);
                      return { status: "succeeded" as const, result: {} };
                    }
                    expect(invocation.canonicalToolName).toBe("terminal.close");
                    closeIds.push(terminalId);
                    state.child.kill();
                    yield* Effect.promise(() => state.exit);
                    return { status: "succeeded" as const, result: {} };
                  }),
              },
            });
            const completed: string[] = [];
            const text: string[] = [];
            const stopFailure = yield* Deferred.make<string>();
            const nextCompleted = yield* Deferred.make<void>();
            const consumer = yield* adapter.streamEvents.pipe(
              Stream.runForEach((event) => {
                if (event.type === "content.delta" && event.payload.streamKind === "assistant_text")
                  text.push(event.payload.delta);
                if (event.type === "turn.completed") {
                  completed.push(event.payload.state);
                  if (event.payload.state === "completed")
                    return Deferred.succeed(nextCompleted, undefined);
                }
                if (event.type === "runtime.error") {
                  expect(event.threadId).toBe(threadId);
                  expect(event.payload.class).toBe("permission_error");
                  return Deferred.succeed(stopFailure, event.payload.message);
                }
                return Effect.void;
              }),
              Effect.forkChild,
            );
            const selection = {
              instanceId: ProviderInstanceId.make("goose-cancel"),
              model: "default",
              options: [{ id: ACP_MODE_OPTION_ID, value: "auto" }],
            };
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("acpAgent"),
              cwd,
              runtimeMode: "full-access",
              capabilityHandshakeId: handshake.handshakeId,
              modelSelection: selection,
            });
            action = 1;
            const turn = yield* adapter
              .sendTurn({
                threadId,
                input: "GOOSE_RUN_1 执行受控工具。",
                attachments: [],
                modelSelection: selection,
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(created);
            if (!late) yield* Deferred.await(waiting);
            const interrupted = yield* Effect.result(adapter.interruptTurn(threadId));
            if (late) yield* Deferred.succeed(createAllowed, undefined);
            if (denied) {
              expect(interrupted._tag).toBe(late ? "Success" : "Failure");
              expect(yield* Deferred.await(stopFailure)).toBe("宿主终端停止未确认（denied）。");
              expect(killIds).toHaveLength(1);
              expect([...terminals.values()][0]!.status).toBe("running");
            } else {
              expect(interrupted._tag).toBe("Success");
              // 等待真实退出回执，不能以本地回合取消代替进程停止。
              if (scenario === "running") expect([...terminals.values()][0]!.status).toBe("exited");
              yield* Deferred.await(killed);
              expect(killIds).toHaveLength(1);
              expect([...terminals.values()][0]!.status).toBe("exited");
            }
            yield* Fiber.join(turn);
            expect(unrelated.exitCode).toBeNull();
            expect(unrelated.signalCode).toBeNull();
            expect(yield* fs.exists(path.join(cwd, "unexpected-write.txt"))).toBe(false);
            if (!denied) {
              yield* adapter.sendTurn({
                threadId,
                input: "取消后仅返回正文。",
                attachments: [],
                modelSelection: selection,
              });
              yield* Deferred.await(nextCompleted);
              expect(text.join("")).toContain("GOOSE_NEXT_OK");
              yield* adapter.interruptTurn(threadId);
              expect(killIds).toHaveLength(1);
            }
            expect(errors).toEqual([]);
            expect(requestedTools).toBe(1);
            yield* adapter.stopSession(threadId);
            expect([...terminals.values()].every((state) => state.status === "exited")).toBe(true);
            expect(closeIds).toHaveLength(1);
            expect(completed).toContain("cancelled");
            yield* Fiber.interrupt(consumer);
          }).pipe(
            Effect.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "goose-cancel-server-" }),
            ),
            Effect.scoped,
            Effect.provide(NodeServices.layer),
          ),
        { timeout: 30000 },
      );
    }
  },
);
