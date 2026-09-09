import { ConfigurationTarget } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration";
import type { IConfigurationService } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration.service";
import type { IWorkbenchThemeService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service";
import type { ITerminalService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/terminal/browser/terminal.service";
import type { ThemeDefinition } from "../../../themePalette";
import { getThemeDecoration, subscribeToThemeDecoration } from "../../../themeDecoration";
import { appThemeFromWorkbench, workbenchColorsFromApp, workbenchThemeAppId } from "./themeColors";

export const APP_WORKBENCH_THEMES = { light: "Code Work Light", dark: "Code Work Dark" } as const;
const PREFERRED_COLOR_THEME_SETTINGS = {
  light: "workbench.preferredLightColorTheme",
  dark: "workbench.preferredDarkColorTheme",
  hcDark: "workbench.preferredHighContrastColorTheme",
  hcLight: "workbench.preferredHighContrastLightColorTheme",
};

export async function startWorkbenchThemeSync(
  themes: Pick<
    IWorkbenchThemeService,
    | "getPreferredColorScheme"
    | "getColorThemes"
    | "setColorTheme"
    | "getColorTheme"
    | "onDidColorThemeChange"
  >,
  configuration: Pick<
    IConfigurationService,
    "getValue" | "updateValue" | "onDidChangeConfiguration"
  >,
  onSelected: (theme: ThemeDefinition) => void,
  onError: (error: unknown) => void,
  terminals?: Pick<ITerminalService, "instances" | "onDidCreateInstance">,
) {
  const root = document.documentElement;
  let lastSnapshot = "";
  let applying = false;
  let disposed = false;
  let pending = Promise.resolve();

  // xterm 画布不继承 CSS 背景；只调整默认底色，不改文字、ANSI 色或启用图片协议。
  const syncTerminal = async (instance: ITerminalService["instances"][number]) => {
    const xterm = await instance.xtermReadyPromise;
    if (disposed || instance.isDisposed || !xterm) return;
    const decoration = getThemeDecoration();
    const transparent = Boolean(decoration.global || decoration.content);
    const theme = themes.getColorTheme();
    const background = transparent
      ? "#00000000"
      : (theme.getColor("terminal.background") ?? theme.getColor("panel.background"))?.toString();
    const allowTransparency =
      transparent || configuration.getValue("terminal.integrated.enableImages") === true;
    if (xterm.raw.options.allowTransparency !== allowTransparency) {
      xterm.raw.options.allowTransparency = allowTransparency;
    }
    if (xterm.raw.options.theme?.background !== background) {
      const next = { ...xterm.raw.options.theme };
      if (background) next.background = background;
      else delete next.background;
      xterm.raw.options.theme = next;
    }
  };
  const syncTerminals = () =>
    Promise.all((terminals?.instances ?? []).map(syncTerminal)).catch(onError);
  const stopDecoration = subscribeToThemeDecoration(() => void syncTerminals());
  const terminalListener = terminals?.onDidCreateInstance(
    (instance) => void syncTerminal(instance).catch(onError),
  );
  const colorListener = themes.onDidColorThemeChange(() => void syncTerminals());

  const snapshot = () => ({
    id: root.dataset.themeId,
    appearance: root.classList.contains("dark") ? ("dark" as const) : ("light" as const),
    colors: workbenchColorsFromApp(getComputedStyle(root), getThemeDecoration()),
  });
  const enqueue = (operation: () => Promise<void>) => {
    pending = pending
      .then(async () => {
        if (!disposed) await operation();
      })
      .catch(onError);
    return pending;
  };
  const applyFromApp = () =>
    enqueue(async () => {
      // 未挂载的终端可能尚未创建画布，不能阻塞工作台首次初始化。
      void syncTerminals();
      const next = snapshot();
      const signature = JSON.stringify(next);
      if (signature === lastSnapshot) return;
      const available = await themes.getColorThemes();
      // 保存的插件主题再次选中或页面重载时，优先恢复实际插件；未安装时仍可使用保存的配色。
      const imported = available.find(
        (theme) =>
          workbenchThemeAppId(theme) === next.id &&
          (theme.type === "light" || theme.type === "hcLight" ? "light" : "dark") ===
            next.appearance,
      );
      const target =
        imported ??
        available.find((theme) => theme.settingsId === APP_WORKBENCH_THEMES[next.appearance]);
      if (!target) throw new Error("Code Work 主题尚未注册");
      applying = true;
      try {
        // 系统深浅模式统一由 Code Work 驱动，保留上游的无障碍高对比度检测。
        await configuration.updateValue(
          "window.autoDetectColorScheme",
          false,
          ConfigurationTarget.MEMORY,
        );
        await configuration.updateValue(
          "workbench.colorCustomizations",
          { [`[${target.settingsId}]`]: next.colors },
          ConfigurationTarget.MEMORY,
        );
        await themes.setColorTheme(target, ConfigurationTarget.USER);
        lastSnapshot = signature;
      } finally {
        applying = false;
      }
    });

  const listener = configuration.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("terminal.integrated")) void syncTerminals();
    // 主题选择器的预览只发主题事件，确认后才写设置；取消预览不会改写全局偏好。
    const preferred = themes.getPreferredColorScheme();
    const key = preferred ? PREFERRED_COLOR_THEME_SETTINGS[preferred] : "workbench.colorTheme";
    if (applying || !event.affectsConfiguration(key)) return;
    return enqueue(async () => {
      // 设置编辑器修改主题时，上游会异步加载；等待加载后再读取实际生效的颜色。
      const id = configuration.getValue<string>(key);
      const target = (await themes.getColorThemes()).find((theme) => theme.settingsId === id);
      if (!target) return;
      const selected = await themes.setColorTheme(target, undefined);
      if (!selected) throw new Error("IDE 主题未能加载");
      onSelected(appThemeFromWorkbench(selected));
      lastSnapshot = JSON.stringify(snapshot());
    });
  });
  const observer = new MutationObserver(applyFromApp);
  observer.observe(root, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme-id"],
  });
  await applyFromApp();
  return () => {
    disposed = true;
    observer.disconnect();
    listener.dispose();
    stopDecoration();
    terminalListener?.dispose();
    colorListener.dispose();
  };
}
