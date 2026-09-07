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
  /** 当前冷却截止（unix ms）；未冷却时是过期时间或 undefined。 */
  readonly cooldownUntilUnixMs?: number | undefined;
}

export interface LocalPoolUsageAccountState {
  readonly provider: string;
  readonly requests: number;
  readonly failed: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly lastUsedAt: string | null;
  readonly cooldownUntilUnixMs?: number | undefined;
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
  /** 记录/清除账号冷却（unix ms；null 清除）。随脏快照持久化，重启后仍生效。 */
  readonly setCooldown: (accountId: string, untilUnixMs: number | null) => void;
  /** 该账号当前冷却截止；未冷却时为 undefined。 */
  readonly cooldownUntilUnixMs: (accountId: string) => number | undefined;
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
    setCooldown: (accountId, untilUnixMs) => {
      if (accounts.has(accountId)) {
        mutate(accountId, accounts.get(accountId)?.provider ?? "", (current) => ({
          ...current,
          ...(untilUnixMs === null
            ? { cooldownUntilUnixMs: undefined }
            : { cooldownUntilUnixMs: untilUnixMs }),
        }));
        return;
      }
      // 冷却先于首次请求到达（如刷新凭据 401）时也建最小条目，让冷却跨重启生效。
      if (untilUnixMs === null) return;
      accounts.set(accountId, {
        provider: "",
        requests: 0,
        failed: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastUsedAt: null,
        cooldownUntilUnixMs: untilUnixMs,
      });
      dirty = true;
    },
    cooldownUntilUnixMs: (accountId) => accounts.get(accountId)?.cooldownUntilUnixMs,
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
            ...(state.cooldownUntilUnixMs === undefined
              ? {}
              : { cooldownUntilUnixMs: state.cooldownUntilUnixMs }),
          }),
        )
        .sort((left, right) => right.requests - left.requests || left.id.localeCompare(right.id)),
    serialize: () => ({
      version: 1,
      accounts: Object.fromEntries(accounts.entries()),
    }),
    // 水合按字段取最大值合并：网关可能在启动水合前已经记了请求，不能覆盖。
    // 冷却截止也是单调的：只前进不后退，过期值由读取方用当前时间过滤。
    hydrate: (state) => {
      for (const [id, incoming] of Object.entries(state.accounts ?? {})) {
        const current = accounts.get(id);
        const cooldownUntilUnixMs = Math.max(
          current?.cooldownUntilUnixMs ?? 0,
          incoming.cooldownUntilUnixMs ?? 0,
        );
        accounts.set(id, {
          provider: incoming.provider,
          requests: Math.max(current?.requests ?? 0, incoming.requests),
          failed: Math.max(current?.failed ?? 0, incoming.failed),
          inputTokens: Math.max(current?.inputTokens ?? 0, incoming.inputTokens),
          outputTokens: Math.max(current?.outputTokens ?? 0, incoming.outputTokens),
          lastUsedAt: incoming.lastUsedAt ?? current?.lastUsedAt ?? null,
          ...(cooldownUntilUnixMs > 0 ? { cooldownUntilUnixMs } : {}),
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
