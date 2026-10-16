import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  type AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
} from "@codework/contracts";

/**
 * Display metadata for every pairable permission, ordered as presented to users.
 * `title`/`description` are i18n message keys; surfaces translate them with their
 * own `t()` so web and mobile share one catalog of grantable permissions.
 */
export const AUTH_SCOPE_OPTIONS: ReadonlyArray<{
  readonly scope: AuthGrantScope;
  readonly title: string;
  readonly description: string;
}> = [
  {
    scope: AuthOrchestrationReadScope,
    title: "viewEnvironment",
    description: "readThreadsStatusDiffsAndConfiguration",
  },
  {
    scope: AuthOrchestrationOperateScope,
    title: "operateTasks",
    description: "startTasksAndPerformChangesInTheEnvironment",
  },
  {
    scope: AuthSettingsWriteScope,
    title: "changeEnvironmentSettings",
    description: "editEnvironmentPreferencesAndKeybindings",
  },
  {
    scope: AuthProvidersManageScope,
    title: "manageProviders",
    description: "configureInstallSignInToAndUpdateProvidersAndUsageSources",
  },
  {
    scope: AuthEnvironmentMaintainScope,
    title: "maintainEnvironment",
    description: "updateTheServerAndControlEnvironmentProcesses",
  },
  {
    scope: AuthPreviewOperateScope,
    title: "controlPreviews",
    description: "openBrowserPreviewsAndHostBrowserAutomation",
  },
  {
    scope: AuthDiagnosticsReadScope,
    title: "viewDiagnosticsAndUsage",
    description: "readProcessDiagnosticsResourceHistoryAndUsageTotals",
  },
  {
    scope: AuthTerminalReadScope,
    title: "viewTerminals",
    description: "readExistingTerminalOutputAndStatus",
  },
  {
    scope: AuthTerminalOperateScope,
    title: "useTerminals",
    description: "createTerminalsAndSendInputToRunningShells",
  },
  {
    scope: AuthSourceControlWriteScope,
    title: "changeSourceControlScope",
    description: "commitPushManageBranchesAndRepositoriesAndChangePullRequests",
  },
  {
    scope: AuthFilesystemReadScope,
    title: "readFilesScope",
    description: "browseHostFilesSearchWorkspacesAndInspectLocalChanges",
  },
  {
    scope: AuthFilesystemWriteScope,
    title: "writeFilesScope",
    description: "editWorkspaceFilesAndSavePlansToDisk",
  },
  {
    scope: AuthAccessReadScope,
    title: "viewAccess",
    description: "inspectPairingLinksAndAuthorizedClients",
  },
  {
    scope: AuthAccessWriteScope,
    title: "manageAccess",
    description: "issueAndRevokeCredentialsForOtherClients",
  },
  {
    scope: AuthRelayReadScope,
    title: "viewRelay",
    description: "inspectManagedRelayConnectivity",
  },
  {
    scope: AuthRelayWriteScope,
    title: "manageRelay",
    description: "changeManagedTunnelConnectivity",
  },
];
