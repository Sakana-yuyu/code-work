import { describe, expect, it } from "vite-plus/test";

import { parseControlServerUrl } from "./controlClient.ts";

describe("parseControlServerUrl", () => {
  it("从配对链接提取凭据，并生成不含敏感信息的 HTTP 与 WebSocket 地址", () => {
    expect(parseControlServerUrl("https://codework.example.test/pair#token=pair-secret")).toEqual({
      httpBaseUrl: "https://codework.example.test/",
      wsBaseUrl: "wss://codework.example.test/",
      pairingCredential: "pair-secret",
    });
  });

  it("接受 WebSocket 地址并保留部署 origin", () => {
    expect(parseControlServerUrl("ws://127.0.0.1:3773/ws")).toEqual({
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });

  it("拒绝非 HTTP 或 WebSocket 协议", () => {
    expect(() => parseControlServerUrl("file:///tmp/codework")).toThrow(
      "Control server URL must use HTTP or WebSocket.",
    );
  });

  it("解析失败时不回显可能包含的敏感凭据", () => {
    expect(() => parseControlServerUrl("not a url#token=pair-secret")).toThrow(
      "Control server URL is invalid.",
    );
    try {
      parseControlServerUrl("not a url#token=pair-secret");
    } catch (error) {
      expect(String(error)).not.toContain("pair-secret");
    }
  });
});
