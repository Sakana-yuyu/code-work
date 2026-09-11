import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyReleaseChannel,
  compareReleaseVersions,
  detectHostPlatform,
  fetchDesktopReleases,
  formatInstallerSize,
  invalidateDesktopReleasesCache,
  isInstallerForHost,
  mapInstallerAssets,
  parseDesktopReleases,
  type DesktopReleaseInstaller,
} from "./versionDownloads.logic";

/** 与 v1.0.3 / v1.0.1-battle 真实资产同构的样本。 */
function sampleAssets(version: string) {
  return [
    {
      name: "builder-debug.yml",
      browser_download_url: `https://x/${version}/builder-debug.yml`,
      size: 1,
    },
    {
      name: `Code-Work-${version}-x86_64.AppImage`,
      browser_download_url: `https://x/${version}/appimage`,
      size: 120 * 1024 * 1024,
    },
    {
      name: `Code-Work-${version}-x64.dmg`,
      browser_download_url: `https://x/${version}/dmg-x64`,
      size: 90 * 1024 * 1024,
    },
    {
      name: `Code-Work-${version}-x64.dmg.blockmap`,
      browser_download_url: `https://x/${version}/dmg-x64.blockmap`,
      size: 2,
    },
    {
      name: `Code-Work-${version}-arm64.dmg`,
      browser_download_url: `https://x/${version}/dmg-arm64`,
      size: 95 * 1024 * 1024,
    },
    {
      name: `Code-Work-${version}-x64.exe`,
      browser_download_url: `https://x/${version}/exe`,
      size: 80 * 1024 * 1024,
    },
    {
      name: `Code-Work-${version}-x64.exe.blockmap`,
      browser_download_url: `https://x/${version}/exe.blockmap`,
      size: 3,
    },
    {
      name: `Code-Work-${version}-x64.zip`,
      browser_download_url: `https://x/${version}/zip`,
      size: 4,
    },
    { name: "latest.yml", browser_download_url: `https://x/${version}/latest.yml`, size: 5 },
  ];
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

const sampleApiPayload = [
  {
    draft: false,
    prerelease: false,
    tag_name: "v1.0.3",
    published_at: "2026-09-11T02:24:24Z",
    body: "**Full Changelog**: https://github.com/Sakana-yuyu/code-work/compare/v1.0.1-battle...v1.0.3",
    html_url: "https://github.com/Sakana-yuyu/code-work/releases/tag/v1.0.3",
    assets: sampleAssets("1.0.3"),
  },
  {
    draft: false,
    prerelease: true,
    tag_name: "v1.0.1-battle",
    published_at: "2026-09-09T18:10:42Z",
    body: "  \n测试线内容\n",
    html_url: "https://github.com/Sakana-yuyu/code-work/releases/tag/v1.0.1-battle",
    assets: sampleAssets("1.0.1-battle"),
  },
  {
    draft: true,
    prerelease: false,
    tag_name: "v1.1.0",
    published_at: null,
    body: null,
    html_url: "https://github.com/Sakana-yuyu/code-work/releases/tag/v1.1.0",
    assets: sampleAssets("1.1.0"),
  },
  {
    draft: false,
    prerelease: false,
    tag_name: "v1.0.0-nightly.20260911.1",
    published_at: "2026-09-11T00:00:00Z",
    body: "nightly",
    html_url: "https://github.com/Sakana-yuyu/code-work/releases/tag/v1.0.0-nightly.20260911.1",
    assets: sampleAssets("1.0.0-nightly.20260911.1"),
  },
  {
    draft: false,
    prerelease: false,
    tag_name: "v0.0.47",
    published_at: "2026-09-08T06:04:06Z",
    body: "旧版本",
    html_url: "https://github.com/Sakana-yuyu/code-work/releases/tag/v0.0.47",
    assets: [{ name: "latest.yml", browser_download_url: "https://x/0.0.47/latest.yml", size: 5 }],
  },
];

describe("classifyReleaseChannel", () => {
  it("classifies stable and battle tags and drops other lines", () => {
    expect(classifyReleaseChannel("1.0.4")).toBe("stable");
    expect(classifyReleaseChannel("0.0.47")).toBe("stable");
    expect(classifyReleaseChannel("1.0.5-battle")).toBe("battle");
    expect(classifyReleaseChannel("1.0.0-nightly.20260911.1")).toBeNull();
    expect(classifyReleaseChannel("not-a-version")).toBeNull();
  });
});

describe("compareReleaseVersions", () => {
  it("orders versions with battle prereleases below their stable base", () => {
    expect(compareReleaseVersions("1.0.5-battle", "1.0.4")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.4", "1.0.4-battle")).toBeGreaterThan(0);
    expect(compareReleaseVersions("1.0.1-battle", "1.0.4-battle")).toBeLessThan(0);
    expect(compareReleaseVersions("1.0.4", "1.0.4")).toBe(0);
    expect(compareReleaseVersions("1.1.0", "1.0.9")).toBeGreaterThan(0);
  });
});

describe("mapInstallerAssets", () => {
  it("keeps only installers and orders them by platform", () => {
    const installers = mapInstallerAssets(sampleAssets("1.0.3"));
    expect(installers.map((installer) => installer.kind)).toEqual([
      "windows",
      "mac-arm64",
      "mac-x64",
      "linux",
    ]);
    expect(installers[0]?.fileName).toBe("Code-Work-1.0.3-x64.exe");
    expect(installers[0]?.url).toBe("https://x/1.0.3/exe");
    expect(installers[0]?.sizeBytes).toBe(80 * 1024 * 1024);
  });
});

describe("parseDesktopReleases", () => {
  it("drops drafts, nightlies and installer-less releases, then sorts newest first", () => {
    const releases = parseDesktopReleases(sampleApiPayload);
    expect(releases.map((release) => release.version)).toEqual(["1.0.3", "1.0.1-battle"]);
    expect(releases[0]?.channel).toBe("stable");
    expect(releases[1]?.channel).toBe("battle");
    expect(releases[1]?.notes).toBe("测试线内容");
    expect(releases[0]?.releaseUrl).toBe(
      "https://github.com/Sakana-yuyu/code-work/releases/tag/v1.0.3",
    );
  });

  it("tolerates non-array and malformed input", () => {
    expect(parseDesktopReleases(null)).toEqual([]);
    expect(parseDesktopReleases("nope")).toEqual([]);
    expect(parseDesktopReleases([{ tag_name: 123 }, { assets: [] }, null])).toEqual([]);
  });
});

describe("detectHostPlatform", () => {
  it("detects from navigator.platform with a userAgent fallback", () => {
    expect(detectHostPlatform({ platform: "Win32", userAgent: "" })).toBe("windows");
    expect(detectHostPlatform({ platform: "MacIntel", userAgent: "" })).toBe("mac");
    expect(detectHostPlatform({ platform: "Linux x86_64", userAgent: "" })).toBe("linux");
    expect(detectHostPlatform({ platform: "", userAgent: "Mozilla (Windows NT 10.0)" })).toBe(
      "windows",
    );
    expect(
      detectHostPlatform({ platform: "", userAgent: "Mozilla (Macintosh; Intel Mac OS X)" }),
    ).toBe("mac");
    expect(detectHostPlatform({ platform: "", userAgent: "Mozilla (X11; Linux x86_64)" })).toBe(
      "linux",
    );
    expect(detectHostPlatform({ platform: "", userAgent: "curl/8.0" })).toBeNull();
  });
});

describe("isInstallerForHost", () => {
  const installer = (kind: DesktopReleaseInstaller["kind"]): DesktopReleaseInstaller => ({
    kind,
    fileName: kind,
    url: `https://x/${kind}`,
    sizeBytes: 1,
  });

  it("matches the host platform and refines mac by reported arch", () => {
    expect(isInstallerForHost(installer("windows"), "windows", null)).toBe(true);
    expect(isInstallerForHost(installer("mac-arm64"), "windows", null)).toBe(false);
    expect(isInstallerForHost(installer("mac-arm64"), "mac", null)).toBe(true);
    expect(isInstallerForHost(installer("mac-x64"), "mac", null)).toBe(false);
    expect(isInstallerForHost(installer("mac-arm64"), "mac", "x64")).toBe(false);
    expect(isInstallerForHost(installer("mac-x64"), "mac", "x64")).toBe(true);
    expect(isInstallerForHost(installer("linux"), "linux", null)).toBe(true);
    expect(isInstallerForHost(installer("linux"), null, null)).toBe(false);
  });
});

describe("formatInstallerSize", () => {
  it("formats sizes and hides unknown ones", () => {
    expect(formatInstallerSize(0)).toBe("");
    expect(formatInstallerSize(95 * 1024 * 1024)).toBe("95.0 MB");
    expect(formatInstallerSize(150 * 1024 * 1024)).toBe("150 MB");
  });
});

describe("fetchDesktopReleases", () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it("caches per session and skips refetching inside the TTL", async () => {
    const storage = new MemoryStorage();
    const fetchImpl = vi.fn(async () => okResponse(sampleApiPayload));

    const first = await fetchDesktopReleases({ fetchImpl, storage, nowMs: 1_000 });
    const second = await fetchDesktopReleases({ fetchImpl, storage, nowMs: 60_000 });

    expect(first.map((release) => release.version)).toEqual(["1.0.3", "1.0.1-battle"]);
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await fetchDesktopReleases({ fetchImpl, storage, nowMs: 6 * 60 * 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("falls back to the stale cache when a refetch fails, and invalidation forces a refetch", async () => {
    const storage = new MemoryStorage();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse(sampleApiPayload))
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(okResponse(sampleApiPayload));

    await fetchDesktopReleases({ fetchImpl, storage, nowMs: 1_000 });
    const stale = await fetchDesktopReleases({ fetchImpl, storage, nowMs: 10 * 60 * 1000 });
    expect(stale.map((release) => release.version)).toEqual(["1.0.3", "1.0.1-battle"]);

    invalidateDesktopReleasesCache(storage);
    await expect(
      fetchDesktopReleases({ fetchImpl, storage, nowMs: 10 * 60 * 1000 + 1 }),
    ).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws when there is no cache and the fetch fails", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 }) as Response);
    await expect(
      fetchDesktopReleases({ fetchImpl, storage: new MemoryStorage(), nowMs: 1_000 }),
    ).rejects.toThrow("GitHub API 403");
  });
});
