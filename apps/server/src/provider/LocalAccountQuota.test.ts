// @effect-diagnostics globalDate:off - 快照 TTL 与冷却断言对照墙上时间。
// @effect-diagnostics globalDateInEffect:off - 冷却与重置断言在 Effect 内对照墙上时间。
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { LocalAccount } from "@codework/contracts";
import { LocalAccountError } from "./LocalAccountPool.ts";
import {
  extendLocalAccountCooldownFromQuota,
  LOCAL_POOL_QUOTA_ERROR_TTL_MS,
  LOCAL_POOL_QUOTA_TTL_MS,
  localAccountQuotaExhaustedResetMs,
  localAccountQuotaForPick,
  refreshLocalAccountQuota,
  refreshLocalPoolQuotas,
  rememberLocalAccountQuota,
  resetLocalAccountQuotaCacheForTest,
  type LocalAccountQuotaDeps,
} from "./LocalAccountQuota.ts";
import { localPoolUsageStore } from "./LocalPoolUsage.ts";

const account = (id: string): LocalAccount =>
  ({
    id: id as never,
    provider: "claude",
    displayName: id,
    credentialRef: `ref-${id}`,
    enabled: true,
    models: [],
  }) as unknown as LocalAccount;

const view = (
  windows: ReadonlyArray<{ label: string; percent?: number; resetsAt?: string }>,
  error?: string,
) => ({
  windows: windows.map((window) => ({
    label: window.label,
    ...(window.percent === undefined ? {} : { percent: window.percent }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  })),
  ...(error === undefined ? {} : { error }),
});

const depsWithViews = (
  failingIds: ReadonlyArray<string> = [],
): LocalAccountQuotaDeps & { fetches: string[] } => {
  const fetches: string[] = [];
  return {
    fetches,
    secretStore: {} as LocalAccountQuotaDeps["secretStore"],
    // 按真实 claude 用量端点形状应答；usage 窗口走 /api/oauth/usage，
    // 其余端点（profile 等）404 由查询方容错。凭据不可用的账号在锁内
    // 短路成 error 视图，不触网。
    httpClient: HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            request.url.includes("/api/oauth/usage")
              ? JSON.stringify({ five_hour: { utilization: 10 } })
              : "not found",
            { status: request.url.includes("/api/oauth/usage") ? 200 : 404 },
          ),
        ),
      ),
    ),
    ensureCredential: (input) =>
      failingIds.includes(String(input.id))
        ? Effect.fail(new LocalAccountError({ detail: "凭据不可用" }))
        : Effect.sync(() => {
            fetches.push(String(input.id));
            return { access_token: "token" };
          }),
  };
};

describe("LocalAccountQuota", () => {
  it("TTL 内的快照可读，过期后为空；失败视图按更短 TTL 过期", () => {
    resetLocalAccountQuotaCacheForTest();
    const now = Date.now();
    rememberLocalAccountQuota("a", view([{ label: "5 小时", percent: 42 }]), now - 1_000);
    expect(localAccountQuotaForPick("a", now)).toEqual({ percent: 42 });
    expect(localAccountQuotaForPick("a", now + LOCAL_POOL_QUOTA_TTL_MS + 1_000)).toBeUndefined();
    // 失败视图按 60s 短缓存：失败不把"无数据"钉死一个长刷新周期。
    rememberLocalAccountQuota("b", view([], "Claude 用量查询失败"), now - 1_000);
    expect(localAccountQuotaForPick("b", now)).toBeUndefined();
    rememberLocalAccountQuota("c", view([], "超时"), now - (LOCAL_POOL_QUOTA_ERROR_TTL_MS + 1_000));
    expect(localAccountQuotaForPick("c", now)).toBeUndefined();
  });

  it("主窗口取已用百分比最大的窗口，重置时间跟随主窗口", () => {
    resetLocalAccountQuotaCacheForTest();
    const resets = "2026-11-08T12:00:00.000Z";
    rememberLocalAccountQuota(
      "a",
      view([
        { label: "5 小时", percent: 30, resetsAt: "2026-11-08T10:00:00.000Z" },
        { label: "7 天", percent: 80, resetsAt: resets },
      ]),
      Date.now(),
    );
    const pick = localAccountQuotaForPick("a", Date.now());
    expect(pick).toEqual({ percent: 80, resetsAtMs: Date.parse(resets) });
    // 只有百分比、没有重置时间的窗口仍参与选号。
    rememberLocalAccountQuota("b", view([{ label: "周额度", percent: 10 }]), Date.now());
    expect(localAccountQuotaForPick("b", Date.now())).toEqual({ percent: 10 });
  });

  it("耗尽窗口的最早重置点只认 percent ≥ 100 的窗口", () => {
    resetLocalAccountQuotaCacheForTest();
    const now = Date.now();
    const resets = new Date(now + 3 * 60 * 60 * 1_000).toISOString();
    rememberLocalAccountQuota(
      "a",
      view([
        { label: "5 小时", percent: 100, resetsAt: resets },
        { label: "7 天", percent: 20, resetsAt: new Date(now + 1000).toISOString() },
      ]),
      now,
    );
    expect(localAccountQuotaExhaustedResetMs("a", now)).toBe(Date.parse(resets));
    // percent 缺失的窗口可能是突发限流，不作为延长冷却的依据。
    rememberLocalAccountQuota("b", view([{ label: "5 小时", resetsAt: resets }]), now);
    expect(localAccountQuotaExhaustedResetMs("b", now)).toBeUndefined();
  });

  it.effect("refreshLocalAccountQuota 在 TTL 内去重，锁外不重复拉账号接口", () =>
    Effect.gen(function* () {
      resetLocalAccountQuotaCacheForTest();
      localPoolUsageStore.resetForTest();
      const deps = depsWithViews();
      const first = yield* refreshLocalAccountQuota(account("a"), deps).pipe(
        Effect.flatMap(() => refreshLocalAccountQuota(account("a"), deps)),
      );
      expect(first.windows).toHaveLength(1);
      expect(first.error).toBeUndefined();
      expect(deps.fetches).toEqual(["a"]);
    }),
  );

  it.effect("extendLocalAccountCooldownFromQuota 把冷却延到触顶窗口的重置点，且只延长不缩短", () =>
    Effect.gen(function* () {
      resetLocalAccountQuotaCacheForTest();
      localPoolUsageStore.resetForTest();
      try {
        const resets = Date.now() + 2 * 60 * 60 * 1_000;
        rememberLocalAccountQuota(
          "a",
          view([{ label: "5 小时", percent: 100, resetsAt: new Date(resets).toISOString() }]),
        );
        const deps = depsWithViews();
        yield* extendLocalAccountCooldownFromQuota(account("a"), 24 * 60 * 60 * 1_000, deps);
        expect(localPoolUsageStore.cooldownUntilUnixMs("a")).toBe(resets);
        // 已有更长冷却时不缩短；重置点超过 cap 时被钳制。
        localPoolUsageStore.setCooldown("a", Date.now() + 3 * 60 * 60 * 1_000);
        yield* extendLocalAccountCooldownFromQuota(account("a"), 24 * 60 * 60 * 1_000, deps);
        expect(localPoolUsageStore.cooldownUntilUnixMs("a")).toBeGreaterThan(resets);
        rememberLocalAccountQuota(
          "b",
          view([
            {
              label: "5 小时",
              percent: 100,
              resetsAt: new Date(Date.now() + 10 * 60 * 60 * 1_000).toISOString(),
            },
          ]),
        );
        yield* extendLocalAccountCooldownFromQuota(account("b"), 30 * 1_000, deps);
        expect(localPoolUsageStore.cooldownUntilUnixMs("b") ?? 0).toBeLessThanOrEqual(
          Date.now() + 35_000,
        );
      } finally {
        localPoolUsageStore.setCooldown("a", null);
        localPoolUsageStore.setCooldown("b", null);
      }
    }),
  );

  it.effect("refreshLocalPoolQuotas 跳过禁用账号并统计成功数", () =>
    Effect.gen(function* () {
      resetLocalAccountQuotaCacheForTest();
      localPoolUsageStore.resetForTest();
      const deps = depsWithViews(["b"]);
      const settings = {
        localAccountPool: {
          strategy: "smart",
          accounts: {
            a: account("a"),
            b: account("b"),
            off: { ...account("off"), enabled: false },
          },
          providerInstances: {},
        },
      } as never;
      const refreshed = yield* refreshLocalPoolQuotas(settings, deps);
      expect(refreshed).toBe(1);
      expect(deps.fetches).toEqual(["a"]);
    }),
  );
});
