import { describe, expect, it } from "vite-plus/test";

import { t } from "~/i18n/runtime";
import {
  searchableSetting,
  searchSettings,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    keywords: ["connections"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches setting titles and beginner-friendly keywords", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS)).toEqual([]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("hides desktop-only settings from browser search", () => {
    expect(SETTINGS_SEARCH_ITEMS.some((item) => item.id === "quit-confirmation")).toBe(true);
    expect(searchSettings("quit confirmation")).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: t("wordWrap") });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: t("archivedThreads") });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
  });

  it("indexes each facilities sidebar destination", () => {
    expect(SETTINGS_SEARCH_ITEMS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "facility-runtime", to: "/settings/runtime" }),
        expect.objectContaining({ id: "facility-delegation", to: "/settings/delegation" }),
        expect.objectContaining({ id: "facility-byok", to: "/settings/byok" }),
      ]),
    );
  });

  it("用“团队”搜索到团队页面", () => {
    expect(searchSettings("团队")).toContainEqual({
      id: "composition-squads",
      title: "团队",
      to: "/settings/squads",
    });
    expect(searchableSetting("composition-squads")).toEqual({
      id: "composition-squads",
      title: "团队",
    });
  });

  it("用萌新常用说法搜索到 AI 服务、密钥和远程连接", () => {
    expect(searchSettings("模型").map((item) => item.id)).toContain("providers");
    expect(searchSettings("API key").map((item) => item.id)).toContain("facility-byok");
    expect(searchSettings("远程").map((item) => item.id)).toContain("remote-environments");
  });

  it("indexes the Automation Center route", () => {
    expect(SETTINGS_SEARCH_ITEMS).toContainEqual(
      expect.objectContaining({
        id: "composition-automations",
        title: "automationCenter.title",
        to: "/settings/automations",
      }),
    );
  });

  it("indexes the standalone local plugins route", () => {
    expect(SETTINGS_SECTION_LABELS["/settings/local-plugins"]).toBe("localPlugins.title");
    expect(SETTINGS_SEARCH_ITEMS).toContainEqual(
      expect.objectContaining({
        id: "local-plugins",
        title: "localPlugins.title",
        to: "/settings/local-plugins",
      }),
    );
    expect(searchSettings("local plugins")[0]).toMatchObject({
      id: "local-plugins",
      to: "/settings/local-plugins",
    });
  });
});
