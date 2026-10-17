import { describe, expect, it } from "vite-plus/test";

import {
  injectMcpAppCsp,
  mcpAppContentSecurityPolicy,
  mcpAppToolCallableByApp,
  readMcpAppReference,
  readMcpAppResourceUri,
} from "./mcpApp.ts";

describe("mcpAppToolCallableByApp", () => {
  it("defaults to callable: no _meta, no ui, or no visibility", () => {
    expect(mcpAppToolCallableByApp(undefined)).toBe(true);
    expect(mcpAppToolCallableByApp({})).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: {} })).toBe(true);
  });

  it("is callable when the visibility list names app", () => {
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["app"] } })).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model", "app"] } })).toBe(true);
  });

  it("rejects tools the server hid from apps", () => {
    expect(mcpAppToolCallableByApp({ ui: { visibility: ["model"] } })).toBe(false);
    expect(mcpAppToolCallableByApp({ ui: { visibility: [] } })).toBe(false);
  });

  it("ignores non-list visibility values rather than locking the tool", () => {
    expect(mcpAppToolCallableByApp({ ui: { visibility: "app" } })).toBe(true);
    expect(mcpAppToolCallableByApp({ ui: { visibility: null } })).toBe(true);
  });
});

describe("readMcpAppReference", () => {
  it("accepts a well-formed reference and keeps optional fields it can read", () => {
    expect(
      readMcpAppReference({
        attachmentId: "att-1",
        server: "weather",
        tool: "forecast",
        resourceUri: "ui://forecast/index.html",
        csp: { connectDomains: ["https://api.example.com", "javascript:alert(1)"] },
        permissions: { clipboardWrite: {} },
        prefersBorder: true,
      }),
    ).toEqual({
      attachmentId: "att-1",
      server: "weather",
      tool: "forecast",
      resourceUri: "ui://forecast/index.html",
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    });
  });

  it("drops references with missing fields or a non-ui resourceUri", () => {
    expect(readMcpAppReference("nope")).toBeUndefined();
    expect(
      readMcpAppReference({ attachmentId: "a", server: "s", tool: "t", resourceUri: "https://x" }),
    ).toBeUndefined();
    expect(
      readMcpAppReference({ attachmentId: "", server: "s", tool: "t", resourceUri: "ui://x" }),
    ).toBeUndefined();
  });
});

describe("readMcpAppResourceUri", () => {
  it("reads the nested and the deprecated flat key, ui:// only", () => {
    expect(readMcpAppResourceUri({ ui: { resourceUri: "ui://a" } })).toBe("ui://a");
    expect(readMcpAppResourceUri({ "ui/resourceUri": "ui://b" })).toBe("ui://b");
    expect(readMcpAppResourceUri({ ui: { resourceUri: "https://c" } })).toBeUndefined();
  });
});

describe("mcpAppContentSecurityPolicy", () => {
  it("locks undeclared categories and never adds the host origin", () => {
    expect(mcpAppContentSecurityPolicy(undefined)).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data: blob:",
        "font-src data:",
        "media-src data: blob:",
        "connect-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    );
    expect(mcpAppContentSecurityPolicy({ connectDomains: ["https://api.example.com"] })).toContain(
      "connect-src https://api.example.com",
    );
    expect(mcpAppContentSecurityPolicy({})).not.toContain("'self'");
  });

  it("injects the policy ahead of any script, keeping a leading doctype", () => {
    const injected = injectMcpAppCsp("<!doctype html><html><body><script>x</script>", {
      connectDomains: ["https://api.example.com"],
    });
    expect(injected.startsWith("<!doctype html><meta http-equiv=")).toBe(true);
    expect(injected.indexOf("Content-Security-Policy")).toBeLessThan(injected.indexOf("<script>"));
    const escaped = injectMcpAppCsp("", undefined);
    expect(escaped.startsWith("<!doctype html><meta")).toBe(true);
  });
});
