import type { LanguagePreference } from "@codework/contracts/settings";

import { readBrowserClientSettings } from "../clientPersistenceStorage";
import { zhCN as legacyZhCN } from "./zh-CN";
import { en as enCatalog, zhCN as zhCNCatalog } from "./messages";

export type AppLanguage = Exclude<LanguagePreference, "system">;
export type TranslateParams = {
  readonly [name: string]: string | number | undefined;
};

export const CATALOGS: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": zhCNCatalog,
  en: enCatalog,
};

export const LEGACY_DICTIONARIES: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": legacyZhCN,
  en: {},
};

export const RESOLVED_LANGUAGE_FALLBACK: AppLanguage = "zh-CN";

export function resolveLanguage(preference: LanguagePreference): AppLanguage {
  if (preference !== "system") return preference;
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }
  return RESOLVED_LANGUAGE_FALLBACK;
}

function initialLanguage(): AppLanguage {
  try {
    const persisted = readBrowserClientSettings();
    if (persisted?.language) return resolveLanguage(persisted.language);
  } catch {
    // 使用默认语言继续启动。
  }
  return RESOLVED_LANGUAGE_FALLBACK;
}

let currentLanguage: AppLanguage = initialLanguage();
const languageListeners = new Set<() => void>();

export function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => languageListeners.delete(listener);
}

export function getCurrentLanguage(): AppLanguage {
  return currentLanguage;
}

export function setCurrentLanguage(next: AppLanguage, notify = true): void {
  if (currentLanguage === next) return;
  currentLanguage = next;
  if (notify) {
    for (const listener of languageListeners) listener();
  }
}

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: TranslateParams): string {
  const catalog = CATALOGS[currentLanguage];
  let template =
    params && typeof params.count === "number" && params.count !== 1
      ? (catalog[`${key}_plural`] ?? catalog[key])
      : catalog[key];
  template ??= CATALOGS.en[key];
  template ??= LEGACY_DICTIONARIES[currentLanguage][key];
  if (template === undefined) return key;
  return params ? interpolate(template, params) : template;
}
