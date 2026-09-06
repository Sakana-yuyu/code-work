// @effect-diagnostics nodeBuiltinImport:off - 断言平台原生路径格式。
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";
import { isDefaultGrokHome, resolveGrokHome } from "./grokHome.ts";

describe("Grok 账号与代理目录", () => {
  it("默认原生账号保持原目录，代理和新增账号隔离且支持显式目录", () => {
    const input = {
      stateDir: NodePath.resolve("fixture-state"),
      instanceId: "grok",
      routed: false,
    };
    expect(isDefaultGrokHome(resolveGrokHome(input))).toBe(true);
    const routed = resolveGrokHome({ ...input, routed: true });
    expect(isDefaultGrokHome(routed)).toBe(false);
    expect(routed).toBe(NodePath.join(input.stateDir, "provider-homes", "grok", "instance-grok"));
    expect(resolveGrokHome({ ...input, instanceId: "grok-work" })).not.toBe(routed);
    expect(resolveGrokHome({ ...input, explicitHome: "fixture-account" })).toBe(
      NodePath.resolve("fixture-account"),
    );
    expect(resolveGrokHome({ ...input, instanceId: "../escape" })).toBe(
      NodePath.join(input.stateDir, "provider-homes", "grok", "instance-%2E%2E%2Fescape"),
    );
    expect(resolveGrokHome({ ...input, instanceId: ".." })).toBe(
      NodePath.join(input.stateDir, "provider-homes", "grok", "instance-%2E%2E"),
    );
  });
});
