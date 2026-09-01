import type { ServerProvider, ServerProviderVersionAdvisory } from "@codework/contracts";
import { t } from "~/i18n/runtime";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-muted-foreground/50",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

function localizeProviderMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  if (message.includes("Cursor CLI command `cursor-agent` was not found")) {
    return t("providerCursorCliMissing");
  }
  const adapterMatch = message.match(/^(\\d+) model adapter(s?) configured\\.?$/);
  if (adapterMatch) {
    return t("providerAdaptersConfigured", { count: Number(adapterMatch[1]) });
  }
  return message;
}

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: t("providerStatusChecking"),
      detail: t("providerStatusWaiting"),
    };
  }
  if (!provider.enabled) {
    return {
      headline: t("providerStatusDisabled"),
      detail: localizeProviderMessage(provider.message) ?? t("providerStatusDisabledDetail"),
    };
  }
  if (!provider.installed) {
    return {
      headline: t("providerStatusNotFound"),
      detail: localizeProviderMessage(provider.message) ?? t("providerStatusCliNotFound"),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? t("providerStatusAuthenticatedWithType", { type: authLabel })
        : t("authenticated"),
      detail: localizeProviderMessage(provider.message),
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: t("providerStatusNotAuthenticated"),
      detail: localizeProviderMessage(provider.message),
    };
  }
  if (provider.status === "warning") {
    return {
      headline: t("providerStatusNeedsAttention"),
      detail: localizeProviderMessage(provider.message) ?? t("providerStatusNeedsAttentionDetail"),
    };
  }
  if (provider.status === "error") {
    return {
      headline: t("providerStatusUnavailable"),
      detail: localizeProviderMessage(provider.message) ?? t("providerStatusStartupFailed"),
    };
  }
  return {
    headline: t("providerStatusAvailable"),
    detail: localizeProviderMessage(provider.message) ?? t("providerStatusAuthUnverified"),
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const label = t("updateAvailable2");
  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    detail:
      advisory.message ??
      (versionLabel
        ? `${label}: install ${versionLabel}.`
        : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
