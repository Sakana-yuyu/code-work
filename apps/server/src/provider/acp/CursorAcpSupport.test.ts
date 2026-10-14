import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "@effect/vitest";

import { applyCursorAcpModelSelection, buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";

const parameterizedGpt54ConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

describe("buildCursorAcpSpawnInput", () => {
  it("builds the default Cursor ACP command", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "cursor-agent",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("includes the configured api endpoint when present", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("applyCursorAcpModelSelection", () => {
  type Call =
    | { readonly type: "model"; readonly value: string }
    | { readonly type: "config"; readonly configId: string; readonly value: string | boolean };

  const makeRuntime = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    availableModels: ReadonlyArray<{
      slug: string;
      name: string;
      isDefault: boolean;
      isCustom: boolean;
      capabilities: null;
    }> | null,
  ) => {
    const calls: Array<Call> = [];
    const runtime = {
      getConfigOptions: Effect.succeed(configOptions),
      getAvailableModels: Effect.succeed(availableModels),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };
    return { runtime, calls };
  };

  const modelConfigOption = (
    currentValue: string,
    options: ReadonlyArray<{ value: string; name: string }>,
  ): EffectAcpSchema.SessionConfigOption => ({
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue,
    options: [...options],
  });

  it.effect("sets the base model before applying separate config options", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime(parameterizedGpt54ConfigOptions, null);
      yield* applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        selections: [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
        mapError: ({ step, configId, cause }) =>
          step === "set-config-option"
            ? `failed to set config option ${configId}: ${cause.message}`
            : `failed to set model: ${cause.message}`,
      });
      expect(calls).toEqual([
        { type: "model", value: "gpt-5.4-medium-fast" },
        { type: "config", configId: "reasoning", value: "extra-high" },
        { type: "config", configId: "context", value: "1m" },
        { type: "config", configId: "fast", value: "true" },
      ]);
    }),
  );

  it.effect(
    "falls back to the advertised current value when the persisted model was withdrawn",
    () =>
      Effect.gen(function* () {
        const { runtime, calls } = makeRuntime(
          [
            modelConfigOption("default", [
              { value: "default", name: "Default" },
              { value: "composer-2", name: "Composer 2" },
              { value: "gpt-5.4", name: "GPT-5.4" },
              { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
            ]),
          ],
          null,
        );
        const result = yield* applyCursorAcpModelSelection({
          runtime,
          model: "dynamic-default",
          selections: undefined,
          mapError: ({ cause }) => cause.message,
        });
        expect(calls).toEqual([{ type: "model", value: "default" }]);
        expect(result.appliedModel).toBe("default");
        expect(result.withdrawnModel).toBe("dynamic-default");
      }),
  );

  it.effect("falls back to the first advertised option when the current value is also stale", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime(
        [
          modelConfigOption("dynamic-default", [
            { value: "composer-2", name: "Composer 2" },
            { value: "gpt-5.4", name: "GPT-5.4" },
          ]),
        ],
        null,
      );
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "dynamic-default",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([{ type: "model", value: "composer-2" }]);
      expect(result.appliedModel).toBe("composer-2");
      expect(result.withdrawnModel).toBe("dynamic-default");
    }),
  );

  it.effect("accepts a parameterized model whose base id is still advertised", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime(parameterizedGpt54ConfigOptions, null);
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium]",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([{ type: "model", value: "gpt-5.4-medium-fast" }]);
      expect(result.appliedModel).toBe("gpt-5.4-medium-fast");
      expect(result.withdrawnModel).toBeUndefined();
    }),
  );

  it.effect("does not dispatch a model when the model config advertises no options", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime([modelConfigOption("dynamic-default", [])], null);
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "dynamic-default",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result.appliedModel).toBeUndefined();
      expect(result.withdrawnModel).toBe("dynamic-default");
    }),
  );

  it.effect("passes the requested base model through when the CLI advertises no catalog", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime([], null);
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "custom-model[reasoning=high]",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([{ type: "model", value: "custom-model" }]);
      expect(result.appliedModel).toBe("custom-model");
      expect(result.withdrawnModel).toBeUndefined();
    }),
  );

  it.effect("falls back to the advertised default in the legacy model list", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime(
        [],
        [
          {
            slug: "composer-2",
            name: "Composer 2",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "gpt-5.4",
            name: "GPT-5.4",
            isDefault: false,
            isCustom: false,
            capabilities: null,
          },
        ],
      );
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "dynamic-default",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([{ type: "model", value: "composer-2" }]);
      expect(result.appliedModel).toBe("composer-2");
      expect(result.withdrawnModel).toBe("dynamic-default");
    }),
  );

  it.effect("does not dispatch a model when the advertised catalog is empty", () =>
    Effect.gen(function* () {
      const { runtime, calls } = makeRuntime([], []);
      const result = yield* applyCursorAcpModelSelection({
        runtime,
        model: "dynamic-default",
        selections: undefined,
        mapError: ({ cause }) => cause.message,
      });
      expect(calls).toEqual([]);
      expect(result.appliedModel).toBeUndefined();
      expect(result.withdrawnModel).toBe("dynamic-default");
    }),
  );
});
