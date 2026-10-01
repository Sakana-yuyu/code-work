// @effect-diagnostics nodeBuiltinImport:off - 官方 CLI 与本机模型端点的产品工具代理检查。
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ACP_MODE_OPTION_ID,
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
} from "@codework/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import * as CapabilityPolicy from "../../composition/CapabilityPolicy.ts";
import * as CapabilityRegistry from "../../composition/CapabilityRegistry.ts";
import { makeCompositionProviderToolBrokerBridge } from "../../composition/CompositionProviderToolBrokerBridge.ts";
import { makeCompositionRuntimeToolBridge } from "../../composition/CompositionRuntimeToolBridge.ts";
import * as ToolBroker from "../../composition/ToolBroker.ts";
import { projectActivityPayload } from "../../orchestration/ActivityPayloadProjection.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { makeCursorAdapter } from "../Layers/CursorAdapter.ts";
import { isolatedProbeEnvironment } from "./isolatedProbeEnvironment.ts";

const cliPath = process.env.CODEWORK_GOOSE_CLI_PATH;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeSync(CursorSettings);
const isReadData = Schema.is(Schema.Struct({ kind: Schema.Literal("read") }));
const isEditData = Schema.is(Schema.Struct({ kind: Schema.Literal("edit") }));
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      stream: Schema.optional(Schema.Boolean),
      tools: Schema.optional(
        Schema.Array(Schema.Struct({ function: Schema.Struct({ name: Schema.String }) })),
      ),
      messages: Schema.Array(
        Schema.Struct({
          role: Schema.String,
          content: Schema.optional(Schema.Unknown),
          tool_call_id: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);
const registry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const policy = CapabilityPolicy.makeCompositionCapabilityPolicy({ capabilityRegistry: registry });
const paths = WorkspacePaths.layer;
const entries = WorkspaceEntries.layer.pipe(Layer.provide(paths));
const files = WorkspaceFileSystem.layer.pipe(Layer.provide(paths), Layer.provide(entries));
const brokerLayer = ToolBroker.layer.pipe(
  Layer.provide(Layer.succeed(CapabilityRegistry.CapabilityRegistry, registry)),
  Layer.provide(Layer.succeed(CapabilityPolicy.CapabilityPolicy, policy)),
  Layer.provide(files),
  Layer.provide(entries),
);

// oxlint-disable-next-line codework/no-global-process-runtime -- 官方 Windows CLI 检查在 Effect 环境外注册。
describe.runIf(Boolean(cliPath) && process.platform === "win32")(
  "Goose 官方 CLI 经产品 ToolBroker 读取",
  () => {
    it.effect(
      "实际读取、脱敏、可信模式写入和审批/越界拒绝与公开详情边界",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const broker = yield* ToolBroker.ToolBroker;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "goose-product-read-" });
          const cwd = path.join(root, "workspace"),
            home = path.join(root, "home");
          yield* fs.makeDirectory(cwd);
          yield* fs.makeDirectory(path.join(home, "config"), { recursive: true });
          const source =
            "GOOSE_PRODUCT_SOURCE_31579\napi_key: GOOSE_SYNTHETIC_SECRET_31579\nEND_31579";
          yield* fs.writeFileString(path.join(cwd, "source.txt"), source);
          yield* fs.writeFileString(path.join(root, "outside.txt"), "GOOSE_OUTSIDE_31579");
          yield* fs.writeFileString(
            path.join(home, "config", "config.yaml"),
            "active_provider: openai\nproviders:\n  openai:\n    enabled: true\n    configured: true\n    model: codework-loopback\nextensions:\n  developer:\n    enabled: true\n  summon:\n    enabled: false\n",
          );
          let nextPath: string | undefined,
            sequence = 0;
          let nextTool: "read" | "write" = "read";
          const writeContents = "GOOSE_PRODUCT_WRITE_31579";
          const requestedTools: string[] = [],
            modelResults: unknown[] = [],
            errors: unknown[] = [];
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
                  const body = decodeRequest(raw);
                  expect(body.model).toBe("codework-loopback");
                  const current = body.messages.at(-1);
                  const toolPath =
                    nextPath &&
                    current?.role === "user" &&
                    encodeJson(current.content).includes("GOOSE_PRODUCT_" + sequence)
                      ? nextPath
                      : undefined;
                  if (toolPath) {
                    expect(body.tools?.some((tool) => tool.function.name === nextTool)).toBe(true);
                    requestedTools.push(toolPath);
                    nextPath = undefined;
                  } else {
                    const result = body.messages.findLast((message) => message.role === "tool");
                    expect(result?.tool_call_id).toBe("goose-product-read-" + sequence);
                    modelResults.push(result?.content);
                  }
                  const message = toolPath
                    ? {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            index: 0,
                            id: "goose-product-read-" + sequence,
                            type: "function",
                            function: {
                              name: nextTool,
                              arguments: encodeJson({
                                path: toolPath,
                                ...(nextTool === "write" ? { content: writeContents } : {}),
                              }),
                            },
                          },
                        ],
                      }
                    : { role: "assistant", content: "GOOSE_PRODUCT_OK" };
                  const finish_reason = toolPath ? "tool_calls" : "stop";
                  if (body.stream) {
                    response.writeHead(200, { "content-type": "text/event-stream" });
                    for (const part of [
                      { delta: message, finish_reason: null },
                      { delta: {}, finish_reason },
                    ])
                      response.write(
                        "data: " +
                          encodeJson({
                            id: "goose-product-completion",
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
                        id: "goose-product-completion",
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
                  response.end("本机模型检查失败");
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
          const adapter = yield* makeCursorAdapter(decodeSettings({ binaryPath: cliPath! }), {
            provider: ProviderDriverKind.make("acpAgent"),
            instanceId: ProviderInstanceId.make("goose-product"),
            acpCommand: cliPath!,
            acpArgs: ["acp"],
            acpAuthMethodId: "",
            supportsModelSelection: false,
            environment: {
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
            },
          });
          const threadId = ThreadId.make("goose-product-read"),
            runtimeId = "goose-product",
            agentId = "goose-product";
          yield* Effect.addFinalizer(() =>
            adapter.hasSession(threadId).pipe(
              Effect.flatMap((exists) => (exists ? adapter.stopSession(threadId) : Effect.void)),
              Effect.orDie,
            ),
          );
          const capabilityGrantIds = ["t3.workspace.read_file", "t3.workspace.write_file"];
          const handshake = yield* adapter.handshakeCapabilities!({
            runtimeId,
            agentId,
            taskId: "task-product",
            runId: "run-product",
            capabilityGrantIds,
          });
          expect(handshake.status).toBe("accepted");
          if (!handshake.handshakeId) throw new Error("缺产品能力握手");
          const task = {
            taskId: "task-product",
            projectId: "project-product",
            threadId,
            assigneeKind: "agent" as const,
            assigneeId: agentId,
            mode: "serial" as const,
            status: "running" as const,
            promptDigest: "sha256:product",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          };
          const run = {
            runId: "run-product",
            taskId: task.taskId,
            agentId,
            runtimeId,
            status: "running" as const,
            attempt: 1,
            capabilityGrantIds,
            capabilityHandshakeId: handshake.handshakeId,
          };
          const hostCalls: Array<{
            toolCallId: string;
            arguments: unknown;
            status: string;
            result: unknown;
            errorCode: string | undefined;
            canonicalToolName: string;
          }> = [];
          const runtimeBridge = makeCompositionRuntimeToolBridge({
            taskStore: {
              getTask: (id) =>
                Effect.succeed(id === task.taskId ? Option.some(task) : Option.none()),
              getRun: (id) => Effect.succeed(id === run.runId ? Option.some(run) : Option.none()),
            },
            inputStore: {
              get: (id) =>
                Effect.succeed(
                  id === task.taskId
                    ? Option.some({ taskId: id, prompt: "读取", workspaceRoot: cwd })
                    : Option.none(),
                ),
            },
            toolBroker: {
              invoke: (input) =>
                broker.invoke(input).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      expect(input.canonicalToolName).toBe(
                        nextTool === "read" ? "workspace.read_file" : "workspace.write_file",
                      );
                      hostCalls.push({
                        toolCallId: input.toolCallId,
                        arguments: input.arguments,
                        status: result.status,
                        result: result.result,
                        errorCode: result.errorCode,
                        canonicalToolName: input.canonicalToolName,
                      });
                    }),
                  ),
                ),
              cancel: broker.cancel,
            },
          });
          const context = {
            runtimeId,
            agentId,
            taskId: task.taskId,
            runId: run.runId,
            capabilityGrantIds,
            capabilityHandshakeId: handshake.handshakeId,
            workspaceRoot: cwd,
            threadId,
            runtimeMode: "full-access" as RuntimeMode,
          };
          yield* adapter.configureToolBroker!({
            threadId,
            context,
            bridge: makeCompositionProviderToolBrokerBridge({ runtimeBridge, context }),
          });
          const events: ProviderRuntimeEvent[] = [];
          const completions = yield* Deferred.make<void>();
          let completed = 0;
          const consumer = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              events.push(event);
              if (event.type === "turn.completed") {
                expect(event.payload.state).toBe("completed");
                if (++completed === 6) return Deferred.succeed(completions, undefined);
              }
              return Effect.void;
            }),
            Effect.forkChild,
          );
          const selection = {
            instanceId: ProviderInstanceId.make("goose-product"),
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
          for (const requestedPath of [
            path.join(cwd, "source.txt"),
            path.join(root, "outside.txt"),
            path.join(cwd, "missing.txt"),
          ]) {
            nextPath = requestedPath;
            sequence++;
            yield* adapter.sendTurn({
              threadId,
              input: "GOOSE_PRODUCT_" + sequence + " 执行一次读取。",
              attachments: [],
              modelSelection: selection,
            });
            expect(nextPath).toBeUndefined();
          }
          for (const [requestedPath, runtimeMode] of [
            [path.join(cwd, "allowed.txt"), "full-access"],
            [path.join(cwd, "denied.txt"), "approval-required"],
            [path.join(root, "outside.txt"), "full-access"],
          ] as const) {
            // binding 在建会话时激活；原生 auto 许可不能替代宿主审批模式。
            yield* adapter.stopSession(threadId);
            nextTool = "write";
            nextPath = requestedPath;
            const writeContext = { ...context, runtimeMode };
            yield* adapter.configureToolBroker!({
              threadId,
              context: writeContext,
              bridge: makeCompositionProviderToolBrokerBridge({
                runtimeBridge,
                context: writeContext,
              }),
            });
            yield* adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("acpAgent"),
              cwd,
              runtimeMode: "full-access",
              capabilityHandshakeId: handshake.handshakeId,
              modelSelection: selection,
            });
            sequence++;
            yield* adapter.sendTurn({
              threadId,
              input: "GOOSE_PRODUCT_" + sequence + " 执行一次写入。",
              attachments: [],
              modelSelection: selection,
            });
            expect(nextPath).toBeUndefined();
          }
          yield* Deferred.await(completions);
          expect(errors).toEqual([]);
          expect(requestedTools).toHaveLength(6);
          expect(modelResults).toHaveLength(6);
          expect(hostCalls).toHaveLength(4);
          expect(hostCalls[0]).toMatchObject({
            status: "succeeded",
            arguments: { cwd, relativePath: "source.txt" },
            result: { contents: source.replace("GOOSE_SYNTHETIC_SECRET_31579", "[REDACTED]") },
          });
          expect(hostCalls[1]).toMatchObject({
            status: "failed",
            arguments: { cwd, relativePath: "missing.txt" },
          });
          expect(hostCalls[2]).toMatchObject({
            status: "succeeded",
            canonicalToolName: "workspace.write_file",
            arguments: { cwd, relativePath: "allowed.txt", contents: writeContents },
          });
          expect(hostCalls[3]).toMatchObject({
            status: "denied",
            errorCode: "tool_approval_required",
            arguments: { cwd, relativePath: "denied.txt" },
          });
          expect(yield* fs.readFileString(path.join(cwd, "allowed.txt"))).toBe(writeContents);
          expect(yield* fs.exists(path.join(cwd, "denied.txt"))).toBe(false);
          expect(yield* fs.readFileString(path.join(root, "outside.txt"))).toBe(
            "GOOSE_OUTSIDE_31579",
          );
          expect(encodeJson(modelResults[3])).toContain("Wrote");
          expect(encodeJson(modelResults[4])).toContain("Code Work ToolBroker 未完成 ACP 请求");
          expect(encodeJson(modelResults[5])).toContain("ACP 文件路径不在授权工作区内");
          const edits = events
            .filter((event) => event.type === "item.completed")
            .filter((event) => isEditData(event.payload.data));
          expect(edits.map((event) => event.payload.status)).toEqual([
            "completed",
            "failed",
            "failed",
          ]);
          const editActivities = edits
            .flatMap((event) => runtimeEventToActivities(event))
            .map(projectActivityPayload);
          expect(editActivities).toMatchObject([
            { kind: "tool.completed", payload: { status: "completed" } },
            { kind: "tool.completed", payload: { status: "failed" } },
            { kind: "tool.completed", payload: { status: "failed" } },
          ]);
          expect(encodeJson(modelResults[0])).toContain("GOOSE_PRODUCT_SOURCE_31579");
          expect(encodeJson(modelResults[0])).toContain("[REDACTED]");
          expect(encodeJson(modelResults)).not.toContain("GOOSE_SYNTHETIC_SECRET_31579");
          expect(encodeJson(modelResults)).not.toContain("GOOSE_OUTSIDE_31579");
          expect(encodeJson(modelResults[1])).toContain("ACP 文件路径不在授权工作区内");
          expect(encodeJson(modelResults[2])).toContain("Code Work ToolBroker 未完成 ACP 请求");
          const reads = events
            .filter((event) => event.type === "item.completed")
            .filter((event) => isReadData(event.payload.data));
          expect(reads).toHaveLength(3);
          expect(reads.map((event) => event.payload.status)).toEqual([
            "completed",
            "failed",
            "failed",
          ]);
          expect(reads[0]!.payload.detail).toBe(path.join(cwd, "source.txt"));
          expect(reads[0]!.payload.data).not.toHaveProperty("rawOutput");
          expect(reads[0]!.payload.data).not.toHaveProperty("content");
          expect(
            hostCalls.every((call) => reads.every((event) => event.itemId !== call.toolCallId)),
          ).toBe(true);
          // 宿主回执与原生工具没有共同ID；不能按文件名把正文塞进某条原生通知。
          const activities = reads
            .flatMap((event) => runtimeEventToActivities(event))
            .map(projectActivityPayload);
          expect(activities).toHaveLength(3);
          expect(encodeJson(activities)).not.toContain("GOOSE_PRODUCT_SOURCE_31579");
          expect(encodeJson(events)).not.toContain("GOOSE_SYNTHETIC_SECRET_31579");
          expect(yield* fs.readFileString(path.join(cwd, "source.txt"))).toBe(source);
          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(consumer);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              brokerLayer,
              ServerConfig.layerTest(process.cwd(), { prefix: "goose-product-server-" }),
            ).pipe(Layer.provideMerge(NodeServices.layer)),
          ),
          Effect.scoped,
        ),
      { timeout: 30000 },
    );
  },
);
