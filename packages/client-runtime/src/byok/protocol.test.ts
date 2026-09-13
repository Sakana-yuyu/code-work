import { describe, expect, it } from "vite-plus/test";

import type { ByokModelAdapter } from "@codework/contracts";

import { diagnoseByokProtocolMismatches, inferByokProtocol } from "./protocol.ts";

const adapter = (overrides: Partial<ByokModelAdapter>): ByokModelAdapter => ({
  id: "adapter-1",
  displayName: "Model",
  protocol: "openai",
  baseURL: "https://relay.example.com/v1",
  apiKey: "sk-test",
  balanceAccessToken: "",
  customHeaders: "",
  modelId: "gpt-5.4",
  contextWindowTokens: 128000,
  ...overrides,
});

describe("inferByokProtocol", () => {
  it("maps claude models to anthropic", () => {
    expect(inferByokProtocol("claude-sonnet-4-6", "openai")).toBe("anthropic");
    expect(inferByokProtocol("  Claude-Opus-4.8 ", "openai")).toBe("anthropic");
  });

  it("maps gemini models to gemini", () => {
    expect(inferByokProtocol("gemini-3.5-flash", "openai")).toBe("gemini");
  });

  it("keeps the channel protocol for everything else", () => {
    expect(inferByokProtocol("gpt-5.4", "openai")).toBe("openai");
    expect(inferByokProtocol("deepseek-v4-pro", "openai")).toBe("openai");
    expect(inferByokProtocol("glm-5.2", "anthropic")).toBe("anthropic");
  });
});

describe("diagnoseByokProtocolMismatches", () => {
  it("flags claude/gemini models configured as openai", () => {
    const issues = diagnoseByokProtocolMismatches([
      adapter({ id: "a", modelId: "claude-sonnet-4-6" }),
      adapter({ id: "b", modelId: "gemini-3.5-flash" }),
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ adapterId: "a", current: "openai", suggested: "anthropic" });
    expect(issues[1]).toMatchObject({ adapterId: "b", suggested: "gemini" });
  });

  it("ignores matching protocols and empty model ids", () => {
    expect(
      diagnoseByokProtocolMismatches([
        adapter({ modelId: "claude-sonnet-4-6", protocol: "anthropic" }),
        adapter({ modelId: "" }),
        adapter({ modelId: "kimi-k3" }),
      ]),
    ).toEqual([]);
  });
});
