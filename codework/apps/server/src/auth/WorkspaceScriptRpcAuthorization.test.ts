import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("Workspace Script RPC authorization", () => {
  it("查询只需要编排只读权限", () => {
    for (const method of [
      WS_METHODS.serverGetWorkspaceScriptRun,
      WS_METHODS.serverListWorkspaceScriptRuns,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("启动和停止需要编排操作权限", () => {
    for (const method of [
      WS_METHODS.serverStartWorkspaceScript,
      WS_METHODS.serverStopWorkspaceScript,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
});
