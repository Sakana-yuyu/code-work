import { describe, expect, it } from "vite-plus/test";

import { ORCHESTRATION_WS_METHODS } from "./orchestration.ts";
import { WsRpcGroup } from "./rpc.ts";

describe("Thread Goal RPC contracts", () => {
  it("registers get/set/pause/resume/clear and subscription methods", () => {
    const methods = [
      ORCHESTRATION_WS_METHODS.getThreadGoal,
      ORCHESTRATION_WS_METHODS.setThreadGoal,
      ORCHESTRATION_WS_METHODS.pauseThreadGoal,
      ORCHESTRATION_WS_METHODS.resumeThreadGoal,
      ORCHESTRATION_WS_METHODS.clearThreadGoal,
      ORCHESTRATION_WS_METHODS.subscribeThreadGoal,
    ];

    expect(methods).toEqual([
      "thread/goal/get",
      "thread/goal/set",
      "thread/goal/pause",
      "thread/goal/resume",
      "thread/goal/clear",
      "thread/goal/subscribe",
    ]);
    for (const method of methods) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });
});
