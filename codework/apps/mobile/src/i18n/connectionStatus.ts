import type { EnvironmentConnectionPresentation } from "@codework/client-runtime/connection";

import { t } from "./runtime";

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
        ? t("connection.failedReconnectingReason", { reason: connection.error })
        : t("reconnecting");
    case "connected":
      return t("connection.connected");
    case "error":
      return connection.error
        ? t("connection.failedReason", { reason: connection.error })
        : t("connection.failed");
  }
}
