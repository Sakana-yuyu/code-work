import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";

it("BYOK 进程内状态不能跨进程证明启动事实，明确要求人工恢复", () => {
  const driver = makeCompositionByokAgentDriver({
    agentId: "provider:byok-recovery",
    runtimeId: "provider:byok-recovery",
    providerInstanceId: "byok-recovery",
    agentService: {
      run: () => Effect.die("恢复策略测试不应启动 BYOK Agent Loop"),
    },
    checkpointStore: {
      appendEventIfNew: () => Effect.die("恢复策略测试不应写入 checkpoint"),
    },
    listTools: () => Effect.succeed([]),
  });

  expect(driver.startRecoveryPolicy).toEqual({
    mode: "manual",
    requiredReceipt: "runtime-task",
    capabilityGrantReplay: { mode: "verified" },
  });
  expect(driver.reconcileStart).toBeUndefined();
});
