import type { WorkspaceState } from "../../state/workspaceModel";

import { t } from "../../i18n/runtime";

export type HomeEmptyAction = "addProject" | null;

export function deriveEmptyState(props: {
  readonly catalogState: WorkspaceState;
  readonly projectCount: number;
}): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly action: HomeEmptyAction;
} {
  const { catalogState } = props;
  if (catalogState.isLoadingConnections) {
    return {
      title: t("loadingEnvironments"),
      detail: t("checkingSavedEnvironmentsOnThisDevice"),
      loading: true,
      action: null,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: t("noEnvironmentsConnected"),
      detail: t("addAnEnvironmentToLoadProjectsAndStartCodingSessions"),
      loading: false,
      action: null,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: t("commandPalette.environmentUnavailable"),
      detail: catalogState.connectionError ?? t("connection.savedEnvironmentOffline"),
      loading: false,
      action: null,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: t("connectingToEnvironment"),
      detail: t("loadingProjectsAndThreadsFromTheSavedEnvironment"),
      loading: true,
      action: null,
    };
  }

  if (props.projectCount === 0 && catalogState.hasLoadedShellSnapshot) {
    return {
      title: t("noProjectsFound"),
      detail: t("theConnectedEnvironmentDidNotReportAnyProjects"),
      loading: false,
      action: "addProject",
    };
  }

  return {
    title: t("noThreadsYet"),
    detail: t("createATaskToStartANewCodingSessionInOneOfYourConnectedProjects"),
    loading: false,
    action: null,
  };
}
