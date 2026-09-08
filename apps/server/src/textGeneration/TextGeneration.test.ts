import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId, type ModelSelection, type ServerProvider } from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const makeStubTextGeneration = (
  overrides: Partial<TextGeneration.TextGeneration["Service"]>,
): TextGeneration.TextGeneration["Service"] =>
  TextGeneration.TextGeneration.of({
    generateCommitMessage: () =>
      Effect.die("generateCommitMessage stub not configured for this test"),
    generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
    generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
    generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
    ...overrides,
  });

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGeneration.TextGeneration["Service"],
  snapshot: Partial<ServerProvider> = {},
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      getSnapshot: Effect.succeed({
        instanceId,
        driver: instanceId as unknown as ProviderInstance["driverKind"],
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-09-08T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
        ...snapshot,
      }),
    } as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect.each([
    "codex",
    "claudeAgent",
    "cursor",
    "grok",
    "kimi",
    "antigravity",
    "opencode",
    "byok",
  ])("所有 Agent 均通过实例生成标题并保留上下文：%s", (driver) =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make(driver);
      const calls: TextGeneration.ThreadTitleGenerationInput[] = [];
      const instance = makeStubInstance(
        instanceId,
        makeStubTextGeneration({
          generateThreadTitle: (input) => {
            calls.push(input);
            return Effect.succeed({ title: "鹈鹕骑行二维动画" });
          },
        }),
      );
      const input = {
        cwd: process.cwd(),
        message: "USER: 创建鹈鹕骑自行车的动画\nASSISTANT: 已生成 HTML",
        previousTitle: "原始消息",
        modelSelection: createModelSelection(instanceId, "custom-model"),
      };
      const result = yield* TextGeneration.makeTextGenerationFromRegistry(
        makeStubRegistry([instance]),
      ).generateThreadTitle(input);
      expect(result.title).toBe("鹈鹕骑行二维动画");
      expect(calls).toEqual([input]);
    }),
  );

  it.effect.each(["codex", "claudeAgent", "grok", "opencode", "byok"])(
    "共享渠道替换失效的后台模型，保留有效选择，空目录明确失败：%s",
    (driver) =>
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make(driver);
        const calls: ModelSelection[] = [];
        const slug = driver === "opencode" ? "byok_gateway/gemini" : "gemini";
        const model = { slug, name: "Gemini", isCustom: false, capabilities: null };
        const snapshot: Partial<ServerProvider> = {
          auth: { status: "authenticated", type: "byok" },
          models: [model],
        };
        const instance = makeStubInstance(
          instanceId,
          makeStubTextGeneration({
            generateThreadTitle: (input) => {
              calls.push(input.modelSelection);
              return Effect.succeed({ title: "鹈鹕骑行二维动画" });
            },
          }),
          snapshot,
        );
        const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([instance]));
        const stale = createModelSelection(instanceId, "gpt-5.6-luna", [
          { id: "reasoningEffort", value: "low" },
        ]);
        yield* tg.generateThreadTitle({
          cwd: process.cwd(),
          message: "生成动画",
          modelSelection: stale,
        });
        expect(calls[0]).toEqual(createModelSelection(instanceId, slug));
        const valid = createModelSelection(instanceId, slug, [
          { id: "reasoningEffort", value: "high" },
        ]);
        yield* tg.generateThreadTitle({
          cwd: process.cwd(),
          message: "生成动画",
          modelSelection: valid,
        });
        expect(calls[1]).toEqual(valid);
        const empty = makeStubInstance(instanceId, instance.textGeneration, {
          ...snapshot,
          models: [],
        });
        const failed = yield* TextGeneration.makeTextGenerationFromRegistry(
          makeStubRegistry([empty]),
        )
          .generateThreadTitle({ cwd: process.cwd(), message: "生成动画", modelSelection: stale })
          .pipe(Effect.result);
        expect(Result.isFailure(failed)).toBe(true);
        expect(calls).toHaveLength(2);
      }),
  );

  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = TextGeneration.makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );
});
