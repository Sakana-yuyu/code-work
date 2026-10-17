import { describe, expect, it } from "@effect/vitest";

import {
  appendMemoryNote,
  clampMemoryText,
  formatMemoryGuidance,
  formatMemoryListing,
  MAX_MEMORY_CHARS,
  recallMemory,
} from "./AgentMemory.ts";

describe("AgentMemory", () => {
  it("appends notes and replaces on request", () => {
    expect(appendMemoryNote("", " first ")).toBe("first");
    expect(appendMemoryNote("keep", "add")).toBe("keep\n\nadd");
    expect(appendMemoryNote("keep", "next", "replace")).toBe("next");
  });

  it("clamps oversized notes", () => {
    const oversized = "a".repeat(MAX_MEMORY_CHARS + 20);
    const clamped = clampMemoryText(oversized);
    expect(clamped.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS + 2);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("recalls matching blocks or returns the full haystack", () => {
    const notes = "Prefer pnpm.\n\nNever kill by pattern.\n\nUse pairing URLs.";
    expect(recallMemory(notes, "pairing")).toBe("Use pairing URLs.");
    expect(recallMemory(notes, "missing")).toBe(notes);
    expect(recallMemory("", "x")).toBe("");
  });

  it("omits empty scopes from prompt guidance", () => {
    expect(formatMemoryGuidance({ userNotes: "", projectNotes: "" })).toContain("memory.save");
    const filled = formatMemoryGuidance({
      userNotes: "Prefer pnpm.",
      projectNotes: "This repo uses vp.",
    });
    expect(filled).toContain('scope="user"');
    expect(filled).toContain("Prefer pnpm.");
    expect(filled).toContain("This repo uses vp.");
  });

  it("lists a disabled store from Settings copy", () => {
    expect(formatMemoryListing({ enabled: false, userNotes: "x", projectNotes: "" })).toContain(
      "Settings → Integrations → Agent memory",
    );
  });
});
