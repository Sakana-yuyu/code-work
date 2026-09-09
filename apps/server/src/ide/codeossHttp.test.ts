// @effect-diagnostics globalFetch:off globalFetchInEffect:off - 通过真实 HTTP/WebSocket 验证代理边界。
import { NodeHttpServer } from "@effect/platform-node";
import { AuthOrchestrationOperateScope, AuthSessionId } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { Codeoss } from "./Codeoss.ts";
import { CodeossRuntime } from "./codeossRuntime.ts";
import { routeLayer } from "./codeossHttp.ts";
import { SessionStore, UnknownWebSocketSessionError } from "../auth/SessionStore.ts";

describe("Code-OSS 代理", () => {
  it.effect("根路径原样透传，静态资源与 WebSocket 可代理并检查会话撤销", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let upstreamCalls = 0;
        const upstream = HttpRouter.add(
          "*",
          "/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            upstreamCalls++;
            if (request.headers.upgrade === "websocket") {
              const socket = yield* request.upgrade;
              const write = yield* socket.writer;
              yield* socket.runRaw(write);
              return HttpServerResponse.empty();
            }
            expect(request.headers.authorization).toBeUndefined();
            expect(request.headers.cookie).toMatch(/^vscode-tkn=[a-f0-9]{64}$/);
            expect(request.headers.cookie).not.toContain("codework-secret");
            if (request.url.endsWith("/static/test.js"))
              return HttpServerResponse.text("native-codeoss-static", {
                contentType: "text/javascript",
              });
            return HttpServerResponse.stream(
              Stream.make(
                new TextEncoder().encode(
                  '<head><meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;example.test&quot;}"></head>',
                ),
              ),
              { contentType: "text/html" },
            );
          }),
        );
        const upstreamContext = yield* Layer.build(
          HttpRouter.serve(upstream, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        );
        const upstreamAddress = Context.get(upstreamContext, HttpServer.HttpServer).address;
        if (upstreamAddress._tag !== "TcpAddress") throw new Error("需要 TCP 测试服务");
        const capability = "a".repeat(64);
        const runtime = new CodeossRuntime("unused-test-runtime", "win32", "x64");
        runtime.sessions.set("session", {
          id: "session",
          capability,
          authTicket: "test-ticket",
          state: { phase: "ready", message: "ready" },
          port: upstreamAddress.port,
        });
        let authorized = true;
        const sessionService = {
          verifyWebSocketToken: () =>
            authorized
              ? Effect.succeed({
                  sessionId: AuthSessionId.make("session"),
                  scopes: [AuthOrchestrationOperateScope],
                  subject: "test",
                  method: "browser-session-cookie",
                  expiresAt: DateTime.nowUnsafe(),
                })
              : Effect.fail(
                  new UnknownWebSocketSessionError({ sessionId: AuthSessionId.make("session") }),
                ),
        } as unknown as SessionStore["Service"];
        const proxyLayer = routeLayer.pipe(
          Layer.provide(
            Layer.succeed(Codeoss, { runtime, open: () => Effect.die("测试不调用启动") }),
          ),
          HttpRouter.provideRequest(
            Layer.mergeAll(Layer.succeed(SessionStore, sessionService), FetchHttpClient.layer),
          ),
        );
        const proxyContext = yield* Layer.build(
          HttpRouter.serve(proxyLayer, { disableLogger: true, disableListenLog: true }).pipe(
            Layer.provideMerge(NodeHttpServer.layerTest),
          ),
        );
        const proxyAddress = Context.get(proxyContext, HttpServer.HttpServer).address;
        if (proxyAddress._tag !== "TcpAddress") throw new Error("需要 TCP 测试服务");
        const origin = `http://127.0.0.1:${proxyAddress.port}`;
        const base = `${origin}/api/ide/${capability}`;
        yield* Effect.promise(async () => {
          const unauthorized = await fetch(`${origin}/api/ide/${"b".repeat(64)}/`);
          expect(unauthorized.status).toBe(401);
          expect(upstreamCalls).toBe(0);
          const html = await fetch(`${base}/`, {
            headers: {
              authorization: "Bearer codework-secret",
              cookie: "codework=codework-secret",
            },
          });
          // 浏览器端工作台在宿主文档内渲染；根路径 HTML 不再改写，只透传上游。
          expect(html.status).toBe(200);
          expect(await html.text()).toContain("vscode-workbench-web-configuration");
          const js = await fetch(`${base}/static/test.js`);
          expect(await js.text()).toBe("native-codeoss-static");
          await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(base.replace("http:", "ws:") + "/socket");
            socket.binaryType = "arraybuffer";
            socket.addEventListener("open", () => socket.send(new Uint8Array([0, 1, 2, 255])));
            socket.addEventListener("message", (event) => {
              try {
                expect([...new Uint8Array(event.data)]).toEqual([0, 1, 2, 255]);
                resolve();
              } catch (error) {
                reject(error);
              } finally {
                socket.close();
              }
            });
            socket.addEventListener("error", () => reject(new Error("WebSocket 代理失败")));
          });
          authorized = false;
          const count = upstreamCalls;
          expect((await fetch(`${base}/static/test.js`)).status).toBe(401);
          expect(upstreamCalls).toBe(count);
          expect(runtime.sessions.size).toBe(0);
        });
      }),
    ),
  );
});
