import { DEFAULT_SERVER_SETTINGS, type AgentHooksSettings } from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatHooksListing,
  hookMatcherMatches,
  matchingHooks,
  parseHookOutput,
} from "./AgentHooks.ts";

const settings = (hooks: AgentHooksSettings["hooks"]): AgentHooksSettings => ({
  enabled: true,
  hooks,
});

describe("AgentHooks", () => {
  it("matches empty matcher against every tool and supports globs", () => {
    expect(hookMatcherMatches("", "terminal.exec")).toBe(true);
    expect(hookMatcherMatches("terminal.exec", "terminal.exec")).toBe(true);
    expect(hookMatcherMatches("terminal.", "terminal.exec")).toBe(true);
    expect(hookMatcherMatches("workspace.*", "workspace.read_file")).toBe(true);
    expect(hookMatcherMatches("workspace.*", "terminal.exec")).toBe(false);
    // 前缀只在命名空间边界生效，避免 "git" 误伤 "github.x"。
    expect(hookMatcherMatches("git", "git.status")).toBe(true);
    expect(hookMatcherMatches("git", "github.x")).toBe(false);
    expect(hookMatcherMatches("mcp.demo", "mcp.demo.echo")).toBe(true);
    expect(hookMatcherMatches("mcp.demo", "mcp.demo2.echo")).toBe(false);
  });

  it("filters disabled, empty, and mismatched hooks", () => {
    const matched = matchingHooks(
      settings([
        {
          id: "a",
          enabled: true,
          event: "pre_tool_use",
          command: "echo a",
          matcher: "workspace.*",
        },
        {
          id: "b",
          enabled: false,
          event: "pre_tool_use",
          command: "echo b",
          matcher: "",
        },
        {
          id: "c",
          enabled: true,
          event: "pre_tool_use",
          command: "",
          matcher: "",
        },
        {
          id: "d",
          enabled: true,
          event: "stop",
          command: "echo d",
          matcher: "",
        },
      ]),
      "pre_tool_use",
      "workspace.read_file",
    );
    expect(matched.map((hook) => hook.id)).toEqual(["a"]);
  });

  it("parses deny JSON and non-zero exits", () => {
    expect(
      parseHookOutput({
        stdout: '{"decision":"deny","reason":"unsafe"}',
        stderr: "",
        code: 0,
        timedOut: false,
      }),
    ).toEqual({ deny: true, reason: "unsafe" });
    expect(
      parseHookOutput({
        stdout: "extra context",
        stderr: "",
        code: 0,
        timedOut: false,
      }),
    ).toEqual({ deny: false, extra: "extra context" });
    expect(
      parseHookOutput({
        stdout: "",
        stderr: "boom",
        code: 2,
        timedOut: false,
      }),
    ).toEqual({ deny: true, reason: "boom" });
  });

  it("points a disabled listing at Settings", () => {
    expect(formatHooksListing(DEFAULT_SERVER_SETTINGS.agentHooks)).toContain(
      "Settings → Integrations → Agent hooks",
    );
  });
});
