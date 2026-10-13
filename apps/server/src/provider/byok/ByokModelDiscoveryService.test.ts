import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import { make, type ByokModelDiscoveryService } from "./ByokModelDiscoveryService.ts";
import * as ByokCatalog from "./ByokCatalog.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const asFetch = (
  implementation: (input: string | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

type Adapter = {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: "openai" | "anthropic";
  readonly baseURL: string;
  readonly apiKey: string;
  readonly customHeaders?: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
  readonly supplierID?: string;
  readonly modelCatalogURL?: string;
  readonly modelCatalogURLs?: readonly string[];
  readonly modelCatalogStatus?: "openai_models" | "gemini_models" | "custom_url" | "manual_only";
  readonly appendModelCatalogCandidates?: boolean;
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

const runDiscoveryScenario = <A>(
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  scenario: (
    service: ByokModelDiscoveryService,
    setSettings: (next: typeof DEFAULT_SERVER_SETTINGS) => Effect.Effect<void>,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const settingsRef = yield* Ref.make(settings);
    const service = yield* make.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settingsRef),
        updateSettings: () => Ref.get(settingsRef),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    );
    return yield* scenario(service, (next) => Ref.set(settingsRef, next));
  }).pipe(
    Effect.provide(
      ByokCatalog.layer.pipe(
        Layer.provideMerge(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
          ),
        ),
      ),
    ),
  );

const runDiscover = (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string; forceRefresh?: boolean },
) =>
  Effect.gen(function* () {
    const service = yield* make;
    return yield* service.discover(input);
  }).pipe(
    Effect.provide(
      ByokCatalog.layer.pipe(
        Layer.provideMerge(
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
    ),
  );

const runBenchmark = (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string },
) =>
  Effect.gen(function* () {
    const service = yield* make;
    return yield* service.benchmark(input);
  }).pipe(
    Effect.provide(
      ByokCatalog.layer.pipe(
        Layer.provideMerge(
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
    ),
  );

const runContextWindowMatch = (
  settings: typeof DEFAULT_SERVER_SETTINGS,
  fetchImplementation: typeof globalThis.fetch,
  input: { instanceId: string; adapterId: string },
) =>
  Effect.gen(function* () {
    const service = yield* make;
    return yield* service.matchContextWindows(input);
  }).pipe(
    Effect.provide(
      ByokCatalog.layer.pipe(
        Layer.provideMerge(
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
    ),
  );

const runDraftDiscover = (
  fetchImplementation: typeof globalThis.fetch,
  input: {
    protocol: "openai" | "anthropic" | "gemini";
    baseURL: string;
    apiKey: string;
    supplierID?: string;
  },
) =>
  Effect.gen(function* () {
    let getSettingsCalls = 0;
    let updateSettingsCalls = 0;
    const settings = DEFAULT_SERVER_SETTINGS;
    const result = yield* Effect.gen(function* () {
      const service = yield* make;
      const first = yield* service.discoverDraft(input);
      const second = yield* service.discoverDraft(input);
      return { first, second };
    }).pipe(
      Effect.provide(
        ByokCatalog.layer.pipe(
          Layer.provideMerge(
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
      ),
    );
    return { ...result, getSettingsCalls, updateSettingsCalls };
  });

const runCatalogLookup = (input: { modelId: string }) => {
  const fetch = asFetch(async (input) => {
    throw new Error(`Catalog lookup must not reach the network: ${String(input)}`);
  });
  return Effect.gen(function* () {
    const service = yield* make;
    return yield* service.lookupCatalogModel(input);
  }).pipe(
    Effect.provide(
      ByokCatalog.layer.pipe(
        Layer.provideMerge(
          Layer.merge(
            Layer.succeed(ServerSettings.ServerSettingsService, {
              start: Effect.void,
              ready: Effect.void,
              getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        ),
      ),
    ),
  );
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
  it.effect("discovers OpenAI models and sends the materialized API key", () =>
    Effect.gen(function* () {
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

      const result = yield* runDiscover(makeSettings("instance-success", [adapter()]), fetch, {
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
    }),
  );

  it.effect("切换供应商后不向旧模板目录发送新 Key", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const result = yield* runDiscover(
        makeSettings("supplier-switch", [
          adapter({
            id: "switched",
            supplierID: "openrouter",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: "sk-new-provider",
            modelCatalogURL: "",
            modelCatalogURLs: ["https://api.deepseek.com/v1/models"],
          }),
        ]),
        asFetch(async (input, init) => {
          requests.push(new Request(String(input), init));
          return new Response(JSON.stringify({ data: [{ id: "openai/gpt-4.1" }] }), {
            status: 200,
          });
        }),
        { instanceId: "supplier-switch", adapterId: "switched", forceRefresh: true },
      );

      expect(result.status).toBe("ready");
      expect(requests.map((request) => request.url)).toEqual([
        "https://openrouter.ai/api/v1/models",
      ]);
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-new-provider");
    }),
  );

  it.effect("自定义中转地址不自动调用所选供应商的官方目录", () =>
    Effect.gen(function* () {
      const requests: Request[] = [];
      const result = yield* runDiscover(
        makeSettings("custom-relay", [
          adapter({
            id: "relay",
            supplierID: "openrouter",
            baseURL: "https://relay.example.test/v1",
            modelCatalogURL: "",
            modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
          }),
        ]),
        asFetch(async (input, init) => {
          requests.push(new Request(String(input), init));
          return new Response(JSON.stringify({ data: [{ id: "openai/gpt-4.1" }] }), {
            status: 200,
          });
        }),
        { instanceId: "custom-relay", adapterId: "relay", forceRefresh: true },
      );

      expect(result.status).toBe("ready");
      expect(requests.map((request) => request.url)).toEqual([
        "https://relay.example.test/v1/models",
      ]);
    }),
  );

  it.effect(
    "enriches discovered models with catalog context and max output when the relay omits them",
    () =>
      Effect.gen(function* () {
        const fetch = asFetch(
          async () =>
            new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        );

        const result = yield* runDiscover(makeSettings("instance-enrich", [adapter()]), fetch, {
          instanceId: "instance-enrich",
          adapterId: "adapter-success",
          forceRefresh: true,
        });

        expect(result.status).toBe("ready");
        expect(result.models).toEqual([
          { id: "claude-sonnet-4-6", contextWindowTokens: 1_000_000, maxOutputTokens: 64_000 },
        ]);
      }),
  );

  it.effect("uses provider usage for benchmark throughput when the relay returns it", () =>
    Effect.gen(function* () {
      let requestedBody = "";
      const fetch = asFetch(async (_input, init) => {
        requestedBody = init?.body === undefined ? "" : await new Response(init.body).text();
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"1 2 3"},"finish_reason":"stop"}]}',
            "",
            'data: {"choices":[],"usage":{"completion_tokens":42}}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      const result = yield* runBenchmark(
        makeSettings("instance-benchmark", [adapter({ id: "benchmark", modelId: "deepseek-v4" })]),
        fetch,
        { instanceId: "instance-benchmark", adapterId: "benchmark" },
      );
      expect(result.outputTokens).toBe(42);
      expect(result.tokensEstimated).toBe(false);
      expect(requestedBody).toContain('"max_tokens":4096');
      expect(requestedBody).toContain('"stream_options":{"include_usage":true}');
    }),
  );

  it.effect("uses Anthropic output_tokens for benchmark throughput", () =>
    Effect.gen(function* () {
      const fetch = asFetch(
        async () =>
          new Response(
            [
              'data: {"type":"content_block_delta","delta":{"text":"1 2 3"}}',
              "",
              'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":37}}',
              "",
              'data: {"type":"message_stop"}',
              "",
            ].join("\n"),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
      );
      const result = yield* runBenchmark(
        makeSettings("instance-anthropic-benchmark", [
          adapter({
            id: "anthropic-benchmark",
            protocol: "anthropic",
            baseURL: "https://api.anthropic.com",
            modelId: "claude-sonnet",
          }),
        ]),
        fetch,
        { instanceId: "instance-anthropic-benchmark", adapterId: "anthropic-benchmark" },
      );
      expect(result.outputTokens).toBe(37);
      expect(result.tokensEstimated).toBe(false);
      expect(result.tokensPerSecond).toBeGreaterThan(0);
    }),
  );

  it.effect("rejects missing credentials and manual-only adapters", () =>
    Effect.gen(function* () {
      const fetch = asFetch(
        async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
      const missing = yield* runDiscover(
        makeSettings("instance-missing", [adapter({ id: "missing-key", apiKey: "" })]),
        fetch,
        { instanceId: "instance-missing", adapterId: "missing-key" },
      );
      expect(missing.error?.code).toBe("missing_credentials");

      const manual = yield* runDiscover(
        makeSettings("instance-manual", [
          adapter({ id: "manual", modelCatalogStatus: "manual_only" }),
        ]),
        fetch,
        { instanceId: "instance-manual", adapterId: "manual" },
      );
      expect(manual.error?.code).toBe("unsupported_catalog");
    }),
  );

  it.effect("等价实例共享目录，失败回退仍补回当前实例与适配器身份", () =>
    Effect.gen(function* () {
      let shouldFail = false;
      let requests = 0;
      const fetch = asFetch(async () => {
        requests += 1;
        return shouldFail
          ? new Response("upstream failure", { status: 503 })
          : new Response(JSON.stringify({ data: [{ id: "cached-model" }] }));
      });
      const settings = {
        ...makeSettings("instance-a", [
          adapter({ id: "first", appendModelCatalogCandidates: false }),
        ]),
        providerInstances: {
          ...makeSettings("instance-a", [
            adapter({ id: "first", appendModelCatalogCandidates: false }),
          ]).providerInstances,
          ...makeSettings("instance-b", [
            adapter({ id: "second", appendModelCatalogCandidates: false }),
          ]).providerInstances,
        },
      };
      const results = yield* runDiscoveryScenario(settings, fetch, (service) =>
        Effect.gen(function* () {
          const first = yield* service.discover({ instanceId: "instance-a", adapterId: "first" });
          const shared = yield* service.discover({ instanceId: "instance-b", adapterId: "second" });
          shouldFail = true;
          const stale = yield* service.discover({
            instanceId: "instance-b",
            adapterId: "second",
            forceRefresh: true,
          });
          return { first, shared, stale };
        }),
      );
      expect(results.first).toMatchObject({
        status: "ready",
        instanceId: "instance-a",
        adapterId: "first",
      });
      expect(results.shared).toMatchObject({
        status: "cached",
        stale: false,
        instanceId: "instance-b",
        adapterId: "second",
        models: [{ id: "cached-model" }],
      });
      expect(results.stale).toMatchObject({
        status: "cached",
        stale: true,
        instanceId: "instance-b",
        adapterId: "second",
        models: [{ id: "cached-model" }],
        error: { code: "upstream_http" },
      });
      expect(requests).toBe(2);
    }),
  );

  it.effect("保存配置与草稿在同一服务生命周期共享等价目录", () =>
    Effect.gen(function* () {
      let requests = 0;
      const fetch = asFetch(async () => {
        requests += 1;
        return new Response(JSON.stringify({ data: [{ id: "shared-draft" }] }));
      });
      const saved = adapter({ id: "saved", supplierID: "custom", modelCatalogURL: "" });
      const result = yield* runDiscoveryScenario(
        makeSettings("shared", [saved]),
        fetch,
        (service) =>
          Effect.gen(function* () {
            const draft = yield* service.discoverDraft({
              protocol: saved.protocol,
              baseURL: saved.baseURL,
              apiKey: saved.apiKey,
              supplierID: "custom",
            });
            const stored = yield* service.discover({ instanceId: "shared", adapterId: "saved" });
            return { draft, stored };
          }),
      );
      expect(result.draft).toMatchObject({ status: "ready", models: [{ id: "shared-draft" }] });
      expect(result.stored).toMatchObject({
        status: "cached",
        instanceId: "shared",
        adapterId: "saved",
        models: result.draft.models,
      });
      expect(requests).toBe(1);
    }),
  );

  for (const field of ["apiKey", "customHeaders"] as const) {
    for (const shouldFail of [false, true]) {
      it.effect(`更换 ${field} 后隔离模型目录缓存，刷新${shouldFail ? "失败" : "成功"}`, () =>
        Effect.gen(function* () {
          const instanceId = `credential-cache-${field}-${shouldFail}`;
          const input = { instanceId, adapterId: "credential-cache" };
          const credentials = (account: "first" | "second") =>
            field === "apiKey"
              ? { apiKey: `sk-cache-${account}` }
              : { customHeaders: JSON.stringify({ "x-account": account }) };
          const settingsFor = (account: "first" | "second") =>
            makeSettings(instanceId, [
              adapter({
                id: input.adapterId,
                appendModelCatalogCandidates: false,
                ...credentials(account),
              }),
            ]);
          const accounts: string[] = [];
          const fetch = asFetch(async (url, init) => {
            const request = new Request(String(url), init);
            const account =
              field === "apiKey"
                ? request.headers.get("authorization") === "Bearer sk-cache-first"
                  ? "first"
                  : "second"
                : request.headers.get("x-account")!;
            accounts.push(account);
            return shouldFail && account === "second"
              ? new Response("upstream failure", { status: 503 })
              : new Response(JSON.stringify({ data: [{ id: `${account}-model` }] }), {
                  status: 200,
                });
          });
          const { first, second, cached } = yield* runDiscoveryScenario(
            settingsFor("first"),
            fetch,
            (service, setSettings) =>
              Effect.gen(function* () {
                const first = yield* service.discover(input);
                yield* setSettings(settingsFor("second"));
                const second = yield* service.discover({ ...input, forceRefresh: shouldFail });
                const cached = shouldFail ? undefined : yield* service.discover(input);
                return { first, second, cached };
              }),
          );
          expect(first).toMatchObject({ status: "ready", models: [{ id: "first-model" }] });
          expect(accounts).toEqual(["first", "second"]);
          expect(second).toMatchObject(
            shouldFail
              ? { status: "failed", stale: false, models: [], error: { code: "upstream_http" } }
              : { status: "ready", stale: false, models: [{ id: "second-model" }] },
          );
          if (!shouldFail) {
            expect(cached).toMatchObject({ status: "cached", models: [{ id: "second-model" }] });
          }
          expect(encodeJson(second)).not.toContain("sk-cache-");
          expect(encodeJson(second)).not.toContain("x-account");
        }),
      );
    }
  }

  it.effect("probes a relay once for manual context matching and never returns its API key", () =>
    Effect.gen(function* () {
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
      const result = yield* runContextWindowMatch(
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
      expect(encodeJson(result)).not.toContain("sk-test-key");
      expect(encodeJson(result).toLowerCase()).not.toContain("apikey");
    }),
  );

  it.effect("uses explicit relay metadata to correct a catalog-known DeepSeek model", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const fetch = asFetch(async () => {
        requestCount += 1;
        return new Response(
          JSON.stringify({ data: [{ id: "deepseek-v3", context_window: 1_000_000 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const result = yield* runContextWindowMatch(
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
    }),
  );

  it.effect("草稿目录复用内存缓存，但不持久化或返回API密钥", () =>
    Effect.gen(function* () {
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

      const { first, second, getSettingsCalls, updateSettingsCalls } = yield* runDraftDiscover(
        fetch,
        {
          protocol: "openai",
          baseURL: "https://draft-discovery.test/v1",
          apiKey: "sk-draft-discovery-key",
          supplierID: "custom",
        },
      );

      expect(first.status).toBe("ready");
      expect(first.models).toEqual([{ id: "draft-model", contextWindowTokens: 32000 }]);
      expect(second.status).toBe("ready");
      expect(requests).toHaveLength(1);
      expect(requests.map((request) => request.url)).toEqual([
        "https://draft-discovery.test/v1/models",
      ]);
      expect(
        requests.every(
          (request) => request.headers.get("authorization") === "Bearer sk-draft-discovery-key",
        ),
      ).toBe(true);
      expect(getSettingsCalls).toBe(0);
      expect(updateSettingsCalls).toBe(0);
      const serialized = encodeJson({ first, second }).toLowerCase();
      expect(serialized).not.toContain("sk-draft-discovery-key");
      expect(serialized).not.toContain("apikey");
    }),
  );

  it.effect("rejects an invalid draft endpoint before sending its request-only API key", () =>
    Effect.gen(function* () {
      const fetch = asFetch(async () => {
        throw new Error("The invalid endpoint must not reach fetch.");
      });

      const { first, second, getSettingsCalls, updateSettingsCalls } = yield* runDraftDiscover(
        fetch,
        {
          protocol: "openai",
          baseURL: "not-an-absolute-url",
          apiKey: "sk-invalid-endpoint-key",
        },
      );

      expect(first.error?.code).toBe("invalid_endpoint");
      expect(second.error?.code).toBe("invalid_endpoint");
      expect(getSettingsCalls).toBe(0);
      expect(updateSettingsCalls).toBe(0);
      expect(encodeJson({ first, second })).not.toContain("sk-invalid-endpoint-key");
    }),
  );

  it.effect("looks up built-in catalog capabilities locally for a manually entered model", () =>
    Effect.gen(function* () {
      const hit = yield* runCatalogLookup({ modelId: "GLM-5.3-Flash" });
      const miss = yield* runCatalogLookup({ modelId: "totally-unknown-model" });

      expect(hit).toEqual({ contextWindowTokens: 1000000, maxOutputTokens: 128000 });
      expect(miss).toEqual({});
    }),
  );
});
