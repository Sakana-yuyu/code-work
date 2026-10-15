import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, type ServerProviderModel } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  applyModelManifest,
  BUNDLED_MODEL_MANIFEST,
  classifyModels,
  isLegacyModel,
  make,
  type ModelManifestData,
} from "./ModelManifest.ts";
import { buildServerProvider, type ServerProviderDraft } from "./providerSnapshot.ts";

const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CURSOR = ProviderDriverKind.make("cursor");

describe("isLegacyModel (bundled manifest)", () => {
  it("keeps current Codex models out of legacy models", () => {
    assert.deepStrictEqual(
      [
        "gpt-5.6-luna",
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-daybreak-blue-latest",
        "gpt-daybreak-red-latest",
        "gpt-5.4",
      ].map((model) => [model, isLegacyModel(BUNDLED_MODEL_MANIFEST, CODEX, model)]),
      [
        ["gpt-5.6-luna", false],
        ["gpt-5.6-terra", false],
        ["gpt-5.6-sol", false],
        ["gpt-daybreak-blue-latest", false],
        ["gpt-daybreak-red-latest", false],
        ["gpt-5.4", true],
      ],
    );
  });

  it("keeps only the Claude 5 family out of legacy models", () => {
    assert.deepStrictEqual(
      ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
        model,
        isLegacyModel(BUNDLED_MODEL_MANIFEST, CLAUDE, model),
      ]),
      [
        ["claude-fable-5", false],
        ["claude-opus-5", false],
        ["claude-sonnet-5", false],
        ["claude-opus-4-8", true],
      ],
    );
  });

  it("leaves driver kinds without a manifest entry unflagged", () => {
    assert.isFalse(isLegacyModel(BUNDLED_MODEL_MANIFEST, CURSOR, "composer-1.5"));
  });
});

const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("flags non-current models, clears stale flags, and skips custom models", () => {
    const models = [
      model({ slug: "gpt-5.6-sol" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "gpt-5.6-luna", isLegacy: true }),
      model({ slug: "gpt-5.4" }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      classifyModels(models, BUNDLED_MODEL_MANIFEST, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["gpt-5.6-sol", false],
        ["gpt-5.6-luna", false],
        ["gpt-5.4", true],
        ["my-own-model", false],
      ],
    );
  });
});

const REMOTE_MANIFEST: ModelManifestData = {
  version: 1,
  currentModels: {
    codex: ["gpt-5.4"],
    claudeAgent: ["claude-fable-5"],
  },
};

const draft = (input: {
  readonly enabled?: boolean;
  readonly installed?: boolean;
  readonly version?: string | null;
  readonly status?: "ready" | "warning" | "error";
  readonly models?: ReadonlyArray<ServerProviderModel>;
  readonly message?: string;
}): ServerProviderDraft =>
  buildServerProvider({
    presentation: { displayName: "manifest-apply-test" },
    enabled: input.enabled ?? true,
    checkedAt: "2026-10-13T00:00:00.000Z",
    models: input.models ?? [],
    probe: {
      installed: input.installed ?? true,
      version: input.version === undefined ? "2.1.219" : input.version,
      status: input.status ?? "ready",
      auth: { status: "authenticated" },
      ...(input.message ? { message: input.message } : {}),
    },
  });

describe("applyModelManifest (claudeAgent catalog)", () => {
  const claudeDraft = (version: string | null) =>
    draft({
      installed: true,
      version,
      models: [
        model({ slug: "claude-sonnet-5", name: "Claude Sonnet 5" }),
        model({ slug: "my-own-model", name: "my-own-model", isCustom: true }),
      ],
    });

  it("gates current models above the installed version into updateRequiredModels", () => {
    const applied = applyModelManifest(claudeDraft("2.1.150"), BUNDLED_MODEL_MANIFEST, CLAUDE);
    const slugs = new Set(applied.models.map((entry) => entry.slug));
    // 2.1.150 clears opus-4-7 (2.1.111) but not opus-4-8 (2.1.154),
    // fable-5 (2.1.169), or opus-5 (2.1.219). Legacy entries gate out
    // silently; only current models reach updateRequiredModels.
    assert.isTrue(slugs.has("claude-opus-4-7"));
    assert.isFalse(slugs.has("claude-opus-4-8"));
    assert.isFalse(slugs.has("claude-fable-5"));
    assert.isFalse(slugs.has("claude-opus-5"));
    assert.isTrue(slugs.has("my-own-model"));
    assert.deepStrictEqual(
      applied.updateRequiredModels?.map((entry) => [entry.slug, entry.minVersion]),
      [
        ["claude-fable-5", "2.1.169"],
        ["claude-opus-5", "2.1.219"],
      ],
    );
    assert.strictEqual(
      applied.message,
      "Update Claude Code to v2.1.169 or newer to use Claude Fable 5.",
    );
  });

  it("keeps the full catalog when every gate is satisfied", () => {
    const applied = applyModelManifest(claudeDraft("2.1.220"), BUNDLED_MODEL_MANIFEST, CLAUDE);
    assert.isTrue(applied.models.some((entry) => entry.slug === "claude-opus-5"));
    assert.isTrue(applied.models.some((entry) => entry.slug === "claude-fable-5"));
    assert.strictEqual(applied.updateRequiredModels, undefined);
    assert.strictEqual(applied.message, undefined);
  });

  it("keeps the full catalog for a never-probed draft", () => {
    const applied = applyModelManifest(
      draft({ enabled: false, installed: false, version: null, models: [] }),
      BUNDLED_MODEL_MANIFEST,
      CLAUDE,
    );
    assert.strictEqual(applied.models.length, 9);
    assert.strictEqual(applied.updateRequiredModels, undefined);
    assert.strictEqual(applied.message, undefined);
  });

  it("drops gated models silently when an installed CLI reports no version", () => {
    const applied = applyModelManifest(claudeDraft(null), BUNDLED_MODEL_MANIFEST, CLAUDE);
    assert.isFalse(applied.models.some((entry) => entry.slug === "claude-opus-5"));
    assert.strictEqual(applied.updateRequiredModels, undefined);
    assert.strictEqual(applied.message, undefined);
  });

  it("resolves profile capabilities and marks legacy via catalog status", () => {
    const applied = applyModelManifest(claudeDraft("2.1.220"), BUNDLED_MODEL_MANIFEST, CLAUDE);
    const opus = applied.models.find((entry) => entry.slug === "claude-opus-5");
    assert.isTrue(
      opus?.capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "effort") ??
        false,
    );
    const sonnet46 = applied.models.find((entry) => entry.slug === "claude-sonnet-4-6");
    assert.strictEqual(sonnet46?.isLegacy, true);
  });

  it("does not overwrite an existing probe message", () => {
    const applied = applyModelManifest(
      draft({
        installed: true,
        version: "2.1.150",
        status: "warning",
        message: "preexisting",
        models: [],
      }),
      BUNDLED_MODEL_MANIFEST,
      CLAUDE,
    );
    assert.strictEqual(applied.message, "preexisting");
  });
});

describe("applyModelManifest (codex catalog)", () => {
  const codexDraft = (version: string | null, slugs: ReadonlyArray<string>) =>
    draft({
      installed: true,
      version,
      models: slugs.map((slug) => model({ slug, name: slug })),
    });

  it("announces current catalog models the installed CLI cannot run yet", () => {
    const applied = applyModelManifest(
      codexDraft("0.152.0", ["gpt-5.5"]),
      BUNDLED_MODEL_MANIFEST,
      CODEX,
    );
    assert.deepStrictEqual(
      applied.updateRequiredModels?.map((entry) => [entry.slug, entry.minVersion]),
      [
        ["gpt-6.1-sol", "0.153.0"],
        ["gpt-6-astra", "0.153.0"],
        ["gpt-6-luna", "0.155.0"],
      ],
    );
    // The CLI-reported models stay untouched besides legacy classification.
    assert.deepStrictEqual(
      applied.models.map((entry) => entry.slug),
      ["gpt-5.5"],
    );
  });

  it("stops announcing models the CLI already reports or can run", () => {
    const discovered = applyModelManifest(
      codexDraft("0.152.0", ["gpt-5.5", "gpt-6.1-sol"]),
      BUNDLED_MODEL_MANIFEST,
      CODEX,
    );
    assert.deepStrictEqual(
      discovered.updateRequiredModels?.map((entry) => entry.slug),
      ["gpt-6-astra", "gpt-6-luna"],
    );
    const newEnough = applyModelManifest(codexDraft("0.156.0", []), BUNDLED_MODEL_MANIFEST, CODEX);
    assert.strictEqual(newEnough.updateRequiredModels, undefined);
  });

  it("announces nothing when the CLI was never probed", () => {
    const applied = applyModelManifest(
      draft({ enabled: false, installed: false, version: null, models: [] }),
      BUNDLED_MODEL_MANIFEST,
      CODEX,
    );
    assert.strictEqual(applied.updateRequiredModels, undefined);
  });
});

const httpClientLayer = (handler: () => Response) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler()))),
  );

const serviceLayers = (input: {
  readonly prefix: string;
  readonly response: () => Response;
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  ServerConfig.layerTest(process.cwd(), { prefix: input.prefix }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettings.layerTest(input.settings ?? {})),
    Layer.provideMerge(httpClientLayer(input.response)),
  );

describe("ModelManifest service", () => {
  it.live("prefers a fetched manifest over the bundle and caches it to disk", () =>
    Effect.gen(function* () {
      const service = yield* make;
      const refreshed = yield* service.refresh;
      assert.deepStrictEqual(refreshed, REMOTE_MANIFEST);
      assert.isTrue(isLegacyModel(refreshed, CODEX, "gpt-5.6-sol"));
      assert.isFalse(isLegacyModel(refreshed, CODEX, "gpt-5.4"));

      // A fresh service instance sees the disk cache without another fetch:
      // its HTTP layer is still stubbed, but `current` never fetches at all.
      const rebooted = yield* make;
      assert.deepStrictEqual(yield* rebooted.current, REMOTE_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-fetch-test",
          response: () => Response.json(REMOTE_MANIFEST),
        }),
      ),
    ),
  );

  it.live("keeps the bundled manifest when the remote payload is malformed", () =>
    Effect.gen(function* () {
      const service = yield* make;
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-malformed-test",
          response: () => Response.json({ version: 999, nonsense: true }),
        }),
      ),
    ),
  );

  it.live("does not fetch when provider update checks are disabled", () =>
    Effect.gen(function* () {
      let fetchCount = 0;
      const service = yield* make.pipe(
        Effect.provide(
          httpClientLayer(() => {
            fetchCount += 1;
            return Response.json(REMOTE_MANIFEST);
          }),
        ),
      );
      assert.deepStrictEqual(yield* service.refresh, BUNDLED_MODEL_MANIFEST);
      assert.strictEqual(fetchCount, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        serviceLayers({
          prefix: "model-manifest-optout-test",
          response: () => Response.json(REMOTE_MANIFEST),
          settings: { enableProviderUpdateChecks: false },
        }),
      ),
    ),
  );
});
