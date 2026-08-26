import { CompositionToolResult, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as CompositionRuntimeToolBridge from "../composition/CompositionRuntimeToolBridge.ts";
import { normalizeMcpHttpResponse } from "./McpHttpServer.ts";
import * as CompositionRuntimeMcpSessionRegistry from "./CompositionRuntimeMcpSessionRegistry.ts";

export const COMPOSITION_RUNTIME_MCP_PATH = "/mcp/composition-runtime";

export class CompositionRuntimeMcpInvocationContext extends Context.Service<
  CompositionRuntimeMcpInvocationContext,
  CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpBinding
>()("t3/mcp/CompositionRuntimeMcpServer/CompositionRuntimeMcpInvocationContext") {}

const CompositionRuntimeMcpInvokeInput = Schema.Struct({
  canonicalToolName: TrimmedNonEmptyString,
  toolCallId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  arguments: Schema.optional(Schema.Unknown),
  approvalRequestId: Schema.optional(TrimmedNonEmptyString),
});

const CompositionRuntimeMcpCancelInput = Schema.Struct({
  canonicalToolName: TrimmedNonEmptyString,
  toolCallId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
});

export const CompositionRuntimeInvokeTool = Tool.make("t3_runtime_invoke", {
  description:
    "Invoke one T3 canonical tool through the current Runtime Task/Run/Agent capability binding.",
  parameters: CompositionRuntimeMcpInvokeInput,
  success: CompositionToolResult,
  failure: Schema.Never,
  dependencies: [
    CompositionRuntimeMcpInvocationContext,
    CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry,
    CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
  ],
})
  .annotate(Tool.Title, "Invoke T3 runtime tool")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Destructive, true);

export const CompositionRuntimeCancelTool = Tool.make("t3_runtime_cancel", {
  description:
    "Cancel one in-flight T3 canonical tool invocation in the current Runtime Task/Run/Agent binding.",
  parameters: CompositionRuntimeMcpCancelInput,
  success: CompositionToolResult,
  failure: Schema.Never,
  dependencies: [
    CompositionRuntimeMcpInvocationContext,
    CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService,
  ],
})
  .annotate(Tool.Title, "Cancel T3 runtime tool")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const CompositionRuntimeToolkit = Toolkit.make(
  CompositionRuntimeInvokeTool,
  CompositionRuntimeCancelTool,
);

const handlers = {
  t3_runtime_invoke: (input) =>
    Effect.gen(function* () {
      const binding = yield* CompositionRuntimeMcpInvocationContext;
      const registry =
        yield* CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry;
      const bridge = yield* CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService;
      const invocation: CompositionRuntimeToolBridge.CompositionRuntimeToolInvocation = {
        runtimeId: binding.runtimeId,
        taskId: binding.taskId,
        runId: binding.runId,
        agentId: binding.agentId,
        capabilityHandshakeId: binding.capabilityHandshakeId,
        capabilityGrantIds: binding.capabilityGrantIds,
        canonicalToolName: input.canonicalToolName,
        toolCallId: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        arguments: input.arguments ?? {},
        ...(input.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: input.approvalRequestId }),
      };
      return yield* Effect.raceFirst(
        bridge.invoke(invocation),
        registry
          .awaitRevocation(binding.capabilityHandshakeId)
          .pipe(Effect.andThen(bridge.cancel(invocation))),
      );
    }),
  t3_runtime_cancel: (input) =>
    Effect.gen(function* () {
      const binding = yield* CompositionRuntimeMcpInvocationContext;
      const bridge = yield* CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService;
      return yield* bridge.cancel({
        runtimeId: binding.runtimeId,
        taskId: binding.taskId,
        runId: binding.runId,
        agentId: binding.agentId,
        capabilityHandshakeId: binding.capabilityHandshakeId,
        capabilityGrantIds: binding.capabilityGrantIds,
        canonicalToolName: input.canonicalToolName,
        toolCallId: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
      });
    }),
} satisfies Parameters<typeof CompositionRuntimeToolkit.toLayer>[0];

export const CompositionRuntimeToolkitHandlersLive = CompositionRuntimeToolkit.toLayer(handlers);

export const CompositionRuntimeToolkitRegistrationLive = McpServer.toolkit(
  CompositionRuntimeToolkit,
).pipe(Layer.provide(CompositionRuntimeToolkitHandlersLive));

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_runtime_mcp_credential",
    message: "需要有效且未过期的 Runtime Agent MCP Bearer 凭据。",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  CompositionRuntimeMcpInvocationContext
>;

type RuntimeMcpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeRuntimeMcpAuthMiddleware =
  CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpSessionRegistry.pipe(
    Effect.map(
      (registry): RuntimeMcpAuthMiddleware =>
        Effect.fn("CompositionRuntimeMcpServer.authenticateRequest")(function* (httpEffect) {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const authorization = request.headers.authorization;
          const token =
            authorization?.startsWith("Bearer ") === true
              ? authorization.slice("Bearer ".length).trim()
              : "";
          const binding = yield* registry.resolve(token);
          if (binding === undefined) {
            yield* Effect.logWarning("拒绝使用无效或过期 Runtime MCP 凭据的请求。", {
              reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
            });
            return unauthorized;
          }
          return yield* httpEffect.pipe(
            Effect.provideService(CompositionRuntimeMcpInvocationContext, binding),
            Effect.map(normalizeMcpHttpResponse),
          );
        }),
    ),
  );

const RuntimeMcpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: CompositionRuntimeMcpInvocationContext;
}>()(makeRuntimeMcpAuthMiddleware).layer;

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Composition Runtime",
  version: packageJson.version,
  path: COMPOSITION_RUNTIME_MCP_PATH,
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(RuntimeMcpAuthMiddlewareLive));

export const layer = CompositionRuntimeToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpTransportLive),
);
