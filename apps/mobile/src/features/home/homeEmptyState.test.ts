import type { WorkspaceState } from "../../state/workspaceModel";
import { describe, expect, it } from "vite-plus/test";

import { deriveEmptyState } from "./homeEmptyState";

function makeCatalogState(
  input: Partial<WorkspaceState> & Pick<WorkspaceState, "hasConnections">,
): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasLoadedShellSnapshot: false,
    hasPendingShellSnapshot: false,
    hasReadyEnvironment: false,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "available",
    connectionError: null,
    shellSnapshotError: null,
    latestCachedSnapshotReceivedAt: null,
    networkStatus: "online",
    ...input,
  };
}

describe("deriveEmptyState", () => {
  it("offers the add-project action once a connected environment has loaded without projects", () => {
    const result = deriveEmptyState({
      catalogState: makeCatalogState({
        hasConnections: true,
        hasLoadedShellSnapshot: true,
        hasReadyEnvironment: true,
      }),
      projectCount: 0,
    });
    expect(result.action).toBe("addProject");
    expect(result.loading).toBe(false);
  });

  it("keeps states without a snapshot free of the add-project action", () => {
    const connecting = deriveEmptyState({
      catalogState: makeCatalogState({
        hasConnections: true,
        hasConnectingEnvironment: true,
        connectionState: "connecting",
      }),
      projectCount: 0,
    });
    expect(connecting.action).toBeNull();
    expect(connecting.loading).toBe(true);

    const noConnections = deriveEmptyState({
      catalogState: makeCatalogState({ hasConnections: false }),
      projectCount: 0,
    });
    expect(noConnections.action).toBeNull();
  });
});
