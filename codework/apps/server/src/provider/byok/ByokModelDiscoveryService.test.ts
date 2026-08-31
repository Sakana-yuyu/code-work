import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@codework/contracts";
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

const runContextWindowMatch = async (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string },
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* make;
      return yield* service.matchContextWindows(input);
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

const runDraftDiscover = async (
  fetchImplementation: typeof globalThis.fetch,
  input: {
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    supplierID?: string;
  },
) => {
  let getSettingsCalls = 0;
  let updateSettingsCalls = 0;
  const settings = DEFAULT_SERVER_SETTINGS;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* make;
      const first = yield* service.discoverDraft(input);
      const second = yield* service.discoverDraft(input);
      return { first, second };
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(ServerSettings.ServerSettingsService, {
            start: Effect.void,
            ready: Effect.void,
            getSettings: Effect.sync(() => {
              getSettingsCalls += 1;
              return settings;
            }),
            updateSettings: () =>
              Effect.sync(() => {
                updateSettingsCalls += 1;
                return settings;
              }),
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
  return { ...result, getSettingsCalls, updateSettingsCalls };
};

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

  it("probes a relay once for manual context matching and never returns its API key", async () => {
    let requestCount = 0;
    const fetch = asFetch(async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({
          data: [
            { id: "private-one", context_window: 64_000 },
            { id: "private-two", context_window: 32_000 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await runContextWindowMatch(
      makeSettings("instance-context-match", [
        adapter({ id: "context-one", modelId: "private-one", contextWindowTokens: 128_000 }),
        adapter({ id: "context-two", modelId: "private-two", contextWindowTokens: 128_000 }),
      ]),
      fetch,
      { instanceId: "instance-context-match", adapterId: "context-one" },
    );

    expect(requestCount).toBe(1);
    expect(result).toMatchObject({
      adapterId: "context-one",
      total: 2,
      fromCatalog: 0,
      fromProbe: 2,
      unchanged: 0,
      details: [
        { adapterId: "context-one", source: "probe", before: 128_000, after: 64_000 },
        { adapterId: "context-two", source: "probe", before: 128_000, after: 32_000 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-key");
    expect(JSON.stringify(result).toLowerCase()).not.toContain("apikey");
  });

  it("uses explicit relay metadata to correct a catalog-known DeepSeek model", async () => {
    let requestCount = 0;
    const fetch = asFetch(async () => {
      requestCount += 1;
      return new Response(
        JSON.stringify({ data: [{ id: "deepseek-v3", context_window: 1_000_000 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await runContextWindowMatch(
      makeSettings("instance-deepseek-context", [
        adapter({
          id: "deepseek-v3",
          modelId: "deepseek-v3",
          contextWindowTokens: 128_000,
        }),
      ]),
      fetch,
      { instanceId: "instance-deepseek-context", adapterId: "deepseek-v3" },
    );

    expect(requestCount).toBe(1);
    expect(result).toMatchObject({
      total: 1,
      fromCatalog: 0,
      fromProbe: 1,
      unchanged: 0,
      details: [
        {
          adapterId: "deepseek-v3",
          modelId: "deepseek-v3",
          source: "probe",
          before: 128_000,
          after: 1_000_000,
        },
      ],
    });
  });

  it("discovers a draft without persisting, caching, or returning its API key", async () => {
    const requests: Request[] = [];
    const fetch = asFetch(async (input, init) => {
      requests.push(new Request(String(input), init));
      return new Response(
        JSON.stringify({ data: [{ id: "draft-model", context_window: 32000 }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const { first, second, getSettingsCalls, updateSettingsCalls } = await runDraftDiscover(fetch, {
      protocol: "openai",
      baseURL: "https://draft-discovery.test/v1",
      apiKey: "sk-draft-discovery-key",
      supplierID: "custom",
    });

    expect(first.status).toBe("ready");
    expect(first.models).toEqual([{ id: "draft-model", contextWindowTokens: 32000 }]);
    expect(second.status).toBe("ready");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.url)).toEqual([
      "https://draft-discovery.test/v1/models",
      "https://draft-discovery.test/v1/models",
    ]);
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === "Bearer sk-draft-discovery-key",
      ),
    ).toBe(true);
    expect(getSettingsCalls).toBe(0);
    expect(updateSettingsCalls).toBe(0);
    const serialized = JSON.stringify({ first, second }).toLowerCase();
    expect(serialized).not.toContain("sk-draft-discovery-key");
    expect(serialized).not.toContain("apikey");
  });

  it("rejects an invalid draft endpoint before sending its request-only API key", async () => {
    const fetch = asFetch(async () => {
      throw new Error("The invalid endpoint must not reach fetch.");
    });

    const { first, second, getSettingsCalls, updateSettingsCalls } = await runDraftDiscover(fetch, {
      protocol: "openai",
      baseURL: "not-an-absolute-url",
      apiKey: "sk-invalid-endpoint-key",
    });

    expect(first.error?.code).toBe("invalid_endpoint");
    expect(second.error?.code).toBe("invalid_endpoint");
    expect(getSettingsCalls).toBe(0);
    expect(updateSettingsCalls).toBe(0);
    expect(JSON.stringify({ first, second })).not.toContain("sk-invalid-endpoint-key");
  });
});
