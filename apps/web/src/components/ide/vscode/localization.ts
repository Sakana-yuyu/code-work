import { getCurrentLanguage } from "../../../i18n/runtime";

export async function loadWorkbenchLanguage(): Promise<void> {
  // 复用对话界面已解析的语言（包括跟随系统），并在工作台模块加载前完成注册。
  const language = getCurrentLanguage();
  if (language === "zh-CN") {
    await import("@codingame/monaco-vscode-language-pack-zh-hans");
  } else if (language === "ja") {
    await import("@codingame/monaco-vscode-language-pack-ja");
  }
  // 英文使用上游默认文案，无需下载语言包。
}
