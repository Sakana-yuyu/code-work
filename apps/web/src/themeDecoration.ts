import {
  THEME_REGIONS,
  type ThemeDecoration,
  type ThemeDecorations,
  type ThemeMedia,
  type ThemeRegion,
  type ThemeSurface,
} from "@codework/shared/themePalettes";
import { t } from "./i18n/runtime";

export { THEME_REGIONS };
export type { ThemeDecoration, ThemeDecorations, ThemeMedia, ThemeRegion, ThemeSurface };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const color = (value: unknown): value is string =>
  typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
export const isThemeAssetId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

export function normalizeThemeImageUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      value.length > 4096
    ) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error(t("themeMedia.invalidUrl"));
  }
}

/** 老主题省略此字段；外部导入严格校验，禁止样式字符串、脚本和路径注入。 */
export function parseThemeDecorations(value: unknown): ThemeDecorations | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error(t("themeMedia.invalidSettings"));
  if (!record(value)) throw invalid();
  const result: Partial<Record<"light" | "dark", ThemeDecoration>> = {};
  for (const [mode, raw] of Object.entries(value)) {
    if ((mode !== "light" && mode !== "dark") || !record(raw)) throw invalid();
    const regions: Partial<Record<ThemeRegion, ThemeSurface>> = {};
    for (const [region, surface] of Object.entries(raw)) {
      if (!THEME_REGIONS.includes(region as ThemeRegion) || !record(surface)) throw invalid();
      const next: { -readonly [K in keyof ThemeSurface]: ThemeSurface[K] } = {};
      for (const key of ["color", "gradient", "border"] as const) {
        if (surface[key] === undefined) continue;
        if (!color(surface[key])) throw invalid();
        next[key] = surface[key];
      }
      for (const [key, max] of [
        ["opacity", 100],
        ["blur", 20],
        ["radius", 32],
        ["x", 100],
        ["y", 100],
        ["dim", 100],
      ] as const) {
        const number = surface[key];
        if (number === undefined) continue;
        if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > max)
          throw invalid();
        next[key] = number;
      }
      if (surface.shadow !== undefined) {
        if (surface.shadow !== "none" && surface.shadow !== "soft" && surface.shadow !== "medium")
          throw invalid();
        next.shadow = surface.shadow;
      }
      if (surface.fit !== undefined) {
        if (surface.fit !== "cover" && surface.fit !== "contain") throw invalid();
        next.fit = surface.fit;
      }
      if (surface.media !== undefined) {
        const media = surface.media;
        if (
          !record(media) ||
          typeof media.value !== "string" ||
          (media.kind !== "image" && media.kind !== "video")
        )
          throw invalid();
        if (
          !["global", "sidebar", "content"].includes(region) ||
          (media.kind === "video" && region !== "global")
        )
          throw invalid();
        if (media.source !== "url" && media.source !== "asset") throw invalid();
        if (media.source === "url" && media.kind !== "image") throw invalid();
        if (media.source === "asset" && !isThemeAssetId(media.value)) throw invalid();
        next.media = {
          kind: media.kind,
          source: media.source,
          value: media.source === "url" ? normalizeThemeImageUrl(media.value) : media.value,
          ...(typeof media.name === "string" ? { name: media.name.slice(0, 160) } : {}),
        };
      }
      regions[region as ThemeRegion] = next;
    }
    result[mode] = regions;
  }
  return result;
}

const listeners = new Set<() => void>();
const EMPTY: ThemeDecoration = {};
let current: ThemeDecoration = EMPTY;
export const getThemeDecoration = () => current;
export const getEmptyThemeDecoration = () => EMPTY;
export function subscribeToThemeDecoration(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function applyThemeDecoration(value: ThemeDecoration | undefined) {
  if (current === (value ?? EMPTY)) return;
  current = value ?? EMPTY;
  for (const listener of listeners) listener();
}

export function themeAssetIds(decorations?: ThemeDecorations): string[] {
  return [
    ...new Set(
      Object.values(decorations ?? {}).flatMap((regions) =>
        Object.values(regions).flatMap((surface) =>
          surface.media?.source === "asset" ? [surface.media.value] : [],
        ),
      ),
    ),
  ];
}
