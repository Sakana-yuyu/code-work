import { describe, expect, it } from "vite-plus/test";

import { modelPickerProviderGroupKey, parseModelPickerProviderGroupKey } from "./modelPickerKeys";
import { buildGroupedModelPickerItemKeys } from "./modelPickerGroups";

describe("buildGroupedModelPickerItemKeys", () => {
  it("groups model rows under provider headers in first-seen order", () => {
    const keys = buildGroupedModelPickerItemKeys({
      models: [
        { key: "m:a1", providerLabel: "自定义模型服务 · GROK", isFavorite: false },
        { key: "m:b1", providerLabel: "Codex", isFavorite: false },
        { key: "m:a2", providerLabel: "自定义模型服务 · GROK", isFavorite: false },
      ],
      favoritesHeaderLabel: "收藏",
      groupFavorites: false,
    });
    expect(keys).toEqual([
      modelPickerProviderGroupKey("自定义模型服务 · GROK"),
      "m:a1",
      "m:a2",
      modelPickerProviderGroupKey("Codex"),
      "m:b1",
    ]);
  });

  it("collects favorites under a leading favorites header without repeating them", () => {
    const keys = buildGroupedModelPickerItemKeys({
      models: [
        { key: "m:a1", providerLabel: "GROK", isFavorite: true },
        { key: "m:b1", providerLabel: "Codex", isFavorite: false },
        { key: "m:a2", providerLabel: "GROK", isFavorite: false },
      ],
      favoritesHeaderLabel: "收藏",
      groupFavorites: true,
    });
    expect(keys).toEqual([
      modelPickerProviderGroupKey("收藏"),
      "m:a1",
      modelPickerProviderGroupKey("Codex"),
      "m:b1",
      modelPickerProviderGroupKey("GROK"),
      "m:a2",
    ]);
  });

  it("emits no favorites header when nothing is favorite or grouping is off", () => {
    const models = [
      { key: "m:a1", providerLabel: "GROK", isFavorite: true },
      { key: "m:b1", providerLabel: "Codex", isFavorite: false },
    ];
    expect(
      buildGroupedModelPickerItemKeys({
        models,
        favoritesHeaderLabel: "收藏",
        groupFavorites: false,
      }),
    ).toEqual([
      modelPickerProviderGroupKey("GROK"),
      "m:a1",
      modelPickerProviderGroupKey("Codex"),
      "m:b1",
    ]);
    expect(
      buildGroupedModelPickerItemKeys({
        models: models.filter((model) => !model.isFavorite),
        favoritesHeaderLabel: "收藏",
        groupFavorites: true,
      }),
    ).toEqual([modelPickerProviderGroupKey("Codex"), "m:b1"]);
  });

  it("round-trips group keys through the parser", () => {
    const label = "自定义模型服务 · 智谱";
    expect(parseModelPickerProviderGroupKey(modelPickerProviderGroupKey(label))).toBe(label);
    expect(parseModelPickerProviderGroupKey("model:abc")).toBeNull();
    expect(parseModelPickerProviderGroupKey("legacy-models:abc")).toBeNull();
  });
});
