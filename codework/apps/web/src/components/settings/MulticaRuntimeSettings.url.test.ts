import { describe, expect, it } from "vite-plus/test";

import {
  isSafeMulticaRuntimeBaseUrl,
  isSafeMulticaTaskMcpEndpoint,
  safeMulticaRuntimeUrlLabel,
} from "./MulticaRuntimeSettings.url";

describe("MulticaRuntimeSettings URL", () => {
  it("base URL 禁止内嵌身份、查询参数和片段", () => {
    expect(isSafeMulticaRuntimeBaseUrl("https://multica.test/api")).toBe(true);
    expect(isSafeMulticaRuntimeBaseUrl("https://operator:secret@multica.test/api")).toBe(false);
    expect(isSafeMulticaRuntimeBaseUrl("https://multica.test/api?region=local")).toBe(false);
    expect(isSafeMulticaRuntimeBaseUrl("https://multica.test/api#token")).toBe(false);
  });

  it("MCP endpoint 允许普通查询，但拒绝 URL 身份和凭据查询", () => {
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp?version=1")).toBe(true);
    expect(isSafeMulticaTaskMcpEndpoint("https://operator:secret@codework.test/mcp")).toBe(false);
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp?access_token=secret")).toBe(
      false,
    );
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp?x-token=secret")).toBe(false);
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp?client_secret=secret")).toBe(
      false,
    );
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp?clientSecret=secret")).toBe(
      false,
    );
    expect(isSafeMulticaTaskMcpEndpoint("https://codework.test/mcp#secret")).toBe(false);
  });

  it("列表标签始终移除 URL 身份、查询参数和片段", () => {
    expect(
      safeMulticaRuntimeUrlLabel(
        "https://operator:secret@multica.test/api?access_token=query-secret#fragment-secret",
      ),
    ).toBe("https://multica.test/api");
  });
});
