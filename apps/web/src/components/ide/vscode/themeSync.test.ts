import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { Color } from "@codingame/monaco-vscode-api/vscode/vs/base/common/color";
import { ColorScheme } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/common/theme";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { IWorkbenchColorTheme } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService";
import type { IConfigurationChangeEvent } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import {
  appThemeFromWorkbench,
  workbenchColorsFromApp,
  workbenchThemeAppId,
  workbenchThemeDataUrl,
} from "./themeColors";
import { APP_WORKBENCH_THEMES, startWorkbenchThemeSync } from "./themeSync";
import { applyThemeDecoration } from "../../../themeDecoration";
import type { ITerminalService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/terminal/browser/terminal.service";

function theme(settingsId: string, type = ColorScheme.LIGHT): IWorkbenchColorTheme {
  return {
    id: settingsId,
    label: settingsId,
    settingsId,
    type,
    getColor: (id) =>
      Color.fromHex(
        id === "titleBar.activeBackground"
          ? "#303640"
          : id.endsWith("background") || id.endsWith("Background")
            ? "#20242b"
            : "#eeeeee",
      ),
    defines: () => true,
    getTokenStyleMetadata: () => undefined,
    tokenColorMap: [],
    tokenFontMap: [],
    tokenColors: [],
    semanticHighlighting: false,
  };
}

function themeChange(key = "workbench.colorTheme"): IConfigurationChangeEvent {
  return {
    source: ConfigurationTarget.USER,
    affectedKeys: new Set([key]),
    change: { keys: [key], overrides: [] },
    affectsConfiguration: (section) => section === key,
  };
}

function fixture() {
  const light = theme(APP_WORKBENCH_THEMES.light);
  const dark = theme(APP_WORKBENCH_THEMES.dark, ColorScheme.DARK);
  const plugin = theme("插件主题", ColorScheme.DARK);
  let current = light;
  let configured = light.settingsId;
  const root = { dataset: { themeId: "ocean" }, classList: { contains: vi.fn(() => false) } };
  const css = {
    "--background": "#fafafa",
    "--foreground": "#202020",
    "--sidebar": "#ededed",
    "--toolbar-background": "#dddddd",
  };
  let mutation: () => unknown = () => {};
  let configChange: (event: IConfigurationChangeEvent) => unknown = () => {};
  let colorChange: () => void = () => {};
  vi.stubGlobal("document", { documentElement: root });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (key: string) => css[key as keyof typeof css] ?? "",
  }));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => unknown) {
        mutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const configuration = {
    getValue: vi.fn(() => configured),
    updateValue: vi.fn(async () => {}),
    onDidChangeConfiguration: vi.fn((callback) => {
      configChange = callback;
      return { dispose: vi.fn() };
    }),
  };
  const themes = {
    getColorTheme: () => current,
    onDidColorThemeChange: vi.fn((callback) => {
      colorChange = callback;
      return { dispose: vi.fn() };
    }),
    getColorThemes: async () => [light, dark, plugin],
    getPreferredColorScheme: vi.fn<() => ColorScheme | undefined>(() => undefined),
    setColorTheme: vi.fn(async (next: IWorkbenchColorTheme, target?: ConfigurationTarget) => {
      current = next;
      if (target !== undefined) {
        configured = next.settingsId;
        void configChange(themeChange());
      }
      return next;
    }),
  };
  const selected = vi.fn((next) => {
    root.dataset.themeId = next.id;
    root.classList.contains.mockReturnValue(next.appearance === "dark");
  });
  const error = vi.fn();
  return {
    root,
    css,
    themes,
    configuration,
    selected,
    error,
    plugin,
    changeColors: () => colorChange(),
    mutate: () => mutation(),
    choose: async (next: IWorkbenchColorTheme, commit: boolean, key?: string) => {
      if (commit) {
        configured = next.settingsId;
        await configChange(themeChange(key));
      } else {
        current = next;
      }
    },
  };
}

afterEach(() => {
  applyThemeDecoration(undefined);
  vi.unstubAllGlobals();
});

describe("IDE 与对话主题同步", () => {
  it("浅色背景使用黑色活动栏图标，深色背景恢复白色，包括未选中状态", () => {
    const style = { getPropertyValue: () => "#fafafa" };
    const light = workbenchColorsFromApp(style);
    expect(light["activityBar.foreground"]).toBe("#000000");
    expect(light["activityBar.inactiveForeground"]).toBe("#000000");
    const dark = workbenchColorsFromApp(style, { sidebar: { color: "#101010" } });
    expect(dark["activityBar.foreground"]).toBe("#ffffff");
    expect(dark["activityBar.inactiveForeground"]).toBe("#ffffff");
    expect(workbenchColorsFromApp(style, { global: { opacity: 20 } })["terminal.background"]).toBe(
      "#00000000",
    );
    expect(workbenchColorsFromApp(style, { sidebar: { opacity: 20 } })["terminal.background"]).toBe(
      "#fafafa",
    );
  });
  it("侧栏未单独设置透明度时沿用全局透明度计算图标对比度", () => {
    const style = { getPropertyValue: (name: string) => (name === "--sidebar" ? "#ffffff" : "") };
    expect(
      workbenchColorsFromApp(style, {
        global: { opacity: 20 },
        sidebar: { color: "#000000" },
      })["activityBar.foreground"],
    ).toBe("#000000");
  });
  it("首次初始化不等待隐藏终端，卸载后不再修改迟到的画布", async () => {
    const f = fixture();
    const options = { allowTransparency: false, theme: { background: "#ffffff" } };
    let resolveReady!: (value: { raw: { options: typeof options } }) => void;
    const ready = new Promise<{ raw: { options: typeof options } }>((resolve) => {
      resolveReady = resolve;
    });
    const terminals = {
      instances: [{ xtermReadyPromise: ready, isDisposed: false }],
      onDidCreateInstance: vi.fn(() => ({ dispose: vi.fn() })),
    } as unknown as Pick<ITerminalService, "instances" | "onDidCreateInstance">;
    applyThemeDecoration({ global: { opacity: 60 } });
    const stop = await startWorkbenchThemeSync(
      f.themes,
      f.configuration,
      f.selected,
      f.error,
      terminals,
    );
    stop();
    resolveReady({ raw: { options } });
    await ready;
    expect(options).toEqual({ allowTransparency: false, theme: { background: "#ffffff" } });
  });

  it("内容背景启用、预览撤销及新终端都更新画布透明度，文字保持不透明", async () => {
    const f = fixture();
    const options = {
      allowTransparency: false,
      theme: { background: "#fafafa", foreground: "#202020" },
    };
    const terminal = {
      xtermReadyPromise: Promise.resolve({ raw: { options } }),
      isDisposed: false,
    };
    let created: (instance: typeof terminal) => void = () => {};
    const terminals = {
      instances: [terminal],
      onDidCreateInstance: vi.fn((callback) => {
        created = callback;
        return { dispose: vi.fn() };
      }),
    } as unknown as Pick<ITerminalService, "instances" | "onDidCreateInstance">;
    const stop = await startWorkbenchThemeSync(
      f.themes,
      f.configuration,
      f.selected,
      f.error,
      terminals,
    );
    applyThemeDecoration({
      global: {
        opacity: 60,
        media: { kind: "image", source: "url", value: "https://example.com/bg.png" },
      },
    });
    await f.mutate();
    expect(options.allowTransparency).toBe(true);
    expect(options.theme).toEqual({ background: "#00000000", foreground: "#202020" });
    const next = {
      ...terminal,
      xtermReadyPromise: Promise.resolve({
        raw: { options: { ...options, theme: { ...options.theme, background: "#ffffff" } } },
      }),
    };
    created(next);
    await Promise.resolve();
    expect((await next.xtermReadyPromise).raw.options.theme.background).toBe("#00000000");
    // 上游更新配置会重设 xterm 选项，背景同步需要再次接管。
    options.allowTransparency = false;
    options.theme.background = "#ffffff";
    f.changeColors();
    await Promise.resolve();
    expect(options.theme.background).toBe("#00000000");
    applyThemeDecoration(undefined);
    await f.mutate();
    expect(options.allowTransparency).toBe(false);
    expect(options.theme.background).toBe("#20242b");
    expect(f.selected).not.toHaveBeenCalled();
    stop();
    applyThemeDecoration({ content: { color: "#123456" } });
    await f.mutate();
    expect(options.allowTransparency).toBe(false);
  });

  it("同为浅色的主题切换仍同步完整配色，不触发反向保存", async () => {
    const f = fixture();
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    expect(f.configuration.updateValue).toHaveBeenLastCalledWith(
      "workbench.colorCustomizations",
      {
        "[Code Work Light]": expect.objectContaining({
          "editor.background": "#fafafa",
          "sideBar.background": "#ededed",
        }),
      },
      ConfigurationTarget.MEMORY,
    );
    f.root.dataset.themeId = "grove";
    f.css["--background"] = "#ddffee";
    await f.mutate();
    expect(f.configuration.updateValue).toHaveBeenLastCalledWith(
      "workbench.colorCustomizations",
      {
        "[Code Work Light]": expect.objectContaining({ "editor.background": "#ddffee" }),
      },
      ConfigurationTarget.MEMORY,
    );
    expect(f.selected).not.toHaveBeenCalled();
    expect(f.configuration.updateValue).toHaveBeenCalledWith(
      "window.autoDetectColorScheme",
      false,
      ConfigurationTarget.MEMORY,
    );
    expect(f.error).not.toHaveBeenCalled();
    stop();
  });

  it("插件主题预览不落盘，确认后同步；后续 DOM 通知不回写覆盖插件", async () => {
    const f = fixture();
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    await f.choose(f.plugin, false);
    expect(f.selected).not.toHaveBeenCalled();
    await f.choose(f.plugin, true);
    expect(f.selected).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: workbenchThemeAppId(f.plugin),
        appearance: "dark",
      }),
    );
    const writes = f.themes.setColorTheme.mock.calls.length;
    await f.mutate();
    expect(f.themes.setColorTheme).toHaveBeenCalledTimes(writes);
    expect(f.error).not.toHaveBeenCalled();
    stop();
  });

  it("刷新后按保存的主题标识恢复插件，深浅模式变化仍可回到应用主题", async () => {
    const f = fixture();
    f.root.dataset.themeId = workbenchThemeAppId(f.plugin);
    f.root.classList.contains.mockReturnValue(true);
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    expect(f.themes.setColorTheme).toHaveBeenLastCalledWith(f.plugin, ConfigurationTarget.USER);
    f.root.classList.contains.mockReturnValue(false);
    await f.mutate();
    expect(f.themes.setColorTheme.mock.lastCall?.[0].settingsId).toBe(APP_WORKBENCH_THEMES.light);
    stop();
  });

  it("已保存的插件不可用时保留配色，不反向覆盖主题库", async () => {
    const f = fixture();
    f.root.dataset.themeId = workbenchThemeAppId(f.plugin);
    f.root.classList.contains.mockReturnValue(true);
    const available = await f.themes.getColorThemes();
    f.themes.getColorThemes = async () => available.filter((entry) => entry !== f.plugin);
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    expect(f.themes.setColorTheme.mock.lastCall?.[0].settingsId).toBe(APP_WORKBENCH_THEMES.dark);
    expect(f.configuration.updateValue).toHaveBeenCalledWith(
      "workbench.colorCustomizations",
      { "[Code Work Dark]": expect.objectContaining({ "editor.background": "#fafafa" }) },
      ConfigurationTarget.MEMORY,
    );
    expect(f.selected).not.toHaveBeenCalled();
    expect(f.error).not.toHaveBeenCalled();
    stop();
  });

  it("主题设置异步加载后再取色，也支持高对比度主题的确认", async () => {
    const f = fixture();
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    f.themes.getPreferredColorScheme.mockReturnValue(ColorScheme.HIGH_CONTRAST_DARK);
    await f.choose(f.plugin, true, "workbench.preferredHighContrastColorTheme");
    expect(f.themes.setColorTheme).toHaveBeenLastCalledWith(f.plugin, undefined);
    expect(f.selected).toHaveBeenCalledWith(
      expect.objectContaining({
        id: workbenchThemeAppId(f.plugin),
        appearance: "dark",
      }),
    );
    stop();
  });

  it("同步失败可见，重试成功；卸载后不继续写配置", async () => {
    const f = fixture();
    const failure = new Error("存储不可用");
    f.configuration.updateValue.mockRejectedValueOnce(failure);
    const stop = await startWorkbenchThemeSync(f.themes, f.configuration, f.selected, f.error);
    expect(f.error).toHaveBeenCalledWith(failure);
    await f.mutate();
    expect(f.themes.setColorTheme).toHaveBeenCalledTimes(1);
    stop();
    f.css["--background"] = "#eeeeee";
    await f.mutate();
    expect(f.themes.setColorTheme).toHaveBeenCalledTimes(1);
  });

  it("主题快照包含顶部和侧栏颜色，且同名不同标识不会混用", () => {
    const first = theme("first");
    const next = appThemeFromWorkbench(first);
    expect(next.colors.chrome).not.toBe(next.colors.canvas);
    expect(next.colors.sidebar).toBe(next.colors.canvas);
    expect(next.id).not.toBe(workbenchThemeAppId(theme("second")));
  });

  it("主题 JSON 经过上游 URI 转换后仍能读取十六进制颜色与中文字体", async () => {
    const tokens = [
      { scope: "comment", settings: { foreground: "#608b4e", fontFamily: "等宽字体" } },
    ];
    const url = URI.parse(workbenchThemeDataUrl(tokens)).toString(true);
    expect(await (await fetch(url)).json()).toEqual({ colors: {}, tokenColors: tokens });
  });
});
