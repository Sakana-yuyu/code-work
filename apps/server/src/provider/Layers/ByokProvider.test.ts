import { DEFAULT_SERVER_SETTINGS, type ByokSettings } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";

import { byokModelsFromSettings, checkByokProviderStatus } from "./ByokProvider.ts";

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

const settings = (): ByokSettings => ({
  ...DEFAULT_SERVER_SETTINGS.providers.byok,
  enabled: true,
  adapters: [
    {
      id: "flash",
      displayName: "deepseek-v4-flash",
      protocol: "openai",
      baseURL: "https://deepseek.example.test/v1",
      apiKey: "sk-test-key",
      balanceAccessToken: "",
      modelId: "deepseek-v4-flash",
      contextWindowTokens: 1_000_000,
    },
    {
      id: "vision",
      displayName: "deepseek-v4-flash-vision-exp",
      protocol: "openai",
      baseURL: "https://deepseek.example.test/v1",
      apiKey: "sk-test-key",
      balanceAccessToken: "",
      modelId: "deepseek-v4-flash-vision-exp",
      contextWindowTokens: 1_000_000,
    },
    {
      id: "pro",
      displayName: "deepseek-v4-pro",
      protocol: "openai",
      baseURL: "https://deepseek.example.test/v1",
      apiKey: "sk-test-key",
      balanceAccessToken: "",
      modelId: "deepseek-v4-pro",
      contextWindowTokens: 1_000_000,
    },
  ],
});

describe("checkByokProviderStatus", () => {
  it("does not repeat models already configured on the same relay", async () => {
    let requestCount = 0;
    const fetch = asFetch(async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          data: [
            { id: "deepseek-v4-flash" },
            { id: "deepseek-v4-flash-vision-exp" },
            { id: "deepseek-v4-pro" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await Effect.runPromise(
      checkByokProviderStatus(settings()).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      ),
    );

    expect(requestCount).toBe(1);
    expect(result.models.map((model) => model.name)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ]);
  });

  it("shows a warning and unknown authentication when the key check fails", async () => {
    const fetch = asFetch(
      async () =>
        new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await Effect.runPromise(
      checkByokProviderStatus(settings()).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      ),
    );

    expect(result.status).toBe("warning");
    expect(result.auth).toEqual({ status: "unknown", type: "byok" });
    expect(result.message).toContain("Key check failed for:");
  });
});

describe("byokModelsFromSettings", () => {
  it("prefers the adapter group label and falls back to the raw model id", () => {
    const models = byokModelsFromSettings({
      ...settings(),
      adapters: [
        {
          ...settings().adapters[0]!,
          displayName: "DeepSeek V4 Flash",
          groupName: "DeepSeek官方",
        },
        { ...settings().adapters[1]! },
      ],
    });

    expect(models.find((model) => model.slug === "flash")?.subProvider).toBe("DeepSeek官方");
    expect(models.find((model) => model.slug === "vision")?.subProvider).toBe(
      "deepseek-v4-flash-vision-exp",
    );
  });

  it("labels discovered models with the adapter group when present", async () => {
    const fetch = asFetch(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "deepseek-v9-beta" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await Effect.runPromise(
      checkByokProviderStatus({
        ...settings(),
        adapters: [
          {
            ...settings().adapters[0]!,
            displayName: "DeepSeek 官方中转",
            groupName: "DeepSeek官方",
            modelId: "deepseek-v4-flash",
          },
        ],
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        ),
      ),
    );

    const discovered = result.models.find((model) => model.slug === "flash/deepseek-v9-beta");
    expect(discovered?.subProvider).toBe("DeepSeek官方");
  });
});
