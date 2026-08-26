/**
 * Key-based i18n with message catalogs.
 *
 * `t(key, params?)` resolves a stable message id against the active locale
 * catalog, then the English catalog, then — as a transitional fallback for
 * surfaces that still pass raw English source strings (e.g. schema
 * annotation titles rendered by data-driven forms) — the legacy zh-CN
 * source-string dictionary, and finally returns the input unchanged.
 * Untranslated surfaces therefore keep rendering their source text instead
 * of breaking.
 *
 * Placeholders use `{{name}}` interpolation. Passing `count` selects the
 * `key_plural` variant when `count !== 1`.
 *
 * `t` is a plain module-level function (usable in non-React modules) that
 * reads a module-scoped locale kept in sync by `<I18nProvider>`. Because the
 * provider remounts its subtree when the resolved language changes,
 * components using `t()` pick up the new language without subscribing
 * individually.
 */
import { Fragment, type ReactNode, useSyncExternalStore } from "react";
import { zhCN as legacyZhCN } from "./zh-CN";
import { en as enCatalog, zhCN as zhCNCatalog } from "./messages";
import { useClientSettings } from "~/hooks/useSettings";
import { readBrowserClientSettings } from "~/clientPersistenceStorage";
import type { LanguagePreference } from "@codework/contracts/settings";

export type AppLanguage = Exclude<LanguagePreference, "system">;

/**
 * The full message catalogs per locale. Keys are stable message ids; values
 * may contain `{{name}}` placeholders.
 */
export const CATALOGS: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": zhCNCatalog,
  en: enCatalog,
};

/**
 * Transitional source-string dictionary (English source → zh-CN). Used only
 * after both locale catalogs miss, so data-driven English (schema annotation
 * titles/descriptions) still renders translated during the migration.
 */
export const LEGACY_DICTIONARIES: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": legacyZhCN,
  en: {},
};

const RESOLVED_LANGUAGE_FALLBACK: AppLanguage = "zh-CN";

/** Resolves the "system" preference against the browser locale. */
export function resolveLanguage(preference: LanguagePreference): AppLanguage {
  if (preference !== "system") {
    return preference;
  }
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  }
  return RESOLVED_LANGUAGE_FALLBACK;
}

// ── Module-level locale (kept in sync by <I18nProvider>) ────────────

/** Reads the persisted language preference synchronously (browser localStorage). */
function initialLanguage(): AppLanguage {
  try {
    const persisted = readBrowserClientSettings();
    if (persisted && persisted.language) {
      return resolveLanguage(persisted.language);
    }
  } catch {
    // Fall through to the default.
  }
  return RESOLVED_LANGUAGE_FALLBACK;
}

let currentLanguage: AppLanguage = initialLanguage();
const languageListeners = new Set<() => void>();

function subscribeLanguage(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

function setModuleLanguage(next: AppLanguage, notify = true): void {
  if (currentLanguage === next) {
    return;
  }
  currentLanguage = next;
  if (notify) {
    for (const listener of languageListeners) {
      listener();
    }
  }
}

/**
 * Subscribe to resolved-language changes from React (used by the provider and
 * `useI18n`).
 */
export function useResolvedLanguage(): AppLanguage {
  return useSyncExternalStore(
    subscribeLanguage,
    () => currentLanguage,
    () => RESOLVED_LANGUAGE_FALLBACK,
  );
}

export type TranslateParams = {
  readonly [name: string]: string | number | undefined;
};

function interpolate(template: string, params: TranslateParams): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Resolve a message. Lookup order: active locale catalog (with plural
 * variant), English catalog, transitional source-string dictionary, then the
 * input itself — so a missing key degrades to readable text, never an id.
 */
export function t(key: string, params?: TranslateParams): string {
  let template: string | undefined;
  const catalog = CATALOGS[currentLanguage];
  if (catalog) {
    template =
      params && typeof params.count === "number" && params.count !== 1
        ? (catalog[`${key}_plural`] ?? catalog[key])
        : catalog[key];
  }
  template ??= CATALOGS.en[key];
  if (template === undefined) {
    const legacy = LEGACY_DICTIONARIES[currentLanguage][key];
    if (legacy !== undefined) {
      template = legacy;
    }
  }
  if (template === undefined) {
    return key;
  }
  return params ? interpolate(template, params) : template;
}

/**
 * React hook form. Re-renders the caller when the resolved language changes
 * and returns the same `t` function.
 */
export function useI18n(): { readonly t: typeof t; readonly language: AppLanguage } {
  const language = useResolvedLanguage();
  return { t, language };
}

/**
 * Reads the persisted language preference and keeps the module-level locale in
 * sync. Remounts its subtree when the resolved language changes so components
 * that call `t()` directly re-render with fresh translations.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const preference = useClientSettings((settings) => settings.language);
  const resolved = resolveLanguage(preference);

  // Keep the module-level locale in sync for non-reactive `t()` callers. The
  // assignment is idempotent and emits no notifications, so it is safe during
  // render; the keyed fragment below remounts the subtree so every `t()` call
  // site re-renders with the new language.
  setModuleLanguage(resolved, false);

  return <Fragment key={resolved}>{children}</Fragment>;
}
