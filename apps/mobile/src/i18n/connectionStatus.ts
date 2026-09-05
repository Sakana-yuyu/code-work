import type { EnvironmentConnectionPresentation } from "@codework/client-runtime/connection";

import { t } from "./runtime";

/**
 * Localized replacement for the known generated error strings surfaced by
 * `connectionStatusText` in client-runtime, which is a shared package without
 * access to the mobile i18n catalogs. Parity with web's
 * `localizeConnectionBannerError`.
 */
const WEBSOCKET_FAILURE_PATTERN = /^(.+?) could not establish a WebSocket connection\.$/;

export function localizeConnectionBannerError(error: string): string {
  const match = error.match(WEBSOCKET_FAILURE_PATTERN);
  return match ? t("connection.websocketFailed", { label: match[1] ?? "" }) : error;
}

export function localizedConnectionStatusText(
  connection: EnvironmentConnectionPresentation,
): string {
  switch (connection.phase) {
    case "available":
      return t("available");
    case "offline":
      return t("connection.offline");
    case "connecting":
      return t("connecting");
    case "reconnecting":
      return connection.error
        ? t("connection.failedReconnectingReason", {
            reason: localizeConnectionBannerError(connection.error),
          })
        : t("reconnecting");
    case "connected":
      return t("connection.connected");
    case "error":
      return connection.error
        ? t("connection.failedReason", {
            reason: localizeConnectionBannerError(connection.error),
          })
        : t("connection.failed");
  }
}
