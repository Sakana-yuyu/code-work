import type { EnvironmentConnectionPresentation } from "@codework/client-runtime/connection";
import { t } from "~/i18n/runtime";
import { localizedConnectionStatusText } from "~/lib/localizedConnectionStatus";

export interface SavedCloudEnvironmentConnectionPresentation {
  readonly buttonLabel: string;
  readonly statusText: string;
  readonly tone: "connected" | "connecting" | "error" | "idle";
}

/**
 * Present the live supervisor state for an environment that is already in the
 * connection catalog. Catalog membership only means the environment is saved;
 * it does not mean the connection attempt succeeded.
 */
export function presentSavedCloudEnvironmentConnection(
  connection: EnvironmentConnectionPresentation,
): SavedCloudEnvironmentConnectionPresentation {
  switch (connection.phase) {
    case "connected":
      return {
        buttonLabel: t("connection.connected"),
        statusText: localizedConnectionStatusText(connection),
        tone: "connected",
      };
    case "connecting":
      return {
        buttonLabel: t("connecting2"),
        statusText: localizedConnectionStatusText(connection),
        tone: "connecting",
      };
    case "reconnecting":
      return {
        buttonLabel: t("interface.reconnecting"),
        statusText: localizedConnectionStatusText(connection),
        tone: "connecting",
      };
    case "error":
      return {
        buttonLabel: t("connection.failed"),
        statusText: localizedConnectionStatusText(connection),
        tone: "error",
      };
    case "offline":
      return {
        buttonLabel: t("connection.offline"),
        statusText: localizedConnectionStatusText(connection),
        tone: "idle",
      };
    case "available":
      return {
        buttonLabel: t("interface.not-connected"),
        statusText: localizedConnectionStatusText(connection),
        tone: "idle",
      };
  }
}
