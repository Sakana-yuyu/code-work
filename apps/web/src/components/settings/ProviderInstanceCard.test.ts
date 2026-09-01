import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@codework/contracts";

import {
  deriveProviderModelsForDisplay,
  normalizeProviderEnvironmentDraftRows,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("normalizeProviderEnvironmentDraftRows", () => {
  it("保存已填写的变量时忽略新增的空白行", () => {
    expect(
      normalizeProviderEnvironmentDraftRows([
        {
          name: " API_BASE_URL ",
          value: "https://api.example.test/v1",
          sensitive: false,
        },
        {
          name: "",
          value: "",
          sensitive: true,
        },
      ]),
    ).toEqual([
      {
        name: "API_BASE_URL",
        value: "https://api.example.test/v1",
        sensitive: false,
      },
    ]);
  });

  it("拒绝保存名称不合法的已填写行", () => {
    expect(
      normalizeProviderEnvironmentDraftRows([
        {
          name: "api-key",
          value: "placeholder",
          sensitive: true,
        },
      ]),
    ).toBeNull();
  });
});
