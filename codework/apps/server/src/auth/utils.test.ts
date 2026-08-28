import { describe, expect, it } from "vite-plus/test";

import {
  deriveAuthClientMetadata,
  isRemoteReachableHost,
  readSessionCookie,
  resolveLegacySessionCookieNames,
  resolveSessionCookieName,
} from "./utils.ts";

describe("deriveAuthClientMetadata", () => {
  it("labels Electron user agents as Electron instead of Chrome", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) codework/0.0.15 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:127.0.0.1",
        },
      } as never,
    });

    expect(metadata).toMatchObject({
      browser: "Electron",
      deviceType: "desktop",
      ipAddress: "127.0.0.1",
      os: "macOS",
    });
  });

  it("applies client-presented display identity without replacing transport metadata", () => {
    const metadata = deriveAuthClientMetadata({
      request: {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/136.0.7103.93 Electron/36.3.2 Safari/537.36",
        },
        source: {
          remoteAddress: "::ffff:192.168.213.72",
        },
      } as never,
      presented: {
        label: "Code Work Mobile",
        deviceType: "mobile",
        os: "iOS",
      },
    });

    expect(metadata).toMatchObject({
      label: "Code Work Mobile",
      browser: "Electron",
      deviceType: "mobile",
      ipAddress: "192.168.213.72",
      os: "iOS",
    });
    expect(metadata.userAgent).toContain("Electron/36.3.2");
  });
});

describe("session cookie isolation", () => {
  it("isolates loopback web servers by port and server state", () => {
    const first = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-one",
      development: true,
    });
    const second = resolveSessionCookieName({
      mode: "web",
      port: 5775,
      host: "127.0.0.1",
      instanceKey: "/tmp/t3-agent-two",
      development: true,
    });

    expect(first).toMatch(/^codework_session_5775_[a-f0-9]{12}$/);
    expect(second).toMatch(/^codework_session_5775_[a-f0-9]{12}$/);
    expect(first).not.toBe(second);
  });

  it("keeps the hosted web cookie stable across server instances", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 8080,
        host: "0.0.0.0",
        instanceKey: "/srv/release-a",
        development: false,
      }),
    ).toBe("codework_session");
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 9090,
        host: "app.example.com",
        instanceKey: "/srv/release-b",
        development: false,
      }),
    ).toBe("codework_session");
  });

  it("retains desktop port scoping", () => {
    expect(
      resolveSessionCookieName({
        mode: "desktop",
        port: 3773,
        host: "127.0.0.1",
        instanceKey: "/tmp/desktop",
        development: true,
      }),
    ).toBe("codework_session_3773");
  });

  it("isolates development servers even when they bind a wildcard host", () => {
    expect(
      resolveSessionCookieName({
        mode: "web",
        port: 5775,
        host: "0.0.0.0",
        instanceKey: "/tmp/t3-wildcard-dev",
        development: true,
      }),
    ).toMatch(/^codework_session_5775_[a-f0-9]{12}$/);
  });

  it("classifies loopback aliases separately from remotely reachable hosts", () => {
    expect(isRemoteReachableHost(undefined)).toBe(false);
    expect(isRemoteReachableHost("localhost")).toBe(false);
    expect(isRemoteReachableHost("127.12.0.1")).toBe(false);
    expect(isRemoteReachableHost("[::1]")).toBe(false);
    expect(isRemoteReachableHost("0.0.0.0")).toBe(true);
    expect(isRemoteReachableHost("192.168.1.50")).toBe(true);
  });
});

describe("pre-rename session cookie compatibility", () => {
  const hostedScope = {
    mode: "web",
    port: 8080,
    host: "app.example.com",
    instanceKey: "/srv/release-a",
    development: false,
  } as const;

  const desktopScope = {
    mode: "desktop",
    port: 3773,
    host: "127.0.0.1",
    instanceKey: "/tmp/desktop",
    development: false,
  } as const;

  const loopbackScope = {
    mode: "web",
    port: 5775,
    host: "127.0.0.1",
    instanceKey: "/tmp/codework-agent-one",
    development: true,
  } as const;

  it("scopes retired names exactly as the build that wrote them did", () => {
    expect(resolveLegacySessionCookieNames(hostedScope)).toEqual(["t3_session"]);
    expect(resolveLegacySessionCookieNames(desktopScope)).toEqual(["t3_session_3773"]);

    const [legacyLoopback] = resolveLegacySessionCookieNames(loopbackScope);
    // Same instance hash as the current name: only the prefix moved.
    expect(legacyLoopback).toBe(
      resolveSessionCookieName(loopbackScope).replace(/^codework_session/, "t3_session"),
    );
  });

  it("accepts a pre-rename cookie and reports which name carried it", () => {
    expect(
      readSessionCookie({
        cookies: { t3_session: "legacy-token" },
        cookieName: "codework_session",
        legacyCookieNames: ["t3_session"],
      }),
    ).toEqual({ token: "legacy-token", legacyCookieName: "t3_session" });
  });

  it("prefers the current name while both cookies are still in the jar", () => {
    expect(
      readSessionCookie({
        cookies: { codework_session: "current-token", t3_session: "legacy-token" },
        cookieName: "codework_session",
        legacyCookieNames: ["t3_session"],
      }),
    ).toEqual({ token: "current-token", legacyCookieName: undefined });
  });

  it("ignores empty cookies so a cleared legacy name does not shadow the current one", () => {
    expect(
      readSessionCookie({
        cookies: { codework_session: "", t3_session: "" },
        cookieName: "codework_session",
        legacyCookieNames: ["t3_session"],
      }),
    ).toBeUndefined();
  });
});
