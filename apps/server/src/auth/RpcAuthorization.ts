import {
  CLIENT_GUARDED_RPC_SCOPES,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  requiredScopesForOrchestrationCommand,
  requiredScopesForServerSettingsPatch,
  AssetCreateUrlInput,
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  ServerSettingsPatch,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  WS_METHODS,
  WsRpcGroup,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * Keep authorization coverage coupled to the RPC group itself. Adding an RPC to
 * `WsRpcGroup` without choosing a scope is a type error instead of a production
 * runtime failure.
 */
export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  [ORCHESTRATION_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getThreadGoal]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.setThreadGoal]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.pauseThreadGoal]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.resumeThreadGoal]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.clearThreadGoal]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.subscribeThreadGoal]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getSpecWorkflow]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.setSpecWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.subscribeSpecWorkflow]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.getSpecWorkflowState]: AuthOrchestrationReadScope,
  [ORCHESTRATION_WS_METHODS.dispatchSpecWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.reviewSpecWorkflowProposal]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.completeSpecWorkflowAcceptance]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.pauseSpecWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.resumeSpecWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_WS_METHODS.subscribeSpecWorkflowState]: AuthOrchestrationReadScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverInstallProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverStartProviderLogin]: AuthProvidersManageScope,
  [WS_METHODS.serverCliProxy]: AuthProvidersManageScope,
  [WS_METHODS.serverZcodeLogin]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetStorageCleanupReport]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsCallTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsUpdateModelContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsToolInfo]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsReadResource]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsItemDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetMcpServers]: AuthOrchestrationReadScope,
  [WS_METHODS.serverConnectMcpServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverDisconnectMcpServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverRefreshMcpServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetByokSupplierCatalog]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetAcpRegistryCatalog]: AuthOrchestrationReadScope,
  [WS_METHODS.serverInstallAcpRegistryBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverScanExternalSessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportExternalSession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetThreadReference]: AuthOrchestrationReadScope,
  [WS_METHODS.serverDiscoverByokModels]: AuthOrchestrationReadScope,
  [WS_METHODS.serverBenchmarkByokModel]: AuthProvidersManageScope,
  [WS_METHODS.serverMatchByokContextWindows]: AuthOrchestrationReadScope,
  [WS_METHODS.serverDiscoverByokDraftModels]: AuthProvidersManageScope,
  [WS_METHODS.serverLookupByokCatalogModel]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetByokBalance]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverByokBalanceDashboard]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverListByokDelegations]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSubmitByokDelegation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCancelByokDelegation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbeByokDelegationExecutor]: AuthProvidersManageScope,
  [WS_METHODS.serverImportByokAdapters]: AuthProvidersManageScope,
  [WS_METHODS.serverRunCompositionAgent]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListCompositionAgentDrivers]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListCompositionIdeSessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverInvokeCompositionRuntimeTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCancelCompositionRuntimeTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDispatchCompositionTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverExecuteCompositionTaskGraph]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListCompositionSquads]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetCompositionSquad]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListCompositionSquadRevisions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListCompositionSquadExecutions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListCompositionSquadExecutionSummaries]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCreateCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDuplicateCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverArchiveCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRestoreCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunCompositionSquad]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListCompositionAutomations]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetCompositionAutomation]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCreateCompositionAutomation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverUpdateCompositionAutomation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverPauseCompositionAutomation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverResumeCompositionAutomation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteCompositionAutomation]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunCompositionAutomationOnce]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRetryCompositionAutomationRun]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListCompositionAutomationRuns]: AuthOrchestrationReadScope,
  [WS_METHODS.serverStartWorkspaceScript]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverStopWorkspaceScript]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetWorkspaceScriptRun]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListWorkspaceScriptRuns]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetWorkspaceScriptLogs]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCancelCompositionTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverResumeCompositionTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverReviewCompositionTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRetryCompositionTask]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListCompositionTaskEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.serverListCompositionTasks]: AuthOrchestrationReadScope,
  [WS_METHODS.serverControlCenterProjection]: AuthOrchestrationReadScope,
  [WS_METHODS.serverControlCenterRedispatch]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverControlCenterByokResumeRedispatch]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverControlCenterAbandon]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverSupplierRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSupplierSetInstanceEnabled]: AuthProvidersManageScope,
  [WS_METHODS.serverSupplierUpdateCredential]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverQueryProviderEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCodeIndexStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCodeGraphStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverCodeGraphInstall]: AuthProvidersManageScope,
  [WS_METHODS.serverCodeGraphSync]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverCodeGraphReindex]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetAccountQuota]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  // Read scope like the reads it un-caches: refreshing is part of reading, and a read-only
  // client pressing refresh must not be told it may not look again.
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  // The candidate list is a read like the detail beside it; asking somebody for a review is a
  // write like every other one.
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsListCanvases]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  // Asset URLs for workspace files carry filesystem reads; attachments and
  // favicons stay on the orchestration read scope.
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.ideOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitGenerateCommitMessage]: AuthOrchestrationOperateScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewControl]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportRecording]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportAnnotation]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportScreenshot]: AuthPreviewOperateScope,
  [WS_METHODS.previewAutomationConnect]: AuthPreviewOperateScope,
  [WS_METHODS.previewAutomationRespond]: AuthPreviewOperateScope,
  [WS_METHODS.previewAutomationFocusHost]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,

  // SSH 远程服务器：读类（状态/文件浏览/读文件/终端事件订阅）放开到读权限，
  // 写删与连接测试、终端操作收紧到各自的语义权限。
  [WS_METHODS.sshGetServerStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.sshListFiles]: AuthFilesystemReadScope,
  [WS_METHODS.sshReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.subscribeSshTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.sshTestConnection]: AuthSettingsWriteScope,
  [WS_METHODS.sshWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.sshDeleteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.sshTerminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.sshTerminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.sshTerminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.sshTerminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.sshTerminalClose]: AuthTerminalOperateScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}

export const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

const SettingsUpdate = Schema.Struct({
  patch: ServerSettingsPatch,
});

const decodeSettingsUpdate = Schema.decodeUnknownSync(SettingsUpdate);
const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeAssetCreateUrlInput = Schema.decodeUnknownSync(AssetCreateUrlInput);

const requiredScopesForSettingsUpdate = (payload: unknown) =>
  requiredScopesForServerSettingsPatch(decodeSettingsUpdate(payload).patch);

export const requiredScopesForRpcCall = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = decodeAssetCreateUrlInput(payload);
    return [
      resource._tag === "workspace-file" ? AuthFilesystemReadScope : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.serverUpdateSettings) return requiredScopesForSettingsUpdate(payload);
  if (method === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return requiredScopesForOrchestrationCommand(decodeClientCommand(payload));
  }
  const guarded = clientRpcRequiredScopes(method, payload);
  if (guarded.length > 0) return guarded;
  return [requiredScopeForRpcMethod(method)];
};
