import { afterEach, describe, expect, it } from "vite-plus/test";
import JSZip from "jszip";
import {
  applyThemeDecoration,
  getThemeDecoration,
  normalizeThemeImageUrl,
  parseThemeDecorations,
  themeAssetIds,
} from "./themeDecoration";
import { getDefaultThemeColors, parseThemeFile, serializeThemeFile } from "./themePalette";
import {
  backgroundFileKind,
  MAX_BACKGROUND_IMAGE_BYTES,
  MAX_BACKGROUND_VIDEO_BYTES,
} from "./themeMedia";
import { mapThemeMedia, readThemeZipEntry } from "./themeMediaArchive";
import { themeSurfaceVariables } from "./components/settings/ThemeBackground";
import { setCurrentLanguage } from "./i18n/runtime";

setCurrentLanguage("en");
afterEach(() => applyThemeDecoration(undefined));
const id = "00000000-0000-4000-8000-000000000001";
const definition = {
  version: 1,
  name: "Wallpaper test",
  appearance: "light",
  colors: { canvas: "#ffffff" },
  decorations: {
    light: {
      global: { media: { source: "asset", kind: "video", value: id, name: "my.mp4" }, dim: 45 },
      sidebar: { color: "#f0f0f0", opacity: 82 },
    },
  },
};

describe("主题背景边界与持久化", () => {
  it("旧主题保持原格式，新配置往返保存且不包含音量或自动出声设置", () => {
    const old = parseThemeFile({
      version: 1,
      name: "Old",
      appearance: "light",
      colors: { canvas: "#fff" },
    });
    expect(old.decorations).toBeUndefined();
    const theme = parseThemeFile(definition);
    expect(parseThemeFile(JSON.parse(serializeThemeFile(theme)))).toEqual(theme);
    expect(themeAssetIds(theme.decorations)).toEqual([id]);
    const withSound = parseThemeDecorations({ light: { global: { muted: false, volume: 100 } } });
    expect(withSound).toEqual({ light: { global: {} } });
  });
  it("仅设置导出移除本机引用，但保留样式及外部图片", () => {
    const theme = parseThemeFile(definition);
    const stripped = mapThemeMedia(theme, (media) => (media.source === "url" ? media : undefined));
    expect(themeAssetIds(stripped.decorations)).toEqual([]);
    expect(stripped.decorations?.light?.global?.dim).toBe(45);
    expect(themeAssetIds(theme.decorations)).toEqual([id]);
  });
  it.each([
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "file:///C:/photo.jpg",
    "https://user:pass@example.com/x",
    "blob:https://host/id",
    "not a URL",
  ])("拒绝危险或不可移植地址 %s", (url) => {
    expect(() => normalizeThemeImageUrl(url)).toThrow();
  });
  it("保留有效外链的参数，不在配置阶段发起请求", () => {
    expect(normalizeThemeImageUrl(" https://example.com/image.png?size=2 ")).toBe(
      "https://example.com/image.png?size=2",
    );
  });
  it.each([
    { light: { sidebar: { media: { kind: "video", source: "asset", value: id } } } },
    {
      light: {
        global: { media: { kind: "video", source: "url", value: "https://example.com/v.mp4" } },
      },
    },
    { light: { global: { media: { kind: "image", source: "asset", value: "../../private" } } } },
    {
      light: {
        composer: { media: { kind: "image", source: "url", value: "https://example.com/i" } },
      },
    },
    { light: { sidebar: { opacity: 101 } } },
    { light: { global: { blur: -1 } } },
    { light: { global: { radius: NaN } } },
    { light: { global: { color: "url(https://host)" } } },
    { light: { global: { color: "#fff; display:none" } } },
    { light: { unknown: {} } },
  ])("严格校验外部主题背景 %j", (value) => expect(() => parseThemeDecorations(value)).toThrow());
  it("预览退出恢复空背景，不会保留上个主题", () => {
    applyThemeDecoration(parseThemeFile(definition).decorations?.light);
    expect(getThemeDecoration().global?.media?.kind).toBe("video");
    applyThemeDecoration(undefined);
    expect(getThemeDecoration()).toEqual({});
  });
  it("不透明度只作用于表面底色，未覆盖时沿用现有玻璃设置", () => {
    const variables = themeSurfaceVariables("sidebar", {});
    expect(variables["--theme-sidebar-background"]).toContain("var(--glass-opacity)");
    expect(Object.keys(variables)).not.toContain("opacity");
    expect(
      themeSurfaceVariables("sidebar", { opacity: 92 }, { opacity: 40 })[
        "--theme-sidebar-background"
      ],
    ).toContain("92%");
  });
  it("格式识别包含无 MIME 的照片和视频，并限制大小", () => {
    expect(backgroundFileKind({ name: "a.HEIC", type: "", size: 100 })).toBe("image");
    expect(backgroundFileKind({ name: "a.MOV", type: "", size: 100 })).toBe("video");
    for (const file of [
      { name: "a.png", type: "image/png", size: MAX_BACKGROUND_IMAGE_BYTES + 1 },
      { name: "a.mp4", type: "video/mp4", size: MAX_BACKGROUND_VIDEO_BYTES + 1 },
      { name: "a.png", type: "image/png", size: 0 },
      { name: "a.exe", type: "application/octet-stream", size: 100 },
    ])
      expect(() => backgroundFileKind(file)).toThrow();
  });
  it("解压按实际输出字节拒绝压缩炸弹，而不是仅信任 ZIP 文件大小", async () => {
    const zip = new JSZip();
    zip.file("large.txt", "x".repeat(100_000));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.length).toBeLessThan(1024);
    const loaded = await JSZip.loadAsync(bytes);
    await expect(readThemeZipEntry(loaded.file("large.txt")!, 1024)).rejects.toThrow();
    const small = await readThemeZipEntry(zip.file("large.txt")!, 100_000);
    expect(small.length).toBe(100_000);
  });
  it("背景编辑不改变已有主题颜色角色", () => {
    expect(Object.keys(parseThemeFile(definition).colors)).toEqual(
      Object.keys(getDefaultThemeColors("light")),
    );
  });
});
