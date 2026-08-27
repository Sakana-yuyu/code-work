import { en, zhCN } from "./i18n.messages.js";

export type DesktopLanguage = "zh-CN" | "en";
export type TranslateParams = Readonly<Record<string, string | number | undefined>>;

function resolveLanguage(): DesktopLanguage {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: TranslateParams): string {
  const template = (resolveLanguage() === "zh-CN" ? zhCN[key] : en[key]) ?? en[key] ?? key;
  return params ? interpolate(template, params) : template;
}
