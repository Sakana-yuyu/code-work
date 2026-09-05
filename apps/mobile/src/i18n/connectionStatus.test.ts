import { setCurrentLanguage } from "./runtime";

setCurrentLanguage("en");

import { describe, expect, it } from "vite-plus/test";

import { localizeConnectionBannerError } from "./connectionStatus";

describe("localizeConnectionBannerError", () => {
  it("rewrites WebSocket connection failures using the catalog", () => {
    setCurrentLanguage("zh-CN");
    try {
      expect(localizeConnectionBannerError("Dev could not establish a WebSocket connection.")).toBe(
        "Dev 无法建立 WebSocket 连接。",
      );
    } finally {
      setCurrentLanguage("en");
    }
  });

  it("keeps the environment label from the generated error", () => {
    const error = "Work Laptop could not establish a WebSocket connection.";
    expect(localizeConnectionBannerError(error)).toContain("Work Laptop");
  });

  it("passes other errors through raw", () => {
    expect(localizeConnectionBannerError("Environment is unreachable.")).toBe(
      "Environment is unreachable.",
    );
  });
});
