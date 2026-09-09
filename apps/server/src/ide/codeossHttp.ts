import { AuthOrchestrationOperateScope } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";

import { SessionStore } from "../auth/SessionStore.ts";
import { Codeoss } from "./Codeoss.ts";

export function parseCodeossPath(rawUrl: string) {
  const path = rawUrl.split("?")[0] ?? "";
  const match = /^\/api\/ide\/([a-f0-9]{64})(?:\/|$)/.exec(path);
  return match?.[1];
}

export const route = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const { runtime } = yield* Codeoss;
  const capability = parseCodeossPath(request.url);
  const session = capability ? runtime.find(capability) : undefined;
  const unauthorized = () =>
    HttpServerResponse.text("IDE 会话已失效，请重新打开 IDE。", {
      status: 401,
      headers: { "cache-control": "no-store" },
    });
  if (!session || !session.port) return unauthorized();
  const sessions = yield* SessionStore;
  const verified = yield* sessions.verifyWebSocketToken(session.authTicket).pipe(Effect.option);
  if (verified._tag === "None" || !verified.value.scopes.includes(AuthOrchestrationOperateScope)) {
    yield* Effect.promise(() => runtime.close(session.id));
    return unauthorized();
  }
  const url = new URL(request.url, `http://127.0.0.1:${session.port}`);
  url.searchParams.delete("tkn");
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    url.protocol = "ws:";
    url.searchParams.set("tkn", session.capability);
    url.searchParams.set("skipWebSocketFrames", "false");
    const upstream = yield* Socket.makeWebSocket(url.toString());
    const downstream = yield* request.upgrade;
    const writeUpstream = yield* upstream.writer;
    const writeDownstream = yield* downstream.writer;
    yield* Effect.raceFirst(upstream.runRaw(writeDownstream), downstream.runRaw(writeUpstream));
    return HttpServerResponse.empty();
  }
  const client = yield* HttpClient.HttpClient;
  // 不将 Code Work Cookie/Authorization 转发给工作台；回环端口只接受独立连接令牌。
  const headers: Record<string, string> = {
    cookie: `vscode-tkn=${session.capability}`,
    "x-forwarded-host": request.headers["x-forwarded-host"] ?? request.headers.host ?? "",
    "accept-encoding": "identity",
  };
  for (const name of [
    "accept",
    "accept-language",
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
  ]) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  const response = yield* client.execute(
    HttpClientRequest.make(request.method)(url, {
      headers,
      ...(request.method === "GET" || request.method === "HEAD"
        ? {}
        : { body: HttpBody.stream(request.stream) }),
    }),
  );
  // 浏览器端工作台由 monaco-vscode-api 在宿主文档内渲染，根路径 HTML 只做
  // 原样透传（调试直开 REH 页面用），不再注入任何脚本或样式。
  return HttpServerResponse.fromClientResponse(response);
}).pipe(
  Effect.scoped,
  HttpMiddleware.withLoggerDisabled,
  Effect.provide(Socket.layerWebSocketConstructorGlobal),
  Effect.catchCause(() =>
    Effect.succeed(HttpServerResponse.text("IDE 连接失败，请重新打开。", { status: 502 })),
  ),
);

export const routeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* Codeoss;
    return HttpRouter.add("*", "/api/ide/*", route.pipe(Effect.provideService(Codeoss, service)));
  }),
);
