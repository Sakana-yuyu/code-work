import { NodeHttpServer } from "@effect/platform-node";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CompositionRuntimeToolBridge from "./CompositionRuntimeToolBridge.ts";
import {
  COMPOSITION_RUNTIME_TOOL_CANCEL_PATH,
  COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL,
  COMPOSITION_RUNTIME_TOOL_INVOKE_PATH,
  makeRouteLayer,
} from "./CompositionRuntimeToolBridgeHttp.ts";
import { makeCompositionRuntimeToolBridgeClient } from "./CompositionRuntimeToolBridgeProtocol.ts";

const invocation = {
  schemaVersion: 1 as const,
  runtimeId: "runtime-http",
  taskId: "task-http",
  runId: "run-http",
  agentId: "agent-http",
  capabilityHandshakeId: "handshake-http",
  toolCallId: "call-http",
  canonicalToolName: "workspace.read_file",
  arguments: { cwd: "C:/workspace", relativePath: "README.md" },
  idempotencyKey: "idempotency-http",
  capabilityGrantIds: ["grant-http"],
};

const cancellation = {
  ...invocation,
  idempotencyKey: "idempotency-http-cancel",
};

const successfulResult = {
  invocationId: "invocation-idempotency-http",
  taskId: invocation.taskId,
  runId: invocation.runId,
  toolCallId: invocation.toolCallId,
  canonicalToolName: invocation.canonicalToolName,
  status: "succeeded" as const,
  result: { contents: "http bridge ok" },
};

const authenticatedSession = {
  sessionId: "session-http",
  subject: "test",
  method: "bearer",
  scopes: [AuthOrchestrationOperateScope],
} as const;

describe("CompositionRuntimeToolBridge HTTP", () => {
  it.effect("让外部 Runtime client 经真实本地 HTTP route 进入 Bridge", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: string[] = [];
        const bridge = CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService.of({
          invoke: (input) =>
            Effect.sync(() => {
              calls.push(`${COMPOSITION_RUNTIME_TOOL_INVOKE_PATH}:${input.idempotencyKey}`);
              return successfulResult;
            }),
          cancel: (input) =>
            Effect.sync(() => {
              calls.push(`${COMPOSITION_RUNTIME_TOOL_CANCEL_PATH}:${input.idempotencyKey}`);
              return { ...successfulResult, status: "cancelled" as const };
            }),
        });
        const auth = EnvironmentAuth.EnvironmentAuth.of({
          authenticateHttpRequest: () => Effect.succeed(authenticatedSession),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]);
        const routeDependencies: Layer.Layer<
          | CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService
          | EnvironmentAuth.EnvironmentAuth
        > = Layer.mergeAll(
          Layer.succeed(CompositionRuntimeToolBridge.CompositionRuntimeToolBridgeService, bridge),
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth),
        );
        const served = HttpRouter.serve(makeRouteLayer(routeDependencies), {
          disableListenLog: true,
          disableLogger: true,
        });
        yield* Layer.build(served);

        const server = yield* HttpServer.HttpServer;
        const address = server.address as HttpServer.TcpAddress;
        const httpClient = yield* HttpClient.HttpClient;
        const client = makeCompositionRuntimeToolBridgeClient({
          baseUrl: `http://127.0.0.1:${address.port}`,
          headers: { authorization: "Bearer test-token" },
        });

        const invalidProtocolResponse = yield* httpClient.post(
          COMPOSITION_RUNTIME_TOOL_INVOKE_PATH,
          {
            headers: {
              authorization: "Bearer test-token",
              "idempotency-key": invocation.idempotencyKey,
              "x-t3-composition-protocol": "wrong-protocol",
            },
            body: yield* HttpBody.json(invocation),
          },
        );
        expect(invalidProtocolResponse.status).toBe(400);
        expect(yield* invalidProtocolResponse.json).toEqual({
          error: "invalid_protocol",
        });

        const invalidIdempotencyResponse = yield* httpClient.post(
          COMPOSITION_RUNTIME_TOOL_INVOKE_PATH,
          {
            headers: {
              authorization: "Bearer test-token",
              "idempotency-key": "wrong-idempotency-key",
              "x-t3-composition-protocol": COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL,
            },
            body: yield* HttpBody.json(invocation),
          },
        );
        expect(invalidIdempotencyResponse.status).toBe(400);
        expect(yield* invalidIdempotencyResponse.json).toEqual({
          error: "idempotency_mismatch",
        });

        yield* client.invoke(invocation);
        yield* client.cancel(cancellation);

        expect(calls).toEqual([
          `${COMPOSITION_RUNTIME_TOOL_INVOKE_PATH}:${invocation.idempotencyKey}`,
          `${COMPOSITION_RUNTIME_TOOL_CANCEL_PATH}:${cancellation.idempotencyKey}`,
        ]);
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it("声明 HTTP path 与 JSON response 不依赖 UI 或 Multica 页面", () => {
    expect(COMPOSITION_RUNTIME_TOOL_INVOKE_PATH).toBe("/api/composition/runtime/tools/invoke");
    expect(COMPOSITION_RUNTIME_TOOL_CANCEL_PATH).toBe("/api/composition/runtime/tools/cancel");
    expect(HttpServerResponse.empty({ status: 204 }).status).toBe(204);
  });
});
