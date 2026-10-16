import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@codework/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopesForRpcCall,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthEnvironmentMaintainScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires providers:manage for draft model discovery because it carries a request-only API key", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverDiscoverByokDraftModels)).toBe(
      AuthProvidersManageScope,
    );
  });

  it("reads saved-relay context diagnostics without exposing a credential mutation path", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverMatchByokContextWindows)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates Squad reads from lifecycle and execution operations", () => {
    for (const method of [
      WS_METHODS.serverListCompositionSquads,
      WS_METHODS.serverGetCompositionSquad,
      WS_METHODS.serverListCompositionSquadRevisions,
      WS_METHODS.serverListCompositionSquadExecutions,
      WS_METHODS.serverListCompositionSquadExecutionSummaries,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.serverCreateCompositionSquad,
      WS_METHODS.serverUpdateCompositionSquad,
      WS_METHODS.serverDuplicateCompositionSquad,
      WS_METHODS.serverArchiveCompositionSquad,
      WS_METHODS.serverRestoreCompositionSquad,
      WS_METHODS.serverRunCompositionSquad,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("separates Automation reads from lifecycle and execution operations", () => {
    for (const method of [
      WS_METHODS.serverListCompositionAutomations,
      WS_METHODS.serverGetCompositionAutomation,
      WS_METHODS.serverListCompositionAutomationRuns,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      WS_METHODS.serverCreateCompositionAutomation,
      WS_METHODS.serverUpdateCompositionAutomation,
      WS_METHODS.serverPauseCompositionAutomation,
      WS_METHODS.serverResumeCompositionAutomation,
      WS_METHODS.serverDeleteCompositionAutomation,
      WS_METHODS.serverRunCompositionAutomationOnce,
      WS_METHODS.serverRetryCompositionAutomationRun,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps thread Goal reads separate from lifecycle mutations", () => {
    for (const method of ["thread/goal/get", "thread/goal/subscribe"]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      "thread/goal/set",
      "thread/goal/pause",
      "thread/goal/resume",
      "thread/goal/clear",
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps Spec Workflow state reads separate from lifecycle mutations", () => {
    for (const method of [
      "thread/spec-workflow/get",
      "thread/spec-workflow/subscribe",
      "thread/spec-workflow/state/get",
      "thread/spec-workflow/state/subscribe",
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
    for (const method of [
      "thread/spec-workflow/set",
      "thread/spec-workflow/dispatch",
      "thread/spec-workflow/pause",
      "thread/spec-workflow/resume",
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

describe("payload-sensitive authorization", () => {
  it("derives settings patch scopes from the touched fields", () => {
    expect(
      requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, {
        patch: { worktreesDirectory: "/tmp/wt" },
      }),
    ).toEqual([AuthSettingsWriteScope]);
    expect(
      requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, {
        patch: { providerInstances: {} },
      }),
    ).toEqual([AuthProvidersManageScope]);
    expect(
      requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, {
        patch: { worktreesDirectory: "/tmp/wt", providers: {} },
      }),
    ).toEqual([AuthSettingsWriteScope, AuthProvidersManageScope]);
    expect(requiredScopesForRpcCall(WS_METHODS.serverUpdateSettings, { patch: {} })).toEqual([
      AuthSettingsWriteScope,
    ]);
  });

  it("splits asset URL creation by resource kind", () => {
    expect(
      requiredScopesForRpcCall(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "workspace-file", threadId: "thread-1", path: "a.png" },
      }),
    ).toEqual([AuthFilesystemReadScope]);
    expect(
      requiredScopesForRpcCall(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "attachment", attachmentId: "att-1" },
      }),
    ).toEqual([AuthOrchestrationReadScope]);
  });

  it("requires diagnostics and maintenance to retry resource telemetry", () => {
    expect(requiredScopesForRpcCall(WS_METHODS.serverRetryResourceTelemetry, {})).toEqual([
      AuthEnvironmentMaintainScope,
      AuthDiagnosticsReadScope,
    ]);
  });

  it("adds settings write for project script mutations", () => {
    const base = {
      commandId: "cmd-1",
      projectId: "proj-1",
      createdAt: "1970-01-01T00:00:00.000Z",
    };
    expect(
      requiredScopesForRpcCall("orchestration.dispatchCommand", {
        type: "project.meta.update",
        ...base,
        title: "x",
      }),
    ).toEqual([AuthOrchestrationOperateScope]);
    expect(
      requiredScopesForRpcCall("orchestration.dispatchCommand", {
        type: "project.meta.update",
        ...base,
        scripts: [],
      }),
    ).toEqual([AuthOrchestrationOperateScope, AuthSettingsWriteScope]);
  });
});
