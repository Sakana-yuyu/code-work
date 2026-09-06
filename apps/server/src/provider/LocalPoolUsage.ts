// @effect-diagnostics globalDate:off - 最近使用时间戳使用墙上时间。

/**
 * 本地账号池的按账号调用统计。
 *
 * 存储本体是纯同步的模块级单例：网关热路径在请求与流结束两个点直接
 * 记录，不引入 Effect 依赖；持久化由 `CliProxy.layer` 负责——启动时
 * 水合，定时把脏快照写进 `<stateDir>/local-pool-usage.json`。统计只含
 * 聚合数字与时间戳，凭据和请求内容永远不进入这里。
 */

export interface LocalPoolUsageEntry {
  readonly id: string;
  readonly provider: string;
  readonly requests: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastUsedAt: string | null;
}

export interface LocalPoolUsageAccountState {
  readonly provider: string;
  readonly requests: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastUsedAt: string | null;
}

export interface LocalPoolUsageState {
  readonly version: 1;
  readonly accounts: Readonly<Record<string, LocalPoolUsageAccountState>>;
}

export interface LocalPoolUsageStore {
  /** 一次账号请求落地（含失败尝试）；失败按尝试次数计。 */
  readonly recordRequest: (accountId: string, provider: string, ok: boolean) => void;
  /** 一次流结束后累积的 token 统计。 */
  readonly recordTokens: (accountId: string, inputTokens: number, outputTokens: number) => void;
  readonly list: () => ReadonlyArray<LocalPoolUsageEntry>;
  readonly serialize: () => LocalPoolUsageState;
  readonly hydrate: (state: LocalPoolUsageState) => void;
  /** 有未落盘的变更时返回快照并清脏标记；否则返回 undefined。 */
  readonly takeDirtySnapshot: () => LocalPoolUsageState | undefined;
}

export const parseLocalPoolUsageState = (text: string): LocalPoolUsageState | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const accounts = (value as { accounts?: unknown }).accounts;
    if (accounts === null || typeof accounts !== "object" || Array.isArray(accounts)) {
      return undefined;
    }
    return value as LocalPoolUsageState;
  } catch {
    return undefined;
  }
};

export const createLocalPoolUsageStore = (): LocalPoolUsageStore => {
  const accounts = new Map<string, LocalPoolUsageAccountState>();
  let dirty = false;

  const mutate = (
    accountId: string,
    provider: string,
    update: (current: LocalPoolUsageAccountState) => LocalPoolUsageAccountState,
  ): void => {
    const previous =
      accounts.get(accountId) ??
      ({
        provider,
        requests: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastUsedAt: null,
      } satisfies LocalPoolUsageAccountState);
    accounts.set(accountId, update(previous));
    dirty = true;
  };

  return {
    recordRequest: (accountId, provider, ok) =>
      mutate(accountId, provider, (current) => ({
        ...current,
        provider,
        requests: current.requests + 1,
        failed: ok ? current.failed : current.failed + 1,
        lastUsedAt: new Date().toISOString(),
      })),
    recordTokens: (accountId, inputTokens, outputTokens) =>
      mutate(accountId, accounts.get(accountId)?.provider ?? "", (current) => ({
        ...current,
        inputTokens: current.inputTokens + Math.max(0, Math.trunc(inputTokens)),
        outputTokens: current.outputTokens + Math.max(0, Math.trunc(outputTokens)),
      })),
    list: () =>
      [...accounts.entries()]
        .map(
          ([id, state]): LocalPoolUsageEntry => ({
            id,
            provider: state.provider,
            requests: state.requests,
            failed: state.failed,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            lastUsedAt: state.lastUsedAt,
          }),
        )
        .sort((left, right) => right.requests - left.requests || left.id.localeCompare(right.id)),
    serialize: () => ({
      version: 1,
      accounts: Object.fromEntries(accounts.entries()),
    }),
    // 水合按字段取最大值合并：网关可能在启动水合前已经记了请求，不能覆盖。
    hydrate: (state) => {
      for (const [id, incoming] of Object.entries(state.accounts ?? {})) {
        const current = accounts.get(id);
        accounts.set(id, {
          provider: incoming.provider,
          requests: Math.max(current?.requests ?? 0, incoming.requests),
          failed: Math.max(current?.failed ?? 0, incoming.failed),
          inputTokens: Math.max(current?.inputTokens ?? 0, incoming.inputTokens),
          outputTokens: Math.max(current?.outputTokens ?? 0, incoming.outputTokens),
          lastUsedAt: incoming.lastUsedAt ?? current?.lastUsedAt ?? null,
        });
      }
    },
    takeDirtySnapshot: () => {
      if (!dirty) return undefined;
      dirty = false;
      return {
        version: 1,
        accounts: Object.fromEntries(accounts.entries()),
      };
    },
  };
};

/** 网关与 CLI 服务共享的进程内单例；持久化由 CliProxy.layer 驱动。 */
export const localPoolUsageStore = createLocalPoolUsageStore();
