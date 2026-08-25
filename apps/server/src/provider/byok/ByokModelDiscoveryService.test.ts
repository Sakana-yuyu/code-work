import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import { make } from "./ByokModelDiscoveryService.ts";

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

type Adapter = {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: "openai" | "anthropic";
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly supplierID?: string;
  readonly modelCatalogURL?: string;
  readonly modelCatalogStatus?: "openai_models" | "gemini_models" | "custom_url" | "manual_only";
};

const makeSettings = (instanceId: string, adapters: ReadonlyArray<Adapter>) =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: {
        driver: ProviderDriverKind.make("byok"),
        enabled: true,
        config: { enabled: true, adapters },
      },
    },
  }) as typeof DEFAULT_SERVER_SETTINGS;

const runDiscover = async (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string; forceRefresh?: boolean },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* make;
      return yield* service.discover(input);
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(ServerSettings.ServerSettingsService, {
            start: Effect.void,
            ready: Effect.void,
            getSettings: Effect.succeed(settings),
            updateSettings: () => Effect.succeed(settings),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
          ),
        ),
      ),
    ),
  );

const adapter = (overrides: Partial<Adapter> = {}): Adapter => ({
  id: "adapter-success",
  displayName: "Example model",
  protocol: "openai",
  baseURL: "https://discovery.test/v1",
  apiKey: "sk-test-key",
  modelId: "example-model",
  contextWindowTokens: 128000,
  supplierID: "openai",
  modelCatalogURL: "https://discovery.test/models",
  ...overrides,
});

describe("ByokModelDiscoveryService", () => {
  it("discovers OpenAI models and sends the materialized API key", async () => {
    let requested: Request | undefined;
    const fetch = asFetch(async (input, init) => {
      requested = new Request(String(input), init);
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "gpt-discovered",
              owned_by: "openai",
              context_window: 200000,
              pricing: { input: 1, output: 2, currency: "USD" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await runDiscover(makeSettings("instance-success", [adapter()]), fetch, {
      instanceId: "instance-success",
      adapterId: "adapter-success",
      forceRefresh: true,
    });

    expect(result.status).toBe("ready");
    expect(result.models).toEqual([
      {
        id: "gpt-discovered",
        ownedBy: "openai",
        contextWindowTokens: 200000,
        pricing: { input: 1, output: 2, currency: "USD" },
      },
    ]);
    expect(requested?.url).toBe("https://discovery.test/models");
    expect(requested?.headers.get("authorization")).toBe("Bearer sk-test-key");
  });

  it("rejects missing credentials and manual-only adapters", async () => {
    const fetch = asFetch(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const missing = await runDiscover(
      makeSettings("instance-missing", [adapter({ id: "missing-key", apiKey: "" })]),
      fetch,
      { instanceId: "instance-missing", adapterId: "missing-key" },
    );
    expect(missing.error?.code).toBe("missing_credentials");

    const manual = await runDiscover(
      makeSettings("instance-manual", [
        adapter({ id: "manual", modelCatalogStatus: "manual_only" }),
      ]),
      fetch,
      { instanceId: "instance-manual", adapterId: "manual" },
    );
    expect(manual.error?.code).toBe("unsupported_catalog");
  });

  it("isolates instances and returns stale cached models after refresh failure", async () => {
    let shouldFail = false;
    const fetch = asFetch(async () => {
      if (shouldFail) return new Response("upstream failure", { status: 503 });
      return new Response(JSON.stringify({ data: [{ id: "cached-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const first = await runDiscover(
      makeSettings("instance-a", [adapter({ id: "shared-adapter" })]),
      fetch,
      { instanceId: "instance-a", adapterId: "shared-adapter", forceRefresh: true },
    );
    expect(first.status).toBe("ready");

    shouldFail = true;
    const stale = await runDiscover(
      makeSettings("instance-a", [adapter({ id: "shared-adapter" })]),
      fetch,
      { instanceId: "instance-a", adapterId: "shared-adapter", forceRefresh: true },
    );
    expect(stale.stale).toBe(true);
    expect(stale.models.map((model) => model.id)).toEqual(["cached-model"]);

    const isolated = await runDiscover(
      makeSettings("instance-b", [adapter({ id: "shared-adapter" })]),
      fetch,
      { instanceId: "instance-b", adapterId: "shared-adapter", forceRefresh: false },
    );
    expect(isolated.status).toBe("failed");
    expect(isolated.models).toEqual([]);
  });
});
