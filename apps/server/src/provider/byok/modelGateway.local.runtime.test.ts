// @effect-diagnostics nodeBuiltinImport:off - 运行时 smoke 使用 Effect HTTP 客户端替身。
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@codework/contracts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { layerTest } from "../../serverSettings.ts";
import {
  byokGatewayRouteLayer,
  cliProxyGatewayRouteLayer,
  cliProxyManagementRouteLayer,
  gatewayAdapterRoutes,
} from "./modelGateway.ts";

type CapturedRequest = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
};

const decodeBody = (body: HttpBody.HttpBody): Record<string, unknown> | undefined => {
  if (!(body instanceof HttpBody.Uint8Array)) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body.body));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const makeSecretStore = (credentials: Record<string, unknown>) => {
  const values = new Map(
    Object.entries(credentials).map(([name, value]) => [
      name,
      Uint8Array.from(Buffer.from(JSON.stringify(value), "utf8")),
    ]),
  );
  const random = Uint8Array.from(Buffer.alloc(32, 7));
  return {
    get: (name: string) =>
      Effect.succeed(
        values.has(name) ? Option.some(Uint8Array.from(values.get(name)!)) : Option.none(),
      ),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => values.set(name, Uint8Array.from(value))),
    getOrCreateRandom: () => Effect.succeed(Uint8Array.from(random)),
    remove: (name: string) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  } as ServerSecretStore["Service"];
};

const makeGateway = (
  settings: ServerSettings,
  responses: readonly Response[],
  externalKey?: string,
  routeLayer = byokGatewayRouteLayer,
) => {
  const captured: CapturedRequest[] = [];
  let responseIndex = 0;
  const httpClient = HttpClient.make((request) =>
    Effect.sync(() => {
      captured.push({
        url: request.url,
        headers: { ...(request.headers as Record<string, string>) },
        body: decodeBody(request.body),
      });
      const response = responses[Math.min(responseIndex++, responses.length - 1)];
      if (response === undefined) throw new Error("测试未提供上游响应");
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const token = Buffer.alloc(32, 7).toString("hex");
  const { handler, dispose } = HttpRouter.toWebHandler(
    routeLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, httpClient),
          layerTest(settings),
          Layer.succeed(
            ServerSecretStore,
            makeSecretStore({
              "codex-a": { api_key: "codex-key-a" },
              "codex-root": { api_key: "codex-root-key" },
              "codex-b": { api_key: "codex-key-b" },
              "codex-external": { api_key: "codex-external-key" },
              "codex-oauth": { access_token: "codex-oauth-token", account_id: "acct-1" },
              "claude-oauth": { access_token: "claude-oauth-token" },
              "xai-api": { api_key: "xai-key" },
              ...(externalKey === undefined
                ? {}
                : {
                    "local-gateway-keys": [
                      {
                        id: "external",
                        name: "fixture",
                        createdAt: "2026-01-01T00:00:00.000Z",
                        key: externalKey,
                      },
                    ],
                  }),
            }),
          ),
        ),
      ),
    ),
    { disableLogger: true },
  );
  return { captured, handler, dispose, token };
};

const localSettings = (
  instanceId: string,
  driver: "byok" | "codex" | "claudeAgent" | "grok",
  provider: "codex" | "claude" | "xai",
  accountIds: readonly string[],
  accounts: Record<string, unknown>,
): ServerSettings =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: { driver, enabled: true, config: {} },
    },
    localAccountPool: {
      accounts,
      strategy: "round-robin",
      providerInstances: { [instanceId]: accountIds },
    },
  }) as unknown as ServerSettings;

describe("本地账号网关 runtime smoke", () => {
  it("按模型改写真实上游模型名，并在 401 前响应阶段切换 Codex 账号", async () => {
    const settings = localSettings("codex", "codex", "codex", ["codex-a", "codex-b"], {
      "codex-a": {
        id: "codex-a",
        provider: "codex",
        authKind: "api-key",
        displayName: "A",
        credentialRef: "codex-a",
        enabled: true,
        models: ["gpt-5.4"],
      },
      "codex-b": {
        id: "codex-b",
        provider: "codex",
        authKind: "api-key",
        displayName: "B",
        credentialRef: "codex-b",
        enabled: true,
        models: ["gpt-5.4"],
      },
    });
    const gateway = makeGateway(settings, [
      new Response('{"error":{"message":"expired"}}', {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      new Response('data: {"ok":true}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    ]);
    const route = gatewayAdapterRoutes(settings, "codex")[0];
    if (route === undefined) throw new Error("本地 Codex 路由未发布");
    const response = await gateway.handler(
      new Request(`http://gateway.test/byok-gw/openai/source/codex/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: route.id,
          stream: true,
          input: [{ role: "user", content: "hi" }],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("[DONE]");
    expect(gateway.captured).toHaveLength(2);
    expect(gateway.captured[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(gateway.captured[1]?.url).toBe("https://api.openai.com/v1/responses");
    expect(new Set(gateway.captured.map((entry) => entry.headers.authorization))).toEqual(
      new Set(["Bearer codex-key-a", "Bearer codex-key-b"]),
    );
    expect(gateway.captured[1]?.body).toMatchObject({ model: "gpt-5.4", stream: true });
    await gateway.dispose();
  });

  it("为 Claude OAuth 注入 Bearer 和 OAuth beta，而不是透传网关令牌", async () => {
    const settings = localSettings("claude", "claudeAgent", "claude", ["claude-oauth"], {
      "claude-oauth": {
        id: "claude-oauth",
        provider: "claude",
        authKind: "oauth",
        displayName: "Claude",
        credentialRef: "claude-oauth",
        enabled: true,
        models: ["claude-sonnet-5"],
      },
    });
    const gateway = makeGateway(settings, [
      new Response('{"content":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const route = gatewayAdapterRoutes(settings, "claude")[0];
    if (route === undefined) throw new Error("本地 Claude 路由未发布");
    const response = await gateway.handler(
      new Request("http://gateway.test/byok-gw/anthropic/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.token}`,
          "content-type": "application/json",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({ model: `${route.id}[1m]`, max_tokens: 16, messages: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(gateway.captured[0]).toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      body: { model: "claude-sonnet-5", max_tokens: 16 },
    });
    expect(gateway.captured[0]?.headers.authorization).toBe("Bearer claude-oauth-token");
    expect(gateway.captured[0]?.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(gateway.captured[0]?.headers["x-api-key"]).toBeUndefined();
    await gateway.dispose();
  });

  it("为 Codex OAuth 使用 ChatGPT Responses 路径和产品头", async () => {
    const settings = localSettings("codex-oauth", "codex", "codex", ["codex-oauth"], {
      "codex-oauth": {
        id: "codex-oauth",
        provider: "codex",
        authKind: "oauth",
        displayName: "Codex OAuth",
        credentialRef: "codex-oauth",
        enabled: true,
        models: ["gpt-5.4"],
      },
    });
    const gateway = makeGateway(settings, [
      new Response('{"output":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const route = gatewayAdapterRoutes(settings, "codex-oauth")[0];
    if (route === undefined) throw new Error("本地 Codex OAuth 路由未发布");
    const response = await gateway.handler(
      new Request("http://gateway.test/byok-gw/openai/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: route.id, input: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(gateway.captured[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/codex/responses",
      body: { model: "gpt-5.4" },
      headers: {
        authorization: "Bearer codex-oauth-token",
        "chatgpt-account-id": "acct-1",
        "oai-product-sku": "codex",
      },
    });
    await gateway.dispose();
  });

  it("为 Grok API key 走 xAI OpenAI 端点并保留模型请求体", async () => {
    const settings = localSettings("grok", "grok", "xai", ["xai-api"], {
      "xai-api": {
        id: "xai-api",
        provider: "xai",
        authKind: "api-key",
        displayName: "Grok",
        credentialRef: "xai-api",
        enabled: true,
        models: ["grok-3"],
      },
    });
    const gateway = makeGateway(settings, [
      new Response('{"choices":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const route = gatewayAdapterRoutes(settings, "grok")[0];
    if (route === undefined) throw new Error("本地 Grok 路由未发布");
    const response = await gateway.handler(
      new Request("http://gateway.test/byok-gw/openai/v1/chat/completions", {
        method: "POST",
        headers: { "x-api-key": gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ model: route.id, messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(gateway.captured[0]).toMatchObject({
      url: "https://api.x.ai/v1/chat/completions",
      body: { model: "grok-3" },
    });
    expect(gateway.captured[0]?.headers.authorization).toBe("Bearer xai-key");
    await gateway.dispose();
  });

  it("外部 Agent key 只允许本地账号池，不能访问普通 BYOK", async () => {
    const settings = {
      ...localSettings("codex", "codex", "codex", ["codex-external"], {
        "codex-external": {
          id: "codex-external",
          provider: "codex",
          authKind: "api-key",
          displayName: "A",
          credentialRef: "codex-external",
          enabled: true,
          models: ["gpt-5.4"],
        },
      }),
      providerInstances: {
        codex: { driver: "codex", enabled: true, config: {} },
        relay: {
          driver: "byok",
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              {
                id: "relay",
                displayName: "Relay",
                groupName: "Relay",
                protocol: "openai",
                baseURL: "https://relay.example/v1",
                apiKey: "relay-secret",
                modelId: "relay-model",
              },
            ],
          },
        },
      },
    } as unknown as ServerSettings;
    const gateway = makeGateway(
      settings,
      [
        new Response('{"choices":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ],
      "cwk_fixture",
    );
    const localRoute = gatewayAdapterRoutes(settings, "codex")[0];
    if (localRoute === undefined) throw new Error("本地路由未发布");
    const localResponse = await gateway.handler(
      new Request("http://gateway.test/byok-gw/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer cwk_fixture", "content-type": "application/json" },
        body: JSON.stringify({ model: localRoute.id, messages: [] }),
      }),
    );
    expect(localResponse.status).toBe(200);
    const ordinaryResponse = await gateway.handler(
      new Request("http://gateway.test/byok-gw/openai/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer cwk_fixture", "content-type": "application/json" },
        body: JSON.stringify({ model: "relay", messages: [] }),
      }),
    );
    expect(ordinaryResponse.status).toBe(404);
    await gateway.dispose();
  });

  it("内置 /v1 facade 暴露模型目录并按裸模型别名路由本地账号", async () => {
    const settings = localSettings("embedded-cpa", "byok", "codex", ["codex-root"], {
      "codex-root": {
        id: "codex-root",
        provider: "codex",
        authKind: "api-key",
        displayName: "A",
        credentialRef: "codex-root",
        enabled: true,
        models: ["gpt-5.4"],
      },
    });
    const gateway = makeGateway(
      settings,
      [
        new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ],
      undefined,
      cliProxyGatewayRouteLayer,
    );
    const models = await gateway.handler(
      new Request("http://gateway.test/v1/models", {
        headers: { authorization: `Bearer ${gateway.token}` },
      }),
    );
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      data: [{ id: "local:embedded-cpa:codex:gpt-5.4" }],
    });
    const response = await gateway.handler(
      new Request("http://gateway.test/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(gateway.captured[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    await gateway.dispose();
  });

  it("内置 /v1/models 按 Claude 客户端请求头返回 Anthropic 目录", async () => {
    const settings = localSettings("embedded-claude", "byok", "claude", ["claude-oauth"], {
      "claude-oauth": {
        id: "claude-oauth",
        provider: "claude",
        authKind: "oauth",
        displayName: "Claude",
        credentialRef: "claude-oauth",
        enabled: true,
        models: ["claude-sonnet-5"],
      },
    });
    const gateway = makeGateway(settings, [], undefined, cliProxyGatewayRouteLayer);
    const openAiModels = await gateway.handler(
      new Request("http://gateway.test/v1/models", {
        headers: { authorization: `Bearer ${gateway.token}` },
      }),
    );
    expect(openAiModels.status).toBe(200);
    expect(await openAiModels.json()).toMatchObject({ data: [] });

    const anthropicModels = await gateway.handler(
      new Request("http://gateway.test/v1/models", {
        headers: { authorization: `Bearer ${gateway.token}`, "anthropic-version": "2023-06-01" },
      }),
    );
    expect(anthropicModels.status).toBe(200);
    expect(await anthropicModels.json()).toMatchObject({
      data: [{ type: "model", display_name: "claude-sonnet-5" }],
    });
    await gateway.dispose();
  });

  it("管理兼容子集只接受内部网关令牌，外部推理 key 不得改账号", async () => {
    const settings = localSettings("codex", "codex", "codex", ["codex-a"], {
      "codex-a": {
        id: "codex-a",
        provider: "codex",
        authKind: "api-key",
        displayName: "A",
        credentialRef: "codex-a",
        enabled: true,
        models: ["gpt-5.4"],
      },
    });
    const gateway = makeGateway(settings, [], "cwk_external", cliProxyManagementRouteLayer);
    const denied = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files", {
        headers: { authorization: "Bearer cwk_external" },
      }),
    );
    expect(denied.status).toBe(401);
    const inferenceHeaderDenied = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files", {
        headers: { authorization: `Bearer ${gateway.token}` },
      }),
    );
    expect(inferenceHeaderDenied.status).toBe(401);
    const listed = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files", {
        headers: { "x-management-key": gateway.token },
      }),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      files: [{ name: "codex-a.json", provider: "codex", status: "active" }],
    });
    await gateway.dispose();
  });

  it("管理 auth-files 接受 CPA multipart 上传并支持模型与策略查询", async () => {
    const settings = localSettings("codex", "codex", "codex", ["codex-a"], {
      "codex-a": {
        id: "codex-a",
        provider: "codex",
        authKind: "api-key",
        displayName: "A",
        credentialRef: "codex-a",
        enabled: true,
        models: ["gpt-5.4"],
      },
    });
    const gateway = makeGateway(settings, [], undefined, cliProxyManagementRouteLayer);
    const form = new FormData();
    form.append(
      "files",
      new File(
        [JSON.stringify({ type: "codex", api_key: "imported-key", models: ["gpt-5.5"] })],
        "codex-import.json",
        { type: "application/json" },
      ),
    );
    const uploaded = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files", {
        method: "POST",
        headers: { "x-management-key": gateway.token },
        body: form,
      }),
    );
    const uploadedText = await uploaded.text();
    expect(uploaded.status, uploadedText).toBe(200);
    expect(uploadedText).not.toContain("imported-key");
    const uploadedPayload = JSON.parse(uploadedText) as unknown;
    expect(uploadedPayload).toMatchObject({
      uploaded: 1,
      files: [{ name: "codex-import.json" }],
    });

    const raw = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files?name=codex-raw.json", {
        method: "POST",
        headers: { "x-management-key": gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ type: "codex", api_key: "raw-key", models: ["gpt-5.6"] }),
      }),
    );
    expect(raw.status).toBe(200);
    expect(await raw.text()).not.toContain("raw-key");
    const invalidName = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files?name=../escape.json", {
        method: "POST",
        headers: { "x-management-key": gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ type: "codex", api_key: "raw-key", models: ["gpt-5.6"] }),
      }),
    );
    expect(invalidName.status).toBe(400);

    const models = await gateway.handler(
      new Request("http://gateway.test/v0/management/auth-files/models?name=codex-import.json", {
        headers: { "x-management-key": gateway.token },
      }),
    );
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({ models: [{ id: "gpt-5.5" }] });

    const strategy = await gateway.handler(
      new Request("http://gateway.test/v0/management/routing/strategy", {
        method: "PATCH",
        headers: { "x-management-key": gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ value: "fill-first" }),
      }),
    );
    expect(strategy.status).toBe(200);
    expect(await strategy.json()).toMatchObject({ strategy: "fill-first" });
    await gateway.dispose();
  });
});
