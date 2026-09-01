import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_LANGUAGE_PREFERENCE } from "@codework/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  Fragment,
  type ReactNode,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";

import { mobilePreferencesAtom } from "../state/preferences";
import {
  fallbackLanguage,
  getCurrentLanguage,
  resolveLanguage,
  setCurrentLanguage,
  subscribeLanguage,
} from "./runtime";
import type { AppLanguage } from "./runtime";

export { t } from "./runtime";
export type { AppLanguage, TranslateParams } from "./runtime";

export function useResolvedLanguage(): AppLanguage {
  return useSyncExternalStore(subscribeLanguage, getCurrentLanguage, () => fallbackLanguage);
}

export function I18nProvider(props: { readonly children: ReactNode }) {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const preference = AsyncResult.isSuccess(preferences)
    ? (preferences.value.language ?? DEFAULT_LANGUAGE_PREFERENCE)
    : DEFAULT_LANGUAGE_PREFERENCE;
  const resolvedLanguage = resolveLanguage(preference);

  useLayoutEffect(() => setCurrentLanguage(resolvedLanguage), [resolvedLanguage]);
  const activeLanguage = useResolvedLanguage();

  return <Fragment key={activeLanguage}>{props.children}</Fragment>;
}
