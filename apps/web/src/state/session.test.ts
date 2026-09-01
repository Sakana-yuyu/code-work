import { describe, expect, it, vi } from "vite-plus/test";

describe("web session module initialization", () => {
  it("creates session atoms without importing the composer UI dependency chain", async () => {
    vi.resetModules();

    const { environmentSession } = await import("./session");

    expect(environmentSession).toBeDefined();
  });
});
