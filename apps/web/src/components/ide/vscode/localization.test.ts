import { afterEach, expect, it, vi } from "vite-plus/test";
import { getCurrentLanguage, setCurrentLanguage, type AppLanguage } from "../../../i18n/runtime";
import { loadWorkbenchLanguage } from "./localization";

const originalLanguage = getCurrentLanguage();

afterEach(() => {
  setCurrentLanguage(originalLanguage);
  vi.unstubAllGlobals();
});

it.each<[AppLanguage, string, string]>([
  ["en", "en", "Command Palette"],
  ["zh-CN", "zh-cn", "命令面板"],
  ["ja", "ja", "コマンド パレット"],
])("IDE 使用对话界面的 %s 语言和真实上游文案", async (language, locale, commandPalette) => {
  // 模拟每次页面启动时尚未初始化工作台的语言状态。
  vi.stubGlobal("_VSCODE_NLS_MESSAGES", undefined);
  vi.stubGlobal("_VSCODE_NLS_LANGUAGE", undefined);
  setCurrentLanguage(language);

  await loadWorkbenchLanguage();

  const { getNLSLanguage, getNLSMessages } =
    await import("@codingame/monaco-vscode-api/vscode/vs/nls");
  expect(getNLSLanguage() ?? "en").toBe(locale);
  // 936 是当前上游版本的命令面板文案索引。
  expect(getNLSMessages()?.[936] ?? "Command Palette").toBe(commandPalette);
});
