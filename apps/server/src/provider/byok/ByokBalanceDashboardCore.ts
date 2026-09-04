import type {
  ByokBalanceAdapterHealth,
  ByokBalanceDashboardAdapter,
  ByokBalanceDashboardInstance,
  ByokBalanceDashboardResult,
  ByokBalanceInstanceHealth,
  ByokBalanceResult,
} from "@codework/contracts";

/** 看板投影的 adapter 输入：一次余额查询的结果加上非敏感展示信息。 */
export interface ByokBalanceDashboardAdapterInput {
  readonly adapterId: string;
  readonly displayName?: string | undefined;
  /** Relay endpoint; display/grouping only, never used to authenticate. */
  readonly baseURL?: string | undefined;
  readonly balance: ByokBalanceResult;
}

/** 看板投影的实例输入：调用方从 ServerSettings 适配而来，不含任何凭据字段。 */
export interface ByokBalanceDashboardInstanceInput {
  readonly instanceId: string;
  readonly displayName?: string | undefined;
  readonly enabled: boolean;
  readonly adapters: ReadonlyArray<ByokBalanceDashboardAdapterInput>;
}

/**
 * 单 adapter 健康归类，显式区分“查询失败”与“余额为空”：
 * - `unsupported`：该 adapter 不支持余额查询（unsupported_profile）；
 * - `error`：查询本身失败（凭据缺失、超时、上游 HTTP、响应非法等），
 *   失败细节原样保留在 `balance.error`，不会被吞掉；
 * - `empty`：查询成功但余额已耗尽（remaining ≤ 0 或全部窗口 exhausted）；
 * - `ok`：查询成功且仍有余额（含不限额）。
 */
export const classifyByokAdapterBalanceHealth = (
  balance: ByokBalanceResult,
): ByokBalanceAdapterHealth => {
  if (balance.error !== undefined) {
    return balance.error.code === "unsupported_profile" ? "unsupported" : "error";
  }
  // supported=false 而无 error 是不该出现的形状；按失败处理，绝不伪装成健康。
  if (!balance.supported) return "error";
  if (balance.unlimited) return "ok";
  if (balance.remaining !== undefined && balance.remaining <= 0) return "empty";
  if (
    balance.windows.length > 0 &&
    balance.windows.every((window) => window.status === "exhausted")
  ) {
    return "empty";
  }
  return "ok";
};

/**
 * 实例级聚合：`empty`（无 adapter）、`unsupported`（全部不支持查询）、
 * `ok`（可查询的全部健康）、`failed`（可查询的全部查询失败）、`degraded`（混合，
 * 含余额耗尽——查询能力正常但余额需要关注）。
 */
export const aggregateByokInstanceHealth = (
  healths: ReadonlyArray<ByokBalanceAdapterHealth>,
): ByokBalanceInstanceHealth => {
  if (healths.length === 0) return "empty";
  const queryable = healths.filter((health) => health !== "unsupported");
  if (queryable.length === 0) return "unsupported";
  if (queryable.every((health) => health === "ok")) return "ok";
  if (queryable.every((health) => health === "error")) return "failed";
  return "degraded";
};

/** BYOK 余额/用量/健康统一看板的纯投影：无 IO、无时钟读取，时间由调用方注入。 */
export const projectByokBalanceDashboard = (input: {
  readonly instances: ReadonlyArray<ByokBalanceDashboardInstanceInput>;
  readonly nowUnixMs: number;
}): ByokBalanceDashboardResult => {
  const instances: ByokBalanceDashboardInstance[] = input.instances.map((instance) => {
    const adapters: ByokBalanceDashboardAdapter[] = instance.adapters.map((adapter) => ({
      adapterId: adapter.adapterId,
      ...(adapter.displayName === undefined ? {} : { displayName: adapter.displayName }),
      ...(adapter.baseURL === undefined ? {} : { baseURL: adapter.baseURL }),
      health: classifyByokAdapterBalanceHealth(adapter.balance),
      balance: adapter.balance,
    }));
    return {
      instanceId: instance.instanceId,
      ...(instance.displayName === undefined ? {} : { displayName: instance.displayName }),
      enabled: instance.enabled,
      health: aggregateByokInstanceHealth(adapters.map((adapter) => adapter.health)),
      adapters,
    };
  });
  const allAdapters = instances.flatMap((instance) => instance.adapters);
  const countOf = (health: ByokBalanceAdapterHealth): number =>
    allAdapters.filter((adapter) => adapter.health === health).length;
  return {
    generatedAtUnixMs: input.nowUnixMs,
    totals: {
      instanceCount: instances.length,
      adapterCount: allAdapters.length,
      okCount: countOf("ok"),
      emptyCount: countOf("empty"),
      unsupportedCount: countOf("unsupported"),
      errorCount: countOf("error"),
    },
    instances,
  };
};
