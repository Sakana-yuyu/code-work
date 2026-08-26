import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import * as CompositionRuntimeToolBridge from "../composition/CompositionRuntimeToolBridge.ts";
import * as CompositionRuntimeMcpServer from "./CompositionRuntimeMcpServer.ts";
import * as CompositionRuntimeMcpSessionRegistry from "./CompositionRuntimeMcpSessionRegistry.ts";

class RuntimeMcpClientError extends Schema.TaggedErrorClass<RuntimeMcpClientError>()(
  "RuntimeMcpClientError",
  { cause: Schema.Unknown },
) {}

const binding = {
  runtimeId: "multica:daemon-1:runtime-1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  capabilityHandshakeId: "handshake-1",
  capabilityGrantIds: ["grant-workspace"],
  expiresAtUnixMs: 2_000,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "multica-runtime-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const nonRevokingRegistry = Layer.succeed(
  CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
  {
    activate: () => Effect.die("unused"),
    resolve: () => Effect.succeed(undefined),
    revokeHandshake: () => Effect.void,
    revokeRun: () => Effect.void,
    revokeRuntime: () => Effect.void,
    awaitRevocation: () => Effect.never,
    revokeAll: Effect.void,
  },
);

it.effect("从 MCP 凭据注入可信 Runtime 身份并调用 T3 Tool Bridge", () => {
  const invoke = vi.fn((input: CompositionRuntimeToolBridge.CompositionRuntimeToolInvocation) =>
    Effect.succeed({
      invocationId: `invocation-${input.idempotencyKey}`,
      taskId: input.taskId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      canonicalToolName: input.canonicalToolName,
      status: "succeeded" as const,
      result: { contents: "ok" },
    }),
  );
  const cancel = vi.fn(() => Effect.die("unused"));
  const bridgeLayer = Layer.succeed(
    CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
    { invoke, cancel },
  );
  const testLayer = CompositionRuntimeMcpServer.CompositionRuntimeToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(nonRevokingRegistry),
    Layer.provide(bridgeLayer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "t3_runtime_invoke",
        arguments: {
          canonicalToolName: "workspace.read_file",
          toolCallId: "tool-call-1",
          idempotencyKey: "idempotency-1",
          arguments: { relativePath: "README.md" },
        },
      })
      .pipe(
        Effect.provideService(
          CompositionRuntimeMcpServer.CompositionRuntimeMcpInvocationContext,
          binding,
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      status: "succeeded",
    });
    expect(invoke).toHaveBeenCalledWith({
      runtimeId: binding.runtimeId,
      taskId: binding.taskId,
      runId: binding.runId,
      agentId: binding.agentId,
      capabilityHandshakeId: binding.capabilityHandshakeId,
      capabilityGrantIds: binding.capabilityGrantIds,
      canonicalToolName: "workspace.read_file",
      toolCallId: "tool-call-1",
      idempotencyKey: "idempotency-1",
      arguments: { relativePath: "README.md" },
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("取消请求沿用同一可信绑定且不会接收外部身份字段", () => {
  const invoke = vi.fn(() => Effect.die("unused"));
  const cancel = vi.fn((input: CompositionRuntimeToolBridge.CompositionRuntimeToolCancellation) =>
    Effect.succeed({
      invocationId: `invocation-${input.idempotencyKey}`,
      taskId: input.taskId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      canonicalToolName: input.canonicalToolName,
      status: "cancelled" as const,
    }),
  );
  const bridgeLayer = Layer.succeed(
    CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
    { invoke, cancel },
  );
  const testLayer = CompositionRuntimeMcpServer.CompositionRuntimeToolkitRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(nonRevokingRegistry),
    Layer.provide(bridgeLayer),
  );

  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "t3_runtime_cancel",
        arguments: {
          canonicalToolName: "terminal.exec",
          toolCallId: "tool-call-2",
          idempotencyKey: "idempotency-2",
        },
      })
      .pipe(
        Effect.provideService(
          CompositionRuntimeMcpServer.CompositionRuntimeMcpInvocationContext,
          binding,
        ),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.structuredContent).toMatchObject({ status: "cancelled" });
    expect(cancel).toHaveBeenCalledWith({
      runtimeId: binding.runtimeId,
      taskId: binding.taskId,
      runId: binding.runId,
      agentId: binding.agentId,
      capabilityHandshakeId: binding.capabilityHandshakeId,
      capabilityGrantIds: binding.capabilityGrantIds,
      canonicalToolName: "terminal.exec",
      toolCallId: "tool-call-2",
      idempotencyKey: "idempotency-2",
    });
  }).pipe(Effect.provide(testLayer));
});

it.effect("handshake 撤销会中断已经进入 MCP handler 的调用", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* CompositionRuntimeMcpSessionRegistry.__testing
        .make({ now: () => 1_000 })
        .pipe(Effect.provide(NodeServices.layer));
      const activated = yield* registry.activate({
        rawToken: "revocation-test-token",
        runtimeId: binding.runtimeId,
        taskId: binding.taskId,
        runId: binding.runId,
        agentId: binding.agentId,
        capabilityGrantIds: binding.capabilityGrantIds,
        expiresAtUnixMs: 2_000,
      });
      const entered = yield* Deferred.make<void>();
      const bridgeLayer = Layer.succeed(
        CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
        {
          invoke: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never.pipe(
                Effect.as({
                  invocationId: "invocation-revocation",
                  taskId: binding.taskId,
                  runId: binding.runId,
                  toolCallId: "tool-call-revocation",
                  canonicalToolName: "terminal.exec",
                  status: "succeeded" as const,
                }),
              );
            }),
          cancel: (input) =>
            Effect.succeed({
              invocationId: `invocation-${input.idempotencyKey}`,
              taskId: input.taskId,
              runId: input.runId,
              toolCallId: input.toolCallId,
              canonicalToolName: input.canonicalToolName,
              status: "cancelled" as const,
            }),
        },
      );
      const registryLayer = Layer.succeed(
        CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
        registry,
      );
      const testLayer = CompositionRuntimeMcpServer.CompositionRuntimeToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(registryLayer),
        Layer.provide(bridgeLayer),
      );

      const server = yield* Effect.service(McpServer.McpServer).pipe(Effect.provide(testLayer));
      const fiber = yield* Effect.forkChild(
        server
          .callTool({
            name: "t3_runtime_invoke",
            arguments: {
              canonicalToolName: "terminal.exec",
              toolCallId: "tool-call-revocation",
              idempotencyKey: "idempotency-revocation",
            },
          })
          .pipe(
            Effect.provideService(
              CompositionRuntimeMcpServer.CompositionRuntimeMcpInvocationContext,
              activated,
            ),
            Effect.provideService(McpSchema.McpServerClient, client),
          ),
      );
      yield* Deferred.await(entered);
      yield* registry.revokeHandshake(activated.capabilityHandshakeId);
      const result = yield* Fiber.join(fiber);
      expect(result.structuredContent).toMatchObject({ status: "cancelled" });
    }),
  ),
);

it.effect("通过真实 HTTP MCP transport 鉴权并调用 Runtime Tool Bridge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* CompositionRuntimeMcpSessionRegistry.__testing
        .make({ now: () => 1_000 })
        .pipe(Effect.provide(NodeServices.layer));
      yield* registry.activate({
        rawToken: "multica-agent-http-token",
        runtimeId: binding.runtimeId,
        taskId: binding.taskId,
        runId: binding.runId,
        agentId: binding.agentId,
        capabilityGrantIds: binding.capabilityGrantIds,
        expiresAtUnixMs: 2_000,
      });

      const invoke = vi.fn((input: CompositionRuntimeToolBridge.CompositionRuntimeToolInvocation) =>
        Effect.succeed({
          invocationId: `invocation-${input.idempotencyKey}`,
          taskId: input.taskId,
          runId: input.runId,
          toolCallId: input.toolCallId,
          canonicalToolName: input.canonicalToolName,
          status: "succeeded" as const,
          result: { contents: "http-ok" },
        }),
      );
      const bridgeLayer = Layer.succeed(
        CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
        { invoke, cancel: () => Effect.die("unused") },
      );
      const registryLayer = Layer.succeed(
        CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
        registry,
      );
      const serverLayer = CompositionRuntimeMcpServer.layer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(bridgeLayer),
      );
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initializeBody = HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"multica-http-test","version":"1.0.0"}}}`,
        "application/json",
      );

      const unauthorized = yield* httpClient.post(
        CompositionRuntimeMcpServer.COMPOSITION_RUNTIME_MCP_PATH,
        {
          headers: { accept: "application/json, text/event-stream" },
          body: initializeBody,
        },
      );
      expect(unauthorized.status).toBe(401);

      const httpServer = yield* HttpServer.HttpServer;
      if (httpServer.address._tag !== "TcpAddress") return;
      const hostname =
        httpServer.address.hostname === "0.0.0.0" || httpServer.address.hostname === "::"
          ? "127.0.0.1"
          : httpServer.address.hostname;
      const endpoint = new URL(
        `http://${hostname}:${httpServer.address.port}${CompositionRuntimeMcpServer.COMPOSITION_RUNTIME_MCP_PATH}`,
      );
      const called = yield* Effect.tryPromise({
        try: async () => {
          const client = new Client({ name: "multica-http-test", version: "1.0.0" });
          const transport = new StreamableHTTPClientTransport(endpoint, {
            requestInit: {
              headers: { authorization: "Bearer multica-agent-http-token" },
            },
          });
          try {
            await client.connect(transport as unknown as Transport);
            return await client.callTool({
              name: "t3_runtime_invoke",
              arguments: {
                canonicalToolName: "workspace.read_file",
                toolCallId: "tool-call-http",
                idempotencyKey: "idempotency-http",
                arguments: { relativePath: "README.md" },
              },
            });
          } finally {
            await client.close();
          }
        },
        catch: (cause) => new RuntimeMcpClientError({ cause }),
      });
      expect(called.isError).toBe(false);
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: binding.runtimeId,
          taskId: binding.taskId,
          runId: binding.runId,
          agentId: binding.agentId,
          canonicalToolName: "workspace.read_file",
          toolCallId: "tool-call-http",
        }),
      );
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
