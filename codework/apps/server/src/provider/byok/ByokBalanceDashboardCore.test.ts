import type { ByokBalanceResult } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  aggregateByokInstanceHealth,
  classifyByokAdapterBalanceHealth,
  projectByokBalanceDashboard,
} from "./ByokBalanceDashboardCore.ts";

const baseBalance: ByokBalanceResult = {
  instanceId: "instance-1",
  adapterId: "adapter-1",
  supported: true,
  source: "newapi",
  currency: "USD",
  unlimited: false,
  windows: [],
  message: "查询成功",
  transient: false,
};

const balance = (overrides: Partial<ByokBalanceResult> = {}): ByokBalanceResult => ({
  ...baseBalance,
  remaining: 42,
  ...overrides,
});

const failedBalance = (
  code: NonNullable<ByokBalanceResult["error"]>["code"],
): ByokBalanceResult => ({
  ...baseBalance,
  supported: false,
  error: { code, message: `failed: ${code}` },
});

describe("classifyByokAdapterBalanceHealth", () => {
  it("查询失败与余额为空是两个不同状态，错误细节不被吞掉", () => {
    expect(classifyByokAdapterBalanceHealth(failedBalance("upstream_http"))).toBe("error");
    expect(classifyByokAdapterBalanceHealth(failedBalance("timeout"))).toBe("error");
    expect(classifyByokAdapterBalanceHealth(failedBalance("missing_credentials"))).toBe("error");
    expect(classifyByokAdapterBalanceHealth(balance({ remaining: 0 }))).toBe("empty");
    expect(classifyByokAdapterBalanceHealth(balance({ remaining: -1 }))).toBe("empty");
  });

  it("不支持余额查询归为 unsupported，不算查询失败", () => {
    expect(classifyByokAdapterBalanceHealth(failedBalance("unsupported_profile"))).toBe(
      "unsupported",
    );
  });

  it("有余额、不限额、窗口耗尽分别归类为 ok/ok/empty", () => {
    expect(classifyByokAdapterBalanceHealth(balance())).toBe("ok");
    expect(classifyByokAdapterBalanceHealth({ ...baseBalance, unlimited: true })).toBe("ok");
    expect(
      classifyByokAdapterBalanceHealth({
        ...baseBalance,
        windows: [
          { id: "5h", label: "5h", unit: "requests", status: "exhausted" },
          { id: "7d", label: "7d", unit: "requests", status: "exhausted" },
        ],
      }),
    ).toBe("empty");
  });
});

describe("aggregateByokInstanceHealth", () => {
  it("空实例/全不支持/全健康/全失败/混合分别聚合为 empty/unsupported/ok/failed/degraded", () => {
    expect(aggregateByokInstanceHealth([])).toBe("empty");
    expect(aggregateByokInstanceHealth(["unsupported", "unsupported"])).toBe("unsupported");
    expect(aggregateByokInstanceHealth(["ok", "ok", "unsupported"])).toBe("ok");
    expect(aggregateByokInstanceHealth(["error", "error"])).toBe("failed");
    expect(aggregateByokInstanceHealth(["ok", "error"])).toBe("degraded");
    expect(aggregateByokInstanceHealth(["ok", "empty"])).toBe("degraded");
  });
});

describe("projectByokBalanceDashboard", () => {
  it("按实例聚合余额/健康并输出全量计数，注入时间原样透传", () => {
    const result = projectByokBalanceDashboard({
      nowUnixMs: 1_234,
      instances: [
        {
          instanceId: "byok-main",
          displayName: "主账号",
          enabled: true,
          adapters: [
            { adapterId: "a-ok", displayName: "OK", balance: balance() },
            { adapterId: "a-fail", balance: failedBalance("upstream_http") },
            { adapterId: "a-none", balance: failedBalance("unsupported_profile") },
          ],
        },
        { instanceId: "byok-bare", enabled: false, adapters: [] },
      ],
    });

    expect(result.generatedAtUnixMs).toBe(1_234);
    expect(result.totals).toEqual({
      instanceCount: 2,
      adapterCount: 3,
      okCount: 1,
      emptyCount: 0,
      unsupportedCount: 1,
      errorCount: 1,
    });
    const main = result.instances[0];
    expect(main?.health).toBe("degraded");
    expect(main?.displayName).toBe("主账号");
    expect(main?.adapters.map((adapter) => adapter.health)).toEqual([
      "ok",
      "error",
      "unsupported",
    ]);
    // 查询失败的错误细节保留在 balance.error 上，不被投影吞掉。
    expect(main?.adapters[1]?.balance.error?.code).toBe("upstream_http");
    const bare = result.instances[1];
    expect(bare?.health).toBe("empty");
    expect(bare?.enabled).toBe(false);
    expect(bare?.displayName).toBeUndefined();
  });
});
