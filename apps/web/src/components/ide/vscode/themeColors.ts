import type { IWorkbenchColorTheme } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService";
import { encodeBase64, VSBuffer } from "@codingame/monaco-vscode-api/vscode/vs/base/common/buffer";
import { fnv1a32 } from "../../../lib/diffRendering";
import { themeColorToHex, type ThemeDefinition } from "../../../themePalette";
import { parseVsCodeThemeFile } from "../../../vscodeThemeImport";

// 映射工作台界面颜色；文件图标和代码语法规则仍由各自的主题负责。
export const WORKBENCH_COLOR_VARIABLES = {
  "editor.background": "--background",
  "editor.foreground": "--foreground",
  foreground: "--foreground",
  descriptionForeground: "--muted-foreground",
  disabledForeground: "--muted-foreground",
  "icon.foreground": "--foreground",
  focusBorder: "--ring",
  "titleBar.activeBackground": "--app-chrome-background",
  "titleBar.activeForeground": "--foreground",
  "titleBar.inactiveBackground": "--app-chrome-background",
  "titleBar.inactiveForeground": "--muted-foreground",
  "titleBar.border": "--border",
  "activityBar.background": "--sidebar",
  "activityBar.foreground": "--sidebar-foreground",
  "activityBar.inactiveForeground": "--sidebar-muted-foreground",
  "activityBar.border": "--sidebar-border",
  "activityBarBadge.background": "--primary",
  "activityBarBadge.foreground": "--primary-foreground",
  "sideBar.background": "--sidebar",
  "sideBar.foreground": "--sidebar-foreground",
  "sideBar.border": "--sidebar-border",
  "sideBarTitle.foreground": "--sidebar-foreground",
  "sideBarSectionHeader.background": "--sidebar-control-surface",
  "sideBarSectionHeader.foreground": "--sidebar-foreground",
  "list.hoverBackground": "--sidebar-row-hover",
  "list.activeSelectionBackground": "--sidebar-row-selected",
  "list.activeSelectionForeground": "--sidebar-foreground",
  "list.inactiveSelectionBackground": "--sidebar-row-active",
  "list.inactiveSelectionForeground": "--sidebar-foreground",
  "editorGroupHeader.tabsBackground": "--toolbar-background",
  "editorGroup.border": "--border",
  "tab.activeBackground": "--background",
  "tab.activeForeground": "--foreground",
  "tab.inactiveBackground": "--toolbar-background",
  "tab.inactiveForeground": "--muted-foreground",
  "tab.border": "--border",
  "panel.background": "--background",
  "panel.border": "--border",
  "panelTitle.activeForeground": "--foreground",
  "panelTitle.inactiveForeground": "--muted-foreground",
  "statusBar.background": "--toolbar-background",
  "statusBar.foreground": "--toolbar-foreground",
  "statusBar.border": "--toolbar-border",
  "statusBar.noFolderBackground": "--toolbar-background",
  "statusBar.noFolderForeground": "--toolbar-foreground",
  "statusBar.debuggingBackground": "--toolbar-background",
  "statusBar.debuggingForeground": "--toolbar-foreground",
  "input.background": "--card",
  "input.foreground": "--foreground",
  "input.border": "--input",
  "input.placeholderForeground": "--placeholder",
  "button.background": "--primary",
  "button.foreground": "--primary-foreground",
  "dropdown.background": "--popover",
  "dropdown.foreground": "--popover-foreground",
  "dropdown.border": "--border",
  "menu.background": "--popover",
  "menu.foreground": "--popover-foreground",
  "menu.border": "--border",
  "quickInput.background": "--popover",
  "quickInput.foreground": "--popover-foreground",
  "editorWidget.background": "--card",
  "editorWidget.foreground": "--foreground",
  "editorWidget.border": "--border",
  "textLink.foreground": "--primary",
  "textCodeBlock.background": "--code-background",
  "editorError.foreground": "--destructive",
  "terminal.background": "--terminal-background",
  "terminal.foreground": "--terminal-foreground",
  "terminalCursor.foreground": "--terminal-cursor",
  "terminal.selectionBackground": "--terminal-selection-background",
} as const;

export function workbenchThemeAppId(theme: Pick<IWorkbenchColorTheme, "settingsId">): string {
  return `ide-theme-${fnv1a32(theme.settingsId).toString(36)}`;
}

export function workbenchThemeDataUrl(tokenColors: IWorkbenchColorTheme["tokenColors"]): string {
  // 上游 URI 会解码百分号；Base64 保证颜色中的 # 不被 fetch 当作 URL 片段丢弃。
  return `data:application/json;base64,${encodeBase64(VSBuffer.fromString(JSON.stringify({ colors: {}, tokenColors })))}`;
}

export function appThemeFromWorkbench(theme: IWorkbenchColorTheme): ThemeDefinition {
  const colors = Object.fromEntries(
    Object.keys(WORKBENCH_COLOR_VARIABLES).flatMap((key) => {
      const color = theme.getColor(key);
      return color ? [[key, color.toString()]] : [];
    }),
  );
  return {
    ...parseVsCodeThemeFile({
      name: theme.label || theme.settingsId,
      type: theme.type === "light" || theme.type === "hcLight" ? "light" : "dark",
      colors,
    }),
    id: workbenchThemeAppId(theme),
  };
}

export function workbenchColorsFromApp(style: Pick<CSSStyleDeclaration, "getPropertyValue">) {
  return Object.fromEntries(
    Object.entries(WORKBENCH_COLOR_VARIABLES).flatMap(([key, variable]) => {
      const color = themeColorToHex(style.getPropertyValue(variable).trim());
      return color ? [[key, color]] : [];
    }),
  );
}
