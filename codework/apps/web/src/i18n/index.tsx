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
import { useClientSettings } from "~/hooks/useSettings";
import {
  getCurrentLanguage,
  RESOLVED_LANGUAGE_FALLBACK,
  resolveLanguage,
  setCurrentLanguage,
  subscribeLanguage,
  t,
} from "./runtime";
import type { AppLanguage } from "./runtime";

export { CATALOGS, LEGACY_DICTIONARIES, resolveLanguage, t } from "./runtime";
export type { AppLanguage, TranslateParams } from "./runtime";

/**
 * Subscribe to resolved-language changes from React (used by the provider and
 * `useI18n`).
 */
export function useResolvedLanguage(): AppLanguage {
  return useSyncExternalStore(
    subscribeLanguage,
    getCurrentLanguage,
    () => RESOLVED_LANGUAGE_FALLBACK,
  );
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
  setCurrentLanguage(resolved, false);

  return <Fragment key={resolved}>{children}</Fragment>;
}
