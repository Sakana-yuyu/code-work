import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("Workspace Script RPC contracts", () => {
  it("把启动、停止、单条查询和列表查询注册到 typed RPC group", () => {
    const methods = [
      WS_METHODS.serverStartWorkspaceScript,
      WS_METHODS.serverStopWorkspaceScript,
      WS_METHODS.serverGetWorkspaceScriptRun,
      WS_METHODS.serverListWorkspaceScriptRuns,
    ];

    expect(methods).toEqual([
      "server.startWorkspaceScript",
      "server.stopWorkspaceScript",
      "server.getWorkspaceScriptRun",
      "server.listWorkspaceScriptRuns",
    ]);
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
