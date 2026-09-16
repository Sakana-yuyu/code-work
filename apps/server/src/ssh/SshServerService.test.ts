import { describe, expect, it } from "vite-plus/test";

import { normalizeRemotePath } from "./SshServerService.ts";

describe("normalizeRemotePath", () => {
  it("keeps the root and clean absolute paths", () => {
    expect(normalizeRemotePath("/")).toBe("/");
    expect(normalizeRemotePath("/var/log")).toBe("/var/log");
  });

  it("collapses duplicate slashes, dot segments and parent traversal", () => {
    expect(normalizeRemotePath("//var///log/")).toBe("/var/log");
    expect(normalizeRemotePath("/a/./b/../c")).toBe("/a/c");
    expect(normalizeRemotePath("/a/b/../../..")).toBe("/");
  });

  it("rejects relative paths and NUL bytes", () => {
    expect(normalizeRemotePath("relative/path")).toBeNull();
    expect(normalizeRemotePath("")).toBeNull();
    expect(normalizeRemotePath("/a\0b")).toBeNull();
  });
});
