import type { WorkspaceState } from "../../state/workspaceModel";

import { t } from "../../i18n/runtime";

export interface WorkspaceConnectionStatusPresentation {
  readonly label: string;
  /** True while actively working (connecting/syncing) — render a spinner. False for offline/error/idle states — render a wifi-slash icon. */
  readonly showsProgress: boolean;
}

export function shouldShowWorkspaceConnectionStatus(state: WorkspaceState): boolean {
  return (
    state.networkStatus === "offline" ||
    state.connectionError !== null ||
    state.hasConnectingEnvironment ||
    state.hasPendingShellSnapshot ||
    (state.hasLoadedShellSnapshot && !state.hasReadyEnvironment)
  );
}

export function workspaceConnectionStatusLabel(state: WorkspaceState): string {
  if (state.networkStatus === "offline") return t("youAreOffline");
  if (state.connectingEnvironments.length === 1) {
    return t("connection.reconnectingTo", {
      environmentLabel: state.connectingEnvironments[0]!.environmentLabel,
    });
  }
  if (state.connectingEnvironments.length > 1) {
    return t("connection.reconnectingEnvironments", {
      count: state.connectingEnvironments.length,
    });
  }
  if (state.connectionError !== null) return state.connectionError;
  if (state.hasPendingShellSnapshot) {
    return state.hasLoadedShellSnapshot
      ? t("connection.syncingThreads")
      : t("connection.loadingThreads");
  }
  return t("connection.notConnected");
}

/** Header-title presentation of the connection state, or null while connected. */
export function workspaceConnectionStatusPresentation(
  state: WorkspaceState,
): WorkspaceConnectionStatusPresentation | null {
  if (!shouldShowWorkspaceConnectionStatus(state)) return null;
  return {
    label: workspaceConnectionStatusLabel(state),
    showsProgress:
      state.networkStatus !== "offline" &&
      state.connectionError === null &&
      (state.connectingEnvironments.length > 0 || state.hasPendingShellSnapshot),
  };
}
