import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@codework/contracts";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" as const };

describe("codex developer instructions 子代理模式", () => {
  it("默认不含 subagent_mode 块", () => {
    const instructions = buildCodexDeveloperInstructions("default", runtime);
    expect(instructions).not.toContain("<subagent_mode>");
  });

  it("开关打开时追加原生子代理指引块", () => {
    const instructions = buildCodexDeveloperInstructions("default", runtime, true, false, true);
    expect(instructions).toContain("<subagent_mode>");
    expect(instructions).toContain("子代理模式已开启");
    expect(instructions.endsWith("</subagent_mode>")).toBe(true);
  });

  it("CodexSettings 解码保留 delegation.enabled,未知驱动实例可共享同一开关", () => {
    const decoded = Schema.decodeSync(CodexSettings)({
      homePath: "~/.codex",
      delegation: { enabled: true },
    });
    expect(decoded.delegation.enabled).toBe(true);
    expect(Schema.decodeSync(CodexSettings)({}).delegation.enabled).toBe(false);
  });
});
