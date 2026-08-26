import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL } from "./CompositionRuntimeToolBridgeHttp.ts";
import { makeCompositionRuntimeToolBridgeClient } from "./CompositionRuntimeToolBridgeProtocol.ts";

const invocation = {
  schemaVersion: 1 as const,
  runtimeId: "runtime-bridge",
  taskId: "task-bridge",
  runId: "run-bridge",
  agentId: "agent-bridge",
  capabilityHandshakeId: "handshake-bridge",
  toolCallId: "tool-call-bridge",
  canonicalToolName: "workspace.read_file",
  arguments: { cwd: "C:/workspace", relativePath: "README.md" },
  idempotencyKey: "idempotency-bridge",
  capabilityGrantIds: ["grant-bridge"],
};

const cancellation = {
  schemaVersion: 1 as const,
  runtimeId: invocation.runtimeId,
  taskId: invocation.taskId,
  runId: invocation.runId,
  agentId: invocation.agentId,
  capabilityHandshakeId: invocation.capabilityHandshakeId,
  toolCallId: invocation.toolCallId,
  canonicalToolName: invocation.canonicalToolName,
  idempotencyKey: "idempotency-cancel-bridge",
  capabilityGrantIds: invocation.capabilityGrantIds,
};

const result = {
  invocationId: "invocation-idempotency-bridge",
  taskId: invocation.taskId,
  runId: invocation.runId,
  toolCallId: invocation.toolCallId,
  canonicalToolName: invocation.canonicalToolName,
  status: "succeeded" as const,
  result: { contents: "bridge ok" },
};

it.effect("通过版本化 HTTP transport 发送 invoke/cancel，并校验 canonical result", () =>
  Effect.gen(function* () {
    const requests: Array<{
      url: string;
      headers: Readonly<Record<string, string>>;
      body: unknown;
    }> = [];
    const client = makeCompositionRuntimeToolBridgeClient({
      baseUrl: "http://t3.test/",
      transport: {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return { status: 200, body: result };
          }),
      },
    });

    expect(yield* client.invoke(invocation)).toEqual(result);
    expect(yield* client.cancel(cancellation)).toEqual(result);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      url: "http://t3.test/api/composition/runtime/tools/invoke",
      headers: {
        "idempotency-key": invocation.idempotencyKey,
        "x-t3-composition-protocol": COMPOSITION_RUNTIME_TOOL_BRIDGE_PROTOCOL,
      },
      body: invocation,
    });
    expect(requests[1]).toMatchObject({
      url: "http://t3.test/api/composition/runtime/tools/cancel",
      headers: { "idempotency-key": cancellation.idempotencyKey },
      body: cancellation,
    });
  }),
);

it.effect("拒绝无效结果，不把 transport 的任意 JSON 当作成功", () =>
  Effect.gen(function* () {
    const client = makeCompositionRuntimeToolBridgeClient({
      baseUrl: "http://t3.test",
      transport: {
        request: () => Effect.succeed({ status: 200, body: { status: "succeeded" } }),
      },
    });

    const failure = yield* client.invoke(invocation).pipe(Effect.flip);
    expect(failure.code).toBe("invalid_response");
  }),
);

it.effect("把非 2xx 响应收敛为稳定错误并保留 HTTP 状态", () =>
  Effect.gen(function* () {
    const client = makeCompositionRuntimeToolBridgeClient({
      baseUrl: "http://t3.test",
      transport: {
        request: () => Effect.succeed({ status: 403, body: { error: "denied" } }),
      },
    });

    const failure = yield* client.cancel(cancellation).pipe(Effect.flip);
    expect(failure).toMatchObject({ code: "http_error", status: 403 });
  }),
);

it.effect("Fetch transport 的超时和非法 JSON 都不会伪装成成功", () =>
  Effect.gen(function* () {
    const timeoutClient = makeCompositionRuntimeToolBridgeClient({
      baseUrl: "http://t3.test",
      fetchImpl: (() =>
        new Promise<Response>((_resolve, reject) => {
          const error = new DOMException("aborted", "AbortError");
          reject(error);
        })) as unknown as typeof fetch,
    });
    const timeoutFailure = yield* timeoutClient.invoke(invocation).pipe(Effect.flip);
    expect(timeoutFailure.code).toBe("timeout");

    const invalidJsonClient = makeCompositionRuntimeToolBridgeClient({
      baseUrl: "http://t3.test",
      fetchImpl: (() =>
        Promise.resolve(new Response("not-json", { status: 200 }))) as unknown as typeof fetch,
    });
    const invalidJsonFailure = yield* invalidJsonClient.invoke(invocation).pipe(Effect.flip);
    expect(invalidJsonFailure.code).toBe("invalid_json");
  }),
);
