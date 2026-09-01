import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("Workspace Script RPC contracts", () => {
  it("把生命周期、运行查询和日志快照注册到 typed RPC group", () => {
    const methods = [
      WS_METHODS.serverStartWorkspaceScript,
      WS_METHODS.serverStopWorkspaceScript,
      WS_METHODS.serverGetWorkspaceScriptRun,
      WS_METHODS.serverListWorkspaceScriptRuns,
      WS_METHODS.serverGetWorkspaceScriptLogs,
    ];

    expect(methods).toEqual([
      "server.startWorkspaceScript",
      "server.stopWorkspaceScript",
      "server.getWorkspaceScriptRun",
      "server.listWorkspaceScriptRuns",
      "server.getWorkspaceScriptLogs",
    ]);
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
