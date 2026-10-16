import { describe, expect, it } from "@effect/vitest";

import type { ByokChatMessage } from "../Layers/byokChatClient.ts";
import {
  applyCompactSummary,
  BYOK_COMPACT_SUMMARY_PREFIX,
  BYOK_SLASH_COMMANDS,
  formatMcpListing,
  formatSkillListing,
  isByokNativeSlashInput,
  parseByokSlashCommand,
  serializeHistoryForCompact,
  splitHistoryForCompact,
} from "./ByokSlashCommands.ts";

describe("parseByokSlashCommand", () => {
  it("recognizes compact, mcp, and skill with optional arguments", () => {
    expect(parseByokSlashCommand("/compact")).toEqual({ name: "compact", argument: "" });
    expect(parseByokSlashCommand("  /COMPACT keep the API plan  ")).toEqual({
      name: "compact",
      argument: "keep the API plan",
    });
    expect(parseByokSlashCommand("/mcp")).toEqual({ name: "mcp", argument: "" });
    expect(parseByokSlashCommand("/skill review-checklist")).toEqual({
      name: "skill",
      argument: "review-checklist",
    });
    expect(parseByokSlashCommand("/memory Prefer pnpm")).toEqual({
      name: "memory",
      argument: "Prefer pnpm",
    });
    expect(parseByokSlashCommand("/hooks")).toEqual({ name: "hooks", argument: "" });
    expect(parseByokSlashCommand("/search-engine tavily")).toEqual({
      name: "search-engine",
      argument: "tavily",
    });
    expect(parseByokSlashCommand("please /compact")).toBeUndefined();
    expect(parseByokSlashCommand("/help")).toBeUndefined();
  });

  it("marks native slash input so Goal wrapping can skip it", () => {
    expect(isByokNativeSlashInput("/compact")).toBe(true);
    expect(isByokNativeSlashInput("/skill foo")).toBe(true);
    expect(isByokNativeSlashInput("/memory")).toBe(true);
    expect(isByokNativeSlashInput("/hooks")).toBe(true);
    expect(isByokNativeSlashInput("/search-engine tavily")).toBe(true);
    expect(isByokNativeSlashInput("continue")).toBe(false);
    expect(isByokNativeSlashInput(undefined)).toBe(false);
  });
});

describe("BYOK_SLASH_COMMANDS", () => {
  it("advertises compact, mcp, skill, memory, hooks, and search-engine", () => {
    expect(BYOK_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "compact",
      "mcp",
      "skill",
      "memory",
      "hooks",
      "search-engine",
    ]);
  });
});

describe("splitHistoryForCompact", () => {
  const turn = (index: number): ByokChatMessage[] => [
    { role: "user", content: `user-${index}` },
    { role: "assistant", content: `assistant-${index}` },
  ];

  it("keeps the last two user turns and folds the rest", () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const { older, recent } = splitHistoryForCompact(history);
    expect(older.map((message) => message.content)).toEqual(["user-1", "assistant-1"]);
    expect(recent.map((message) => message.content)).toEqual([
      "user-2",
      "assistant-2",
      "user-3",
      "assistant-3",
    ]);
  });

  it("does not compact a short transcript", () => {
    const history = [...turn(1), ...turn(2)];
    const { older, recent } = splitHistoryForCompact(history);
    expect(older).toEqual([]);
    expect(recent).toEqual(history);
  });
});

describe("applyCompactSummary", () => {
  it("prefixes a summary turn ahead of recent messages", () => {
    const recent: ByokChatMessage[] = [{ role: "user", content: "continue" }];
    const next = applyCompactSummary(recent, "Shipped the login form.");
    expect(next[0]).toEqual({
      role: "user",
      content: `${BYOK_COMPACT_SUMMARY_PREFIX}\nShipped the login form.`,
    });
    expect(next.at(-1)).toEqual(recent[0]);
  });
});

describe("serializeHistoryForCompact", () => {
  it("renders roles and replaces images", () => {
    const text = serializeHistoryForCompact([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", mimeType: "image/png", dataBase64: "xx" },
        ],
      },
      { role: "assistant", content: "ok" },
    ]);
    expect(text).toContain("user: see[image]");
    expect(text).toContain("assistant: ok");
  });
});

describe("formatMcpListing", () => {
  it("groups tools by server and explains the empty state", () => {
    expect(formatMcpListing([])).toContain("Settings → Integrations");
    expect(
      formatMcpListing([
        {
          canonicalToolName: "mcp.demo.echo",
          serverId: "demo",
          toolName: "echo",
          description: "Echo text",
          operation: "read",
          status: "available",
          trusted: true,
        },
      ]),
    ).toContain("mcp.demo.echo");
  });
});

describe("formatSkillListing", () => {
  it("lists names and the SKILL.md locations", () => {
    expect(formatSkillListing([])).toContain("SKILL.md");
    expect(
      formatSkillListing([
        { name: "review-checklist", description: "Review steps", scope: "project" },
      ]),
    ).toContain("review-checklist");
  });
});
