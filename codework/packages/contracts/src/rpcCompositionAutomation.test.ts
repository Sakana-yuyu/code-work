import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("Automation RPC contracts", () => {
  it("把 Automation 生命周期、手动运行和历史方法注册到 typed RPC group", () => {
    const methods = [
      WS_METHODS.serverListCompositionAutomations,
      WS_METHODS.serverGetCompositionAutomation,
      WS_METHODS.serverCreateCompositionAutomation,
      WS_METHODS.serverUpdateCompositionAutomation,
      WS_METHODS.serverPauseCompositionAutomation,
      WS_METHODS.serverResumeCompositionAutomation,
      WS_METHODS.serverDeleteCompositionAutomation,
      WS_METHODS.serverRunCompositionAutomationOnce,
      WS_METHODS.serverRetryCompositionAutomationRun,
      WS_METHODS.serverListCompositionAutomationRuns,
    ];

    expect(methods).toEqual([
      "server.listCompositionAutomations",
      "server.getCompositionAutomation",
      "server.createCompositionAutomation",
      "server.updateCompositionAutomation",
      "server.pauseCompositionAutomation",
      "server.resumeCompositionAutomation",
      "server.deleteCompositionAutomation",
      "server.runCompositionAutomationOnce",
      "server.retryCompositionAutomationRun",
      "server.listCompositionAutomationRuns",
    ]);
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
