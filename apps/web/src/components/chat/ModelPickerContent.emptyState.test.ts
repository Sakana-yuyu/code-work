import { describe, expect, it } from "vite-plus/test";
import { getModelPickerEmptyState } from "./ModelPickerContent";

describe("模型选择器空状态", () => {
  it("搜索时保持搜索结果提示", () => {
    expect(getModelPickerEmptyState({ isSearching: true, readyModelCount: 0 })).toBe("search");
  });

  it("没有可用模型时引导进入 AI 服务设置", () => {
    expect(getModelPickerEmptyState({ isSearching: false, readyModelCount: 0 })).toBe(
      "provider-settings",
    );
  });

  it("已有模型但当前筛选为空时不误导用户去设置", () => {
    expect(getModelPickerEmptyState({ isSearching: false, readyModelCount: 2 })).toBe("filtered");
  });
});
