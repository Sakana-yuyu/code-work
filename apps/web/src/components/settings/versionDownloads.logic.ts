/**
 * 版本与下载页的数据层：把 GitHub Releases API 的响应对齐成两条发布线
 * （正式 / 测试）的版本列表。纯函数为主，fetch 与缓存通过参数注入，
 * 便于测试。
 */

export type DesktopReleaseChannel = "stable" | "battle";

export type DesktopInstallerKind = "windows" | "mac-arm64" | "mac-x64" | "linux";

export interface DesktopReleaseInstaller {
  readonly kind: DesktopInstallerKind;
  readonly fileName: string;
  readonly url: string;
  readonly sizeBytes: number;
}

export interface DesktopRelease {
  readonly version: string;
  readonly channel: DesktopReleaseChannel;
  readonly publishedAt: string;
  readonly notes: string;
  readonly releaseUrl: string;
  readonly installers: ReadonlyArray<DesktopReleaseInstaller>;
}

/** 下载按钮的展示顺序。 */
const INSTALLER_KIND_ORDER: Readonly<Record<DesktopInstallerKind, number>> = {
  windows: 0,
  "mac-arm64": 1,
  "mac-x64": 2,
  linux: 3,
};

const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BATTLE_VERSION_PATTERN = /^\d+\.\d+\.\d+-battle$/;

const INSTALLER_FILE_PATTERNS: ReadonlyArray<readonly [RegExp, DesktopInstallerKind]> = [
  [/x64\.exe$/i, "windows"],
  [/arm64\.dmg$/i, "mac-arm64"],
  [/x64\.dmg$/i, "mac-x64"],
  [/x86_64\.AppImage$/i, "linux"],
];

/**
 * 按版本号判定发布线。标签是更新通道的唯一事实来源（battle 版本恒定
 * 跟随 battle 线），所以不看 GitHub 的 prerelease 标记。nightly 与其他
 * 预发布线不经此页分发，直接忽略。
 */
export function classifyReleaseChannel(version: string): DesktopReleaseChannel | null {
  if (BATTLE_VERSION_PATTERN.test(version)) return "battle";
  if (STABLE_VERSION_PATTERN.test(version)) return "stable";
  return null;
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly battle: boolean;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-battle)?$/.exec(version);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    battle: match[4] !== undefined,
  };
}

/** 语义化版本比较；同版本号的 battle 预发布低于正式版。返回负数表示 left 更小。 */
export function compareReleaseVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (parsedLeft === null || parsedRight === null) {
    return left.localeCompare(right);
  }
  if (parsedLeft.major !== parsedRight.major) return parsedLeft.major - parsedRight.major;
  if (parsedLeft.minor !== parsedRight.minor) return parsedLeft.minor - parsedRight.minor;
  if (parsedLeft.patch !== parsedRight.patch) return parsedLeft.patch - parsedRight.patch;
  if (parsedLeft.battle === parsedRight.battle) return 0;
  return parsedLeft.battle ? -1 : 1;
}

export function mapInstallerAssets(
  assets: ReadonlyArray<{
    readonly name?: unknown;
    readonly browser_download_url?: unknown;
    readonly size?: unknown;
  }>,
): Array<DesktopReleaseInstaller> {
  const installers: Array<DesktopReleaseInstaller> = [];
  for (const asset of assets) {
    const name = typeof asset.name === "string" ? asset.name : "";
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (name === "" || url === "") continue;
    const kind = INSTALLER_FILE_PATTERNS.find(([pattern]) => pattern.test(name))?.[1];
    if (kind === undefined) continue;
    installers.push({
      kind,
      fileName: name,
      url,
      sizeBytes: typeof asset.size === "number" ? asset.size : 0,
    });
  }
  return installers.sort(
    (left, right) => INSTALLER_KIND_ORDER[left.kind] - INSTALLER_KIND_ORDER[right.kind],
  );
}

/** 把 GitHub Releases API 的响应裁剪成两条发布线的版本列表（新版本在前）。 */
export function parseDesktopReleases(input: unknown): Array<DesktopRelease> {
  if (!Array.isArray(input)) return [];
  const releases: Array<DesktopRelease> = [];
  for (const entry of input) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as {
      draft?: unknown;
      tag_name?: unknown;
      published_at?: unknown;
      body?: unknown;
      html_url?: unknown;
      assets?: unknown;
    };
    if (raw.draft === true) continue;
    const tagName = typeof raw.tag_name === "string" ? raw.tag_name : "";
    const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
    const channel = classifyReleaseChannel(version);
    if (channel === null) continue;
    const installers = mapInstallerAssets(
      Array.isArray(raw.assets)
        ? (raw.assets as ReadonlyArray<Record<string, unknown>>).map((asset) => ({
            name: asset["name"],
            browser_download_url: asset["browser_download_url"],
            size: asset["size"],
          }))
        : [],
    );
    if (installers.length === 0) continue;
    releases.push({
      version,
      channel,
      publishedAt: typeof raw.published_at === "string" ? raw.published_at : "",
      notes: typeof raw.body === "string" ? raw.body.trim() : "",
      releaseUrl: typeof raw.html_url === "string" ? raw.html_url : "",
      installers,
    });
  }
  return releases.sort((left, right) => compareReleaseVersions(right.version, left.version));
}

export type HostPlatform = "windows" | "mac" | "linux";

/** 从浏览器环境推断宿主平台；识别不了返回 null（页面退化为不高亮）。 */
export function detectHostPlatform(input: {
  readonly platform: string;
  readonly userAgent: string;
}): HostPlatform | null {
  const platform = input.platform.toLowerCase();
  if (platform.startsWith("win")) return "windows";
  if (platform.startsWith("mac")) return "mac";
  if (platform.startsWith("linux")) return "linux";

  const userAgent = input.userAgent;
  if (/windows/i.test(userAgent)) return "windows";
  if (/mac os/i.test(userAgent)) return "mac";
  if (/linux/i.test(userAgent)) return "linux";
  return null;
}

/**
 * 判断某个安装包是否适合当前机器。mac 的架构以桌面桥上报的 hostArch
 * 为准（浏览器无法区分 Apple 芯片与 Intel），拿不到时默认 Apple 芯片。
 */
export function isInstallerForHost(
  installer: DesktopReleaseInstaller,
  hostPlatform: HostPlatform | null,
  hostArch: string | null,
): boolean {
  if (hostPlatform === null) return false;
  switch (installer.kind) {
    case "windows":
      return hostPlatform === "windows";
    case "linux":
      return hostPlatform === "linux";
    case "mac-arm64":
      return hostPlatform === "mac" && hostArch !== "x64";
    case "mac-x64":
      return hostPlatform === "mac" && hostArch === "x64";
  }
}

export function formatInstallerSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "";
  const megabytes = sizeBytes / (1024 * 1024);
  return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`;
}

export const DESKTOP_RELEASES_REPO = "Sakana-yuyu/code-work";
export const DESKTOP_RELEASES_API_URL = `https://api.github.com/repos/${DESKTOP_RELEASES_REPO}/releases?per_page=100`;

const RELEASES_CACHE_KEY = "codework-desktop-releases-v1";
const RELEASES_CACHE_TTL_MS = 5 * 60 * 1000;

interface ReleasesCacheEntry {
  readonly fetchedAt: number;
  /** GitHub API 的原始响应；读取时重新解析，避免缓存形状与解析器脱节。 */
  readonly raw: unknown;
}

function readCachedReleases(nowMs: number, storage: Storage | null): ReleasesCacheEntry | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(RELEASES_CACHE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const entry = parsed as { fetchedAt?: unknown; raw?: unknown };
    if (typeof entry.fetchedAt !== "number" || !Array.isArray(entry.raw)) return null;
    if (!Number.isFinite(entry.fetchedAt) || entry.fetchedAt > nowMs) return null;
    return { fetchedAt: entry.fetchedAt, raw: entry.raw };
  } catch {
    return null;
  }
}

function writeCachedReleases(entry: ReleasesCacheEntry, storage: Storage | null): void {
  if (storage === null) return;
  try {
    storage.setItem(RELEASES_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // 隐私模式等场景下写入失败无所谓，缓存只是加速。
  }
}

export interface FetchDesktopReleasesOptions {
  readonly fetchImpl?: typeof fetch;
  readonly storage?: Storage | null;
  readonly nowMs?: number;
}

/**
 * 拉取两条发布线的版本列表。带 sessionStorage 缓存（5 分钟），拉取失败时
 * 回退到过期缓存，避免 GitHub API 限流时页面直接报废。
 */
export async function fetchDesktopReleases(
  options: FetchDesktopReleasesOptions = {},
): Promise<Array<DesktopRelease>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now();
  const storage =
    options.storage === undefined
      ? typeof sessionStorage === "undefined"
        ? null
        : sessionStorage
      : options.storage;

  const cached = readCachedReleases(nowMs, storage);
  if (cached !== null && nowMs - cached.fetchedAt < RELEASES_CACHE_TTL_MS) {
    return parseDesktopReleases(cached.raw);
  }

  try {
    const response = await fetchImpl(DESKTOP_RELEASES_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}`);
    }
    const raw: unknown = await response.json();
    const releases = parseDesktopReleases(raw);
    writeCachedReleases({ fetchedAt: nowMs, raw }, storage);
    return releases;
  } catch (error) {
    if (cached !== null) return parseDesktopReleases(cached.raw);
    throw error;
  }
}

/** 丢弃缓存，强制下次重新拉取。 */
export function invalidateDesktopReleasesCache(storage?: Storage | null): void {
  const resolved =
    storage === undefined
      ? typeof sessionStorage === "undefined"
        ? null
        : sessionStorage
      : storage;
  if (resolved === null) return;
  try {
    resolved.removeItem(RELEASES_CACHE_KEY);
  } catch {
    // 同上，缓存清理失败可以忽略。
  }
}
