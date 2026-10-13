// @effect-diagnostics nodeBuiltinImport:off
// 本机 HTTP 服务用来验证真实 Fetch 的跳转行为，不能用 HttpClient 替代服务端夹具。
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import { fetchByokCatalog } from "./byokHttp.ts";

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

const runWithFetch = (
  fetch: typeof globalThis.fetch,
  url: string,
  headers?: Record<string, string>,
) =>
  Effect.runPromise(
    fetchByokCatalog({ url, ...(headers ? { headers } : {}) }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

describe("byokHttp", () => {
  it("实际Fetch的跨源跳转由目录层处理，不向下一源转发供应商密钥", async () => {
    let forwardedHeaders: NodeHttp.IncomingHttpHeaders | undefined;
    let destination = "";
    const target = NodeHttp.createServer((request, response) => {
      forwardedHeaders = request.headers;
      response.end(JSON.stringify({ data: [{ id: "model-a" }] }));
    });
    const source = NodeHttp.createServer((_request, response) => {
      response.writeHead(302, { location: destination });
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        target.once("error", reject);
        target.listen(0, "127.0.0.1", resolve);
      });
      destination = `http://127.0.0.1:${(target.address() as NodeNet.AddressInfo).port}/models`;
      await new Promise<void>((resolve, reject) => {
        source.once("error", reject);
        source.listen(0, "127.0.0.1", resolve);
      });
      const result = await runWithFetch(
        globalThis.fetch,
        `http://127.0.0.1:${(source.address() as NodeNet.AddressInfo).port}/models`,
        {
          authorization: "Bearer test-key",
          "x-api-key": "test-key",
          "x-goog-api-key": "test-key",
          "x-catalog-client": "test-client",
        },
      );
      expect(result.status).toBe(200);
      expect(forwardedHeaders?.authorization).toBeUndefined();
      expect(forwardedHeaders?.["x-api-key"]).toBeUndefined();
      expect(forwardedHeaders?.["x-goog-api-key"]).toBeUndefined();
      expect(forwardedHeaders?.["x-catalog-client"]).toBe("test-client");
    } finally {
      await Promise.all(
        [source, target].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.closeAllConnections();
              server.close((error) =>
                error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")
                  ? reject(error)
                  : resolve(),
              );
            }),
        ),
      );
    }
  });

  it("rejects non-http endpoints", async () => {
    await expect(runWithFetch(globalThis.fetch, "file:///tmp/models")).rejects.toMatchObject({
      code: "invalid_endpoint",
    });
  });

  it("preserves credentials after a same-origin redirect", async () => {
    const seen: Request[] = [];
    const fetch = async (input: string | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      if (seen.length === 1) {
        // 跳转正文保持未结束，返回后应由此次请求链的作用域主动释放。
        return new Response(new ReadableStream(), {
          status: 302,
          headers: { location: "/v2/models" },
        });
      }
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await runWithFetch(asFetch(fetch), "https://source.test/models", {
      authorization: "Bearer secret",
      "x-api-key": "secret",
    });
    expect(result.status).toBe(200);
    expect(seen[1]?.url).toBe("https://source.test/v2/models");
    expect(seen[1]?.headers.get("authorization")).toBe("Bearer secret");
    expect(seen[1]?.headers.get("x-api-key")).toBe("secret");
    expect(seen.map((request) => request.signal.aborted)).toEqual([true, true]);
  });

  it("strips credentials after a cross-origin redirect", async () => {
    const seen: Request[] = [];
    const fetch = async (input: string | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      if (seen.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.test/models" },
        });
      }
      return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await runWithFetch(asFetch(fetch), "https://source.test/models", {
      authorization: "Bearer secret",
      "x-api-key": "secret",
    });
    expect(result.status).toBe(200);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(seen[1]?.headers.get("authorization")).toBeNull();
    expect(seen[1]?.headers.get("x-api-key")).toBeNull();
  });

  it("rejects an upstream non-2xx response without exposing its body", async () => {
    const fetch = async () => new Response("provider secret body", { status: 503 });
    const result = await runWithFetch(asFetch(fetch), "https://source.test/models");
    expect(result.status).toBe(503);
    expect(result.body).toBe("provider secret body");
    expect(result.headers).toEqual({ "content-type": "text/plain;charset=UTF-8" });
  });

  it("blocks redirects beyond the configured limit", async () => {
    let calls = 0;
    const fetch = async (input: string | URL) => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `${new URL(String(input)).origin}/models-${calls + 1}` },
      });
    };
    await expect(runWithFetch(asFetch(fetch), "https://source.test/models")).rejects.toMatchObject({
      code: "redirect_blocked",
    });
    expect(calls).toBe(4);
  });

  it("maps a request that exceeds the timeout to a timeout error", async () => {
    vi.useFakeTimers();
    try {
      const fetch = async () => await new Promise<Response>(() => undefined);
      const pending = runWithFetch(asFetch(fetch), "https://source.test/models");
      const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds oversized response bodies", async () => {
    const fetch = async () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 200 });
    await expect(runWithFetch(asFetch(fetch), "https://source.test/models")).rejects.toMatchObject({
      code: "response_too_large",
    });
  });
});
