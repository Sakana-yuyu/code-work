import type { LanguagePreference } from "@codework/contracts";

import { en, zhCN } from "./messages";

export type AppLanguage = Exclude<LanguagePreference, "system">;
export type TranslateParams = Readonly<Record<string, string | number | undefined>>;

const catalogs: Record<AppLanguage, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

export const fallbackLanguage: AppLanguage = "zh-CN";

let currentLanguage: AppLanguage = fallbackLanguage;
const listeners = new Set<() => void>();

export function resolveLanguage(preference: LanguagePreference): AppLanguage {
  if (preference !== "system") return preference;
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCurrentLanguage(): AppLanguage {
  return currentLanguage;
}

export function setCurrentLanguage(language: AppLanguage): void {
  if (language === currentLanguage) return;
  currentLanguage = language;
  for (const listener of listeners) listener();
}

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: TranslateParams): string {
  const template = catalogs[currentLanguage][key] ?? en[key] ?? key;
  return params ? interpolate(template, params) : template;
}
