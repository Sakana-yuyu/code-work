import { en, ja, zhCN } from "./i18n.messages.js";

export type DesktopLanguage = "zh-CN" | "en" | "ja";
export type TranslateParams = Readonly<Record<string, string | number | undefined>>;

function resolveLanguage(): DesktopLanguage {
  const override = process.env.CODEWORK_DESKTOP_LANGUAGE;
  if (override === "en" || override === "zh-CN" || override === "ja") return override;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  if (locale.toLowerCase().startsWith("zh")) return "zh-CN";
  if (locale.toLowerCase().startsWith("ja")) return "ja";
  return "en";
}

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: TranslateParams): string {
  const language = resolveLanguage();
  const template =
    (language === "zh-CN" ? zhCN[key] : language === "ja" ? ja[key] : en[key]) ?? en[key] ?? key;
  return params ? interpolate(template, params) : template;
}
