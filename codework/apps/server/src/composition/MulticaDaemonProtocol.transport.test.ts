import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeMulticaDaemonProtocol,
  makeMulticaFetchHttpTransport,
} from "./MulticaDaemonProtocol.ts";

const asFetch = (
  implementation: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch => implementation as typeof fetch;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("MulticaDaemonProtocol fetch transport", () => {
  it.effect("配置 Header 的大小写变体不能覆盖 quick-create 协议控制项", () =>
    Effect.gen(function* () {
      let capturedHeaders = new Headers();
      const transport = makeMulticaFetchHttpTransport({
        baseUrl: "https://multica.test",
        headers: {
          aCcEpT: "text/plain",
          "CONTENT-type": "text/plain",
          "x-WORKSPACE-id": "workspace-from-settings",
          "X-idempotency-KEY": "idempotency-from-settings",
          "X-Custom-Trace": "trace-from-settings",
        },
        fetchImpl: asFetch(async (_input, init) => {
          capturedHeaders = new Headers(init?.headers);
          return jsonResponse(202, { task_id: "multica-task-1" });
        }),
      });
      const protocol = makeMulticaDaemonProtocol({
        baseUrl: "https://multica.test",
        transport,
      });

      const result = yield* protocol.quickCreateTask({
        workspaceId: "workspace-from-request",
        agentId: "agent-1",
        prompt: "创建任务",
        idempotencyKey: "idempotency-from-request",
      });

      expect(result).toEqual({ taskId: "multica-task-1" });
      expect(capturedHeaders.get("accept")).toBe("application/json");
      expect(capturedHeaders.get("content-type")).toBe("application/json");
      expect(capturedHeaders.get("x-workspace-id")).toBe("workspace-from-request");
      expect(capturedHeaders.get("x-idempotency-key")).toBe("idempotency-from-request");
      expect(capturedHeaders.get("x-custom-trace")).toBe("trace-from-settings");
    }),
  );

  it.effect("无请求体时不发送 Content-Type，并保留普通配置 Header", () =>
    Effect.gen(function* () {
      let capturedBody: BodyInit | null | undefined;
      let capturedHeaders = new Headers();
      const transport = makeMulticaFetchHttpTransport({
        baseUrl: "https://multica.test",
        headers: {
          ACCEPT: "text/plain",
          "Content-Type": "text/plain",
          "X-Workspace-ID": "workspace-from-settings",
          "X-Idempotency-Key": "idempotency-from-settings",
          "X-Custom-Trace": "trace-from-settings",
        },
        fetchImpl: asFetch(async (_input, init) => {
          capturedBody = init?.body;
          capturedHeaders = new Headers(init?.headers);
          return jsonResponse(200, { status: "ok" });
        }),
      });

      const result = yield* transport.request<{ readonly status: string }>({
        method: "GET",
        path: "/api/daemon/tasks/task-1/status",
      });

      expect(result).toEqual({ status: 200, body: { status: "ok" } });
      expect(capturedBody).toBeUndefined();
      expect(capturedHeaders.get("accept")).toBe("application/json");
      expect(capturedHeaders.get("content-type")).toBeNull();
      expect(capturedHeaders.get("x-workspace-id")).toBeNull();
      expect(capturedHeaders.get("x-idempotency-key")).toBeNull();
      expect(capturedHeaders.get("x-custom-trace")).toBe("trace-from-settings");
    }),
  );
});
