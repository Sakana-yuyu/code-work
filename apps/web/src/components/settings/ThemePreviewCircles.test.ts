import { expect, it } from "vite-plus/test";
import { CODEWORK_CHAT_THEME, type ThemeDefinition } from "../../themePalette";
import { getThemeCardDefinition } from "./ThemePreviewCircles";

it("按外观选择背景图片，沿用主题回退规则且不把视频当图片", () => {
  const global = {
    media: { kind: "image", source: "url", value: "https://example.com/light.png" },
  } as const;
  const sidebar = {
    media: {
      kind: "image",
      source: "asset",
      value: "8332cfa9-7582-4104-9ab8-849f5f04582a",
    },
    x: 25,
  } as const;
  const theme: ThemeDefinition = {
    ...CODEWORK_CHAT_THEME,
    appearance: "light",
    decorations: { light: { global, sidebar }, dark: { sidebar } },
  };
  expect(getThemeCardDefinition(theme).previews.map((preview) => preview.background)).toEqual([
    global,
    sidebar,
  ]);
  expect(
    getThemeCardDefinition({ ...theme, decorations: { light: { global } } }).previews.map(
      (preview) => preview.background,
    ),
  ).toEqual([global, global]);
  expect(
    getThemeCardDefinition({
      ...theme,
      decorations: { light: { global: { media: { ...sidebar.media, kind: "video" } } } },
    }).previews.every((preview) => preview.background === undefined),
  ).toBe(true);
  expect(
    getThemeCardDefinition(CODEWORK_CHAT_THEME).previews.every(
      (preview) => preview.background === undefined,
    ),
  ).toBe(true);
});
